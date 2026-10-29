#!/usr/bin/env node
'use strict';
// hooks/board.js — 세션 게시판: 같은 저장소의 대화형 세션들이 서로를 알게 한다(Claude · Codex 공용).
//   [2026-10-25 Light 1단계] 같은 체크아웃에서 두 세션이 일하면 미커밋 편집이 섞이고, 같은 요청을 두 번 처음부터 했다.
//   막지 않는다 — 알리고(문맥) 물을 뿐이다(ask). 판정은 사람이 한다.
//   SessionStart · UserPromptSubmit: 이 세션의 cwd · root · branch · last_seen · goal(첫 요청)을 세션 파일에 적는다.
//     UserPromptSubmit: 같은 root 에서 다른 산 세션이 일하면 한 번 알린다(세션 쌍마다 한 번) · 첫 요청이 다른 산 세션 · 열린 작업의 목표와 같으면 알린다.
//     SessionStart(가벼운 길 안): CLAUDE_ENV_FILE 에 그 길의 환경(작업 이름 · 임시 폴더 · 포트)을 export 로 덧붙인다.
//   PreToolUse(Write · Edit …): 다른 산 세션이 기록한 파일이 지금 미커밋이면 permissionDecision 'ask'. 아니면 출력 없음.
//   산 세션 = 이 세션이 아님 · Claude 세션은 `claude agents --json` 목록에 있다(C.platformAgents · 30초 캐시) —
//     목록을 못 얻었거나 Codex 세션이면 ended_at 없음 · last_seen 30분 안. 무인 작업자의 worktree 에서는 아무것도 하지 않는다.
//   알림에는 플랫폼 이름(예: proj-34)과 busy/idle 을 싣는다.
//   내부 오류는 열어 둔다(허용) — 대신 hook-errors.log 에 남긴다.
const fs = require('node:fs');
const C = require('./_common');

const LIVE_MS = C.LIVE_MS;
const GOAL_MAX = 200;
const MAX_DUPS = 3;
const FINAL = new Set(['accepted', 'cancelled']);

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// 첫 요청에 든 비밀(토큰 · 키 · 비밀번호)을 가린다 — 기록하는 쪽에서. [2026-10-29 감사] 첫 요청이 그대로 세션 파일에 저장되고
//   다른 세션의 문맥 · status 에 실렸다(요청에 넣은 토큰 · 비밀번호가 다른 세션의 대화 기록으로 옮겨 갔다).
const SECRET = '<secret>';
const SECRET_RES = [
  /\b(?:sk|pk|rk)-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{10,}/g,               // OpenAI · Anthropic · Stripe 꼴
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,}/g,   // GitHub
  /\bglpat-[A-Za-z0-9_-]{10,}|\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                    // GitLab · Slack
  /\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}/g,                                 // AWS 액세스 키 · Google API 키
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,                 // JWT
];
function maskSecrets(text) {
  let s = String(text || '');
  for (const re of SECRET_RES) s = s.replace(re, SECRET);
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${SECRET}`);
  s = s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${SECRET}@`);                       // scheme://user:pass@
  // NAME=값 · NAME: 값 (이름이 key · token · secret · password · pwd · pass 로 끝나는 것 — keyboard: 는 아니다)
  s = s.replace(/\b([A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|pass)s?)(\s*[=:]\s*)(?!<secret>)("[^"]*"|'[^']*'|\S+)/gi, `$1$2${SECRET}`);
  // 비밀번호는 … · 토큰: … — 조사(은 · 는 · 이 · 가)나 : · = 뒤의 비밀 꼴 낱말(한글이 없고 숫자 · 기호가 든 4자 이상 — "토큰이 만료" 는 그대로)
  s = s.replace(/(비밀번호|비번|패스워드|암호|토큰|비밀\s?키|API\s?키|액세스\s?키)(\s*(?:은|는|이|가|:|=)\s*)(?!<secret>)(?=[^\s가-힣]*[0-9!@#$%^&*_+=-])([^\s가-힣]{4,})/gi, `$1$2${SECRET}`);
  return s;
}
const minutesAgo = (iso, now) => { const t = Date.parse(iso || ''); return t ? Math.max(0, Math.round((now - t) / 60000)) : null; };
const isLive = (s, now, agents) => C.sessionLive(s, agents, now);
// 플랫폼 목록 — 후보 세션이 있을 때만 한 번 묻는다(캐시 30초). 못 얻으면 null(last_seen 어림).
function lazyAgents(common) {
  let v;
  return () => { if (v === undefined) { try { v = C.platformAgents(common); } catch (e) { C.logError('board', e); v = null; } } return v; };
}
// 세션 한 줄: 세션 <sid8>(이름 · busy|idle · N분 전 · 목표: "…")
function who(p, agents, now, goalLen, extra) {
  const a = C.agentOf(p, agents), m = minutesAgo(p.last_seen, now), parts = [];
  if (a && a.name) parts.push(a.name);
  if (a && a.status) parts.push(a.status);
  if (m != null) parts.push(`${m}분 전`);
  parts.push(...(extra || []));
  if (goalLen && p.goal) parts.push(`목표: "${clip(p.goal, goalLen)}"`);
  return `세션 ${C.sid8(p.session_id)}(${parts.join(' · ')})`;
}
function sameRoot(a, b) {
  if (!a || !b) return false;
  try { return C.samePath(a, b); } catch { return false; }
}
function branchOf(root) {
  const r = C.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
  const b = r.status === 0 ? r.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : null;
}
// 다른 산 세션들(같은 root 만 고르려면 root 를 준다 · keep 으로 먼저 거른다). 후보가 없으면 플랫폼에 묻지 않는다.
function others(common, sid, now, root, agents, keep) {
  const cand = C.listSessions(common).filter(s => s.session_id !== String(sid) && (!root || sameRoot(s.root, root)) && (!keep || keep(s)));
  if (!cand.length) return [];
  const ag = typeof agents === 'function' ? agents() : agents;
  return cand.filter(s => isLive(s, now, ag));
}

// ── 같은 체크아웃 ──
function sameCheckoutNote(info, me, peers, now, agents) {
  const fresh = peers.filter(p => !(me.warned_sessions || []).includes(p.session_id));
  if (!fresh.length) return { text: null, warned: [] };
  const list = fresh.map(p => who(p, agents, now, 80)).join(', ');
  const text = `[pilot board] 같은 폴더(${info.root})에서 다른 세션이 일하고 있다: ${list}. 한 체크아웃에서 두 세션이 고치면 서로의 미커밋 편집이 섞인다(커밋 · 되돌리기가 남의 변경을 건드린다). ` +
    `이 세션의 일은 자기 worktree 에서 하라: \`node harness/cli.js start "<목표>"\` — 그 worktree 폴더에서 이어 간다. 이 폴더에서 계속해야 하면 자기가 고친 파일만 경로로 커밋한다.`;
  return { text, warned: fresh.map(p => p.session_id) };
}

// ── 같은 목표 ──
function duplicateNote(info, sid, prompt, now, agents) {
  const W = require('../lib/worklog');
  const want = String(prompt || '').slice(0, 2000);
  if (!want.trim()) return null;
  const cand = [];
  const similar = new Map();
  for (const s of others(info.common, sid, now, null, agents, x => { if (!x.goal) return false; const sc = W.similarity(want, x.goal); similar.set(x.session_id, sc); return sc >= W.SAME; })) {
    const ag = typeof agents === 'function' ? agents() : agents;
    cand.push({ score: similar.get(s.session_id), line: `${who(s, ag, now, 0, [s.branch || '분리된 HEAD', s.root || '?'])}: "${clip(s.goal, 100)}"` });
  }
  let tasks = [];
  try { tasks = require('../lib/state').listTasks(info.root); } catch { tasks = []; }
  for (const t of tasks) {
    if (!t || FINAL.has(t.status) || !t.goal) continue;
    const score = W.similarity(want, t.goal);
    if (score >= W.SAME) cand.push({ score, task: t.id, line: `작업 ${t.id}(${t.status}${t.mode ? ` · ${t.mode}` : ''} · ${t.branch || `harness/${t.id}`}): "${clip(t.goal, 100)}"` });
  }
  if (!cand.length) return null;
  const top = cand.sort((a, b) => b.score - a.score).slice(0, MAX_DUPS);
  const task = top.find(x => x.task);
  return `[pilot board] 이 요청과 같은 일이 이미 있다 — ${top.map(x => x.line).join(' · ')}. 처음부터 다시 하지 말고 그것을 확인하고 이어 가라.` +
    (task ? ` 작업은 그 브랜치에서 이어 갈 수 있다: \`node harness/cli.js start --from ${task.task} "<목표>"\`.` : ' 그 세션이 하는 일이면 사용자에게 먼저 물어라.');
}

// ── 가벼운 길의 환경 ──
const shQuote = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
function laneEnvLines(laneRoot) {
  const env = require('../lib/resources').envFor(laneRoot) || {};
  return Object.entries(env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v != null && !/[\r\n\0]/.test(String(v))).map(([k, v]) => `export ${k}=${shQuote(v)}`);
}

function touch(info, sid, runtime, cwd, ev, prompt, now) {
  const branch = branchOf(info.root);
  let first = false, me = null;
  C.updateSession(info.common, sid, runtime, s => {
    s.cwd = cwd; s.root = info.root; s.branch = branch; s.last_seen = new Date(now).toISOString();
    delete s.ended_at;                                     // 다시 말을 걸었다 — 이어 간 세션
    if (ev === 'UserPromptSubmit' && !s.goal && String(prompt || '').trim()) { s.goal = clip(maskSecrets(prompt), GOAL_MAX); first = true; }
    me = s;
    return s;
  });
  return { me, first };
}

// 도구 점검 한 줄 — 저장소마다 하루 한 번(<common>/harness/toolkit-hint.json). 맞는 도구가 다 있고 주의할 것도 없으면 조용하다.
//   [2026-10-26 사용자 요청] 일을 시작할 때 스킬 · MCP 를 확인해 가장 효율적인 길을 찾는다. HARNESS_TOOLKIT_HINT=off 면 끈다.
function toolkitTip(info, now) {
  if (/^(off|0|false|no)$/i.test(process.env.HARNESS_TOOLKIT_HINT || '')) return null;
  try {
    const file = require('node:path').join(info.common, 'harness', 'toolkit-hint.json'), day = new Date(now).toISOString().slice(0, 10);
    let last = null; try { last = JSON.parse(fs.readFileSync(file, 'utf8')).day; } catch { /* 처음 */ }
    if (last === day) return null;
    const tip = require('../lib/toolkit').hint({ root: info.root, now });
    C.writeJsonAtomic(file, { day, shown: !!tip });
    return tip;
  } catch (e) { C.logError('board', e, info.root); return null; }
}
function decide(input, runtime, now) {
  now = now || Date.now();
  const ev = String(input.hook_event_name || '');
  const sid = input.session_id;
  if (!sid) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const info = C.repoInfo(cwd);
  if (!info || C.harnessOwned(info)) return null;          // 무인 작업자의 worktree — 게시판에 오르지 않는다

  if (ev === 'PreToolUse') {
    const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    const file = ti.file_path || ti.notebook_path;
    const rel = typeof file === 'string' ? C.repoRel(info.root, cwd, file) : null;
    if (!rel) return null;
    const k = C.keyOf(rel);
    const mine = C.loadSession(info.common, sid);
    // 이미 이 세션이 고친 파일이면 묻지 않는다(한 번 물었거나 이 세션이 먼저였다 — 매번 묻지 않게)
    if (mine && (mine.files || []).some(f => C.keyOf(f) === k)) return null;
    // 싼 것부터: 그 파일을 기록한 다른 세션(파일만 읽음) → 지금 미커밋인가(그 경로만 git status) → 살아 있나(플랫폼 목록 · 캐시)
    const holds = p => p.files.some(f => C.keyOf(f) === k);
    if (!C.listSessions(info.common).some(p => p.session_id !== String(sid) && sameRoot(p.root, info.root) && holds(p))) return null;
    if (!C.dirtyPaths(info.root, [rel]).has(k)) return null;
    const agents = lazyAgents(info.common);
    const holders = others(info.common, sid, now, info.root, agents, holds);
    if (!holders.length) return null;
    const list = holders.map(p => who(p, agents(), now, 60)).join(', ');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
      permissionDecisionReason: `[pilot board] \`${rel}\` 에 다른 세션의 미커밋 편집이 있습니다(${list}). 지금 고치면 두 세션의 변경이 한 파일에 섞이고, 그 세션의 커밋이 이 편집까지 가져갑니다. 계속할까요?` } };
  }

  if (ev !== 'UserPromptSubmit' && ev !== 'SessionStart') return null;
  const { me, first } = touch(info, sid, runtime, cwd, ev, input.prompt, now);

  if (ev === 'SessionStart') {
    const lane = C.laneOf(info);
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (lane && envFile) {
      const lines = laneEnvLines(info.root);
      if (lines.length) fs.appendFileSync(envFile, `# pilot lane ${lane.id}\n${lines.join('\n')}\n`);
    }
    const tip = toolkitTip(info, now);
    return tip ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: tip } } : null;
  }

  const notes = [];
  const agents = lazyAgents(info.common);
  const peers = others(info.common, sid, now, info.root, agents);
  const same = sameCheckoutNote(info, me || {}, peers, now, peers.length ? agents() : null);
  if (same.text) {
    notes.push(same.text);
    C.updateSession(info.common, sid, runtime, s => { s.warned_sessions = [...new Set([...(s.warned_sessions || []), ...same.warned])]; return s; });
  }
  if (first) { const d = duplicateNote(info, sid, input.prompt, now, agents); if (d) notes.push(d); }
  return notes.length ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notes.join('\n\n') } } : null;
}

function main() {
  let input = null;
  try {
    const r = C.readStdinJson();
    if (!r.input) { if (r.error !== 'empty stdin') C.logError('board', r.error); return; }
    input = r.input;
    const out = decide(input, C.detectRuntime(input));
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  } catch (e) { C.logError('board', e, input && input.cwd); }
}

if (require.main === module) { main(); process.exitCode = 0; }
module.exports = { decide, isLive, laneEnvLines, shQuote, maskSecrets, LIVE_MS };

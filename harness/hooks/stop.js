#!/usr/bin/env node
'use strict';
// hooks/stop.js — Stop: 이 세션이 고친 파일이 커밋되지 않은 채 끝나지 않게 한다(설계 §0.4 · §7).
//   대상 = 세션 파일(track.js 가 기록)의 경로 ∩ `git status --porcelain -z` 의 미커밋 경로. 다른 세션·사람의 변경은 보지 않는다.
//   (셸로 고친 파일은 기록되지 않는다 — 스냅샷 대조는 하지 않는다: 같은 체크아웃의 다른 세션·편집기 변경과 구별할 수 없다.)
//
//   Claude: 남은 파일이 있으면 {"decision":"block","reason":…} — 턴을 이어 가며 모델이 그 파일만 커밋한다.
//           한 번만 막는다. 이어 간 턴 뒤에도 남아 있으면(권한 프롬프트에 막혔거나 모델이 못 했으면) 훅이 직접 그 파일만 커밋하고 통과시킨다.
//           [2026-09-29 실측] -p 세션에서 모델의 `git commit` 이 승인 대기에 걸려 커밋하지 못했다 — 막기만 하면 커밋 없이 끝난다.
//   Codex : 샌드박스가 .git 쓰기를 막아 모델이 커밋할 수 없다 → 막지 않고 훅이 직접 그 파일만 커밋한다.
//   비밀 파일(.env* · *.pem · *.key · id_rsa*)은 절대 커밋하지 않는다 — Claude 에는 이유에 따로 적고, Codex 에서는 세션 파일에 남긴다.
const C = require('./_common');

const MAX_BLOCKS = 1;

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  const clean = line.replace(/^[#>*\-\s`]+/, '').replace(/\s+/g, ' ').trim();
  return clean.length > 72 ? clean.slice(0, 69) + '...' : clean;
}

// [2026-09-29 실측] 마지막 말을 메시지로 쓰면 "커밋이 승인 대기로 막혀…" 같은 불평이 이력에 남았다 — 파일 목록으로 쓴다.
function filesSummary(files) {
  const head = files.slice(0, 3).join(', ');
  return `update ${head}${files.length > 3 ? ` (+${files.length - 3} more)` : ''}`;
}

function blockReason(mine, secrets) {
  let r = `${C.listForReason(mine)} — 이 세션이 고친 파일이 커밋되지 않았습니다. 이 파일들만 스테이징해 의미 있는 메시지로 커밋하고 끝내세요(다른 변경은 건드리지 마세요).`;
  r += ` 예: \`git add -- <파일들>\` 후 \`git commit -m "<무엇을 왜>" -- <파일들>\`.`;
  if (secrets.length) r += ` 비밀 파일로 보이는 ${C.listForReason(secrets, 10)} 은(는) 커밋하지 마세요.`;
  return r;
}

// [2026-10-21 자동 이슈 #35] 대화 에이전트가 "다음 단계는 바로 이어서 진행하겠다" 고 답한 뒤 아무것도 띄우지 않고 차례를 끝내,
//   사용자가 물을 때까지 실제로는 멈춰 있었다. 마지막 답에 그런 약속이 있는데 이번 차례에 이어 갈 것(백그라운드 작업 · 예약 깨우기 ·
//   감시 · 하네스 작업)을 하나도 띄우지 않았으면 한 번만 되돌려 보낸다. 질문으로 끝난 답 · 이미 되돌려 보낸 뒤(stop_hook_active)는 그냥 둔다.
const PROMISE = /(바로 이어서|이어서 (진행|하겠|할게|작업)|곧 (시작|진행)하|계속 진행하겠|다음 단계(를|는)? ?(바로|곧|이어서)|지금 (시작|진행)하겠|\b(I'll|I will) (now )?(continue|proceed|start|kick off) (with|on|the)\b|\bwill (continue|proceed) (now|next|right away)\b)/i;
const CONTINUES = new Set(['ScheduleWakeup', 'Monitor', 'CronCreate', 'Workflow']);
function lastTurn(transcriptPath) {
  const fs = require('node:fs');
  let text = ''; try { const st = fs.statSync(transcriptPath); const fd = fs.openSync(transcriptPath, 'r'); const n = Math.min(st.size, 400000); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd); text = b.toString('utf8'); } catch { return null; }
  const rows = text.split(/\r?\n/).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // 마지막 사람 메시지(도구 결과가 아닌 글) 뒤의 것만
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i], c = r.message && r.message.content; if (r.type === 'user' && !r.isMeta && (typeof c === 'string' || (Array.isArray(c) && c.some(x => x && x.type === 'text')))) { start = i + 1; break; } }
  let finalText = '', launched = false;
  for (const r of rows.slice(start)) {
    if (r.type !== 'assistant' || !r.message || !Array.isArray(r.message.content)) continue;
    for (const x of r.message.content) {
      if (x.type === 'text' && x.text) finalText = x.text;
      if (x.type === 'tool_use') {
        const inp = x.input || {};
        if (CONTINUES.has(x.name) || inp.run_in_background === true || /\bcli\.js\s+(go|resume|factory)\b|--detach\b/.test(String(inp.command || ''))) launched = true;
      }
    }
  }
  return { finalText, launched };
}
function promiseWithoutAction(input) {
  if (input.stop_hook_active === true || !input.transcript_path) return null;
  if (Array.isArray(input.background_tasks) && input.background_tasks.some(t => t && !/^(completed|done|failed|killed|stopped)$/i.test(String(t.status || '')))) return null;
  const t = lastTurn(input.transcript_path);
  if (!t || t.launched) return null;
  const tail = String(t.finalText || '').trim().slice(-600);
  if (!tail || /[?？]\s*[)\]"'`*_]*\s*$/.test(tail) || !PROMISE.test(tail)) return null;
  return '방금 다음 단계를 "이어서 진행하겠다" 고 했지만, 이번 차례에 이어 갈 것(백그라운드 작업 · 예약 깨우기 · 감시 · 하네스 작업)을 하나도 띄우지 않았습니다 — 차례가 끝나면 아무것도 진행되지 않습니다. 약속한 단계를 지금 시작하거나, 시작하지 않을 거면 그렇다고 말하고 끝내세요.';
}

function main() {
  let input = null;
  try {
    const r = C.readStdinJson();
    if (!r.input) { if (r.error !== 'empty stdin') C.logError('stop', r.error); return; }
    input = r.input;
    const sid = input.session_id;
    if (!sid) return;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const info = C.repoInfo(cwd);
    if (!info || C.harnessOwned(info)) return;            // 가벼운 길의 worktree 는 사람이 모는 세션 — 메인 체크아웃처럼 커밋시킨다
    if (C.detectRuntime(input) !== 'codex') {
      const why = promiseWithoutAction(input);
      if (why) { process.stdout.write(JSON.stringify({ decision: 'block', reason: why }) + '\n'); return; }
    }
    const sess = C.loadSession(info.common, sid);
    if (!sess || !sess.files || !sess.files.length) return;
    const runtime = C.detectRuntime(input);
    // [2026-09-30 실측 · 이 저장소에서 v5 를 쓰다가] 백그라운드 서브에이전트가 아직 파일을 고치는 중인데 Stop 이 발화해
    //   "그 파일들을 커밋하라" 고 막았다 — 그대로 커밋하면 반쯤 된 작업이 들어가고, 한 번 더 멈추면 훅이 대신 커밋한다.
    //   백그라운드 작업이 남아 있으면 막지도 커밋하지도 않는다(그 작업이 끝난 뒤의 Stop 이 처리한다).
    if (Array.isArray(input.background_tasks) && input.background_tasks.some(t => !t || !/^(completed|done|failed|killed|stopped)$/i.test(String(t.status || '')))) return;
    const { mine, secrets } = C.uncommittedOf(info.root, sess.files);
    const now = new Date().toISOString();

    if (runtime === 'codex') {
      if (!mine.length) {
        if (secrets.length) C.updateSession(info.common, sid, runtime, s => { s.secrets_left = secrets; return s; });
        return;
      }
      const msg = `wip(codex ${C.sid8(sid)}): ${filesSummary(mine)}`;
      const res = C.commitFiles(info.root, mine, msg);
      C.updateSession(info.common, sid, runtime, s => {
        if (res.ok) { s.last_commit = { sha: res.sha, files: mine, at: now, by: 'stop' }; delete s.commit_error; }
        else s.commit_error = { error: res.error, files: mine, at: now };
        if (secrets.length) s.secrets_left = secrets; else delete s.secrets_left;
        return s;
      });
      if (!res.ok) C.logError('stop', new Error(res.error), cwd);
      return;
    }

    // Claude
    if (!mine.length) {
      if (sess.stop_blocks) C.updateSession(info.common, sid, runtime, s => { s.stop_blocks = 0; return s; });
      return;
    }
    const prior = input.stop_hook_active === true ? (Number(sess.stop_blocks) || 0) : 0;
    if (prior >= MAX_BLOCKS) {
      const res = C.commitFiles(info.root, mine, `wip(session ${C.sid8(sid)}): ${filesSummary(mine)}`);
      C.updateSession(info.common, sid, runtime, s => {
        s.stop_blocks = 0;
        if (res.ok) { s.last_commit = { sha: res.sha, files: mine, at: now, by: 'stop-fallback' }; delete s.commit_error; }
        else { s.stop_gave_up = { at: now, files: mine }; s.commit_error = { error: res.error, files: mine, at: now }; }
        return s;
      });
      if (!res.ok) C.logError('stop', new Error(res.error), cwd);
      return;
    }
    C.updateSession(info.common, sid, runtime, s => { s.stop_blocks = prior + 1; return s; });
    process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(mine, secrets) }) + '\n');
  } catch (e) {
    C.logError('stop', e, input && input.cwd);
  }
}

if (require.main === module) { main(); process.exitCode = 0; }
module.exports = { firstLine, blockReason, filesSummary, promiseWithoutAction, lastTurn };

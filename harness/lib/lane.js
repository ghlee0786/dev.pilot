'use strict';
// light 칸 — 작업자 · 루프 없이 worktree + 브랜치 harness/<id> 만 연다. 사람이 그 폴더에서 Claude Code · VS Code 를 열어 일하고, 끝나면 accept(또는 batch).
//   [2026-10-25 증거 검토 · C++ 저장소] 카드마다 전체 검사 + 검사 잠금 폴링 + "되돌리고 처음부터 다시" 로 작업 64개 · $313 에 병합 2건 —
//   끝난 브랜치를 묶어 검사를 한 번 돌리자 1,187/0 · 32분. 남길 것만 남긴다: worktree 격리 · guard · 자기 파일 커밋 · accept(나빠지면 거부) · 정리.
//   작업 기록: mode 'light' · status 'open' · owner null · checks.deferred(accept 가 한 번 돈다). 같은 요청을 막지 않는다 —
//   "같은 요청 10번" 은 운영자의 의도된 재시작이었고 낭비는 처음부터 다시 만든 것이다. 그래서 --from <id> 로 이어 가기를 알린다.
//   [2026-10-29 사용자 요구] v6 무인 작업(thin · full)을 --from 으로 이으면 그 worktree 를 그대로 레인으로 받는다(같은 id · 브랜치 · 폴더) —
//   작업자의 대화(claude --resume <세션>)를 잃지 않게. 새 worktree 를 만들면 대화 기록(폴더 경로로 묶인다)과 미커밋 작업이 떨어진다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const S = require('./state'), G = require('./git'), K = require('./checks');

const usage = msg => Object.assign(new Error(msg), { code: 'USAGE' });
const strip = b => String(b).replace(/^refs\/heads\//, '');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const FINAL = new Set(['accepted', 'cancelled']);

// ── 작업자의 대화 찾기(읽기만) ───────────────────────────────────────────────
//   Claude Code 는 대화 기록을 <~/.claude 또는 CLAUDE_CONFIG_DIR>/projects/<작업 폴더 경로의 [A-Za-z0-9] 아닌 글자를 '-' 로>/<세션 id>.jsonl 에 둔다
//   (예: C:\repo\.harness-worktrees\t-… → C--repo--harness-worktrees-t-…). 실제 폴더로 맞춰 봤다(2026-10-29).
const mangle = p => String(p).replace(/[^A-Za-z0-9]/g, '-');
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;   // 셸 명령에 그대로 싣는다 — 이 꼴만
function claudeProjectsDir() { return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'); }
// 대화 기록 { id, dir } — dirs 중 sid 의 기록이 있는 폴더(sid 가 없으면 가장 최근 기록) · 없으면 null
let projCache = null;   // status 가 작업마다 부른다 — 폴더 목록은 몇 초 동안 한 번만 읽는다
function findTranscript(dirs, sid) {
  const dir = claudeProjectsDir();
  const wants = dirs.map(d => new Set([d, (() => { try { return fs.realpathSync.native(d); } catch { return d; } })()].map(p => mangle(path.resolve(p)).toLowerCase())));
  const read = () => { let n = []; try { n = fs.readdirSync(dir); } catch { n = []; } projCache = { dir, at: Date.now(), names: n }; return n; };
  const cached = projCache && projCache.dir === dir && Date.now() - projCache.at < 5000;
  let names = cached ? projCache.names : read();
  // 캐시를 채운 뒤 생긴 기록 폴더(방금 연 세션)는 목록에 없다 — 찾는 폴더가 하나도 없으면 한 번 다시 읽는다
  if (cached && !names.some(x => wants.some(w => w.has(x.toLowerCase())))) names = read();
  if (!names.length) return null;
  let best = null;
  for (const [i, d] of dirs.entries()) {
    const want = wants[i];
    for (const n of names.filter(x => want.has(x.toLowerCase()))) {
      let files = []; try { files = fs.readdirSync(path.join(dir, n)); } catch { continue; }
      for (const f of files) {
        const id = f.slice(0, -6);
        if (!f.endsWith('.jsonl') || !SID_RE.test(id) || (sid && id !== sid)) continue;
        let m = 0; try { m = fs.statSync(path.join(dir, n, f)).mtimeMs; } catch { continue; }
        if (!best || m > best.m) best = { id, dir: d, m };
      }
    }
  }
  return best ? { id: best.id, dir: best.dir } : null;
}
// 그 폴더에서 가장 최근의 대화 id — 없으면 null
function transcriptSession(wt) { const f = findTranscript([wt]); return f ? f.id : null; }
// 작업자의 대화를 그대로 이어 가는 명령 → { runtime, session_id, source, command, transcript_dir? } (모르면 command null)
//   [2026-10-29 설치 전 점검] 작업 폴더가 옆 경로(worktree_alt)로 옮겨졌으면 대화 기록은 원래 자리(task.worktree)에 묶여 있다 —
//   기록이 있는 폴더에서 이어 가야 claude --resume 이 찾는다(transcript_dir 로 알린다).
function resumeInfo(task, wt) {
  const runtime = task.runtime === 'codex' ? 'codex' : 'claude';
  const known = SID_RE.test(String(task.session_id || '')) ? task.session_id : null;
  const found = runtime === 'claude' ? findTranscript([...new Set([wt, task.worktree].filter(Boolean))], known) : null;
  const sid = known || (found && found.id);
  const at = found ? found.dir : wt;
  const command = sid ? `cd "${at}" ; ${runtime === 'codex' ? `codex resume ${sid}` : `claude --resume ${sid}`}` : null;
  return { runtime, session_id: sid, source: known ? 'task' : sid ? 'transcript' : null, command, ...(at !== wt ? { transcript_dir: at } : {}) };
}
// 대화 기록이 원래 자리에 묶여 있을 때 붙이는 한 줄
function movedNote(resume, wt, ko) {
  if (!resume || !resume.transcript_dir) return null;
  return ko ? `(대화 기록은 원래 자리에 묶여 있다 — 작업 파일은 ${wt} 로 옮겨졌다. 이어 간 대화에 그 폴더에서 일하라고 알려 준다)`
    : `(the conversation is tied to the original folder — the work files moved to ${wt}; tell the resumed conversation to work there)`;
}

// ── 하네스가 추적되지 않는 저장소 ────────────────────────────────────────────
//   [2026-10-29 감사] harness/ · .claude/ 를 추적하지 않는(무시하는) 저장소에서는 레인 폴더에 훅 · guard · CLI · 스킬이 없었다 —
//   그 폴더에서 연 세션은 guard 없이 push · reset --hard 가 통과했다. 레인에 없고 무시되는 것만 메인에서 복사하고 복사 기록에 남긴다
//   (accept · gc 가 "git 밖 변경" 으로 보고 worktree 를 남기지 않게). 무시되지 않는 것은 복사하지 않는다(남은 변경으로 커밋된다).
const HARNESS_PATHS = ['harness', '.claude/settings.json', '.claude/skills/harness', '.codex/hooks.json', '.agents/skills/harness'];
function filesUnder(abs, rel, acc) {
  let st; try { st = fs.statSync(abs); } catch { return acc; }
  if (st.isFile()) { acc.push(rel); return acc; }
  if (!st.isDirectory()) return acc;
  for (const n of fs.readdirSync(abs)) if (n !== 'node_modules' && n !== '.git') filesUnder(path.join(abs, n), `${rel}/${n}`, acc);
  return acc;
}
function copyHarness(root, wt) {
  const copied = [], skipped = [];
  for (const rel of HARNESS_PATHS) {
    const src = path.join(root, ...rel.split('/')), dst = path.join(wt, ...rel.split('/'));
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    const files = filesUnder(src, rel, []);
    if (!files.length) continue;
    if (!G.git(wt, ['check-ignore', '-q', '--', files[0]], { allowFail: true }).ok) { skipped.push(rel); continue; }
    for (const f of files) {
      try {
        const to = path.join(wt, ...f.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(root, ...f.split('/')), to);
        copied.push({ path: f, sha1: G.sha1(to) });
      } catch { /* 복사 실패는 레인을 막지 않는다 — 보고에 남는다 */ }
    }
  }
  return { copied, skipped };
}

// start — o = { root, goal, base, from, checks, checkTimeoutMs, log } → 결과(id · status 'open' · branch · worktree · base_branch · base_commit · ports · related · report)
function start(o) {
  const goal = String(o.goal || '').replace(/^﻿/, '').trim();
  if (!goal) throw usage('start needs a goal');
  const here = S.repoRoot(o.root || process.cwd());
  const root = S.mainRoot(here);
  // 시작점: --from <id> 면 그 작업의 브랜치 끝(커밋을 이어 받는다) · 아니면 기준 브랜치(기본: 메인 체크아웃이 연 브랜치)의 끝
  let from = null, baseRef, baseBranch, baseCommit;
  if (o.from != null) {
    if (!S.validId(o.from)) throw usage(`--from needs a task id (t-yyyymmdd-HHMMss-xxxx), got ${JSON.stringify(String(o.from)).slice(0, 80)}`);
    from = S.readTask(root, o.from);
    if (!from) throw Object.assign(new Error(`unknown task: ${o.from}`), { code: 'UNKNOWN_TASK' });
    if (from.status === 'accepted') throw usage(`task ${from.id} is already accepted into ${from.accepted_into} — its work is there; start without --from`);
    // [2026-10-29 감사] 병합 뒤 취소(revert)된 작업의 커밋은 이미 대상 브랜치의 조상이다 — 그 브랜치에서 이으면 accept 때 revert 가 함께 들어와 지운다.
    if (from.status === 'cancelled' && (from.cancelled_from === 'accepted' || from.revert_commit)) {
      throw usage(`task ${from.id} was merged into ${from.accepted_into || 'its target'} and then reverted (cancel after merge) — its commits are already in that history, so a lane from its branch would lose them at accept. Bring the work back with: node harness/cli.js restore ${from.id} (re-applies the merge), then start a new lane`);
    }
    if (from.status === 'running' && S.ownerAlive(from.owner)) throw usage(`task ${from.id} is still running (pid ${from.owner.pid}) — wait for it or stop that session first`);
    // v6 무인 작업이 남긴 worktree 가 있으면 그대로 레인으로 받는다(새 worktree 를 만들지 않는다)
    if (from.mode !== 'light' && !FINAL.has(from.status)) {
      const P0 = S.taskPathsFor(root, from);
      if (fs.existsSync(P0.wt) && G.isWorktreeRoot(P0.wt, from.branch)) return adopt(root, here, from, P0, goal, o);
    }
    const tag = `harness/cancelled/${from.id}`;   // 병합 전에 취소된 작업은 브랜치 대신 태그에 남아 있다
    baseRef = G.branchExists(root, from.branch) ? from.branch : G.tagExists(root, tag) ? tag : null;
    if (!baseRef) throw usage(`task ${from.id} has no branch ${from.branch} (and no tag ${tag}) to continue from`);
    baseBranch = o.base ? strip(o.base) : require('./integrate').acceptTarget(from, {}, root) || null;
    baseCommit = (from.base_commit && G.headSha(root, from.base_commit)) || (baseBranch && G.mergeBase(root, baseBranch, baseRef)) || G.headSha(root, baseRef);
  } else {
    const b = o.base ? strip(o.base) : G.currentBranch(root);
    if (!b) throw usage(`the main checkout ${root} is on a detached HEAD — pass --base <branch>`);
    baseCommit = G.headSha(root, b);
    if (!baseCommit) throw usage(`unknown base: ${b}`);
    baseRef = baseCommit;
    baseBranch = G.branchExists(root, b) ? b : null;   // 커밋 · 태그에서 시작했으면 accept 에 --into 가 필요하다
  }
  const yamlLang = K.yamlString(here, 'reply_language') || K.yamlString(root, 'reply_language');
  const id = S.newId(), P = S.taskPaths(root, id);
  const lock = S.acquire(root, `task-${id}`);
  const task = S.newTask({ id, goal, mode: 'light', status: 'open', reason: 'light lane — work in the worktree yourself; the checks run once at accept', owner: null,
    runtime: 'claude', model: null, base_branch: baseBranch, base_commit: baseCommit, branch: P.branch, worktree: P.wt,
    caps: { budget_usd: null, token_budget: null, wall_min: null, max_continuations: 0 }, language: yamlLang || (/[가-힣]/.test(goal) ? 'Korean' : null) });
  if (from) { task.continues = from.id; task.from_commit = G.headSha(root, baseRef); }
  // 작업 장부 — 같은 · 비슷한 작업을 보여 준다(막지 않는다)
  let related = [];
  try { related = require('./worklog').related(root, task); } catch { related = []; }
  task.related = related;
  let harnessCopy = { copied: [], skipped: [] };
  try {
    S.writeTask(root, task);
    S.log(root, id, { event: 'created', mode: 'light', goal, base_branch: baseBranch, base_commit: baseCommit, continues: task.continues, related: related.length ? related : undefined });
    G.addWorktree(root, P.wt, { branch: P.branch, base: baseRef });
    // go 와 같은 준비: .worktreeinclude 의 무시된 파일 · 서브모듈 사본 · 형제 폴더 링크(G.copyWorktreeInclude). 줄바꿈은 accept 의 남은 변경 커밋에서 되돌린다.
    task.worktree_include = G.copyWorktreeInclude(root, P.wt);
    harnessCopy = copyHarness(root, P.wt);
    if (harnessCopy.copied.length) task.worktree_include = [...task.worktree_include, ...harnessCopy.copied];
    setChecks(task, P.wt, here, o);
    S.writeTask(root, task);
    givePorts(root, task);
  } catch (e) {
    task.status = 'error'; task.reason = `could not open the light lane: ${String(e.message).slice(0, 300)}`;
    try { S.writeTask(root, task); S.log(root, id, { event: 'end', status: 'error', reason: task.reason }); } catch { /* 기록 실패는 원래 오류를 덮지 않는다 */ }
    lock.release();
    throw e;
  }
  lock.release();
  // 이어 받은 작업에 표시만 한다(상태는 그대로)
  if (from) {
    const old = S.readTask(root, from.id);
    if (old) { old.continued_by = id; S.writeTask(root, old); S.log(root, old.id, { event: 'continued_by', id }); }
  }
  const res = { id, status: 'open', reason: task.reason, branch: task.branch, worktree: P.wt, base_branch: baseBranch, base_commit: baseCommit,
    ports: task.ports || null, related: related.map(r => ({ ...r, branch: (S.readTask(root, r.id) || {}).branch || null })), continues: task.continues || null, checks: { source: task.checks.source, verdict: 'deferred' } };
  res.report = report(root, task, related, harnessCopy);
  return res;
}

// 검사 기록 — accept 때 한 번 돈다(deferred)
function setChecks(task, wt, here, o) {
  const found = K.discover(wt, o.checks, here);
  let timeoutMs = o.checkTimeoutMs;
  if (timeoutMs == null) { const m = K.yamlNumber(here, 'check_timeout_min') || K.yamlNumber(wt, 'check_timeout_min'); if (m) timeoutMs = m * 60000; }
  task.checks = { source: found.source, from: found.from || null, commands: found.commands, defs: K.definitions(wt), baseline: null, last: null, timeout_ms: timeoutMs || K.CHECK_TIMEOUT_MS, deferred: true, baseline_mode: 'lazy' };
  if (/^(off|false|no)$/i.test(K.yamlString(here, 'rerun_failed') || K.yamlString(wt, 'rerun_failed') || '')) task.checks.rerun = false;
  if (/^(on|true|yes)$/i.test(K.yamlString(here, 'serial_checks') || K.yamlString(wt, 'serial_checks') || '')) task.checks.serial = true;
  const lintCmd = K.yamlString(here, 'lint_command') || K.yamlString(wt, 'lint_command');
  if (lintCmd) task.checks.lint = { command: lintCmd, files: /{files}/.test(lintCmd), baseline_ok: null, last: null };
}
// 포트 구역(resources.portBlock) — 칸마다 겹치지 않는 포트. 없는 판이면 건너뛴다.
function givePorts(root, task) {
  const Rs = require('./resources');
  if (typeof Rs.portBlock !== 'function') return;
  try { task.ports = Rs.portBlock(root, task.id); delete task.ports_error; } catch (e) { task.ports_error = String(e.message).slice(0, 200); }
  S.writeTask(root, task);
}

// v6 작업을 그 자리에서 레인으로 받는다 — 같은 id · 브랜치 · worktree · 기록(log). mode 'light' · status 'open'.
function adopt(root, here, from, P, goal, o) {
  let lock;
  try { lock = S.acquire(root, `task-${from.id}`); }
  catch (e) { if (e.code === 'LOCK_HELD') throw usage(`task ${from.id} is being integrated by another process (pid ${e.owner && e.owner.pid}) — try again when it ends`); throw e; }
  let task;
  try {
    task = S.readTask(root, from.id);
    const was = { status: task.status, mode: task.mode || null };
    Object.assign(task, { mode: 'light', status: 'open', owner: null, adopted_from_status: was.status, adopted_from_mode: was.mode, adopted_at: S.nowIso(),
      reason: `v6 task adopted as a light lane (was ${was.status}) — work in its worktree; the checks run once at accept` });
    task.worktree = task.worktree || S.taskPaths(root, task.id).wt;
    // 검사: 작업에 기록된 것을 그대로 쓰되 accept 때 한 번 다시 돈다(사람이 이어서 커밋한다) · 없으면 새로 찾는다
    if (task.checks && Array.isArray(task.checks.commands)) task.checks.deferred = true;
    else setChecks(task, P.wt, here, o);
    S.writeTask(root, task);
    S.log(root, task.id, { event: 'adopted', from_status: was.status, from_mode: was.mode, goal });
    givePorts(root, task);
  } finally { lock.release(); }
  const resume = resumeInfo(task, P.wt);
  const res = { id: task.id, status: 'open', adopted: true, reason: task.reason, branch: task.branch, worktree: P.wt, base_branch: task.base_branch || null, base_commit: task.base_commit || null,
    ports: task.ports || null, related: [], continues: null, resume, checks: { source: task.checks.source, verdict: 'deferred' } };
  res.report = adoptReport(task, P.wt, resume);
  return res;
}
function adoptReport(task, wt, resume) {
  const cli = 'node harness/cli.js';
  const L = [`pilot ${task.id} — v6 작업을 그 자리에서 레인으로 받았다(light · 이전 상태 ${task.adopted_from_status}${task.adopted_from_mode ? ` · ${task.adopted_from_mode}` : ''})`,
    `작업 폴더: ${wt} (그대로 — 미커밋 작업도 그대로다)`, `브랜치: ${task.branch} — 사용자 브랜치는 그대로다.`];
  if (task.ports) L.push(`포트: ${task.ports.base}–${task.ports.base + task.ports.count - 1} (이 칸 전용 · HARNESS_PORT_BASE=${task.ports.base} HARNESS_PORT_COUNT=${task.ports.count})`);
  L.push('작업자의 대화를 그대로 이어 가려면:',
    resume.command ? `  ${resume.command}` : `  대화 기록을 찾지 못했다 — 그 폴더에서 새 세션을 연다: cd "${wt}" ; claude`,
    ...(movedNote(resume, wt, true) ? [`  ${movedNote(resume, wt, true)}`] : []),
    `끝나면(사용자가 말한 뒤) ${cli} accept ${task.id} — 검사를 한 번 돌려 나빠지지 않았을 때만 병합한다.`, `버리기: ${cli} cancel ${task.id}`);
  return L.join('\n');
}

// 한국어 안내 — 어디서 · 어떻게 일하고 · 끝나면 무엇을 하는지
function report(root, task, related, harnessCopy) {
  const cli = 'node harness/cli.js', ch = task.checks, wt = task.worktree;
  const L = [`pilot ${task.id} — 작업 칸을 열었다(light · 작업자 없음)`,
    `작업 폴더: ${wt}`,
    `브랜치: ${task.branch} (${task.base_branch || 'detached HEAD'} @ ${String(task.base_commit || '').slice(0, 10)} 에서${task.continues ? ` · ${task.continues} 의 커밋을 이어서 — ${String(task.from_commit || '').slice(0, 10)}` : ''}) — 사용자 브랜치는 그대로다.`];
  if (task.ports) L.push(`포트: ${task.ports.base}–${task.ports.base + task.ports.count - 1} (이 칸 전용 · HARNESS_PORT_BASE=${task.ports.base} HARNESS_PORT_COUNT=${task.ports.count})`);
  L.push(ch.commands.length ? `검사: ${ch.commands.map(K.display).join(' ; ')} — accept 때 한 번 돈다(미리 보기: ${cli} check ${task.id})` : '검사: 찾지 못했다 — accept 는 검사 없이 병합한다(결과는 직접 확인하세요)');
  if (harnessCopy && harnessCopy.copied.length) L.push(`하네스: 이 저장소는 harness/ · .claude/ 를 추적하지 않는다 — 레인 폴더에 메인의 사본(훅 · guard · CLI · 스킬, ${harnessCopy.copied.length}개 파일)을 넣었다.`);
  if (harnessCopy && harnessCopy.skipped.length) L.push(`주의: ${harnessCopy.skipped.join(', ')} 가 레인 폴더에 없다(추적되지도 무시되지도 않아 복사하지 않았다 — 복사하면 커밋된다). 그 폴더의 세션에는 하네스 훅이 없을 수 있다 — CLI 는 메인에서: node "${path.join(root, 'harness', 'cli.js')}" accept ${task.id}`);
  const same = related.filter(r => r.kind === 'same');
  if (related.length) {
    L.push('이 저장소의 같은 · 비슷한 작업(막지 않는다 — 처음부터 다시 만들지 말고 이어 가세요):');
    for (const r of related) {
      const t = S.readTask(root, r.id) || {};
      L.push(`  - ${r.id} (${r.status}${r.kind === 'same' ? ' · 같은 요청' : ` · ${Math.round(r.score * 100)}% 비슷`}) ${t.branch || ''} — ${clip(t.goal, 100)}`);
    }
    for (const r of same.filter(x => x.status !== 'accepted')) L.push(`  이어 가려면: ${cli} start --from ${r.id} "<목표>"   (그 브랜치의 커밋에서 시작한다)`);
  }
  L.push('일하는 법:',
    `  1. 그 폴더에서 새 Claude Code 세션을 연다: cd "${wt}" ; claude   (또는 VS Code 창: code "${wt}") — 지금 Claude Code 세션을 대화 그대로 옮기려면 EnterWorktree 에 이 경로를 준다`,
    '  2. 하면서 커밋한다(자기 파일만) — 이 칸의 브랜치에만 쌓이고 사용자 브랜치는 accept 전까지 그대로다.',
    `  3. 끝나면(사용자가 말한 뒤) ${cli} accept ${task.id} — 검사를 한 번 돌려 나빠지지 않았을 때만 병합한다. 여러 칸은 ${cli} batch <id> <id>… 로 묶어 검사를 한 번.`,
    `버리기: ${cli} cancel ${task.id}`);
  return L.join('\n');
}

module.exports = { start, resumeInfo, transcriptSession, movedNote, mangle };

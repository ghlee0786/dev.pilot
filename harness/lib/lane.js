'use strict';
// light 칸 — 작업자 · 루프 없이 worktree + 브랜치 harness/<id> 만 연다. 사람이 그 폴더에서 Claude Code · VS Code 를 열어 일하고, 끝나면 accept(또는 batch).
//   [2026-10-25 증거 검토 · C++ 저장소] 카드마다 전체 검사 + 검사 잠금 폴링 + "되돌리고 처음부터 다시" 로 작업 64개 · $313 에 병합 2건 —
//   끝난 브랜치를 묶어 검사를 한 번 돌리자 1,187/0 · 32분. 남길 것만 남긴다: worktree 격리 · guard · 자기 파일 커밋 · accept(나빠지면 거부) · 정리.
//   작업 기록: mode 'light' · status 'open' · owner null · checks.deferred(accept 가 한 번 돈다). 같은 요청을 막지 않는다 —
//   "같은 요청 10번" 은 운영자의 의도된 재시작이었고 낭비는 처음부터 다시 만든 것이다. 그래서 --from <id> 로 이어 가기를 알린다.
const S = require('./state'), G = require('./git'), K = require('./checks');

const usage = msg => Object.assign(new Error(msg), { code: 'USAGE' });
const strip = b => String(b).replace(/^refs\/heads\//, '');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// start — o = { root, goal, base, from, checks, owns, checkTimeoutMs, log } → 결과(id · status 'open' · branch · worktree · base_branch · base_commit · ports · related · report)
function start(o) {
  const goal = String(o.goal || '').replace(/^﻿/, '').trim();
  if (!goal) throw usage('start needs a goal');
  const here = S.repoRoot(o.root || process.cwd());
  const root = S.mainRoot(here);
  // 쓰기 소유 경로 — go 와 같은 규칙(worktree 기준 상대 glob 만)
  const owns = (o.owns || []).map(g => String(g).trim().replace(/\\/g, '/')).filter(Boolean);
  for (const g of owns) if (/^([a-zA-Z]:|\/)|(^|\/)\.\.(\/|$)/.test(g)) throw usage(`--owns must be a path inside the repository (relative, no ..): ${g}`);
  // 시작점: --from <id> 면 그 작업의 브랜치 끝(커밋을 이어 받는다) · 아니면 기준 브랜치(기본: 메인 체크아웃이 연 브랜치)의 끝
  let from = null, baseRef, baseBranch, baseCommit;
  if (o.from != null) {
    if (!S.validId(o.from)) throw usage(`--from needs a task id (t-yyyymmdd-HHMMss-xxxx), got ${JSON.stringify(String(o.from)).slice(0, 80)}`);
    from = S.readTask(root, o.from);
    if (!from) throw Object.assign(new Error(`unknown task: ${o.from}`), { code: 'UNKNOWN_TASK' });
    if (from.status === 'accepted') throw usage(`task ${from.id} is already accepted into ${from.accepted_into} — its work is there; start without --from`);
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
  if (owns.length) task.owns = owns;
  if (from) { task.continues = from.id; task.from_commit = G.headSha(root, baseRef); }
  // 작업 장부 — 같은 · 비슷한 작업을 보여 준다(막지 않는다)
  let related = [];
  try { related = require('./worklog').related(root, task); } catch { related = []; }
  task.related = related;
  try {
    S.writeTask(root, task);
    S.log(root, id, { event: 'created', mode: 'light', goal, base_branch: baseBranch, base_commit: baseCommit, continues: task.continues, related: related.length ? related : undefined });
    G.addWorktree(root, P.wt, { branch: P.branch, base: baseRef });
    // go 와 같은 준비: .worktreeinclude 의 무시된 파일 · 서브모듈 사본 · 형제 폴더 링크(G.copyWorktreeInclude). 줄바꿈은 accept 의 남은 변경 커밋에서 되돌린다.
    task.worktree_include = G.copyWorktreeInclude(root, P.wt);
    const found = K.discover(P.wt, o.checks, here);
    let timeoutMs = o.checkTimeoutMs;
    if (timeoutMs == null) { const m = K.yamlNumber(here, 'check_timeout_min') || K.yamlNumber(P.wt, 'check_timeout_min'); if (m) timeoutMs = m * 60000; }
    task.checks = { source: found.source, from: found.from || null, commands: found.commands, defs: K.definitions(P.wt), baseline: null, last: null, timeout_ms: timeoutMs || K.CHECK_TIMEOUT_MS, deferred: true, baseline_mode: 'lazy' };
    if (/^(off|false|no)$/i.test(K.yamlString(here, 'rerun_failed') || K.yamlString(P.wt, 'rerun_failed') || '')) task.checks.rerun = false;
    if (/^(on|true|yes)$/i.test(K.yamlString(here, 'serial_checks') || K.yamlString(P.wt, 'serial_checks') || '')) task.checks.serial = true;
    const lintCmd = K.yamlString(here, 'lint_command') || K.yamlString(P.wt, 'lint_command');
    if (lintCmd) task.checks.lint = { command: lintCmd, files: /{files}/.test(lintCmd), baseline_ok: null, last: null };
    S.writeTask(root, task);
    // 포트 구역(resources.portBlock) — 칸마다 겹치지 않는 포트. 없는 판이면 건너뛴다.
    const Rs = require('./resources');
    if (typeof Rs.portBlock === 'function') {
      try { task.ports = Rs.portBlock(root, id); } catch (e) { task.ports_error = String(e.message).slice(0, 200); }
      S.writeTask(root, task);
    }
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
  res.report = report(root, task, related);
  return res;
}

// 한국어 안내 — 어디서 · 어떻게 일하고 · 끝나면 무엇을 하는지
function report(root, task, related) {
  const cli = 'node harness/cli.js', ch = task.checks, wt = task.worktree;
  const L = [`pilot ${task.id} — 작업 칸을 열었다(light · 작업자 없음)`,
    `작업 폴더: ${wt}`,
    `브랜치: ${task.branch} (${task.base_branch || 'detached HEAD'} @ ${String(task.base_commit || '').slice(0, 10)} 에서${task.continues ? ` · ${task.continues} 의 커밋을 이어서 — ${String(task.from_commit || '').slice(0, 10)}` : ''}) — 사용자 브랜치는 그대로다.`];
  if (task.ports) L.push(`포트: ${task.ports.base}–${task.ports.base + task.ports.count - 1} (이 칸 전용 · HARNESS_PORT_BASE=${task.ports.base} HARNESS_PORT_COUNT=${task.ports.count})`);
  L.push(ch.commands.length ? `검사: ${ch.commands.map(K.display).join(' ; ')} — accept 때 한 번 돈다(미리 보기: ${cli} check ${task.id})` : '검사: 찾지 못했다 — accept 는 검사 없이 병합한다(결과는 직접 확인하세요)');
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
    `  1. 그 폴더에서 새 Claude Code 세션을 연다: cd "${wt}" ; claude   (또는 VS Code 창: code "${wt}")`,
    '  2. 하면서 커밋한다(자기 파일만) — 이 칸의 브랜치에만 쌓이고 사용자 브랜치는 accept 전까지 그대로다.',
    `  3. 끝나면(사용자가 말한 뒤) ${cli} accept ${task.id} — 검사를 한 번 돌려 나빠지지 않았을 때만 병합한다. 여러 칸은 ${cli} batch <id> <id>… 로 묶어 검사를 한 번.`,
    `버리기: ${cli} cancel ${task.id}`);
  return L.join('\n');
}

module.exports = { start };

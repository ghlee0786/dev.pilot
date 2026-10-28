'use strict';
// v5 통합 — accept / cancel / restore. 사용자가 받아들인다고 말한 뒤에만 부른다. 전부 `merge` 잠금 아래 직렬로.
//   accept : .harness/<id>/ 를 기록 보관소로 옮겨 결과 브랜치에서 걷어 냄 → 대상 브랜치를 결과 브랜치로 가져와 최신화
//            (충돌이면 같은 세션에 최대 2회 "충돌을 풀어라") → 검사 재실행 → 메인 체크아웃이 대상 브랜치이고
//            결과 브랜치가 건드린 파일에 미커밋 변경이 없을 때만 `merge --no-ff` + 태그 harness/merged/<id>.
//   cancel : 병합 전 — 미커밋분을 커밋한 뒤 worktree 제거, 브랜치 끝을 태그 harness/cancelled/<id> 로 남기고 브랜치 삭제.
//            병합 후 — 임시 worktree 에서 `revert -m 1 <merge>` 를 만들고 검사 통과를 확인한 뒤 대상 브랜치를 그 커밋으로 fast-forward.
//   restore: 취소를 되돌린다(revert 의 revert · 병합 전 취소는 태그에서 브랜치 복원).
//   금지: reset --hard · 강제 push · 다른 세션 미커밋 변경을 stash/덮기.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const S = require('./state'), G = require('./git'), K = require('./checks'), Pr = require('./prompts'), L = require('./loop'), St = require('./status');

const MERGE_WAIT_MS = 10 * 60 * 1000;
const MAX_CONFLICT_ROUNDS = 2;
const DEFAULT_CONFLICT_BUDGET_USD = 5;   // 작업에 비용 상한이 없을 때만
// 검사 상한: 이번 호출의 --check-timeout-min > 작업에 기록된 상한(go 때 check_timeout_min · --check-timeout-min) > 기본.
const checkTimeout = (task, o) => o.checkTimeoutMs || (task.checks && task.checks.timeout_ms) || K.CHECK_TIMEOUT_MS;
const norm = f => { const p = String(f).replace(/\\/g, '/').replace(/^\.\//, ''); return S.IS_WIN ? p.toLowerCase() : p; };

// 진입점 검증: id 는 경로 조각이 된다(tasks/<id>/ · .harness-worktrees/<id>) — 형식이 맞지 않으면 아무것도 읽지 않는다.
function load(o) {
  if (!S.validId(o.id)) throw Object.assign(new Error(`invalid task id: ${JSON.stringify(o.id)} (expected t-yyyymmdd-HHMMss-xxxx)`), { code: 'USAGE' });
  const root = S.mainRoot(o.root || process.cwd());
  const task = S.readTask(root, o.id);
  if (!task) throw Object.assign(new Error(`unknown task: ${o.id}`), { code: 'UNKNOWN_TASK' });
  return { root, task, P: S.taskPathsFor(root, task), log: o.log || (m => process.stderr.write(m + '\n')) };
}
function out(task, extra) {
  const r = { ...L.result(task), ...(extra || {}) };
  r.report = extra && extra.report ? extra.report : `pilot ${task.id} — ${r.status}${r.reason ? ': ' + r.reason : ''}`;
  return r;
}
// 한국어 작업(task.language === 'Korean')이면 보고를 한국어로 — [2026-10-13 사용자 보고] 결과가 영어로 나왔다.
const isKo = task => !!task && task.language === 'Korean';
const REFUSE_KO = [
  [/^task is still running \(pid (\d+)\)(.*)$/s, m => `작업이 아직 실행 중이다(pid ${m[1]}) — 끝나기를 기다리거나 node harness/cli.js stop 으로 멈추세요`],
  [/^task status is (\w+)(.*) — only done tasks are accepted; pass --force to merge it anyway$/s, m => `작업 상태가 ${m[1]}${m[2]} — done 인 작업만 받아들인다. 그래도 병합하려면 --force`],
  [/^already accepted into (\S+) \((\w+)\)$/, m => `이미 ${m[1]} 에 받아들였다(${m[2]})`],
  [/^the task was cancelled; use restore first$/, () => '취소된 작업이다 — 먼저 restore'],
  [/^already cancelled$/, () => '이미 취소했다'],
  [/^uncommitted changes in (\S+) touch files this (?:task changed|task changes|would change): (.*) — commit them first$/s, m => `${m[1]} 의 미커밋 변경이 이 작업의 파일과 겹친다: ${m[2]} — 먼저 커밋하세요`],
  [/^target branch (\S+) is not checked out in any checkout(.*)$/s, m => `대상 브랜치 ${m[1]} 가 어느 체크아웃에도 열려 있지 않다 — 메인 체크아웃에서 열고 다시 하세요`],
  [/^checks fail after bringing (\S+) into (\S+) \((\d+) failing\)(.*)$/s, m => `${m[1]} 를 ${m[2]} 에 들인 뒤 검사가 실패한다(${m[3]}건) — 결과 브랜치에 ${m[1]} 가 들어 있다. resume 하거나 고친 뒤 다시 accept`],
  [/^lint fails on (\S+) \((.*?)\): (.*) — resume or fix it, then accept again( \(this lints the whole repository.*\))?$/s, m => `${m[1]} 에서 린트가 실패한다(${m[2]}): ${m[3]} — resume 하거나 고친 뒤 다시 accept${m[4] ? ' (저장소 전체 린트다 — lint_command 에 {files} 를 쓰면 바꾼 파일만 본다(accept 는 지금 값을 읽는다) · 또는 accept --force)' : ''}`],
  [/^this task is stacked on (\S+) \(task (\S+?)(?:, (\w+))?\) — (.*)$/s, m => `이 작업은 ${m[1]} 위에 쌓은 작업이다(앞 작업 ${m[2]}${m[3] ? ` · ${m[3]}` : ''}) — 앞 작업을 먼저 accept 하면(그러면 이 작업도 같은 브랜치로 따라간다) 되고, 아니면 --into <브랜치>`],
  [/^the previous worktree (\S+) is still being removed(.*)$/s, m => `이전 worktree ${m[1]} 가 아직 지워지는 중이다(다른 프로세스가 파일을 잡고 있다) — 1분쯤 뒤 다시 하세요`],
];
const refuseKo = r => { for (const [re, fn] of REFUSE_KO) { const m = re.exec(String(r)); if (m) return fn(m); } return String(r); };
const refused = (task, reason) => out(task, { refused: true, reason, report: isKo(task) ? `pilot ${task.id} — 바뀐 것 없음: ${refuseKo(reason)}` : `pilot ${task.id} — nothing changed: ${reason}` });

// 메인 체크아웃(대상 브랜치가 체크아웃된 곳)의 미커밋 변경 중 files 와 겹치는 것.
function dirtyOverlap(cwd, files) {
  const want = new Set(files.map(norm));
  const hits = [];
  for (const e of G.dirtyFiles(cwd)) for (const p of [e.path, e.orig]) if (p && want.has(norm(p))) hits.push(p);
  return [...new Set(hits)];
}

// [PRD R1] 작업을 치울 때 git 밖 자원(볼륨 · 이미지 · 임시 폴더 · 프로젝트 정리 명령)을 회수한다 — 실패해도 병합 · 취소는 그대로, 남은 것은 기록한다.
function releaseResources(root, task) {
  try {
    const r = require('./resources').release(root, task);
    if (Object.keys(r.docker.removed).length || r.residue.length || r.cleanup || (r.tmp && r.tmp.removed)) S.log(root, task.id, { event: 'resources_released', docker: r.docker.removed, cleanup: r.cleanup && { ok: r.cleanup.ok, exit_code: r.cleanup.exit_code }, tmp_removed: !!(r.tmp && r.tmp.removed), residue: r.residue });
    return r;
  } catch (e) { task.resources = { ...(task.resources || {}), error: String(e.message).slice(0, 200) }; return null; }
}

function withTaskLock(root, task, fn) {
  let h;
  try { h = S.acquire(root, `task-${task.id}`); }
  catch (e) { if (e.code === 'LOCK_HELD') return refused(task, `task is owned by a live process (pid ${e.owner && e.owner.pid})`); throw e; }
  return Promise.resolve().then(() => fn()).finally(() => h.release());
}
function ownerBusy(task) { return task.status === 'running' && task.owner && !S.isSelf(task.owner) && S.ownerAlive(task.owner); }
// merge 잠금 → task 잠금 → 잠금 아래에서 task 를 **다시 읽고** 선행 조건을 다시 본다.
//   잠금 전에 읽은 task 는 낡았을 수 있다(동시에 accept 두 번: 두 번째가 이미 병합된 작업을 다시 병합) — 판정은 잠금 아래의 기록으로만.
function locked(root, staleTask, pre, fn) {
  return S.withLock(root, 'merge', () => withTaskLock(root, staleTask, async () => {
    const task = S.readTask(root, staleTask.id);
    if (!task) return refused(staleTask, 'the task record disappeared while waiting for the lock');
    const why = pre(task);
    if (why) return refused(task, why);
    return fn(task);
  }), { waitMs: MERGE_WAIT_MS });
}

// 작업의 worktree 를 쓸 수 있게 한다 → 못 하면 거부 이유(문자열). 지워지는 중인 예전 폴더는 G.clearWorktreeSlot 이 기다린다(자동 이슈 #1 · #2).
function ensureWorktree(root, task, P, waitMs, log) {
  if (fs.existsSync(P.wt) && G.worktreeRegistered(root, P.wt) && G.isWorktreeRoot(P.wt, task.branch)) return null;
  const why = G.clearWorktreeSlot(root, P.wt, task.branch, waitMs, G.slotOpts(root, task.id, P.dir, log));
  if (why) {
    if (!G.useAltWorktree(root, task, P, why, log)) return why;
    if (fs.existsSync(P.wt) && G.worktreeRegistered(root, P.wt) && G.isWorktreeRoot(P.wt, task.branch)) return null;
  }
  G.git(root, ['worktree', 'prune'], { allowFail: true });
  G.addWorktree(root, P.wt, { branch: task.branch });
  task.worktree_include = G.copyWorktreeInclude(root, P.wt);
}
function commitInto(task, cwd, label) {
  const sha = G.commitAll(cwd, `harness(${task.id}): ${label}`, { branch: task.branch });
  if (sha) task.commits.push(sha);
  return sha;
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// 결과 브랜치에서 .harness/<id>/ 를 걷어 내 tasks/<id>/archive/ 로.
function archivePlan(root, task, P) {
  if (!fs.existsSync(P.workDir)) return null;
  copyDir(P.workDir, P.archiveDir);
  fs.rmSync(P.workDir, { recursive: true, force: true });
  const parent = path.dirname(P.workDir);
  try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* 다른 것이 남음 */ }
  const sha = commitInto(task, P.wt, `archive .harness/${task.id}`);
  S.log(root, task.id, { event: 'archive', sha, to: P.archiveDir });
  return sha;
}

// 충돌 해결 예산: --budget-usd(o.budgetUsd)를 주면 이번 accept 에서 쓸 수 있는 총액, 아니면 작업 상한에서 남은 만큼.
//   남은 것이 0 이하면 모델을 부르지 않는다(상한은 모델 밖에서 강제한다 — 설계 §0.6).
function conflictBudget(task, o, spentAtStart) {
  if (o.budgetUsd != null) {
    const cap = Number(o.budgetUsd), used = task.spent.cost_usd - spentAtStart;
    return { left: cap - used, why: `the --budget-usd $${cap.toFixed(2)} for conflict resolution is used up ($${used.toFixed(2)} spent)` };
  }
  const cap = task.caps && task.caps.budget_usd;
  if (cap == null || !Number.isFinite(Number(cap))) return { left: DEFAULT_CONFLICT_BUDGET_USD - (task.spent.cost_usd - spentAtStart), why: `the default conflict-resolution budget $${DEFAULT_CONFLICT_BUDGET_USD} is used up` };
  return { left: Number(cap) - task.spent.cost_usd, why: `no budget left for conflict resolution ($${task.spent.cost_usd.toFixed(2)} of the task's $${Number(cap).toFixed(2)} spent)` };
}

async function resolveConflicts(root, task, P, target, o) {
  // 모델은 git 을 쓰지 못하므로 턴 뒤에도 색인은 "미병합" 이다 — 판정은 충돌 표식으로 한다.
  const conflicted = G.unmergedFiles(P.wt);
  let pending = conflicted;
  const spentAtStart = task.spent.cost_usd;
  let run = null;
  for (let round = 1; round <= MAX_CONFLICT_ROUNDS; round++) {
    const b = conflictBudget(task, o, spentAtStart);
    if (!(b.left > 0)) {
      G.git(P.wt, ['merge', '--abort'], { allowFail: true });
      S.log(root, task.id, { event: 'conflict_budget', round, left: b.left });
      return { ok: false, why: `conflicts with ${target} in ${pending.join(', ')} — ${b.why}; nothing was merged (pass --budget-usd <N> to let the session resolve them, or resolve by hand)` };
    }
    const budget = Math.round(b.left * 1e6) / 1e6;
    run = run || L.getRun(o);
    let r;
    try {
      r = await run({ runtime: task.runtime, cwd: P.wt, prompt: Pr.conflictMessage(task, target, pending), sessionId: task.session_id || null,
        newSessionId: task.session_id || task.runtime !== 'claude' ? undefined : crypto.randomUUID(), model: task.model, effort: task.effort,
        budgetUsd: budget, tokenBudget: task.caps.token_budget, timeoutMs: (o.conflictTimeoutMin || 30) * 60000,
        allowCommands: K.allowCommands(P.wt, task.checks), systemAppend: Pr.systemAppend(task), priorSessionCostUsd: task.session_id ? (task.session_cost_usd || 0) : 0 });
    } catch (e) { r = { is_error: true, error_kind: 'crash', error_message: e.message }; }
    r = r || {};
    task.spent.cost_usd = Math.round((task.spent.cost_usd + (Number(r.cost_usd) || 0)) * 1e6) / 1e6;
    if (r.session_cost_usd != null) task.session_cost_usd = Number(r.session_cost_usd) || 0;
    else if (r.session_id) task.session_cost_usd = (r.session_id === task.session_id ? (task.session_cost_usd || 0) : 0) + (Number(r.cost_usd) || 0);
    if (r.session_id) task.session_id = r.session_id;
    S.log(root, task.id, { event: 'conflict_turn', round, files: pending, is_error: !!r.is_error, error_kind: r.error_kind || null });
    pending = conflicted.filter(f => G.hasConflictMarkers(path.join(P.wt, f)));
    if (!pending.length) {
      G.git(P.wt, ['add', '-A'], { retryLock: true });
      G.git(P.wt, [...G.identityArgs(P.wt), 'commit', '-q', '--no-verify', '--no-edit'], { retryLock: true });
      task.commits.push(G.headSha(P.wt));
      return { ok: true, rounds: round };
    }
    if (r.is_error && (r.error_kind === 'quota' || r.error_kind === 'auth')) break;
  }
  G.git(P.wt, ['merge', '--abort'], { allowFail: true });
  return { ok: false, why: `conflicts with ${target} were not resolved after ${MAX_CONFLICT_ROUNDS} attempts (the branch is unchanged; resolve by hand or cancel)` };
}

// ── accept ────────────────────────────────────────────────────────────
// 선행 조건. 잠금 전(빠른 거절)과 잠금 아래(다시 읽은 기록)에서 두 번 본다. 문자열이면 거절 이유.
//   기본은 done 만 받아들인다 — 다른 상태(failed · stalled · blocked · capped · interrupted · error …)는 o.force 일 때만.
//   거절 이유는 작업의 상태와 그 이유로 시작한다(무엇이 잘못됐는지가 먼저 보이게).
//   [2026-10-16 자동 이슈 #15] go --base harness/<앞 작업> 으로 쌓은 작업은 기본 대상이 그 harness 브랜치라 거부됐다 —
//   앞 작업이 받아들여졌으면 그 대상으로 따라간다(여러 겹도). 아직이면 acceptPre 가 무엇을 먼저 할지 알려 준다.
const HARNESS_BRANCH_RE = /^harness\/(t-\d{8}-\d{6}-[0-9a-f]{4})$/;
function acceptTarget(task, o, root) {
  if (o.into) return String(o.into).replace(/^refs\/heads\//, '');
  let t = String(task.base_branch || '').replace(/^refs\/heads\//, '');
  for (let i = 0; i < 10; i++) {
    const m = HARNESS_BRANCH_RE.exec(t), b = m && root ? S.readTask(root, m[1]) : null;
    if (!b || b.status !== 'accepted' || !b.accepted_into) break;
    t = b.accepted_into;
  }
  return t;
}
function acceptPre(root, o) {
  return task => {
    if (task.status === 'accepted') return `already accepted into ${task.accepted_into} (${String(task.merge_commit).slice(0, 10)})`;
    if (task.status === 'cancelled') return 'the task was cancelled; use restore first';
    if (ownerBusy(task)) return `task is still running (pid ${task.owner.pid})`;
    if (task.status !== 'done' && !o.force) return `task status is ${task.status}${task.reason ? ` (${task.reason})` : ''} — only done tasks are accepted; pass --force to merge it anyway`;
    if (!G.branchExists(root, task.branch)) return `branch ${task.branch} does not exist`;
    const target = acceptTarget(task, o, root);
    if (!target) return 'no target branch (the task started on a detached HEAD); pass --into <branch>';
    const stacked = HARNESS_BRANCH_RE.exec(target);
    if (stacked) {
      const b = S.readTask(root, stacked[1]);
      return `this task is stacked on ${target} (task ${stacked[1]}${b ? `, ${b.status}` : ''}) — accept ${stacked[1]} first (this task then follows it into the same branch), or pass --into <branch>`;
    }
    if (!G.branchExists(root, target)) return `target branch ${target} does not exist`;
    return null;
  };
}

async function accept(o) {
  const { root, task: task0, P, log } = load(o);
  const pre = acceptPre(root, o);
  const why0 = pre(task0);
  if (why0) return refused(task0, why0);

  return locked(root, task0, pre, async task => {
    const target = acceptTarget(task, o, root);
    const was = { status: task.status, reason: task.reason };
    const co = G.checkoutOf(root, target);
    if (!co) return refused(task, `target branch ${target} is not checked out in any checkout; check it out in your main checkout and run accept again`);
    if (G.mergeInProgress(co.path)) return refused(task, `a merge is in progress in ${co.path}`);
    const mb = G.mergeBase(root, target, task.branch);
    const touched0 = G.diffNames(root, mb || task.base_commit, task.branch);
    const clash0 = dirtyOverlap(co.path, touched0);
    if (clash0.length) return refused(task, `uncommitted changes in ${co.path} touch files this task changed: ${clash0.join(', ')} — commit them first`);

    // 작업이 끝난 뒤 결과 브랜치가 그대로인가 — 그렇고 대상 브랜치도 들이지 않으면 루프의 린트 통과를 그대로 쓴다(아래).
    const unchangedSinceLoop = !!task.head && G.headSha(root, task.branch) === task.head;
    let broughtTarget = false;

    // 1. .harness/<id>/ 보관 → 삭제 커밋
    const wtWhy = ensureWorktree(root, task, P, o.removalWaitMs, log);
    if (wtWhy) return refused(task, wtWhy);
    commitInto(task, P.wt, 'uncommitted work before accept');
    archivePlan(root, task, P);

    // 2. 대상 브랜치를 가져와 최신화(충돌 → 같은 세션이 푼다 · 예산 안에서만) → 검사
    const checkHere = async (why) => {
      const run1 = async () => {
        const j1 = (await K.runJudged(P.wt, K.commandsForJudge(P.wt, task.checks), { timeoutMs: checkTimeout(task, o), rerun: task.checks.rerun, serialRoot: task.checks.serial ? root : null })).judged;
        // [자동 이슈 #57] 검사가 다시 쓴 outside_git_ok 산출물은 되돌린다 — 아래 거절 커밋이 그것을 작업 브랜치에 넣어 다음 accept 를 막았다
        const restored = G.restoreOutsideOk(P.wt);
        if (restored.length) S.log(root, task.id, { event: 'restored_after_checks', phase: 'accept', files: restored.slice(0, 50) });
        return j1;
      };
      let j = await run1();
      // 늦은 기준선(D2): 실패했는데 기준선이 없으면 지금 작업 시작 시점에서 잰다 — 명령이 바뀌면(멈춘 테스트 · 빠진 검사) 다시 잰다
      if (!j.ok && !task.checks.baseline) { const before = JSON.stringify(task.checks.commands); await L.ensureBaseline(root, task, { o: { checkTimeoutMs: checkTimeout(task, o) }, log }); if (JSON.stringify(task.checks.commands) !== before) j = await run1(); }
      task.checks.last = K.brief(j);
      // [자동 이슈 #29] 저장소 검사가 작업 전부터 시간 초과로 모두 빠졌다 — 아무것도 재지 못했으니 검증 안 된 병합을 막는다(--force 면 이 단계를 거치지 않는다)
      if (!task.checks.commands.length && (task.checks.dropped || []).length) {
        S.log(root, task.id, { event: 'checks', phase: 'accept', why, verdict: 'unverified', dropped: task.checks.dropped.length });
        S.writeTask(root, task);
        return refused(task, `unverified — the repository checks were dropped (${task.checks.dropped.map(d => d.command).join(' ; ').slice(0, 200)}: timed out even before the task), so nothing judged this work; run the tests yourself, then accept again with --force`);
      }
      const v = K.judge(j, task.checks.baseline, { notWorse: task.checks.source !== 'user' });
      S.log(root, task.id, { event: 'checks', phase: 'accept', why, verdict: v.verdict, pass: j.pass, fail: j.fail });
      if (v.verdict !== 'fail') return null;
      commitInto(task, P.wt, 'checks after bringing target up to date');
      S.writeTask(root, task);
      if (why === 'deferred checks (thin)') return refused(task, `checks fail on ${task.branch} and are worse than before the task (${j.fail} failing) — resume or fix it, then accept again (or --force if you accept the failures)`);
      return refused(task, `checks fail after bringing ${target} into ${task.branch} (${j.fail} failing) — the task branch now contains ${target}; resume or fix it, then accept again`);
    };
    let rounds = 0;
    for (let pass = 0; pass < 2 && !G.isAncestor(root, target, task.branch); pass++) {
      broughtTarget = true;
      const m = G.git(P.wt, [...G.identityArgs(P.wt), 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', `harness(${task.id}): bring ${target} up to date`, target], { allowFail: true, retryLock: true });
      if (!m.ok) {
        if (!G.mergeInProgress(P.wt)) { S.writeTask(root, task); return refused(task, `could not bring ${target} into ${task.branch}: ${m.err.trim().slice(0, 300)}`); }
        log(`[pilot] ${task.id} — conflicts with ${target}; asking the session to resolve them`);
        const res = await resolveConflicts(root, task, P, target, o);
        if (!res.ok) { S.writeTask(root, task); return refused(task, res.why); }
        rounds += res.rounds;
      } else task.commits.push(G.headSha(P.wt));
      S.log(root, task.id, { event: 'target_merged', target, rounds });
      // [자동 이슈 #31] --force 는 사용자가 검사 결과를 알고 합치기로 한 것 — 대상을 들인 뒤의 검사도 건너뛴다(기록은 남긴다)
      if (o.force) S.log(root, task.id, { event: 'checks', phase: 'accept', why: 'target brought in', verdict: 'skipped', skipped: 'force' });
      else if (task.checks.commands.length) { const no = await checkHere('target brought in'); if (no) return no; }
    }
    // 대상 브랜치를 새로 들이지 않았어도, 마지막으로 기록된 검사가 실패면 다시 잰다 — [2026-10-20 실측 · 작업 수치에서 발견]
    //   위에서 거절된 작업을 다시 accept 하면 이미 들인 상태라 위 고리를 건너뛰어 검사 없이 병합됐다(실패 0 → 133 인 채로 사용자 브랜치에).
    //   --force(사용자가 실패를 알고 병합)면 다시 재지 않는다.
    if (!broughtTarget && !o.force && task.checks.commands.length && task.checks.last && K.judge(task.checks.last, task.checks.baseline, { notWorse: task.checks.source !== 'user' }).verdict === 'fail') {
      const no = await checkHere('last recorded checks failed'); if (no) return no;
    }
    // thin: 작업이 끝 검사를 미뤘다 — 합치기 전에 여기서 처음 잰다(실패면 기준선과 비교해 나빠졌을 때만 막는다). --force 면 재지 않는다.
    if (!broughtTarget && !o.force && task.checks.commands.length && task.checks.deferred && !task.checks.last) {
      const no = await checkHere('deferred checks (thin)'); if (no) return no;
    }
    // 린트 — 대상 브랜치를 들인 뒤에도 작업이 바꾼 파일에서 다시 본다(루프에서 통과했어도 그 뒤의 커밋 · 대상 브랜치가 깨뜨릴 수 있다).
    //   [2026-10-14 자동 이슈 #3] 새로 만든 worktree 는 빌드 · 복원 산출물이 없어(--no-restore 린트) 루프에서 통과한 린트가 거절됐다.
    const lintSync = K.syncLint(task, [co.path, root, P.wt]);
    if (lintSync) S.log(root, task.id, { event: 'lint_command_changed', phase: 'accept', ...lintSync });
    const lintPassedInLoop = task.checks.lint && task.checks.lint.last && task.checks.lint.last.ok;
    if (task.checks.lint && unchangedSinceLoop && !broughtTarget && lintPassedInLoop) S.log(root, task.id, { event: "lint", phase: "accept", ok: true, reused: "passed in the loop; nothing changed since" });
    // [자동 이슈 #38] --force 는 사용자가 검사 결과를 알고 합치기로 한 것 — 검사(#31)처럼 린트도 건너뛴다(기록은 남긴다)
    else if (task.checks.lint && o.force) S.log(root, task.id, { event: 'lint', phase: 'accept', skipped: 'force' });
    else if (task.checks.lint) {
      const lt = task.checks.lint;
      const changed = G.diffNames(root, target, task.branch).filter(f => !f.startsWith('.harness/') && fs.existsSync(path.join(P.wt, f)));
      const argv = K.lintArgv(lt.command, lt.files ? changed : []);
      if (argv) {
        const lr = await K.runCheck(P.wt, argv, { timeoutMs: checkTimeout(task, o) });
        S.log(root, task.id, { event: 'lint', phase: 'accept', ok: lr.ok, exit_code: lr.exit_code });
        if (!lr.ok && (lt.files || lt.baseline_ok !== false)) { S.writeTask(root, task); return refused(task, `lint fails on ${task.branch} (${lr.command}): ${K.firstAssertion(lr).slice(0, 200)} — resume or fix it, then accept again${lt.files ? '' : ' (this lints the whole repository; put {files} in lint_command to lint only the changed files — accept reads the current value — or accept --force)'}`); }
      }
    }
    if (!G.isAncestor(root, target, task.branch)) { S.writeTask(root, task); return refused(task, `${target} kept moving while integrating; run accept again`); }

    // 3. 메인 체크아웃에서 --no-ff 병합 — 대상 브랜치가 결과 브랜치의 조상이므로 충돌은 있을 수 없다.
    const touched = G.diffNames(root, target, task.branch);
    const clash = dirtyOverlap(co.path, touched);
    if (clash.length) { S.writeTask(root, task); return refused(task, `uncommitted changes in ${co.path} touch files this task changes: ${clash.join(', ')} — commit them first`); }
    if (G.currentBranch(co.path) !== target) { S.writeTask(root, task); return refused(task, `${co.path} is no longer on ${target}`); }
    const before = G.headSha(co.path), branchTip = G.headSha(root, task.branch);
    const title = task.goal.split(/\r?\n/)[0].slice(0, 72);
    const m = G.git(co.path, [...G.identityArgs(co.path), 'merge', '--no-ff', '--no-edit', '-m', `harness: accept ${task.id} — ${title}`, task.branch], { allowFail: true, retryLock: true });
    if (!m.ok) {
      if (G.mergeInProgress(co.path)) G.git(co.path, ['merge', '--abort'], { allowFail: true });
      S.writeTask(root, task);
      // [2026-10-19 자동 이슈 #20] 남은 index.lock 때문에 병합이 멈췄다 — 잠금은 기다렸다 다시 시도한 뒤에도 남은 것이다. 무엇을 하면 되는지 알린다.
      const lockHint = /index\.lock/.test(m.err) ? ` — ${path.join(co.path, '.git', 'index.lock')} is left over; if no git command is running (editor, another session), delete that file and run accept again` : '';
      return refused(task, `git merge into ${target} failed: ${m.err.trim().slice(0, 300)}${lockHint}`);
    }
    // 병합이 정말 이 작업의 병합 커밋을 만들었는가: HEAD 가 움직였고 · 첫 부모 = 이전 HEAD · 둘째 부모 = 결과 브랜치 끝.
    //   "Already up to date" 는 exit 0 이지만 커밋이 없다 — 그때 HEAD(사용자 커밋)를 merge_commit 으로 적으면 나중 cancel 이 사용자 커밋을 되돌린다.
    const merge = G.headSha(co.path);
    if (merge === before) {
      S.writeTask(root, task);
      S.log(root, task.id, { event: 'accept_noop', head: merge, branch_tip: branchTip });
      return refused(task, `${target} already contains ${task.branch} — git made no merge commit, so nothing was recorded (HEAD ${String(merge).slice(0, 10)} is not this task's merge)`);
    }
    const p1 = G.headSha(co.path, `${merge}^1`), p2 = G.headSha(co.path, `${merge}^2`);
    if (p1 !== before || p2 !== branchTip) {
      S.writeTask(root, task);
      S.log(root, task.id, { event: 'accept_unexpected_merge', head: merge, parents: [p1, p2], expected: [before, branchTip] });
      return refused(task, `git merge produced ${String(merge).slice(0, 10)} whose parents are not (${String(before).slice(0, 10)}, ${String(branchTip).slice(0, 10)}); it was not recorded as this task's merge — inspect ${target}`);
    }
    // 병합은 끝났다 — 무엇보다 먼저 기록한다(태그 · worktree 정리가 실패해도 기록은 남는다).
    Object.assign(task, { status: 'accepted', reason: `merged into ${target} as ${merge.slice(0, 10)}`, merge_commit: merge, accepted_into: target, accepted_at: S.nowIso(), revert_commit: null });
    if (was.status !== 'done') task.forced_from = { status: was.status, reason: was.reason };
    delete task.tag_error;
    S.writeTask(root, task);
    S.log(root, task.id, { event: 'accepted', merge_commit: merge, into: target, conflict_rounds: rounds, forced_from: was.status !== 'done' ? was.status : null });

    const tag = `harness/merged/${task.id}`;
    let tagErr = null;
    if (!G.tagExists(root, tag)) {
      for (let i = 0; i < 3; i++) {
        const t = G.git(root, ['tag', tag, merge], { allowFail: true });
        if (t.ok) { tagErr = null; break; }
        tagErr = t.err.trim().slice(0, 300);
        if (/exists; cannot create|already exists/.test(t.err)) break;   // 재시도로 풀리지 않는다
        S.sleepSync(200 * (i + 1));
      }
    }
    if (tagErr) { task.tag_error = tagErr; S.log(root, task.id, { event: 'tag_failed', tag, error: tagErr }); }

    // git 밖(무시된) 파일이 바뀐 worktree 는 지우지 않는다 — 남기고 이유를 적는다.
    const rm = St.removeIfSafe(root, P.wt, task.worktree_include);
    if (rm.ok) delete task.worktree_kept;
    else {
      task.worktree_kept = rm.why;
      if (rm.ignored) task.outside_git = { ...(task.outside_git || {}), ignored_changed: rm.ignored };
    }
    releaseResources(root, task);
    // go --doc 로 연결한 관리 문서: tasks 에 id · updated · 색인. git 이 추적하는 문서만 그 경로로 커밋한다. 실패해도 병합은 그대로.
    let docLines = [];
    if ((task.docs || []).length) {
      try {
        const lk = require('./docs').linkTask(root, task, { target });
        docLines = lk.lines;
        task.docs_linked = { updated: lk.updated, commit: lk.commit, committed: lk.committed, skipped: lk.skipped };
        S.log(root, task.id, { event: 'docs_linked', updated: lk.updated, commit: lk.commit, skipped: lk.skipped });
      } catch (e) {
        docLines = [`warning: could not link the documents (${task.docs.join(', ')}): ${e.message}`];
        S.log(root, task.id, { event: 'docs_link_failed', error: String(e.message).slice(0, 300) });
      }
    }
    S.writeTask(root, task);
    if (isKo(task)) {
      const headKo = was.status === 'done' ? `pilot ${task.id} — 받아들임` : `pilot ${task.id} — 받아들임(강제) — 작업 상태는 ${was.status}: ${was.reason || '(이유 기록 없음)'}`;
      return out(task, { report: [headKo, `${task.branch} 를 ${target} 에 ${merge.slice(0, 10)} 로 병합했다${tagErr ? '' : `(태그 ${tag})`}${rounds ? ` — 충돌 해결 ${rounds}회 뒤` : ''}.`,
        ...(tagErr ? [`경고: 태그 ${tag} 를 만들지 못했다: ${tagErr} — 병합은 작업 기록(merge_commit ${merge.slice(0, 10)})에 있어 cancel 은 그대로 된다`] : []),
        ...(task.worktree_kept ? [`작업 폴더(worktree) 남김: ${P.wt} (${task.worktree_kept})`] : []),
        ...docLines,
        `계획 보관: ${P.archiveDir}`, `되돌리기: node harness/cli.js cancel ${task.id}   (revert 커밋을 만든다 · reset 은 쓰지 않는다)`].join('\n') });
    }
    const head = was.status === 'done' ? `pilot ${task.id} — ACCEPTED` : `pilot ${task.id} — ACCEPTED (forced) — the task was ${was.status}: ${was.reason || '(no reason recorded)'}`;
    return out(task, { report: [head, `merged ${task.branch} into ${target} as ${merge.slice(0, 10)}${tagErr ? '' : ` (tag ${tag})`}${rounds ? ` after ${rounds} conflict-resolution round(s)` : ''}.`,
      ...(tagErr ? [`warning: could not create tag ${tag}: ${tagErr} — the merge is recorded in the task (merge_commit ${merge.slice(0, 10)}); cancel still works`] : []),
      ...(task.worktree_kept ? [`worktree kept: ${P.wt} (${task.worktree_kept})`] : []),
      ...docLines,
      `plan archived at ${P.archiveDir}`, `undo: node harness/cli.js cancel ${task.id}   (creates a revert commit; never resets)`].join('\n') });
  });
}

// 대상 브랜치에서 commit 을 되돌리는 커밋을 임시 worktree 에서 만들고, 검사를 통과하면 대상 브랜치를 그 커밋으로 fast-forward.
async function revertOnto(root, task, target, commit, extra, label, o) {
  const co = G.checkoutOf(root, target);
  if (!co) return { refused: `target branch ${target} is not checked out in any checkout` };
  if (G.mergeInProgress(co.path)) return { refused: `a merge is in progress in ${co.path}` };
  const touched = G.diffNames(root, `${commit}^1`, commit);
  const clash0 = dirtyOverlap(co.path, touched);
  if (clash0.length) return { refused: `uncommitted changes in ${co.path} touch files this would change: ${clash0.join(', ')} — commit them first` };
  const tip = G.headSha(root, target);
  const tmp = path.join(S.paths(root).worktreesDir, `${task.id}-${label}-${crypto.randomBytes(2).toString('hex')}`);
  G.addWorktree(root, tmp, { detach: true, base: tip });
  let sha = null, checksSkipped = false;
  try {
    // 무시된 의존성(.env 등 .worktreeinclude)을 임시 worktree 에도 — 없으면 검사가 환경 탓으로만 빨개진다.
    G.copyWorktreeInclude(root, tmp);
    const r = G.git(tmp, [...G.identityArgs(tmp), 'revert', '--no-edit', ...extra, commit], { allowFail: true, retryLock: true });
    if (!r.ok) {
      G.git(tmp, ['revert', '--abort'], { allowFail: true });
      return { refused: `the ${label} revert conflicts with later changes on ${target}: ${r.err.trim().slice(0, 300)}` };
    }
    sha = G.headSha(tmp);
    if (task.checks.commands.length && o.skipChecks) {
      checksSkipped = true;
      S.log(root, task.id, { event: 'checks', phase: label, verdict: 'skipped', why: 'skipChecks' });
    } else if (task.checks.commands.length) {
      // cancel: 되돌린 뒤의 상태는 작업 전 기준선보다 나쁘지 않으면 된다(사용자 검사는 되돌린 기능을 묘사하므로 다시 빨개지는 게 맞다).
      // restore: 기능이 돌아오므로 accept 때와 같은 판정.
      const runT = () => K.runAll(tmp, K.commandsForJudge(tmp, task.checks), { timeoutMs: checkTimeout(task, o), serialRoot: task.checks.serial ? root : null });
      let j = await runT();
      if (!j.ok && !task.checks.baseline) { const before = JSON.stringify(task.checks.commands); await L.ensureBaseline(root, task, { o: { checkTimeoutMs: checkTimeout(task, o) }, log: (o && o.log) || (() => {}) }); if (JSON.stringify(task.checks.commands) !== before) j = await runT(); }
      const v = K.judge(j, task.checks.baseline, { notWorse: label === 'cancel' || task.checks.source !== 'user' });
      S.log(root, task.id, { event: 'checks', phase: label, verdict: v.verdict, pass: j.pass, fail: j.fail });
      if (v.verdict === 'fail') return { refused: `checks fail on ${target} after the ${label} revert (${j.fail} failing); nothing was applied — if this is only an environment problem, run ${label} again with --skip-checks` };
    }
    const clash = dirtyOverlap(co.path, touched);
    if (clash.length) return { refused: `uncommitted changes in ${co.path} touch files this would change: ${clash.join(', ')} — commit them first` };
    if (G.headSha(root, target) !== tip || G.currentBranch(co.path) !== target) return { refused: `${target} moved while verifying; run ${label} again` };
    const ff = G.git(co.path, ['merge', '--ff-only', '-q', sha], { allowFail: true, retryLock: true });
    if (!ff.ok) return { refused: `could not apply the ${label} commit to ${target}: ${ff.err.trim().slice(0, 300)}` };
    return { sha, checksSkipped };
  } finally {
    // 임시 worktree 는 하네스의 것 — 검사 산출물이 남아 있어도 지운다(커밋은 대상 브랜치에 있거나 거절됐다).
    G.dropSubmoduleClones(root, tmp, { force: true });   // git 은 서브모듈이 든 worktree 를 지우지 못한다
    G.git(root, ['worktree', 'remove', '--force', tmp], { allowFail: true, retryLock: true });
    try { const parent = path.dirname(tmp); if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* 남음 */ }
  }
}

// ── cancel ────────────────────────────────────────────────────────────
// o.skipChecks: 병합 후 cancel 의 검증 검사를 건너뛴다(의존성 등 환경 문제로만 빨갈 때). 보고에 생략을 적는다.
const skippedLine = (r, label) => (r.checksSkipped ? [`checks skipped (--skip-checks): the ${label} commit was applied without running the checks — verify it yourself`] : []);
function cancelPre(task) {
  if (task.status === 'cancelled') return 'already cancelled';
  if (ownerBusy(task)) return `task is still running (pid ${task.owner.pid}); wait for it, or stop it with: node harness/cli.js stop ${task.id}`;
  return null;
}
async function cancel(o) {
  const { root, task: task0, P, log } = load(o);
  const why0 = cancelPre(task0);
  if (why0) return refused(task0, why0);
  return locked(root, task0, cancelPre, async task => {
    if (task.status === 'accepted' && task.merge_commit) {
      const target = task.accepted_into;
      const r = await revertOnto(root, task, target, task.merge_commit, ['-m', '1'], 'cancel', o);
      if (r.refused) return refused(task, r.refused);
      Object.assign(task, { status: 'cancelled', reason: `merge ${task.merge_commit.slice(0, 10)} reverted on ${target} by ${r.sha.slice(0, 10)}${r.checksSkipped ? ' (checks skipped)' : ''}`, revert_commit: r.sha, cancelled_from: 'accepted', cancelled_at: S.nowIso() });
      S.writeTask(root, task);
      S.log(root, task.id, { event: 'cancelled', after_merge: true, revert_commit: r.sha, checks_skipped: !!r.checksSkipped });
      if (isKo(task)) return out(task, { report: [`pilot ${task.id} — 취소(병합 뒤)`, `${target} 에서 ${task.merge_commit.slice(0, 10)} 를 ${r.sha.slice(0, 10)} 로 되돌렸다(보통 커밋 — 기록은 남는다).`, ...(r.checksSkipped ? ['검사를 건너뛰었다(--skip-checks) — 직접 확인하세요'] : []), `되살리기: node harness/cli.js restore ${task.id}`].join('\n') });
      return out(task, { report: [`pilot ${task.id} — CANCELLED (after merge)`, `reverted ${task.merge_commit.slice(0, 10)} on ${target} with ${r.sha.slice(0, 10)} (a normal commit; history is kept).`, ...skippedLine(r, 'revert'), `undo: node harness/cli.js restore ${task.id}`].join('\n') });
    }
    // 병합 전: 커밋되지 않은 것은 먼저 커밋한다 — 커밋되지 않은 worktree 는 지우지 않는다.
    // [버그 2026-10-01] 폴더가 있다는 것만으로 커밋하지 않는다 — 등록이 사라진 빈 폴더에서는 git 이 메인 저장소를 본다.
    //   이 작업의 worktree(루트 · 브랜치 일치)일 때만 커밋하고 지운다. 아니면 비었을 때만 치우고 정리로 넘어간다.
    if (fs.existsSync(P.wt)) {
      if (G.isWorktreeRoot(P.wt, task.branch)) {
        try { commitInto(task, P.wt, 'cancel — saving uncommitted work'); }
        catch (e) { S.writeTask(root, task); return refused(task, `could not commit the worktree before discarding it: ${e.message}`); }
        const rm = G.removeWorktree(root, P.wt);
        if (!rm.ok) { S.writeTask(root, task); return refused(task, `could not remove the worktree ${P.wt}: ${rm.error}`); }
      } else {
        // 등록이 사라진 남은 폴더 — 붙잡은 프로세스를 끝내고 브랜치와 다른 파일은 작업 기록에 보관한 뒤 치운다(자동 이슈 #11 과 같은 자리).
        const why = G.clearWorktreeSlot(root, P.wt, task.branch, o.removalWaitMs, G.slotOpts(root, task.id, P.dir, log));
        if (why) { S.writeTask(root, task); return refused(task, `${P.wt} is not this task's worktree any more (its registration is gone) and could not be cleared: ${why}`); }
        S.log(root, task.id, { event: 'leftover_folder_removed', path: P.wt });
      }
    }
    const tag = `harness/cancelled/${task.id}`;
    let kept = null;
    if (G.branchExists(root, task.branch)) {
      kept = G.headSha(root, task.branch);
      if (!G.tagExists(root, tag)) G.git(root, ['tag', tag, kept]);
      const d = G.git(root, ['branch', '-D', task.branch], { allowFail: true, retryLock: true });
      if (!d.ok) { S.writeTask(root, task); return refused(task, `could not delete ${task.branch}: ${d.err.trim().slice(0, 200)}`); }
    }
    // 원래 상태와 그 이유를 남긴다 — restore 뒤 accept 가 (강제일 때) 실패 이유를 앞세울 수 있게.
    Object.assign(task, { status: 'cancelled', cancelled_from: task.status, cancelled_from_reason: task.reason || '', reason: `discarded before merge${kept ? `; the work stays reachable at tag ${tag}` : ''}`, cancelled_at: S.nowIso() });
    delete task.worktree_kept;
    releaseResources(root, task);
    S.writeTask(root, task);
    S.log(root, task.id, { event: 'cancelled', after_merge: false, tag: kept ? tag : null });
    if (isKo(task)) return out(task, { report: [`pilot ${task.id} — 취소`, `브랜치 ${task.branch} 와 worktree 를 버렸다${kept ? ` — 커밋은 태그 ${tag} 에 남는다` : ''}.`, `되살리기: node harness/cli.js restore ${task.id}`].join('\n') });
    return out(task, { report: [`pilot ${task.id} — CANCELLED`, `branch ${task.branch} and its worktree were discarded${kept ? `; the commits are kept at tag ${tag}` : ''}.`, `undo: node harness/cli.js restore ${task.id}`].join('\n') });
  });
}

// ── restore ───────────────────────────────────────────────────────────
// o.skipChecks: 병합 후 취소의 되살리기에서 검증 검사를 건너뛴다.
const restorePre = task => (task.status !== 'cancelled' ? `status is ${task.status}; only cancelled tasks can be restored` : null);
async function restore(o) {
  const { root, task: task0 } = load(o);
  const why0 = restorePre(task0);
  if (why0) return refused(task0, why0);
  return locked(root, task0, restorePre, async task => {
    if (task.revert_commit) {
      const target = task.accepted_into;
      const r = await revertOnto(root, task, target, task.revert_commit, [], 'restore', o);
      if (r.refused) return refused(task, r.refused);
      Object.assign(task, { status: 'accepted', reason: `restored on ${target} by ${r.sha.slice(0, 10)} (revert of ${task.revert_commit.slice(0, 10)})${r.checksSkipped ? ' (checks skipped)' : ''}`, restore_commit: r.sha,
        reverts: [...(task.reverts || []), task.revert_commit], revert_commit: null, restored_at: S.nowIso() });
      S.writeTask(root, task);
      S.log(root, task.id, { event: 'restored', restore_commit: r.sha, checks_skipped: !!r.checksSkipped });
      if (isKo(task)) return out(task, { status: 'restored', task_status: task.status, report: [`pilot ${task.id} — 되살림`, `${target} 에 ${r.sha.slice(0, 10)} 로 병합을 다시 적용했다.`, ...(r.checksSkipped ? ['검사를 건너뛰었다(--skip-checks) — 직접 확인하세요'] : [])].join('\n') });
      return out(task, { status: 'restored', task_status: task.status, report: [`pilot ${task.id} — RESTORED`, `re-applied the merge on ${target} with ${r.sha.slice(0, 10)}.`, ...skippedLine(r, 'restore')].join('\n') });
    }
    const tag = `harness/cancelled/${task.id}`;
    if (!G.tagExists(root, tag)) return refused(task, `nothing to restore (no revert commit and no tag ${tag})`);
    if (G.branchExists(root, task.branch)) return refused(task, `branch ${task.branch} already exists`);
    G.git(root, ['branch', task.branch, tag]);
    G.git(root, ['tag', '-d', tag], { allowFail: true });
    const back = task.cancelled_from && task.cancelled_from !== 'cancelled' ? task.cancelled_from : 'done';
    Object.assign(task, { status: back, reason: task.cancelled_from_reason ? `${task.cancelled_from_reason} (restored from tag ${tag})` : `restored from tag ${tag}`, restored_at: S.nowIso() });
    S.writeTask(root, task);
    S.log(root, task.id, { event: 'restored', from_tag: tag });
    if (isKo(task)) return out(task, { status: 'restored', task_status: task.status, report: `pilot ${task.id} — 되살림\n브랜치 ${task.branch} 가 돌아왔다(상태 ${task.status}) — 전처럼 accept 하거나 cancel 하세요.` });
    return out(task, { status: 'restored', task_status: task.status, report: `pilot ${task.id} — RESTORED\nbranch ${task.branch} is back (status ${task.status}); accept or cancel it as before.` });
  });
}

// check <id> — 결과 브랜치에서 저장소 검사를 지금 돌려 기록한다(합치지 않는다). thin 작업의 미룬 검사를 accept 전에 미리 보는 길.
//   실패면 작업 시작 시점의 기준선과 비교한다(원래부터 실패 = 나빠지지 않음). 기록된 결과는 accept 가 그대로 쓴다(나빠졌으면 다시 재고 막는다).
async function check(o) {
  const { root, task: task0, P, log } = load(o);
  if (!['done', 'failed', 'interrupted', 'capped', 'blocked', 'stalled'].includes(task0.status)) return refused(task0, `task status is ${task0.status} — check runs on finished work`);
  return withTaskLock(root, task0, async () => {
    const task = S.readTask(root, task0.id);
    if (!(task.checks && task.checks.commands && task.checks.commands.length)) return out(task, { status: 'checked', report: `pilot ${task.id} — no checks found for this repository` });
    const wtWhy = ensureWorktree(root, task, P, o.removalWaitMs, log);
    if (wtWhy) return refused(task, wtWhy);
    const run1 = async () => (await K.runJudged(P.wt, K.commandsForJudge(P.wt, task.checks), { timeoutMs: checkTimeout(task, o), rerun: task.checks.rerun, serialRoot: task.checks.serial ? root : null })).judged;
    let j = await run1();
    if (!j.ok && !task.checks.baseline && task.checks.source !== 'user') { const before = JSON.stringify(task.checks.commands); await L.ensureBaseline(root, task, { o: { checkTimeoutMs: checkTimeout(task, o) }, log }); if (JSON.stringify(task.checks.commands) !== before) j = await run1(); }
    task.checks.last = K.brief(j);
    const v = K.judge(j, task.checks.baseline, { notWorse: task.checks.source !== 'user' });
    task.checks.verdict = v.verdict;
    S.log(root, task.id, { event: 'checks', phase: 'check', verdict: v.verdict, pass: j.pass, fail: j.fail });
    S.writeTask(root, task);
    const ko = task.language === 'Korean';
    const head = `pilot ${task.id} — ${ko ? '검사' : 'CHECKS'}: ${v.verdict} (${j.pass} ${ko ? '통과' : 'pass'} / ${j.fail} ${ko ? '실패' : 'fail'})`;
    return out(task, { status: v.verdict === 'fail' ? 'check-failed' : 'checked', verdict: v.verdict, report: [head, v.why, ...(v.verdict === 'fail' ? [K.failureExcerpt(j).slice(0, 1500)] : [])].filter(Boolean).join('\n') });
  });
}

module.exports = { accept, cancel, restore, check, dirtyOverlap, archivePlan, conflictBudget };

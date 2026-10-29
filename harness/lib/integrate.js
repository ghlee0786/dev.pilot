'use strict';
// 통합 — accept / cancel / restore / check. 사용자가 받아들인다고 말한 뒤에만 부른다. 전부 `merge` 잠금 아래 직렬로.
//   accept : .harness/<id>/ 를 기록 보관소로 옮겨 결과 브랜치에서 걷어 냄 → 대상 브랜치를 결과 브랜치로 가져와 최신화
//            (충돌이면 그 작업 폴더에 병합을 남겨 두고 거부 — 그 레인에서 풀고 다시 accept) → 검사 → 메인 체크아웃이 대상 브랜치이고
//            결과 브랜치가 건드린 파일에 미커밋 변경이 없을 때만 `merge --no-ff` + 태그 harness/merged/<id>.
//   cancel : 병합 전 — 미커밋분을 커밋한 뒤 worktree 제거, 브랜치 끝을 태그 harness/cancelled/<id> 로 남기고 브랜치 삭제.
//            병합 후 — 임시 worktree 에서 `revert -m 1 <merge>` 를 만들고 검사 통과를 확인한 뒤 대상 브랜치를 그 커밋으로 fast-forward.
//   restore: 취소를 되돌린다(revert 의 revert · 병합 전 취소는 태그에서 브랜치 복원).
//   light 칸(start 로 연 · mode 'light' · status 'open'): --force 없이 받아들인다 · 검사는 accept 때 늘 한 번 돈다(사람이 계속 커밋한 칸이라
//            앞서 잰 결과를 믿지 않는다). 사용자의 accept 는 검사 줄의 맨 앞(priority 0). 시간 초과뿐인 실패는 "나빠짐" 이 아니라 판정 불가로 거부.
//   산 세션: 그 칸의 worktree 안에서 대화형 세션이 아직 일하고 있으면 accept · check · cancel 은 거부한다(--force 면 진행).
//   금지: reset --hard · 강제 push · 다른 세션 미커밋 변경을 stash/덮기.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const S = require('./state'), G = require('./git'), K = require('./checks'), B = require('./baseline'), St = require('./status');

const MERGE_WAIT_MS = 10 * 60 * 1000;
// 검사 상한: 이번 호출의 --check-timeout-min > 작업에 기록된 상한(start 때 check_timeout_min · --check-timeout-min) > 기본.
const checkTimeout = (task, o) => o.checkTimeoutMs || (task.checks && task.checks.timeout_ms) || K.CHECK_TIMEOUT_MS;
const norm = f => { const p = String(f).replace(/\\/g, '/').replace(/^\.\//, ''); return S.IS_WIN ? p.toLowerCase() : p; };
// 검사를 하나씩 돌릴 저장소 — 직렬이 기본(K.serialChecksOn · 프로젝트 블록 serial_checks: off 면 끔). 그 함수가 없는 판이면 작업에 기록된 값.
const serialRootOf = (root, task) => ((typeof K.serialChecksOn === 'function' ? K.serialChecksOn(root) : !!(task && task.checks && task.checks.serial)) ? root : null);
// 판정 불가 — 실패한 검사가 모두 시간 초과로만 실패했다(무엇이 나빠졌는지 잰 것이 없다). checks.js 의 j.indeterminate 가 없으면 여기서 같은 규칙으로.
function isIndeterminate(j) {
  if (!j) return false;
  if (j.indeterminate != null) return !!j.indeterminate;
  const bad = (j.results || []).filter(r => !r.ok);
  return bad.length > 0 && bad.every(r => r.timed_out && !r.stalled);   // 출력이 멈춘 시험(stalled)은 기준선이 떼어 낸다 — 판정 불가가 아니다
}
const failedTests = j => ((j && j.failed_tests) || []).slice(0, 10);

// 진입점 검증: id 는 경로 조각이 된다(tasks/<id>/ · .harness-worktrees/<id>) — 형식이 맞지 않으면 아무것도 읽지 않는다.
function load(o) {
  if (!S.validId(o.id)) throw Object.assign(new Error(`invalid task id: ${JSON.stringify(o.id)} (expected t-yyyymmdd-HHMMss-xxxx)`), { code: 'USAGE' });
  const root = S.mainRoot(o.root || process.cwd());
  const task = S.readTask(root, o.id);
  if (!task) throw Object.assign(new Error(`unknown task: ${o.id}`), { code: 'UNKNOWN_TASK' });
  return { root, task, P: S.taskPathsFor(root, task), log: o.log || (m => process.stderr.write(m + '\n')) };
}
// 기계용 결과(HARNESS_RESULT) — 작업 기록의 요약
function checksVerdict(ch) {
  if (!ch) return null;
  if (!(ch.commands || []).length && (ch.dropped || []).length) return 'unverified';
  if (ch.deferred && !ch.last) return 'deferred';
  return ch.verdict || null;
}
function result(task) {
  const ch = task.checks || null, last = ch && (ch.last || null), sp = task.spent || {};
  return { id: task.id, status: task.status, reason: task.reason, mode: task.mode || null, branch: task.branch, commit: task.head || (task.commits || []).slice(-1)[0] || null,
    base_branch: task.base_branch, base_commit: task.base_commit,
    checks: { source: ch ? ch.source : 'none', ok: last && checksVerdict(ch) !== 'unverified' ? last.ok : null, pass: last ? last.pass : null, fail: last ? last.fail : null,
      baseline_fail: ch && ch.baseline ? ch.baseline.fail : null, verdict: checksVerdict(ch), baseline_warning: ch && ch.baseline_warning || null },
    cost_usd: sp.cost_usd || 0, merge_commit: task.merge_commit || null, revert_commit: task.revert_commit || null, outside_git: task.outside_git || null };
}
function out(task, extra) {
  const r = { ...result(task), ...(extra || {}) };
  r.report = extra && extra.report ? extra.report : `pilot ${task.id} — ${r.status}${r.reason ? ': ' + r.reason : ''}`;
  return r;
}
// 한국어 작업(task.language === 'Korean')이면 보고를 한국어로 — [2026-10-13 사용자 보고] 결과가 영어로 나왔다.
const isKo = task => !!task && task.language === 'Korean';
const REFUSE_KO = [
  [/^task is still running \(pid (\d+)\)(.*)$/s, m => `작업이 아직 실행 중이다(pid ${m[1]}) — 끝나기를 기다리거나 그 세션을 멈추세요(claude agents)`],
  [/^task status is (\w+)(.*) — only done tasks are accepted; pass --force to merge it anyway$/s, m => `작업 상태가 ${m[1]}${m[2]} — done 인 작업만 받아들인다. 그래도 병합하려면 --force`],
  [/^already accepted into (\S+) \((\w+)\)$/, m => `이미 ${m[1]} 에 받아들였다(${m[2]})`],
  [/^the task was cancelled; use restore first$/, () => '취소된 작업이다 — 먼저 restore'],
  [/^already cancelled$/, () => '이미 취소했다'],
  [/^uncommitted changes in (\S+) touch files this (?:task changed|task changes|would change): (.*) — commit them first$/s, m => `${m[1]} 의 미커밋 변경이 이 작업의 파일과 겹친다: ${m[2]} — 먼저 커밋하세요`],
  [/^target branch (\S+) is not checked out in any checkout(.*)$/s, m => `대상 브랜치 ${m[1]} 가 어느 체크아웃에도 열려 있지 않다 — 메인 체크아웃에서 열고 다시 하세요`],
  [/^checks fail after bringing (\S+) into (\S+) \((\d+) failing(?:; newly failing: (.*?))?\)(.*)$/s, m => `${m[1]} 를 ${m[2]} 에 들인 뒤 검사가 실패한다(${m[3]}건${m[4] ? ` · 새로 실패: ${m[4]}` : ''}) — 결과 브랜치에 ${m[1]} 가 들어 있다. 레인에서 고친 뒤 다시 accept${/itself also fails/.test(m[5]) ? ` (${m[1]} 자체도 이 검사에서 실패한다 — 그쪽도 고치세요)` : ''}`],
  [/^lint fails on (\S+) \((.*?)\): (.*) — fix it in the lane, then accept again( \(this lints the whole repository.*\))?$/s, m => `${m[1]} 에서 린트가 실패한다(${m[2]}): ${m[3]} — 레인에서 고친 뒤 다시 accept${m[4] ? ' (저장소 전체 린트다 — lint_command 에 {files} 를 쓰면 바꾼 파일만 본다(accept 는 지금 값을 읽는다) · 또는 accept --force)' : ''}`],
  [/^this task is stacked on (\S+) \(task (\S+?)(?:, (\w+))?\) — (.*)$/s, m => `이 작업은 ${m[1]} 위에 쌓은 작업이다(앞 작업 ${m[2]}${m[3] ? ` · ${m[3]}` : ''}) — 앞 작업을 먼저 accept 하면(그러면 이 작업도 같은 브랜치로 따라간다) 되고, 아니면 --into <브랜치>`],
  [/^the previous worktree (\S+) is still being removed(.*)$/s, m => `이전 worktree ${m[1]} 가 아직 지워지는 중이다(다른 프로세스가 파일을 잡고 있다) — 1분쯤 뒤 다시 하세요`],
  [/^checks undetermined on (\S+) — every failing check timed out \((.*?)\)(.*)$/s, m => `${m[1]} 의 검사를 판정하지 못했다 — 실패한 검사가 모두 시간 초과다(${m[2]}). "작업 전보다 나빠짐" 이 아니다 — accept 를 다시 하거나(부하가 줄었을 때) 결과를 알고 합치려면 --force`],
  // [2026-10-29 감사 G2 #12] 머리만 한국어이고 충돌 · 표식 · 대량 삭제 · unverified · 나빠짐 내용은 영어로 남았다
  [/^conflicts with (\S+) in (.*?) — the merge is left in progress in (.+?): (.*)$/s, m => `${m[1]} 와 ${m[2]} 에서 충돌한다 — 병합을 ${m[3]} 에 진행 중으로 남겼다: 그 레인의 세션(또는 직접)에서 충돌을 풀고(표식 · 수정/삭제 · 이진 파일) 커밋한 뒤 다시 accept(또는 cancel)`],
  [/^the merge left in (.+?) still has conflict markers in (.*?) — (.*)$/s, m => `${m[1]} 에 남긴 병합에 아직 충돌 표식이 있다: ${m[2]} — 풀고 커밋한 뒤 다시 accept(또는 cancel)`],
  [/^the merge left in (.+?) still has unresolved conflicts: (.*?) — (.*)$/s, m => `${m[1]} 에 남긴 병합에 아직 풀지 않은 충돌이 있다: ${m[2]} — 남길 판을 골라(수정/삭제는 git add <파일> 또는 git rm <파일> · 이진 파일은 git checkout --ours|--theirs -- <파일> 뒤 git add) 커밋한 뒤 다시 accept(또는 cancel)`],
  [/^(\S+) has committed conflict markers in (.*?) — (.*)$/s, m => `${m[1]} 에 충돌 표식이 커밋돼 있다: ${m[2]} — 레인에서 표식을 풀고 커밋한 뒤 다시 accept`],
  [/^the worktree (.+?) is missing (\d+) tracked file\(s\)(.*?) that are not committed as deleted \(e\.g\. (.*?)\) — .*?\((git -C .*?)\).*$/s, m => `작업 폴더 ${m[1]} 에서 추적 파일 ${m[2]}개${m[3] ? `(${m[3].replace(/^ including submodule\(s\) /, '서브모듈 ')})` : ''}가 삭제 커밋 없이 사라졌다(예: ${m[4]}) — 작업이 아니라 중단된 git 작업으로 보여 아무것도 커밋하지 않았다. 되살리거나(${m[5]}) 지운 게 맞으면 직접 커밋한 뒤 다시 accept`],
  [/^unverified — the checks fail on (\S+) \((.*?)\) but they timed out at the base commit \((.*?)\)(.*)$/s, m => `검증하지 못했다 — ${m[1]} 에서 검사가 실패하는데(${m[2]}) 작업 시작 커밋에서는 그 검사가 시간 초과라(${m[3]}) 이 작업이 나쁘게 했는지 알 수 없다 — 실패를 고치거나, 직접 시험을 돌려 확인한 뒤 --force 로 다시 accept(부하가 줄었을 때 다시 accept 하면 다시 잰다)`],
  [/^unverified — (.*)$/s, m => `검증하지 못했다 — ${m[1]}`],
  [/^checks fail on (\S+) and are worse than before the task \((\d+) failing(?:; newly failing: (.*?))?\)(.*)$/s, m => `${m[1]} 의 검사가 실패하고 작업 전보다 나빠졌다(${m[2]}건${m[3] ? ` · 새로 실패: ${m[3]}` : ''}) — 레인에서 고친 뒤 다시 accept(실패를 알고 합치려면 --force)`],
  [/^could not bring (\S+) into (\S+): (.*)$/s, m => `${m[1]} 를 ${m[2]} 에 들이지 못했다: ${m[3]}`],
  [/^(\S+) kept moving while integrating; run accept again$/, m => `${m[1]} 가 들이는 동안 계속 움직였다 — accept 를 다시 하세요`],
  [/^a live session is working in this lane's worktree (.+?) \((.*?)\) — .*?; --force to (\w+) anyway$/s, m => `이 레인의 작업 폴더 ${m[1]} 에서 산 세션이 일하고 있다(${m[2]}) — 그 세션에서 일을 끝내고 커밋한 뒤(또는 세션을 끝낸 뒤) 다시 하세요. 그래도 하려면 ${m[3]} --force`],
];
const refuseKo = r => { for (const [re, fn] of REFUSE_KO) { const m = re.exec(String(r)); if (m) return fn(m); } return String(r); };
// extra.failed_tests: 실패한 시험 이름(최대 10) — 결과 · 보고에 함께 싣는다.
const refused = (task, reason, extra) => {
  const tests = (extra && extra.failed_tests) || [];
  const tl = tests.length ? [`${isKo(task) ? '실패한 시험' : 'failing tests'}: ${tests.join(', ')}`] : [];
  return out(task, { refused: true, reason, ...(tests.length ? { failed_tests: tests } : {}), report: [isKo(task) ? `pilot ${task.id} — 바뀐 것 없음: ${refuseKo(reason)}` : `pilot ${task.id} — nothing changed: ${reason}`, ...tl].join('\n') });
};

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
    const Rs = require('./resources');
    if (typeof Rs.freePorts === 'function') { try { Rs.freePorts(root, task.id); } catch { /* 장부는 끝난 작업을 다음 할당 때 스스로 비운다 */ } }
    const r = Rs.release(root, task);
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
// [2026-10-29 감사 G2 #25 · 사용자 요구] 레인 세션이 아직 일하는 중인데 accept 가 반쯤 된 편집을 대신 커밋해 병합하고 그 worktree 를 지웠다 —
//   그 칸의 worktree 안(root · cwd)에 산 대화형 세션(_common.sessionLive: 플랫폼 목록 · 없으면 last_seen 30분)이 있으면 → [세션]. 없으면 [].
//   부른 쪽이 그 worktree 안에 있으면(그 칸의 세션이 스스로 부른 것) 보지 않는다. 세션 파일이 그 칸을 가리킬 때만 플랫폼 목록을 묻는다.
function liveLaneSessions(root, task) {
  let Ch; try { Ch = require('../hooks/_common'); } catch { return []; }
  const key = p => { const r = Ch.real(p).replace(/[\\/]+$/, ''); return S.IS_WIN ? r.toLowerCase() : r; };
  const wts = [...new Set([S.taskPathsFor(root, task).wt, task.worktree].filter(Boolean).map(key))];
  const inside = p => !!p && typeof p === 'string' && wts.some(w => { const k = key(p); return k === w || k.startsWith(w + path.sep); });
  if (inside(process.cwd())) return [];
  const common = S.paths(root).commonDir;
  let cand = [];
  // [자동 이슈 #67] 부른 세션 자신(CLAUDE_CODE_SESSION_ID)은 뺀다 — 예전에 그 레인에 cd 했다가 돌아와 accept 를 부르면 세션 파일의 cwd 가 아직 레인이다.
  const self = process.env.CLAUDE_CODE_SESSION_ID || null;
  try { cand = Ch.listSessions(common).filter(s => String(s.session_id) !== self && (inside(s.root) || inside(s.cwd))); } catch { return []; }
  if (!cand.length) return [];
  let agents = null; try { agents = Ch.platformAgents(common); } catch { agents = null; }
  return cand.filter(s => Ch.sessionLive(s, agents)).map(s => { const a = Ch.agentOf(s, agents); return { session_id: s.session_id, name: a && a.name || null, status: a && a.status || null }; });
}
function liveSessionWhy(root, task, o, cmd) {
  if (o.force) return null;
  const live = liveLaneSessions(root, task);
  if (!live.length) return null;
  const who = live.slice(0, 3).map(s => `${s.name || String(s.session_id).slice(0, 8)}${s.status ? ` ${s.status}` : ''}`).join(', ');
  return `a live session is working in this lane's worktree ${S.taskPathsFor(root, task).wt} (${who}) — finish and commit the work in that session (or end it), then run ${cmd} again; --force to ${cmd} anyway`;
}
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
// 칸의 커밋되지 않은 변경을 그 칸의 브랜치에 커밋한다 → 커밋한 파일(없으면 []) — 무엇을 대신 커밋했는지 보고에 싣는다.
//   light 칸은 사람이 일한 곳이라 턴 체크포인트가 없었다 — 줄바꿈을 먼저 원래대로(G.keepEol · 루프의 체크포인트와 같이).
function commitLeftovers(task, wt, label) {
  if (task.mode === 'light') { try { G.keepEol(wt); } catch { /* 줄바꿈 복원 실패는 커밋을 막지 않는다 */ } }
  const sha = commitInto(task, wt, label);
  return sha ? G.diffNames(wt, `${sha}^`, sha) : [];
}
// 커밋하지 않은 삭제가 수상한가 — 서브모듈(gitlink) 삭제가 있거나 MASS_DELETE 개 이상이면 { deleted, gitlinks, sample } · 아니면 null
const MASS_DELETE = 20;
//   [2026-10-29 감사 G2 #6] 남긴 병합을 풀고 다시 accept 하면 대상 브랜치가 지운 파일(병합이 스테이징한 'D ')까지 세어 거부했다 —
//   진행 중인 병합이면 대상 쪽(MERGE_HEAD)이 병합 기준 뒤에 지운 경로는 뺀다.
function suspiciousDeletes(wt) {
  let del = G.statusEntries(wt).filter(e => e.code !== '??' && e.code !== '!!' && !UNMERGED.has(e.code) && (e.x === 'D' || e.y === 'D')).map(e => e.path);
  if (del.length && G.mergeInProgress(wt)) {
    const mb = G.mergeBase(wt, 'HEAD', 'MERGE_HEAD');
    const theirs = new Set((mb ? G.diffNames(wt, mb, 'MERGE_HEAD', ['--diff-filter=D']) : []).map(norm));
    del = del.filter(p => !theirs.has(norm(p)));
  }
  if (!del.length) return null;
  const stage = G.git(wt, ['ls-files', '-s', '--', ...del.slice(0, 500).map(p => `:(literal)${p}`)], { allowFail: true }).out;
  const gitlinks = stage.split(/\r?\n/).filter(l => /^160000 /.test(l)).map(l => l.split('\t')[1]).filter(Boolean);
  return gitlinks.length || del.length >= MASS_DELETE ? { deleted: del.length, gitlinks, sample: del.slice(0, 5), restore: restoreSpecs(del) } : null;
}
// 되살릴 경로 — 지운 파일의 상위 폴더(최대 10개) · 맨 위 파일은 그대로. 너무 많으면 앞의 것만.
//   [G2 #6] 예전 안내 `checkout HEAD -- .` 은 풀어 둔 해결까지 덮고 guard 의 "작업 트리 전체" 규칙에 막혔다 — 사라진 경로만 restore 한다.
function restoreSpecs(del) {
  const specs = [...new Set(del.map(p => (p.includes('/') ? `${p.slice(0, p.lastIndexOf('/'))}/` : p)))];
  return specs.slice(0, 10).map(p => (/[\s"]/.test(p) ? `"${p}"` : p)).join(' ') + (specs.length > 10 ? ' …' : '');
}
// 표식으로 드러나지 않는 미해결 충돌 — 수정/삭제(DU · UD · AU · UA · DD)와 이진 파일(UU · AA 인데 NUL 바이트). 사람이 남길 판을 골라 add/rm 해야 풀린다.
//   [2026-10-29 감사 G2 #4] 표식만 봐서 이런 충돌을 다시 accept 하면 한쪽 판으로 조용히 병합됐다(레인의 삭제 · 대상의 이진 변경이 사라짐).
//   글자 파일(UU · AA)은 그대로 — 표식을 풀어 두기만 해도 accept 가 커밋한다(아래 표식 검사가 본다).
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const CONFLICT_KIND = { DD: 'deleted by both', AU: 'added by us', UA: 'added by them', DU: 'deleted by us, modified by them', UD: 'modified by us, deleted by them' };
function isBinary(file) {
  try { const fd = fs.openSync(file, 'r'); try { const buf = Buffer.alloc(8000); const n = fs.readSync(fd, buf, 0, buf.length, 0); return buf.subarray(0, n).includes(0); } finally { fs.closeSync(fd); } } catch { return false; }
}
function unresolvedConflicts(wt) {
  return G.statusEntries(wt).filter(e => UNMERGED.has(e.code))
    .filter(e => (e.code !== 'UU' && e.code !== 'AA') || isBinary(path.join(wt, e.path)))
    .map(e => `${e.path} (${CONFLICT_KIND[e.code] || 'binary file'})`);
}
// 앞서 충돌을 남긴 파일(기록 conflict_left) 가운데 지금 칸의 커밋된 내용에 표식이 있는 것 — 표식째 커밋된 병합(옛 cancel · 사람의 커밋)을 대상에 들이지 않는다(G2 #0).
function committedMarkers(root, task, P) {
  let files = [];
  try { files = S.readLog(root, task.id).filter(e => e.event === 'conflict_left').flatMap(e => e.files || []); } catch { files = []; }
  return [...new Set(files)].filter(f => G.hasConflictMarkersText(G.git(P.wt, ['show', `HEAD:${f}`], { allowFail: true }).out));
}
// [자동 이슈 #57] 검사가 추적 파일(빌드 산출물 · outside_git_ok 경로)을 다시 쓰면 그것이 작업 브랜치에 커밋돼 다음 병합을 막았다 —
//   검사 전에 미커밋이 아니던 추적 파일의 변경은 검사 뒤 HEAD 로 되돌린다(새로 생긴 추적 안 된 파일은 그대로 — 무시 규칙의 몫이다) → 되돌린 경로
function undoCheckWrites(wt, before) {
  const ps = G.statusEntries(wt).filter(e => e.code !== '??' && e.code !== '!!' && !before.has(e.path)).map(e => e.path);
  for (let i = 0; i < ps.length; i += 100) G.git(wt, ['checkout', '-q', 'HEAD', '--', ...ps.slice(i, i + 100).map(p => `:(literal)${p}`)], { allowFail: true, retryLock: true });
  return ps;
}
// [자동 이슈 #56] 검사 뒤 대상 브랜치에 들어온 것이 문서뿐이면 다시 들이되 전체 검사는 다시 돌리지 않는다(문서 커밋 하나에 몇 시간 재검사)
//   [2026-10-29 감사 G2 #8] doc/ · docs/ 폴더면 무엇이든 문서로 봐서 lib/doc/util.js · docs/conf.py 같은 코드 변경이 재검사 없이 병합됐다 —
//   문서 확장자(.md · .rst · .adoc) · .harness/ · docs/ 아래의 글 · 그림(.txt · 이미지 · pdf)만. .txt 는 docs/ 밖이면 아니다(CMakeLists.txt · requirements.txt).
const DOC_FILE = f => /(^|\/)\.harness\//.test(f) || /\.(md|markdown|rst|adoc)$/i.test(f) || (/(^|\/)docs?\//i.test(f) && /\.(txt|png|jpe?g|gif|svg|webp|pdf)$/i.test(f));
const docsOnly = files => files.length > 0 && files.every(DOC_FILE);
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

// 충돌 — 모델에게 풀게 하지 않는다(v7: 무인 작업자 없음). 병합을 그 작업 폴더에 진행 중으로 남겨 두고 알린다 —
//   그 폴더의 세션(또는 사람)이 충돌 표식을 풀고 커밋한 뒤 accept 를 다시 한다(직접 git merge 는 guard 가 막으므로 남겨 둬야 풀 수 있다).
function leaveConflicts(root, task, P, target) {
  const files = G.unmergedFiles(P.wt);
  S.log(root, task.id, { event: 'conflict_left', target, files: files.slice(0, 200) });
  return `conflicts with ${target} in ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` … (+${files.length - 10})` : ''} — the merge is left in progress in ${P.wt}: resolve the conflicts there (markers · modify/delete · binary files; in that lane's session or by hand), commit, then accept again (or cancel)`;
}

// ── accept ────────────────────────────────────────────────────────────
// 선행 조건. 잠금 전(빠른 거절)과 잠금 아래(다시 읽은 기록)에서 두 번 본다. 문자열이면 거절 이유.
//   기본은 done 만 받아들인다 — 다른 상태(failed · stalled · blocked · capped · interrupted · error …)는 o.force 일 때만.
//   거절 이유는 작업의 상태와 그 이유로 시작한다(무엇이 잘못됐는지가 먼저 보이게).
//   [2026-10-16 자동 이슈 #15] --base harness/<앞 작업> 으로 쌓은 작업(start --base · 예전 go --base)은 기본 대상이 그 harness 브랜치라 거부됐다 —
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
    const live = liveSessionWhy(root, task, o, 'accept');
    if (live) return live;
    // light 칸은 끝났다는 신호가 사용자의 accept 자체다 — open 을 done 처럼 받는다(검사는 아래에서 한 번).
    if (task.status !== 'done' && !(task.mode === 'light' && task.status === 'open') && !o.force) return `task status is ${task.status}${task.reason ? ` (${task.reason})` : ''} — only done tasks are accepted; pass --force to merge it anyway`;
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

    // 예전 go 작업: 끝난 뒤 결과 브랜치가 그대로인가 — 그렇고 대상 브랜치도 들이지 않으면 그때(task.checks.lint.last) 통과한 린트를 그대로 쓴다(아래).
    const unchangedSinceLoop = !!task.head && G.headSha(root, task.branch) === task.head;
    let broughtTarget = false;
    const notes = [];   // 받아들인 보고에 덧붙일 말(막지 않은 것 — 작업 전부터 빨간 린트 · 대상이 스스로 빨간 검사)

    // [2026-10-29 감사 G2 #1] 'unverified'(기준선에서 시간 초과로 검사가 모두 빠짐)로 거부된 칸을 --force 없이 다시 accept 하면 검사 없이 병합됐다 —
    //   빠진 검사를 되살려 다시 잰다(기준선도 다시 — 시간 초과는 캐시하지 않는다). 되살릴 명령이 없는 옛 기록이면 --force 를 요구한다.
    let reverify = false;
    if (!o.force && checksVerdict(task.checks) === 'unverified') {
      const back = task.checks.dropped.map(d => d.argv).filter(Array.isArray);
      if (back.length !== task.checks.dropped.length) return refused(task, `unverified — the repository checks were dropped (${task.checks.dropped.map(d => d.command).join(' ; ').slice(0, 200)}: timed out before the task) and cannot be restored from this record; run the tests yourself, then accept again with --force`);
      task.checks.commands = back; task.checks.baseline = null; delete task.checks.dropped; delete task.checks.baseline_cached;
      S.log(root, task.id, { event: 'checks_restored', phase: 'accept', commands: back.map(K.display) });
      reverify = true;
    }

    // 1. .harness/<id>/ 보관 → 삭제 커밋
    const wtWhy = ensureWorktree(root, task, P, o.removalWaitMs, log);
    if (wtWhy) return refused(task, wtWhy);
    // 앞선 accept 가 남긴 충돌 병합(leaveConflicts) — 풀지 않은 것(표식 · 수정/삭제 · 이진)이 남았으면 거절, 다 풀었으면 아래 커밋이 병합을 마친다
    const finishingMerge = G.mergeInProgress(P.wt);
    if (finishingMerge) {
      const open = unresolvedConflicts(P.wt);
      if (open.length) { S.writeTask(root, task); return refused(task, `the merge left in ${P.wt} still has unresolved conflicts: ${open.slice(0, 10).join(', ')} — pick the version to keep (modify/delete: git add <file> or git rm <file>; binary: git checkout --ours|--theirs -- <file>, then git add <file>), commit, then accept again (or cancel)`); }
      // 미병합 목록만 보면 표식이 남은 채 git add 된 파일을 놓친다 — 병합 중 바뀐 파일 전부에서 본다
      const still = [...new Set([...G.unmergedFiles(P.wt), ...G.dirtyFiles(P.wt).map(e => e.path)])].filter(f => G.hasConflictMarkers(path.join(P.wt, f)));
      if (still.length) { S.writeTask(root, task); return refused(task, `the merge left in ${P.wt} still has conflict markers in ${still.slice(0, 10).join(', ')} — resolve them, commit, then accept again (or cancel)`); }
    }
    // 남은 미커밋분은 커밋하고 무엇을 커밋했는지 보고한다 — light 칸에서는 사람이 아직 고치던 파일일 수 있다.
    //   [자동 이슈 #61] 강제로 끝난 accept 뒤 작업 폴더에서 추적 파일 79개 · 서브모듈 등록이 사라졌고, 다음 accept 가 그 "삭제" 를 그대로 커밋했다 — 커밋하지 않고 멈춘다.
    const gone = suspiciousDeletes(P.wt);
    if (gone) { S.writeTask(root, task); return refused(task, `the worktree ${P.wt} is missing ${gone.deleted} tracked file(s)${gone.gitlinks.length ? ` including submodule(s) ${gone.gitlinks.slice(0, 5).join(', ')}` : ''} that are not committed as deleted (e.g. ${gone.sample.join(', ')}) — this looks like an interrupted git operation, not work; nothing was committed. Restore them (git -C "${P.wt}" restore --source=HEAD --staged --worktree -- ${gone.restore}) or, if the deletions are intended, commit them yourself, then accept again`); }
    let leftover;
    if (finishingMerge) {
      // [G2 #4 · #5] 남긴 병합을 마치는 커밋 — 색인이 HEAD 와 같아도(ours 로 풀고 add 만) 병합 커밋을 만든다(아니면 MERGE_HEAD 가 남아 끝없이 거부됐다).
      //   첫 부모와의 차이에는 대상에서 온 파일이 섞인다 — "커밋되지 않았던 변경" 으로 보고하지 않는다.
      if (task.mode === 'light') { try { G.keepEol(P.wt); } catch { /* 줄바꿈 복원 실패는 커밋을 막지 않는다 */ } }
      const sha = G.commitAll(P.wt, `harness(${task.id}): finish the merge left by an earlier accept`, { branch: task.branch, allowEmpty: true });
      if (sha) task.commits.push(sha);
      S.log(root, task.id, { event: 'conflict_merge_finished', sha });
      leftover = [];
    } else {
      leftover = commitLeftovers(task, P.wt, 'uncommitted work before accept');
      if (leftover.length) S.log(root, task.id, { event: 'leftovers_committed', phase: 'accept', files: leftover.slice(0, 200) });
    }
    // [G2 #0] 표식째 커밋된 병합(예전 cancel 이 남긴 태그를 restore · 사람이 표식째 커밋)을 대상에 들이지 않는다
    const marked = committedMarkers(root, task, P);
    if (marked.length) { S.writeTask(root, task); return refused(task, `${task.branch} has committed conflict markers in ${marked.slice(0, 10).join(', ')} — resolve them in the lane, commit, then accept again`); }
    archivePlan(root, task, P);

    // 2. 대상 브랜치를 가져와 최신화(충돌 → 그 작업 폴더에 남기고 거부) → 검사
    let checkedNow = false;
    // targetSha: 방금 들인 대상 브랜치 끝(대상을 들인 뒤의 검사일 때만) — 실패하면 그 끝에서도 같은 검사를 재 본다(G2 #11).
    const checkHere = async (why, targetSha) => {
      checkedNow = true;
      const dirtyBefore = new Set(G.dirtyFiles(P.wt).map(e => e.path));
      // priority 0: 사용자가 기다리는 accept 가 검사 줄의 맨 앞으로(state.acquireQueued — 없는 판이면 무시된다)
      const run1 = async () => (await K.runJudged(P.wt, K.commandsForJudge(P.wt, task.checks), { timeoutMs: checkTimeout(task, o), rerun: task.checks.rerun, serialRoot: serialRootOf(root, task), priority: 0 })).judged;
      let j = await run1();
      const laneRun = j;   // 기준선 때문에 검사가 빠져 다시 돌려도(빈 실행 = 통과) 레인의 실제 결과는 이것
      // light 칸: 시간 초과뿐인 실패면 기준선을 재지 않는다 — 부하로 기준선마저 시간 초과면 검사가 판정에서 영영 빠진다(아래 #29). 판정 불가로 바로 거부.
      const early = !j.ok && task.mode === 'light' && !task.checks.baseline && isIndeterminate(j);
      // 늦은 기준선(D2): 실패했는데 기준선이 없으면 지금 작업 시작 시점에서 잰다 — 명령이 바뀌면(멈춘 테스트 · 빠진 검사) 다시 잰다
      if (!j.ok && !early && !task.checks.baseline) { const before = JSON.stringify(task.checks.commands); await B.ensureBaseline(root, task, { o: { checkTimeoutMs: checkTimeout(task, o), priority: 0 }, log }); if (JSON.stringify(task.checks.commands) !== before) j = await run1(); }
      task.checks.last = K.brief(j);
      const undone = undoCheckWrites(P.wt, dirtyBefore);
      if (undone.length) S.log(root, task.id, { event: 'check_writes_undone', phase: 'accept', files: undone.slice(0, 50) });
      // [자동 이슈 #29] 저장소 검사가 작업 전부터 시간 초과로 모두 빠졌다 — 나빠졌는지 잴 수 없으니 검증 안 된 병합을 막는다(--force 면 이 단계를 거치지 않는다).
      //   [G2 #1] 예전 문구 "nothing judged this work" 는 틀렸다 — 레인의 검사는 실제로 실패했다. 레인의 결과를 기록하고 그대로 말한다.
      if (!task.checks.commands.length && (task.checks.dropped || []).length) {
        task.checks.last = K.brief(laneRun);
        S.log(root, task.id, { event: 'checks', phase: 'accept', why, verdict: 'unverified', dropped: task.checks.dropped.length, pass: laneRun.pass, fail: laneRun.fail });
        S.writeTask(root, task);
        const laneWhat = isIndeterminate(laneRun) ? 'every failing check timed out' : `${laneRun.fail} failing`;
        return refused(task, `unverified — the checks fail on ${task.branch} (${laneWhat}) but they timed out at the base commit (${task.checks.dropped.map(d => d.command).join(' ; ').slice(0, 200)}), so it is unknown whether this work made them worse; fix the failures, or run the tests yourself and accept again with --force (accept again when the machine is less busy measures them again)`, { failed_tests: failedTests(laneRun) });
      }
      const v = K.judge(j, task.checks.baseline, { notWorse: task.checks.source !== 'user' });
      const undecided = early || (v.verdict === 'fail' && isIndeterminate(j));
      // [2026-10-29 감사 G2 #11] 기준선은 작업 시작 커밋에서 잰다 — 그 뒤 대상 브랜치가 스스로 깨졌으면 레인 탓으로 거부됐다.
      //   대상을 들인 뒤의 실패면 대상 끝에서도 같은 검사를 잰다: 저장소의 검사(자동 발견)는 대상 끝보다 나쁘지 않으면 받아들인다(병합이 대상을 더 나쁘게 하지 않는다).
      //   사용자가 준 검사는 새 동작을 묘사하므로 그대로 거부하되, 대상도 같은 이유로 실패한다고 알린다.
      let targetRed = null;
      if (v.verdict === 'fail' && !undecided && targetSha && targetSha !== task.base_commit) {
        const tb = await B.measureAt(root, task, targetSha, { o: { checkTimeoutMs: checkTimeout(task, o), priority: 0 }, log });
        if (tb && !tb.ok && !tb.indeterminate) {
          if (task.checks.source !== 'user' && K.judge(j, tb).verdict !== 'fail') {
            S.log(root, task.id, { event: 'checks', phase: 'accept', why, verdict: 'not_worse_than_target', pass: j.pass, fail: j.fail, target_fail: tb.fail, target: targetSha });
            notes.push(`checks fail on ${target} itself (${String(targetSha).slice(0, 10)}: ${tb.fail} failing${tb.failed_tests.length ? ` — ${tb.failed_tests.slice(0, 10).join(', ')}` : ''}) — this work did not make them worse`);
            return null;
          }
          targetRed = tb;
        }
      }
      S.log(root, task.id, { event: 'checks', phase: 'accept', why, verdict: undecided ? 'indeterminate' : v.verdict, pass: j.pass, fail: j.fail });
      if (v.verdict !== 'fail' && !undecided) return null;
      S.writeTask(root, task);   // 검사가 쓴 것은 커밋하지 않는다(#57 — 위에서 되돌렸다)
      const tests = { failed_tests: failedTests(j) };
      // [2026-10-25 C++ 저장소] 부하가 큰 PC 에서 시간 초과뿐인 실패가 "작업 전보다 나빠짐" 으로 거부돼 작업을 처음부터 다시 만들었다 — 판정 불가로 따로 말한다.
      if (undecided) return refused(task, `checks undetermined on ${task.branch} — every failing check timed out (${j.results.filter(r => !r.ok).map(r => r.command).join(' ; ').slice(0, 200)}) — this is not "worse than before"; run accept again (when the machine is less busy), or --force to merge without a verdict`, tests);
      const red = targetRed ? ` (${target} itself also fails these checks at ${String(targetSha).slice(0, 10)}: ${targetRed.fail} failing — fix it there too)` : '';
      const fresh = v.newly_failing && v.newly_failing.length ? `; newly failing: ${v.newly_failing.slice(0, 10).join(', ')}` : '';
      // [G2 #10] 대상을 들이지 않았으면 "bringing main" 이 아니다 — 그 칸의 검사 실패로 말한다
      if (why !== 'target brought in') return refused(task, `checks fail on ${task.branch} and are worse than before the task (${j.fail} failing${fresh}) — fix it in the lane, then accept again (or --force if you accept the failures)`, tests);
      return refused(task, `checks fail after bringing ${target} into ${task.branch} (${j.fail} failing${fresh}) — the task branch now contains ${target}; fix it in the lane, then accept again${red}`, tests);
    };
    let checkedAt = null, checkedPasses = 0;
    for (let pass = 0; pass < 6 && checkedPasses < 2 && !G.isAncestor(root, target, task.branch); pass++) {
      broughtTarget = true;
      const targetNow = G.headSha(root, target);
      // #56: 앞서 검사한 뒤 대상 브랜치에 들어온 것이 문서뿐이면 들이기만 하고 다시 검사하지 않는다
      const docsSince = checkedAt ? G.diffNames(root, checkedAt, targetNow) : [];
      const m = G.git(P.wt, [...G.identityArgs(P.wt), 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', `harness(${task.id}): bring ${target} up to date`, target], { allowFail: true, retryLock: true });
      if (!m.ok) {
        // 충돌로 멈춘 병합(미병합 경로가 있다)만 남긴다 — 그 밖의 실패(끝나지 않은 병합 등)는 빈 충돌 목록으로 알리지 않는다(G2 #5)
        if (!G.mergeInProgress(P.wt) || !G.unmergedFiles(P.wt).length) { S.writeTask(root, task); return refused(task, `could not bring ${target} into ${task.branch}: ${m.err.trim().slice(0, 300)}`); }
        S.writeTask(root, task); return refused(task, leaveConflicts(root, task, P, target));
      } else task.commits.push(G.headSha(P.wt));
      S.log(root, task.id, { event: 'target_merged', target });
      // [자동 이슈 #31] --force 는 사용자가 검사 결과를 알고 합치기로 한 것 — 대상을 들인 뒤의 검사도 건너뛴다(기록은 남긴다)
      if (o.force) S.log(root, task.id, { event: 'checks', phase: 'accept', why: 'target brought in', verdict: 'skipped', skipped: 'force' });
      else if (task.checks.commands.length && docsOnly(docsSince)) S.log(root, task.id, { event: 'checks', phase: 'accept', why: 'target brought in', verdict: 'skipped', skipped: 'docs only since the last check', files: docsSince.slice(0, 20) });
      else if (task.checks.commands.length) { const no = await checkHere('target brought in', targetNow); if (no) return no; checkedPasses++; }
      checkedAt = targetNow;
    }
    // [G2 #1] 빠졌던 검사를 되살렸다 — 대상을 들이며 재지 않았으면 여기서 잰다
    if (reverify && !checkedNow && task.checks.commands.length) {
      const no = await checkHere('checks restored after unverified'); if (no) return no;
    }
    // 대상 브랜치를 새로 들이지 않았어도, 마지막으로 기록된 검사가 실패면 다시 잰다 — [2026-10-20 실측 · 작업 수치에서 발견]
    //   위에서 거절된 작업을 다시 accept 하면 이미 들인 상태라 위 고리를 건너뛰어 검사 없이 병합됐다(실패 0 → 133 인 채로 사용자 브랜치에).
    //   --force(사용자가 실패를 알고 병합)면 다시 재지 않는다.
    if (!broughtTarget && !checkedNow && !o.force && task.checks.commands.length && task.checks.last && K.judge(task.checks.last, task.checks.baseline, { notWorse: task.checks.source !== 'user' }).verdict === 'fail') {
      const no = await checkHere('last recorded checks failed'); if (no) return no;
    }
    // thin: 작업이 끝 검사를 미뤘다 — 합치기 전에 여기서 처음 잰다(실패면 기준선과 비교해 나빠졌을 때만 막는다). --force 면 재지 않는다.
    //   light 칸은 앞서 잰 결과(check <id>)가 있어도 다시 잰다 — 그 뒤에도 사람이 커밋했을 수 있다(턴마다 지우는 루프가 없다).
    if (!broughtTarget && !checkedNow && !o.force && task.checks.commands.length && task.checks.deferred && (!task.checks.last || task.mode === 'light')) {
      const no = await checkHere('deferred checks (thin)'); if (no) return no;
    }
    // 린트 — 대상 브랜치를 들인 뒤에도 작업이 바꾼 파일에서 다시 본다(그 뒤의 커밋 · 대상 브랜치가 깨뜨릴 수 있다).
    //   [2026-10-14 자동 이슈 #3] 새로 만든 worktree 는 빌드 · 복원 산출물이 없어(--no-restore 린트) 예전 go 작업에서 통과한 린트가 거절됐다 —
    //   그 작업이 끝난 뒤 바뀐 것이 없으면 그때의 통과(task.checks.lint.last)를 그대로 쓴다.
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
        const dirtyBefore = new Set(G.dirtyFiles(P.wt).map(e => e.path));
        const lr = await K.runCheck(P.wt, argv, { timeoutMs: checkTimeout(task, o) });
        // [G2 #7] 린트(--fix 류)가 고쳐 쓴 추적 파일도 검사처럼 되돌린다 — 다음 accept 가 그것을 "미커밋 작업" 으로 커밋하지 않게
        const undone = undoCheckWrites(P.wt, dirtyBefore);
        if (undone.length) S.log(root, task.id, { event: 'check_writes_undone', phase: 'lint', files: undone.slice(0, 50) });
        S.log(root, task.id, { event: 'lint', phase: 'accept', ok: lr.ok, exit_code: lr.exit_code });
        // [2026-10-29 감사 G2 #20] v7 은 린트 기준선(baseline_ok)을 재지 않는다 — 작업 전부터 빨간 저장소 전체 린트가 모든 accept 를 막았다.
        //   저장소 전체 린트({files} 없음)가 실패하면 대상 끝에서 한 번 더 잰다: 거기서도 실패하면 작업 전부터 빨갛다 — 막지 않고 보고한다.
        //   {files} 린트(작업이 바꾼 파일만) · 예전 기록이 green 이던 린트(baseline_ok true)는 그대로 막는다. 예전 기록이 red(false)면 재지 않고 넘긴다.
        let preExisting = false;
        if (!lr.ok && !lt.files && lt.baseline_ok !== true) {
          if (lt.baseline_ok === false) preExisting = true;
          else { const tr = await B.lintAt(root, task, G.headSha(root, target), argv, { o: { checkTimeoutMs: checkTimeout(task, o) } }); preExisting = !!tr && !tr.ok; }
        }
        if (!lr.ok && preExisting) {
          S.log(root, task.id, { event: 'lint', phase: 'accept', ok: false, pre_existing: true, command: lr.command });
          notes.push(`lint fails on ${target} too, before this work (${lr.command}): ${K.firstAssertion(lr).slice(0, 160)} — not blocking (it lints the whole repository; put {files} in lint_command to lint only the changed files)`);
        } else if (!lr.ok) { S.writeTask(root, task); return refused(task, `lint fails on ${task.branch} (${lr.command}): ${K.firstAssertion(lr).slice(0, 200)} — fix it in the lane, then accept again${lt.files ? '' : ' (this lints the whole repository; put {files} in lint_command to lint only the changed files — accept reads the current value — or accept --force)'}`); }
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
    const forced = was.status !== 'done' && !(task.mode === 'light' && was.status === 'open');
    if (forced) task.forced_from = { status: was.status, reason: was.reason };
    delete task.tag_error;
    S.writeTask(root, task);
    S.log(root, task.id, { event: 'accepted', merge_commit: merge, into: target, forced_from: forced ? was.status : null, leftovers: leftover.length || undefined });

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
    S.writeTask(root, task);
    const leftLines = ko => (leftover.length ? [`${ko ? '커밋되지 않았던 변경을 커밋해 함께 병합했다' : 'committed the uncommitted changes and merged them too'}: ${leftover.slice(0, 20).join(', ')}${leftover.length > 20 ? ` … (+${leftover.length - 20})` : ''}`] : []);
    if (isKo(task)) {
      const headKo = was.status === 'done' || (task.mode === 'light' && was.status === 'open') ? `pilot ${task.id} — 받아들임` : `pilot ${task.id} — 받아들임(강제) — 작업 상태는 ${was.status}: ${was.reason || '(이유 기록 없음)'}`;
      return out(task, { report: [headKo, `${task.branch} 를 ${target} 에 ${merge.slice(0, 10)} 로 병합했다${tagErr ? '' : `(태그 ${tag})`}.`, ...leftLines(true), ...notes.map(n => `참고(막지 않음): ${n}`),
        ...(tagErr ? [`경고: 태그 ${tag} 를 만들지 못했다: ${tagErr} — 병합은 작업 기록(merge_commit ${merge.slice(0, 10)})에 있어 cancel 은 그대로 된다`] : []),
        ...(task.worktree_kept ? [`작업 폴더(worktree) 남김: ${P.wt} (${task.worktree_kept})`] : []),
        `계획 보관: ${P.archiveDir}`, `되돌리기: node harness/cli.js cancel ${task.id}   (revert 커밋을 만든다 · reset 은 쓰지 않는다)`].join('\n') });
    }
    const head = was.status === 'done' || (task.mode === 'light' && was.status === 'open') ? `pilot ${task.id} — ACCEPTED` : `pilot ${task.id} — ACCEPTED (forced) — the task was ${was.status}: ${was.reason || '(no reason recorded)'}`;
    return out(task, { report: [head, `merged ${task.branch} into ${target} as ${merge.slice(0, 10)}${tagErr ? '' : ` (tag ${tag})`}.`, ...leftLines(false), ...notes.map(n => `note (not blocking): ${n}`),
      ...(tagErr ? [`warning: could not create tag ${tag}: ${tagErr} — the merge is recorded in the task (merge_commit ${merge.slice(0, 10)}); cancel still works`] : []),
      ...(task.worktree_kept ? [`worktree kept: ${P.wt} (${task.worktree_kept})`] : []),
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
      const runT = () => K.runAll(tmp, K.commandsForJudge(tmp, task.checks), { timeoutMs: checkTimeout(task, o), serialRoot: serialRootOf(root, task) });
      let j = await runT();
      if (!j.ok && !task.checks.baseline) { const before = JSON.stringify(task.checks.commands); await B.ensureBaseline(root, task, { o: { checkTimeoutMs: checkTimeout(task, o) }, log: (o && o.log) || (() => {}) }); if (JSON.stringify(task.checks.commands) !== before) j = await runT(); }
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
const cancelPre = (root, o) => task => {
  if (task.status === 'cancelled') return 'already cancelled';
  if (ownerBusy(task)) return `task is still running (pid ${task.owner.pid}); wait for it, or stop that session (claude agents)`;
  // 병합 전 취소는 그 worktree 를 커밋하고 지운다 — 산 세션이 일하는 중이면 멈춘다(병합 후 취소는 worktree 를 건드리지 않는다)
  if (task.status !== 'accepted') { const live = liveSessionWhy(root, task, o, 'cancel'); if (live) return live; }
  return null;
};
async function cancel(o) {
  const { root, task: task0, P, log } = load(o);
  const pre = cancelPre(root, o);
  const why0 = pre(task0);
  if (why0) return refused(task0, why0);
  return locked(root, task0, pre, async task => {
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
        // [2026-10-29 감사 G2 #0] accept 가 남긴 충돌 병합을 add -A 로 표식째 커밋해 태그에 남겼고, restore 뒤 accept 가 그 표식을 대상에 병합했다 —
        //   진행 중인 병합은 먼저 거둔다(그 병합 전 칸은 깨끗했다 — accept 가 미커밋분을 커밋한 뒤 들였다). 거두지 못하면 지우지 않고 거부.
        if (G.mergeInProgress(P.wt)) {
          const ab = G.git(P.wt, ['merge', '--abort'], { allowFail: true, retryLock: true });
          if (!ab.ok || G.mergeInProgress(P.wt)) { S.writeTask(root, task); return refused(task, `could not abort the merge left in ${P.wt}: ${String(ab.err || '').trim().slice(0, 200)} — resolve or abort it there, then cancel again`); }
          S.log(root, task.id, { event: 'conflict_merge_aborted', phase: 'cancel' });
        }
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
  if (!['done', 'failed', 'interrupted', 'capped', 'blocked', 'stalled'].includes(task0.status) && !(task0.mode === 'light' && task0.status === 'open')) return refused(task0, `task status is ${task0.status} — check runs on finished work`);
  return withTaskLock(root, task0, async () => {
    const task = S.readTask(root, task0.id);
    const live = liveSessionWhy(root, task, o, 'check');
    if (live) return refused(task, live);
    if (!(task.checks && task.checks.commands && task.checks.commands.length)) return out(task, { status: 'checked', report: `pilot ${task.id} — no checks found for this repository` });
    const wtWhy = ensureWorktree(root, task, P, o.removalWaitMs, log);
    if (wtWhy) return refused(task, wtWhy);
    // [2026-10-29 감사 G2 #7] check 는 검사가 고쳐 쓴 추적 파일을 되돌리지 않아 다음 accept 가 그것을 "미커밋 작업" 으로 커밋해 병합했다(#57 재발) — accept 처럼 되돌린다.
    const dirtyBefore = new Set(G.dirtyFiles(P.wt).map(e => e.path));
    const run1 = async () => (await K.runJudged(P.wt, K.commandsForJudge(P.wt, task.checks), { timeoutMs: checkTimeout(task, o), rerun: task.checks.rerun, serialRoot: serialRootOf(root, task) })).judged;
    let j = await run1();
    const laneRun = j;
    if (!j.ok && !task.checks.baseline && task.checks.source !== 'user') { const before = JSON.stringify(task.checks.commands); await B.ensureBaseline(root, task, { o: { checkTimeoutMs: checkTimeout(task, o) }, log }); if (JSON.stringify(task.checks.commands) !== before) j = await run1(); }
    const undone = undoCheckWrites(P.wt, dirtyBefore);
    if (undone.length) S.log(root, task.id, { event: 'check_writes_undone', phase: 'check', files: undone.slice(0, 50) });
    // [G2 #1] 기준선에서 시간 초과로 검사가 모두 빠졌으면 빈 실행(= 통과)으로 보고하지 않는다 — 레인의 결과로 unverified
    if (!task.checks.commands.length && (task.checks.dropped || []).length) {
      task.checks.last = K.brief(laneRun); task.checks.verdict = 'unverified';
      S.log(root, task.id, { event: 'checks', phase: 'check', verdict: 'unverified', pass: laneRun.pass, fail: laneRun.fail });
      S.writeTask(root, task);
      const ko = task.language === 'Korean';
      return out(task, { status: 'check-failed', verdict: 'unverified', report: [`pilot ${task.id} — ${ko ? '검사' : 'CHECKS'}: unverified (${laneRun.pass} ${ko ? '통과' : 'pass'} / ${laneRun.fail} ${ko ? '실패' : 'fail'})`,
        ko ? `작업 시작 커밋에서 검사가 시간 초과라(${task.checks.dropped.map(d => d.command).join(' ; ')}) 나빠졌는지 알 수 없다 — accept 는 다시 잰다(부하가 줄었을 때)` : `the checks timed out at the base commit (${task.checks.dropped.map(d => d.command).join(' ; ')}), so it is unknown whether this work made them worse — accept measures them again`].join('\n') });
    }
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

module.exports = { accept, cancel, restore, check, dirtyOverlap, archivePlan, acceptTarget, result, releaseResources, commitLeftovers, copyDir, isIndeterminate, serialRootOf, docsOnly, refuseKo, liveLaneSessions, MERGE_WAIT_MS };

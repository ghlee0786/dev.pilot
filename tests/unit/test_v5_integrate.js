'use strict';
// v5 통합 — accept(보관 · --no-ff 2부모 · 태그 · 미커밋 충돌 거부 · 대상이 앞서 가 충돌 → 작업 폴더에 병합을 남기고 거부 → 풀면 받아들임) · cancel(병합 전 · 병합 후 revert) · restore.
//   모델은 부르지 않는다: light 칸(lane.start)을 열고 그 worktree 에서 직접 커밋한다. 예전 go 작업(mode thin/full · status done 등)은
//   칸을 연 뒤 task.json 을 예전 모양으로 고쳐 만든다(받아들이기 하위 호환). 모든 저장소는 임시 디렉터리에 있다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const Ln = require('../../harness/lib/lane');
const I = require('../../harness/lib/integrate');
const R = makeReporter('v5 통합 — accept · cancel · restore');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-integ-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
let seq = 0;
// feature.txt 가 있고 충돌 표식이 없으면 통과.
const CHECK_JS = `const fs=require('fs');const v=fs.existsSync('feature.txt')?fs.readFileSync('feature.txt','utf8'):'';
if(v&&!/^(<<<<<<<|>>>>>>>)/m.test(v)){console.log('# pass 1\\n# fail 0');process.exit(0);}
console.log('AssertionError: feature.txt missing or conflicted');console.log('# pass 0\\n# fail 1');process.exit(1);`;
// 의존성 흉내: .env(무시됨 · .worktreeinclude 로 복사)가 없으면 실패 5개 — 환경 문제만으로 빨개지는 검사.
const CHECK_ENV_JS = `if(!require('fs').existsSync('.env')){console.log('Error: .env missing (dependency)');console.log('# pass 0\\n# fail 5');process.exit(1);}
${CHECK_JS}`;
const ENV_FILES = { '.gitignore': '.env\n*.log\n', '.worktreeinclude': '.env\n' };
function mkRepo(o) {
  const opt = o || {};
  const dir = path.join(base, `r${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  write(path.join(dir, 'check.js'), opt.check || CHECK_JS);
  write(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  write(path.join(dir, 'b.txt'), 'bee\n');
  for (const [f, t] of Object.entries(opt.files || {})) write(path.join(dir, f), t);
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  for (const [f, t] of Object.entries(opt.untracked || {})) write(path.join(dir, f), t);
  return dir;
}
function cliAsync(args, env) {
  return new Promise(res => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('close', code => res({ code, out, err }));
  });
}
const quiet = { log: () => {} };
const commitIn = (wt, msg) => { git(wt, ['add', '-A']); git(wt, ['commit', '-qm', msg]); };
// 기본 작업: feature.txt 를 만들고 a.txt 첫 줄을 바꾸고 PLAN.md 를 쓴다(이 칸의 worktree 에서 커밋).
const work = (line1) => (wt, id) => {
  write(path.join(wt, 'feature.txt'), 'feature\n');
  if (line1) write(path.join(wt, 'a.txt'), `${line1}\ntwo\nthree\n`);
  write(path.join(wt, '.harness', id, 'PLAN.md'), '# plan\n- [x] feature\n');
};
// light 칸을 열고(lane.start) edit 으로 그 worktree 를 고쳐 커밋한다 → start 의 결과(status 'open')
function laneDone(root, edit, o) {
  const opt = o || {};
  const t = Ln.start({ ...quiet, root, goal: opt.goal || 'add the feature\nwith details', checks: opt.checks || ['node check.js'], base: opt.base, checkTimeoutMs: opt.checkTimeoutMs });
  edit(t.worktree, t.id);
  commitIn(t.worktree, 'work');
  return t;
}
const dropWt = (root, t) => git(root, ['worktree', 'remove', '--force', S.taskPaths(root, t.id).wt]);
// 예전 go 작업처럼 보이게: 끝난 go 는 worktree 를 지웠고 head 를 적었다. thin 은 검사를 미뤘고(deferred · last 없음), full 은 루프에서 잰 결과(last)가 있다.
const PASS_BRIEF = { ok: true, pass: 1, fail: 0, failed_tests: [], indeterminate: false, results: [{ command: 'node check.js', ok: true, pass: 1, fail: 0, exit_code: 0, timed_out: false, found: true }] };
function asOld(root, t, f) {
  dropWt(root, t);
  const task = S.readTask(root, t.id);
  Object.assign(task, { mode: f.mode, status: f.status, reason: f.reason || 'the work is done', session_id: 'S-old', head: git(root, ['rev-parse', t.branch]), runtime: 'claude', model: 'opus' });
  delete task.checks.baseline_mode;
  if (f.mode === 'full') { delete task.checks.deferred; task.checks.last = f.last || PASS_BRIEF; task.checks.verdict = task.checks.last.ok ? 'pass' : 'fail'; }
  else { task.checks.deferred = true; task.checks.last = null; }
  if (f.lint && task.checks.lint) Object.assign(task.checks.lint, f.lint);
  S.writeTask(root, task);
  return { ...t, status: task.status, reason: task.reason };
}
const parents = (cwd, ref) => git(cwd, ['rev-list', '--parents', '-n', '1', ref]).split(/\s+/).length - 1;
const hasMergeHead = cwd => spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }).status === 0;

(async () => {
  try {
    // ── accept: 기본(light 칸) ───────────────────────────────────────
    const r1 = mkRepo();
    const t1 = laneDone(r1, work('ONE'));
    const before = git(r1, ['rev-parse', 'main']);
    R.check('[IN-00] 준비: 칸 open · main 은 그대로', t1.status === 'open' && S.readTask(r1, t1.id).mode === 'light' && git(r1, ['rev-parse', 'main']) === before, `${t1.status} ${t1.reason}`);
    const acc = await I.accept({ ...quiet, root: r1, id: t1.id });
    const task1 = S.readTask(r1, t1.id);
    const head1 = git(r1, ['rev-parse', 'main']);
    R.check('[IN-01] accept → accepted · main 에 병합 커밋(부모 2) · 메시지', acc.status === 'accepted' && !acc.refused && parents(r1, 'main') === 2 && git(r1, ['log', '-1', '--format=%s', 'main']) === `harness: accept ${t1.id} — add the feature`, `${acc.status} ${acc.reason}`);
    R.check('[IN-01] 첫 부모 = 이전 main · 태그 harness/merged/<id> = 병합 커밋', git(r1, ['rev-parse', 'main^1']) === before && git(r1, ['rev-parse', `harness/merged/${t1.id}^{commit}`]) === head1 && task1.merge_commit === head1 && task1.accepted_into === 'main');
    R.check('[IN-01] 대상 브랜치에 .harness/<id> 가 없다 · 기능은 있다', !git(r1, ['ls-tree', '-r', '--name-only', 'main']).includes('.harness/') && read(path.join(r1, 'feature.txt')) === 'feature\n' && read(path.join(r1, 'a.txt')).startsWith('ONE\n'));
    R.check('[IN-01] PLAN.md 는 tasks/<id>/archive/ 로 보관', read(path.join(S.taskPaths(r1, t1.id).archiveDir, 'PLAN.md')) === '# plan\n- [x] feature\n');
    R.check('[IN-01] 메인 체크아웃은 깨끗 · worktree 없음 · 잠금 해제', git(r1, ['status', '--porcelain']) === '' && !fs.existsSync(S.taskPaths(r1, t1.id).wt) && !fs.existsSync(S.lockDir(r1, 'merge')) && !fs.existsSync(S.lockDir(r1, `task-${t1.id}`)));
    const acc2 = await I.accept({ ...quiet, root: r1, id: t1.id });
    R.check('[IN-01] 두 번 accept 는 거부 · 아무것도 바뀌지 않음', acc2.refused === true && git(r1, ['rev-parse', 'main']) === head1);

    // ── cancel(병합 후) → revert 커밋 · restore ───────────────────────
    const can = await I.cancel({ ...quiet, root: r1, id: t1.id });
    const task1c = S.readTask(r1, t1.id);
    const head1c = git(r1, ['rev-parse', 'main']);
    R.check('[IN-02] 병합 후 cancel → cancelled · main 에 일반 revert 커밋(부모 1, 이전 HEAD 위)', can.status === 'cancelled' && !can.refused && parents(r1, 'main') === 1 && git(r1, ['rev-parse', 'main^']) === head1 && task1c.revert_commit === head1c, `${can.status} ${can.reason}`);
    R.check('[IN-02] 내용이 병합 전으로 돌아간다 · 히스토리는 남는다(reset 없음)', read(path.join(r1, 'feature.txt')) === null && read(path.join(r1, 'a.txt')) === 'one\ntwo\nthree\n' && git(r1, ['merge-base', '--is-ancestor', head1, 'main']) === '' && spawnSync('git', ['merge-base', '--is-ancestor', head1, 'main'], { cwd: r1 }).status === 0);
    R.check('[IN-02] revert 검증용 임시 worktree 가 남지 않는다', git(r1, ['worktree', 'list']).split(/\r?\n/).length === 1 && git(r1, ['status', '--porcelain']) === '');
    const rs = await I.restore({ ...quiet, root: r1, id: t1.id });
    R.check('[IN-03] restore → revert 의 revert · 내용 복귀 · 상태 accepted', rs.status === 'restored' && S.readTask(r1, t1.id).status === 'accepted' && read(path.join(r1, 'feature.txt')) === 'feature\n' && read(path.join(r1, 'a.txt')).startsWith('ONE\n') && git(r1, ['rev-parse', 'main^']) === head1c && parents(r1, 'main') === 1, `${rs.status} ${rs.reason}`);

    // ── accept 거부: 메인 체크아웃의 미커밋 변경이 작업이 건드린 파일과 겹침 — 예전 go 작업(thin · done · worktree 없음)으로 ─
    const r2 = mkRepo();
    const t2 = asOld(r2, laneDone(r2, work('TASK')), { mode: 'thin', status: 'done' });
    write(path.join(r2, 'a.txt'), 'my own edit\n');
    const mainBefore = git(r2, ['rev-parse', 'main']), branchBefore = git(r2, ['rev-parse', t2.branch]);
    const ref = await I.accept({ ...quiet, root: r2, id: t2.id });
    R.check('[IN-04] 미커밋 변경이 a.txt 에 있으면 accept 거부 · 이유에 파일 이름', ref.refused === true && /a\.txt/.test(ref.reason) && ref.status === 'done', `${ref.status} ${ref.reason}`);
    R.check('[IN-04] 아무것도 바뀌지 않음(main · 작업 브랜치 · 사용자 파일 · 태그 · 상태)', git(r2, ['rev-parse', 'main']) === mainBefore && git(r2, ['rev-parse', t2.branch]) === branchBefore && read(path.join(r2, 'a.txt')) === 'my own edit\n'
      && git(r2, ['tag', '--list', 'harness/*']) === '' && S.readTask(r2, t2.id).status === 'done' && !fs.existsSync(S.taskPaths(r2, t2.id).wt));
    write(path.join(r2, 'a.txt'), 'one\ntwo\nthree\n');
    write(path.join(r2, 'b.txt'), 'my unrelated edit\n');
    const ok2 = await I.accept({ ...quiet, root: r2, id: t2.id });
    R.check('[IN-04] 겹치지 않는 미커밋 변경(b.txt)은 막지 않고 그대로 남는다 · 예전 thin(done) 작업도 받아들인다', ok2.status === 'accepted' && read(path.join(r2, 'b.txt')) === 'my unrelated edit\n' && git(r2, ['status', '--porcelain']) === 'M b.txt'
      && /^pilot \S+ — ACCEPTED$/m.test(ok2.report || '') && S.readLog(r2, t2.id).some(e => e.event === 'checks' && e.phase === 'accept' && e.verdict === 'pass'), `${ok2.status} ${ok2.reason} ${git(r2, ['status', '--porcelain'])}`);
    const other = mkRepo();
    const t2b = laneDone(other, work(null));
    git(other, ['checkout', '-q', '-b', 'elsewhere']);
    const notOn = await I.accept({ ...quiet, root: other, id: t2b.id });
    R.check('[IN-04] 대상 브랜치가 어디에도 체크아웃되어 있지 않으면 거부', notOn.refused === true && /not checked out/.test(notOn.reason), notOn.reason);

    // ── accept: 대상이 앞서 가서 충돌 → 작업 폴더에 병합을 남기고 거부 → 표식이 남으면 다시 거부 → 풀면 받아들임 ─────────
    const r3 = mkRepo();
    const t3 = laneDone(r3, work('TASK'));
    const br3 = git(r3, ['rev-parse', t3.branch]);
    write(path.join(r3, 'a.txt'), 'USER\ntwo\nthree\n');
    git(r3, ['commit', '-qam', 'user moved ahead']);
    const main3 = git(r3, ['rev-parse', 'main']);
    const wt3 = S.taskPaths(r3, t3.id).wt;
    const acc3 = await I.accept({ ...quiet, root: r3, id: t3.id });
    R.check('[IN-05] 충돌 → 거부 · 이유에 대상 · 충돌 파일 · 남겨 둔 폴더 · main 그대로 · 상태 open', acc3.refused === true && /conflicts with main in a\.txt/.test(acc3.reason) && acc3.reason.includes(wt3) && /left in progress/.test(acc3.reason)
      && git(r3, ['rev-parse', 'main']) === main3 && S.readTask(r3, t3.id).status === 'open', `${acc3.status} ${acc3.reason}`);
    R.check('[IN-05] 병합은 칸의 worktree 에 진행 중으로 남는다(MERGE_HEAD · a.txt 에 충돌 표식) · 기록에 conflict_left', hasMergeHead(wt3) && /^<<<<<<< /m.test(read(path.join(wt3, 'a.txt')) || '')
      && S.readLog(r3, t3.id).some(e => e.event === 'conflict_left' && e.target === 'main' && (e.files || []).includes('a.txt')), read(path.join(wt3, 'a.txt')));
    R.check('[IN-05] 거부된 뒤 작업 브랜치에는 보관 커밋만 더해진다(작업 내용은 그대로)', git(r3, ['rev-parse', `${t3.branch}^`]) === br3 && git(r3, ['show', `${t3.branch}:a.txt`]).startsWith('TASK'));
    const acc3b = await I.accept({ ...quiet, root: r3, id: t3.id });
    R.check('[IN-05] 표식이 남은 채 다시 accept → 거부(표식이 남은 파일) · main 그대로 · 병합은 그대로 진행 중', acc3b.refused === true && /still has conflict markers in a\.txt/.test(acc3b.reason) && git(r3, ['rev-parse', 'main']) === main3 && hasMergeHead(wt3), `${acc3b.status} ${acc3b.reason}`);
    write(path.join(wt3, 'a.txt'), 'USER+TASK\ntwo\nthree\n');   // 그 칸의 세션(또는 사람)이 표식을 푼다 — 커밋은 accept 가 한다
    const acc3c = await I.accept({ ...quiet, root: r3, id: t3.id });
    R.check('[IN-05] 표식을 풀고 accept → accepted · 해결된 내용이 main 에 · 병합 커밋 부모 2(첫 부모 = 사용자 커밋)', acc3c.status === 'accepted' && !acc3c.refused && read(path.join(r3, 'a.txt')) === 'USER+TASK\ntwo\nthree\n' && parents(r3, 'main') === 2
      && git(r3, ['rev-parse', 'main^1']) === main3 && read(path.join(r3, 'feature.txt')) === 'feature\n', `${acc3c.status} ${acc3c.reason}`);
    R.check('[IN-05] 해결 커밋은 대상과 작업을 모두 부모로 가진 병합(대상이 결과 브랜치의 조상) · 표식 없음', spawnSync('git', ['merge-base', '--is-ancestor', main3, t3.branch], { cwd: r3 }).status === 0
      && !/^(<<<<<<<|>>>>>>>)/m.test(git(r3, ['show', 'main:a.txt'])) && !fs.existsSync(wt3), git(r3, ['log', '--oneline', '--graph', '-8', 'main']));

    // ── cancel(병합 전): 미커밋분은 먼저 커밋 → 태그로 남기고 브랜치 · worktree 버림 → restore — 예전 go 작업(interrupted)으로 ─
    const r4 = mkRepo();
    const i4 = asOld(r4, laneDone(r4, wt => write(path.join(wt, 'half.txt'), 'h'), { goal: 'half' }), { mode: 'thin', status: 'interrupted', reason: 'usage limit — resume after the reset' });
    const P4 = S.taskPaths(r4, i4.id);
    git(r4, ['worktree', 'add', '-q', P4.wt, i4.branch]);
    write(path.join(P4.wt, 'uncommitted.txt'), 'not yet committed\n');
    const c4 = await I.cancel({ ...quiet, root: r4, id: i4.id });
    const tag4 = `harness/cancelled/${i4.id}`;
    R.check('[IN-06] 병합 전 cancel → cancelled · 브랜치 · worktree 사라짐', c4.status === 'cancelled' && !c4.refused && git(r4, ['branch', '--list', i4.branch]) === '' && !fs.existsSync(P4.wt), `${c4.status} ${c4.reason}`);
    R.check('[IN-06] 지우기 전에 미커밋분을 커밋했다 — 태그에 남아 있다', git(r4, ['show', `${tag4}:uncommitted.txt`]) === 'not yet committed' && git(r4, ['show', `${tag4}:half.txt`]) === 'h');
    R.check('[IN-06] main 은 그대로', git(r4, ['log', '--format=%s', '-1', 'main']) === 'init' && git(r4, ['status', '--porcelain']) === '');
    const rs4 = await I.restore({ ...quiet, root: r4, id: i4.id });
    R.check('[IN-06] restore → 태그에서 브랜치 복원 · 이전 상태(interrupted)로', rs4.status === 'restored' && S.readTask(r4, i4.id).status === 'interrupted' && git(r4, ['show', `${i4.branch}:uncommitted.txt`]) === 'not yet committed' && git(r4, ['tag', '--list', tag4]) === '', `${rs4.status} ${rs4.reason}`);
    const main4 = git(r4, ['rev-parse', 'main']);
    const ac4n = await I.accept({ ...quiet, root: r4, id: i4.id });
    R.check('[IN-06][M3] 복원된 interrupted 작업은 --force 없이 accept 거부 · 이유가 상태와 원래 이유로 시작', ac4n.refused === true && /^task status is interrupted \(usage limit/.test(ac4n.reason) && /--force/.test(ac4n.reason) && git(r4, ['rev-parse', 'main']) === main4, `${ac4n.status} ${ac4n.reason}`);
    const ac4 = await I.accept({ ...quiet, root: r4, id: i4.id, force: true });
    R.check('[IN-06] 복원된 작업은 --force 로 다시 accept 할 수 있다', ac4.status === 'accepted' && read(path.join(r4, 'uncommitted.txt')) === 'not yet committed\n', ac4.reason);
    R.check('[IN-06][M3] 강제 accept 보고는 실패 이유를 앞세운다', /^pilot \S+ — ACCEPTED \(forced\) — the task was interrupted: usage limit/.test(ac4.report || ''), (ac4.report || '').split('\n')[0]);

    // ── 취소된 작업의 accept 거부 · CLI ─────────────────────────────
    const r5 = mkRepo();
    const t5 = laneDone(r5, work(null));
    const cliCancel = spawnSync(process.execPath, [CLI, 'cancel', t5.id, '--root', r5], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    R.check('[IN-07] CLI cancel: exit 0 · HARNESS_RESULT cancelled', cliCancel.status === 0 && /HARNESS_RESULT \{.*"status":"cancelled"/.test(cliCancel.stdout), `${cliCancel.status} ${cliCancel.stderr.slice(-300)}`);
    const cliAcc = spawnSync(process.execPath, [CLI, 'accept', t5.id, '--root', r5], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    R.check('[IN-07] CLI accept(취소된 작업): 거부 · exit 1 · refused', cliAcc.status === 1 && /"refused":true/.test(cliAcc.stdout) && /restore first/.test(cliAcc.stdout), `${cliAcc.status} ${cliAcc.stdout.slice(-300)}`);

    // ── [M1] 두 프로세스가 동시에 accept → 병합 커밋 하나 · 두 번째는 거부 ─────────
    //   대상이 앞서 가(충돌 없음) 결과 브랜치로 들인 뒤 느린 검사(1.5초)가 도는 동안 두 번째 프로세스는 낡은 task(open)를 읽고 잠금을 기다린다.
    const SLOW_CHECK_JS = `{const t=Date.now();while(Date.now()-t<1500){}}\n${CHECK_JS}`;
    const r6 = mkRepo({ check: SLOW_CHECK_JS });
    const t6 = laneDone(r6, work('TASK'));
    write(path.join(r6, 'b.txt'), 'USER\n');
    git(r6, ['commit', '-qam', 'user moved ahead']);
    const main6 = git(r6, ['rev-parse', 'main']);
    const both = await Promise.all([0, 1].map(() => cliAsync(['accept', t6.id, '--root', r6])));
    const task6 = S.readTask(r6, t6.id);
    // main 의 첫 부모 사슬 위 병합 커밋 = accept 가 main 에 만든 병합(결과 브랜치 안의 "bring main up to date" 병합은 제외).
    const merges6 = git(r6, ['rev-list', '--merges', '--first-parent', `${main6}..main`]).split(/\r?\n/).filter(Boolean);
    const tip6 = git(r6, ['rev-parse', t6.branch]);
    R.check('[IN-08][M1] 동시 accept 2개 → 정확히 하나만 exit 0 · 다른 하나는 거부(already accepted)', both.filter(x => x.code === 0).length === 1 && both.some(x => x.code === 1 && /"refused":true/.test(x.out) && /already accepted/.test(x.out)),
      both.map(x => `${x.code} ${x.out.slice(-200)} ${x.err.slice(-200)}`).join(' | '));
    R.check('[IN-08][M1] main 에 만들어진 병합 커밋은 정확히 하나', merges6.length === 1 && git(r6, ['log', '--first-parent', '--format=%s', `${main6}..main`]).split(/\r?\n/).filter(s => s.startsWith('harness: accept')).length === 1, JSON.stringify(merges6));
    R.check('[IN-08][M1] 기록된 merge_commit = main 끝 · 그 둘째 부모 = 결과 브랜치 끝 · 첫 부모 = 사용자 커밋', task6.status === 'accepted' && task6.merge_commit === git(r6, ['rev-parse', 'main']) && git(r6, ['rev-parse', `${task6.merge_commit}^2`]) === tip6 && git(r6, ['rev-parse', `${task6.merge_commit}^1`]) === main6,
      `${task6.status} ${task6.merge_commit} main=${git(r6, ['rev-parse', 'main'])} tip=${tip6}`);

    // ── [M1] 병합이 커밋을 만들지 않으면(이미 들어 있음) 사용자 커밋을 merge_commit 으로 기록하지 않는다 ─
    const r7 = mkRepo();
    const t7 = laneDone(r7, wt => write(path.join(wt, 'feature.txt'), 'feature\n'), { goal: 'plain feature' });
    git(r7, ['merge', '--ff-only', '-q', t7.branch]);
    const head7 = git(r7, ['rev-parse', 'main']);
    const a7 = await I.accept({ ...quiet, root: r7, id: t7.id });
    const task7 = S.readTask(r7, t7.id);
    R.check('[IN-09][M1] "Already up to date" 병합은 거부 · merge_commit 미기록 · 태그 없음 · main 그대로', t7.status === 'open' && a7.refused === true && /no merge commit|already contains/.test(a7.reason) && !task7.merge_commit && task7.status === 'open'
      && git(r7, ['rev-parse', 'main']) === head7 && git(r7, ['tag', '--list', 'harness/*']) === '', `${t7.status} ${a7.status} ${a7.reason} mc=${task7.merge_commit}`);

    // ── [M2] 태그 생성이 실패해도 병합은 기록된다 ───────────────────────────
    const r8 = mkRepo();
    const t8 = laneDone(r8, work(null));
    git(r8, ['tag', 'harness/merged', 'HEAD']);   // refs/tags/harness/merged 가 있으면 refs/tags/harness/merged/<id> 를 만들 수 없다
    let a8; try { a8 = await I.accept({ ...quiet, root: r8, id: t8.id }); } catch (e) { a8 = { threw: e.message }; }
    const task8 = S.readTask(r8, t8.id);
    R.check('[IN-10][M2] 태그 실패 → 예외 없이 accepted · merge_commit = main 끝(부모 2)', !a8.threw && a8.status === 'accepted' && task8.status === 'accepted' && task8.merge_commit === git(r8, ['rev-parse', 'main']) && parents(r8, 'main') === 2, `${a8.threw || a8.reason} ${task8.status}`);
    R.check('[IN-10][M2] 태그 실패는 기록 · 보고에 남는다', !!task8.tag_error && /tag/.test(a8.report || '') && /could not create tag/.test(a8.report || ''), `${task8.tag_error} ${a8.report}`);
    const c8 = await I.cancel({ ...quiet, root: r8, id: t8.id });
    R.check('[IN-10][M2] 기록된 병합은 cancel 로 되돌릴 수 있다', c8.status === 'cancelled' && !c8.refused && read(path.join(r8, 'feature.txt')) === null, `${c8.status} ${c8.reason}`);

    // ── [M3] done 이 아닌 작업은 --force 없이 accept 거부 — 예전 go 작업(full · stalled)으로 ─────────────────
    const r9 = mkRepo();
    const FAIL_BRIEF = { ok: false, pass: 0, fail: 1, failed_tests: [], indeterminate: false, results: [{ command: 'node check.js', ok: false, pass: 0, fail: 1, exit_code: 1, timed_out: false, found: true }] };
    const t9 = asOld(r9, laneDone(r9, wt => write(path.join(wt, 'half.txt'), 'x\n'), { goal: 'never works' }),
      { mode: 'full', status: 'stalled', reason: 'the same check failure twice in a row: AssertionError: feature.txt missing or conflicted', last: FAIL_BRIEF });
    const main9 = git(r9, ['rev-parse', 'main']);
    const a9 = await I.accept({ ...quiet, root: r9, id: t9.id });
    R.check('[IN-11][M3] stalled 작업: 거부 · 이유가 상태와 실패 이유로 시작 · --force 안내 · main 그대로', t9.status === 'stalled' && a9.refused === true && a9.reason.startsWith(`task status is stalled (${t9.reason.slice(0, 20)}`) && /--force/.test(a9.reason) && git(r9, ['rev-parse', 'main']) === main9,
      `${t9.status} ${a9.status} ${a9.reason}`);
    const a9f = await I.accept({ ...quiet, root: r9, id: t9.id, force: true });
    R.check('[IN-11][M3] --force 면 병합 · 보고 첫 줄이 실패 이유를 앞세운다', a9f.status === 'accepted' && parents(r9, 'main') === 2 && /^pilot \S+ — ACCEPTED \(forced\) — the task was stalled: /.test(a9f.report), (a9f.report || a9f.reason).split('\n')[0]);

    // ── [M4] accept 는 git 밖(무시된) 산출물이 있는 worktree 를 지우지 않는다 ─
    const r10 = mkRepo({ files: ENV_FILES, untracked: { '.env': 'TOKEN=1\n' } });
    const t10 = laneDone(r10, work(null));
    const a10 = await I.accept({ ...quiet, root: r10, id: t10.id });
    R.check('[IN-13][M4] .worktreeinclude 복사분(.env)만 있으면 accept 뒤 worktree 는 지워진다', a10.status === 'accepted' && !fs.existsSync(S.taskPaths(r10, t10.id).wt) && !S.readTask(r10, t10.id).worktree_kept, `${a10.status} ${a10.reason} kept=${S.readTask(r10, t10.id).worktree_kept}`);
    const r11 = mkRepo({ files: ENV_FILES, untracked: { '.env': 'TOKEN=1\n' } });
    const t11 = laneDone(r11, work(null));
    const P11 = S.taskPaths(r11, t11.id);
    if (!fs.existsSync(P11.wt)) git(r11, ['worktree', 'add', '-q', P11.wt, t11.branch]);
    write(path.join(P11.wt, 'out.log'), 'build output the user wants\n');
    const a11 = await I.accept({ ...quiet, root: r11, id: t11.id });
    const task11 = S.readTask(r11, t11.id);
    R.check('[IN-13][M4] 무시된 파일(out.log)이 바뀐 worktree 는 accept 뒤에도 남는다 · 파일 그대로', a11.status === 'accepted' && read(path.join(P11.wt, 'out.log')) === 'build output the user wants\n', `${a11.status} ${a11.reason}`);
    R.check('[IN-13][M4] 남긴 이유(worktree_kept)에 파일 이름 · 보고에도', /out\.log/.test(task11.worktree_kept || '') && /out\.log/.test(a11.report || ''), `${task11.worktree_kept} | ${a11.report}`);

    // ── [M7] cancel/restore 의 임시 worktree 에도 .worktreeinclude 복사 · --skip-checks ─
    const r12 = mkRepo({ check: CHECK_ENV_JS, files: ENV_FILES, untracked: { '.env': 'TOKEN=1\n' } });
    const t12 = laneDone(r12, work(null));
    const a12 = await I.accept({ ...quiet, root: r12, id: t12.id });
    const bl12 = S.readTask(r12, t12.id).checks.baseline;
    R.check('[IN-14] 준비: 의존성(.env) 검사 저장소에서 칸(open) → accepted', t12.status === 'open' && a12.status === 'accepted' && ([null, undefined].includes(bl12) || bl12.fail === 1), `${t12.status} ${t12.reason} ${a12.reason}`);
    const c12 = await I.cancel({ ...quiet, root: r12, id: t12.id });
    R.check('[IN-14][M7] 병합 후 cancel: 임시 revert worktree 에 .env 가 복사되어 검사가 환경 탓으로 빨개지지 않는다', c12.status === 'cancelled' && !c12.refused && read(path.join(r12, 'feature.txt')) === null, `${c12.status} ${c12.reason}`);
    const rs12 = await I.restore({ ...quiet, root: r12, id: t12.id });
    R.check('[IN-14][M7] restore 도 같다(사용자 검사 통과 필요)', rs12.status === 'restored' && read(path.join(r12, 'feature.txt')) === 'feature\n', `${rs12.status} ${rs12.reason}`);
    fs.rmSync(path.join(r12, '.env'));   // 이제 환경 자체가 깨졌다
    const main12 = git(r12, ['rev-parse', 'main']);
    const c12b = await I.cancel({ ...quiet, root: r12, id: t12.id });
    R.check('[IN-14][M7] 환경이 깨지면 cancel 은 검사 실패로 거부 · main 그대로', c12b.refused === true && /checks fail/.test(c12b.reason) && git(r12, ['rev-parse', 'main']) === main12, `${c12b.status} ${c12b.reason}`);
    const c12s = await I.cancel({ ...quiet, root: r12, id: t12.id, skipChecks: true });
    R.check('[IN-14][M7] cancel --skip-checks → cancelled · 보고에 검사 생략 명시', c12s.status === 'cancelled' && !c12s.refused && read(path.join(r12, 'feature.txt')) === null && /checks skipped/.test(c12s.report || '')
      && S.readLog(r12, t12.id).some(e => e.event === 'checks' && e.phase === 'cancel' && e.verdict === 'skipped'), `${c12s.status} ${c12s.reason}`);
    const rs12b = await I.restore({ ...quiet, root: r12, id: t12.id });
    R.check('[IN-14][M7] 환경이 깨지면 restore 도 거부', rs12b.refused === true && /checks fail/.test(rs12b.reason), `${rs12b.status} ${rs12b.reason}`);
    const rs12s = await I.restore({ ...quiet, root: r12, id: t12.id, skipChecks: true });
    R.check('[IN-14][M7] restore --skip-checks → restored · 보고에 검사 생략 명시', rs12s.status === 'restored' && read(path.join(r12, 'feature.txt')) === 'feature\n' && /checks skipped/.test(rs12s.report || ''), `${rs12s.status} ${rs12s.reason}`);

    // ── [L5] 잘못된 id 는 진입점에서 거부(경로 이탈 금지) ─────────────────────
    const r14 = mkRepo();
    const evilId = '../../evil';
    const evilFile = path.join(S.paths(r14).tasksDir, evilId, 'task.json');
    write(evilFile, JSON.stringify(S.newTask({ id: evilId, goal: 'evil', status: 'cancelled', branch: 'main', base_branch: 'main', merge_commit: null })));
    for (const [name, fn] of [['accept', I.accept], ['cancel', I.cancel], ['restore', I.restore]]) {
      let err = null, res = null;
      try { res = await fn({ ...quiet, root: r14, id: evilId }); } catch (e) { err = e; }
      R.check(`[IN-15][L5] ${name} '../../evil' → USAGE 오류(invalid task id) · 경로 밖 task.json 을 읽지 않는다`, err && err.code === 'USAGE' && /invalid task id/.test(err.message), err ? `${err.code} ${err.message}` : JSON.stringify(res && res.reason));
    }
    const cliBadId = spawnSync(process.execPath, [CLI, 'cancel', evilId, '--root', r14], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    R.check('[IN-15][L5] CLI cancel ../../evil → exit 2', cliBadId.status === 2 && /invalid task id/.test(cliBadId.stderr), `${cliBadId.status} ${cliBadId.stderr.slice(-200)}`);

    // ── [버그 2026-10-01 · Python 서비스 저장소] 멈춘 작업의 cancel: 등록이 사라진 빈 worktree 폴더 ──
    //   재현: 작업을 멈춘 뒤 cancel → 등록은 지워지고 빈 폴더만 남음 → 다시 cancel 하면 그 폴더에서 git 이 메인 저장소를 보고
    //   사용자 브랜치의 남의 미커밋 변경을 하네스 이름으로 커밋할 수 있었다.
    const r16 = mkRepo();
    const t16 = laneDone(r16, work());
    dropWt(r16, t16);
    const P16 = S.taskPaths(r16, t16.id);
    const main16 = git(r16, ['rev-parse', 'HEAD']);
    // 상태를 "주인이 죽은 실행 중" 으로 되돌리고, 등록 없는 빈 폴더를 남기고, 메인 체크아웃에 남의 미커밋 변경을 둔다.
    const task16 = S.readTask(r16, t16.id);
    Object.assign(task16, { status: 'running', owner: { pid: 999999, host: os.hostname(), heartbeat_at: new Date().toISOString() } });
    S.writeTask(r16, task16);
    fs.mkdirSync(path.join(P16.wt, 'sub'), { recursive: true });
    write(path.join(r16, 'b.txt'), 'someone else is editing this\n');
    const c16 = await I.cancel({ ...quiet, root: r16, id: t16.id });
    R.check('[IN-16] 등록 없는 빈 폴더가 남아도 cancel 은 사용자 브랜치에 아무것도 커밋하지 않는다', git(r16, ['rev-parse', 'HEAD']) === main16 && /someone else/.test(read(path.join(r16, 'b.txt'))) && /b\.txt/.test(git(r16, ['status', '--porcelain'])), `${git(r16, ['log', '--oneline', '-2'])} | ${git(r16, ['status', '--porcelain'])}`);
    R.check('[IN-16] 빈 폴더를 치우고 cancelled 로 닫는다(작업물은 태그에)', c16.status === 'cancelled' && !fs.existsSync(P16.wt) && git(r16, ['tag', '-l', `harness/cancelled/${t16.id}`]) === `harness/cancelled/${t16.id}`, JSON.stringify({ status: c16.status, reason: c16.reason, wt: fs.existsSync(P16.wt) }));
    // 비어 있지 않은 남은 폴더(등록 없음) — 사용자 브랜치에 커밋하지 않는다. 남은 파일은 지우지 않고 작업 기록에 보관한 뒤 치우고 닫는다(자동 이슈 #11).
    const r17 = mkRepo();
    const t17 = laneDone(r17, work());
    dropWt(r17, t17);
    const P17 = S.taskPaths(r17, t17.id), main17 = git(r17, ['rev-parse', 'HEAD']);
    write(path.join(P17.wt, 'stray.txt'), 'left behind\n');
    write(path.join(r17, 'b.txt'), 'dirty elsewhere\n');
    const c17 = await I.cancel({ ...quiet, root: r17, id: t17.id });
    const lo17 = (fs.readdirSync(P17.dir).find(n => n.startsWith('leftover-')) || '');
    R.check('[IN-17] 등록 없는 폴더에 파일이 있어도 사용자 브랜치에 커밋하지 않고 · 남은 파일은 작업 기록에 보관한 뒤 cancelled', c17.status === 'cancelled' && git(r17, ['rev-parse', 'HEAD']) === main17 && /dirty elsewhere/.test(read(path.join(r17, 'b.txt'))) && !!lo17 && read(path.join(P17.dir, lo17, 'stray.txt')) === 'left behind\n', JSON.stringify({ status: c17.status, reason: c17.reason, lo17 }));
    // 최후 방어선: 하네스 커밋은 worktree 루트가 아니면 던진다(하위 폴더에서 부르면 위 저장소를 커밋할 뻔했다).
    const G = require('../../harness/lib/git');
    fs.mkdirSync(path.join(r17, 'nested'), { recursive: true });
    let thrown = null; try { G.commitAll(path.join(r17, 'nested'), 'x'); } catch (e) { thrown = e; }
    R.check('[IN-18] commitAll 은 worktree 루트가 아닌 폴더에서 NOT_WORKTREE_ROOT 로 거부한다', thrown && thrown.code === 'NOT_WORKTREE_ROOT' && git(r17, ['rev-parse', 'HEAD']) === main17, thrown ? thrown.message : 'no throw');

    // ── accept 의 검사는 작업에 기록된 검사 상한(check_timeout_min · --check-timeout-min)을 쓴다 ──
    //   [적대 2026-10-02] accept · cancel 은 o.checkTimeoutMs 만 봐서 작업의 상한(예: 20분 저장소)을 버리고 기본 15분으로 돌았다.
    const SLOW_JS = `if(require('fs').existsSync('slow.flag')){const t=Date.now();while(Date.now()-t<4000){}}\n${CHECK_JS}`;
    const r19 = mkRepo({ check: SLOW_JS });
    const t19 = laneDone(r19, work(), { goal: 'add the feature', checkTimeoutMs: 1500 });
    write(path.join(r19, 'slow.flag'), 'x\n'); git(r19, ['add', 'slow.flag']); git(r19, ['commit', '-qm', 'main moves on']);
    const a19 = await I.accept({ ...quiet, root: r19, id: t19.id });
    //   [Light 1단계] 시간 초과뿐인 실패는 "나빠짐" 이 아니라 판정 불가로 거절한다(예전 단언: /checks fail after bringing main/)
    R.check('[IN-19] accept 의 검사는 작업의 검사 상한(1.5초)을 쓴다 — 4초 걸리는 검사는 시간 초과로 거절(판정 불가 · 다시 하거나 --force)',
      t19.status === 'open' && S.readTask(r19, t19.id).checks.timeout_ms === 1500 && a19.refused && /checks undetermined on harness\/\S+ — every failing check timed out/.test(a19.reason) && /--force/.test(a19.reason) && !/worse than before/.test(a19.reason.replace('not "worse than before"', '')), `${t19.status} · ${a19.status} · ${a19.reason}`);
    // [2026-10-20 실측 · 작업 수치에서 발견] 거절 뒤 다시 accept 하면 이미 대상 브랜치를 들인 상태라 검사를 건너뛰어 실패 0 → 133 인 채로 병합됐다
    const main19 = git(r19, ['rev-parse', 'main']);
    const a19b = await I.accept({ ...quiet, root: r19, id: t19.id });
    R.check('[IN-19b] 검사 실패로 거절된 작업을 다시 accept 해도 검사를 다시 돌려 거절한다 — main 은 그대로',
      a19b.refused === true && /checks undetermined/.test(a19b.reason) && git(r19, ['rev-parse', 'main']) === main19, `${a19b.status} · ${a19b.refused} · ${a19b.reason}`);

    // ── accept 도 린트를 다시 본다 — 작업 뒤 결과 브랜치에 린트 위반이 들어오면 병합하지 않는다 ──
    const LINT = "const fs=require('fs');const bad=process.argv.slice(2).filter(f=>fs.existsSync(f)&&/TODO-SLOP/.test(fs.readFileSync(f,'utf8')));if(bad.length){console.log(bad.join(',')+': slop');process.exit(1)}";
    const r20 = mkRepo({ files: { 'lint.js': LINT, 'AGENTS.md': '```yaml\nlint_command: "node lint.js {files}"\n```\n' } });
    const t20 = laneDone(r20, work(), { goal: 'add the feature' });
    // 작업 뒤 결과 브랜치에 린트 위반이 커밋됐다
    write(path.join(t20.worktree, 'feature.txt'), 'feature TODO-SLOP\n'); commitIn(t20.worktree, 'slop');
    const a20 = await I.accept({ ...quiet, root: r20, id: t20.id });
    R.check('[IN-20] accept: 린트가 실패하면 병합하지 않는다(main 그대로)', t20.status === 'open' && a20.refused && /lint/.test(a20.reason) && git(r20, ['log', '-1', '--format=%s', 'main']) === 'init', `${a20.status} ${a20.reason}`);

    // ── 한국어 작업의 accept · cancel 보고는 한국어 ──
    const r21 = mkRepo();
    const t21 = laneDone(r21, work(), { goal: '기능을 추가해 줘' });
    const a21 = await I.accept({ ...quiet, root: r21, id: t21.id });
    const c21 = await I.cancel({ ...quiet, root: r21, id: t21.id });
    R.check('[IN-21] 한국어 작업: accept · cancel 보고가 한국어(명령 · 해시는 원문)', /받아들임/.test(a21.report) && /되돌리기: node harness\/cli\.js cancel/.test(a21.report) && /취소/.test(c21.report) && !/^(merged|reverted|undo)/m.test(a21.report + '\n' + c21.report), `${a21.report}\n--\n${c21.report}`);

    // ── [2026-10-14 자동 이슈 #1 · #2] Windows 에서 worktree 삭제가 끝나지 않았다(등록은 남고 .git 파일은 지워졌고
    //    파일 수천 개가 아직 지워지는 중). accept 가 NOT_WORKTREE_ROOT 예외로 죽었다(1분 뒤 다시 하면 성공). ──
    const halfRemoved = (r, t) => {
      const P = S.taskPaths(r, t.id);
      if (!fs.existsSync(P.wt)) git(r, ['worktree', 'add', '-q', P.wt, t.branch]);
      fs.rmSync(path.join(P.wt, '.git'), { force: true });   // 등록은 남고 .git 파일만 먼저 사라진 상태
      return P;
    };
    const r22 = mkRepo();
    const t22 = laneDone(r22, work());
    const P22 = halfRemoved(r22, t22);
    // 남은 파일은 1초 뒤 사라진다(다른 프로세스가 핸들을 놓는 것을 흉내)
    spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').rmSync(${JSON.stringify(P22.wt)},{recursive:true,force:true}),1000)`], { stdio: 'ignore', windowsHide: true });
    const a22 = await I.accept({ ...quiet, root: r22, id: t22.id, removalWaitMs: 15000 });
    R.check('[IN-22] 삭제 중인 worktree 가 곧 비워지면 accept 는 기다렸다가 병합한다', a22.status === 'accepted' && !a22.refused && parents(r22, 'main') === 2, `${a22.status} ${a22.reason}`);
    // [2026-10-15 자동 이슈 #11] 남은 폴더가 사라지지 않으면 사람이 지워야 했다 — 브랜치와 같은 파일은 지우고, 다른 파일은 작업 기록 폴더에 보관한 뒤 진행한다.
    const leftoverOf = (r, id) => { const d = S.taskPaths(r, id).dir; return (fs.readdirSync(d).find(n => n.startsWith('leftover-')) || null) && path.join(d, fs.readdirSync(d).find(n => n.startsWith('leftover-'))); };
    const r23 = mkRepo();
    const t23 = laneDone(r23, work());
    const P23 = halfRemoved(r23, t23);
    write(path.join(P23.wt, 'feature.txt'), 'changed after the task\n');   // 브랜치와 다른 파일
    write(path.join(P23.wt, 'stray.txt'), 'only here\n');                  // 브랜치에 없는 파일
    let a23 = null, e23 = null;
    try { a23 = await I.accept({ ...quiet, root: r23, id: t23.id, removalWaitMs: 500 }); } catch (e) { e23 = e; }
    const lo23 = leftoverOf(r23, t23.id);
    R.check('[IN-23] 남은 폴더(등록 없음)는 치우고 진행한다 — 브랜치와 다른 파일만 작업 기록에 보관(같은 파일은 보관하지 않는다)',
      !e23 && a23 && a23.status === 'accepted' && !!lo23 && read(path.join(lo23, 'stray.txt')) === 'only here\n' && read(path.join(lo23, 'feature.txt')) === 'changed after the task\n' && !fs.existsSync(path.join(lo23, 'a.txt')),
      e23 ? String(e23.stack).slice(0, 400) : `${a23 && a23.status} ${a23 && a23.reason} | ${lo23}`);

    // ── [2026-10-14 자동 이슈 #3] accept 가 새로 만든 worktree 에서 린트를 복원 없이 돌려 거절 — 루프에서는 빌드 산출물(obj/)이 있어 통과했다.
    //    작업 뒤 브랜치가 그대로이고 대상 브랜치를 들이지 않았으면 루프의 린트 통과를 그대로 쓴다 — 예전 go 작업(full · done · 루프 린트 통과)으로. ──
    const NEEDS_RESTORE = "if(!require('fs').existsSync('obj/restored.flag')){console.log('error: assets file not found; run restore');process.exit(1)}";
    const r24 = mkRepo({ files: { 'lint.js': NEEDS_RESTORE, '.gitignore': 'obj/\n', 'AGENTS.md': '```yaml\nlint_command: "node lint.js {files}"\n```\n' } });
    const t24 = asOld(r24, laneDone(r24, wt => {
      write(path.join(wt, 'obj', 'restored.flag'), 'x');   // 검사(빌드)가 남긴 복원 산출물 흉내 — 무시되므로 커밋되지 않고 worktree 와 함께 사라진다
      write(path.join(wt, 'feature.txt'), 'feature\n');
    }, { goal: 'add the feature' }), { mode: 'full', status: 'done', lint: { baseline_ok: true, last: { ok: true, exit_code: 0 } } });
    const a24 = await I.accept({ ...quiet, root: r24, id: t24.id });
    R.check('[IN-24] 작업 뒤 바뀐 것이 없으면 accept 는 루프에서 통과한 린트를 다시 돌리지 않는다(복원 없는 새 worktree 에서 거절되지 않는다)',
      t24.status === 'done' && a24.status === 'accepted' && !a24.refused && S.readLog(r24, t24.id).some(e => e.event === 'lint' && e.phase === 'accept' && e.reused), `${t24.status} ${t24.reason} | ${a24.status} ${a24.reason}`);

    // ── [2026-10-16 자동 이슈 #15] --base harness/<앞 작업> 으로 쌓은 작업 — accept 의 기본 대상이 그 harness 브랜치라 거부됐다 ──
    const r28 = mkRepo();
    const tA = laneDone(r28, work('ONE'));
    const tB = laneDone(r28, wt => write(path.join(wt, 'b.txt'), 'bee two\n'), { goal: 'more', base: tA.branch });
    const aB1 = await I.accept({ ...quiet, root: r28, id: tB.id });
    R.check('[IN-28] 앞 작업이 아직 받아들여지지 않았으면 무엇을 먼저 할지(앞 작업 accept · --into) 알려 주며 거부한다',
      tB.status === 'open' && tB.base_branch === tA.branch && aB1.refused && new RegExp(tA.id).test(aB1.reason) && /--into/.test(aB1.reason), `${tB.status} ${aB1.reason}`);
    await I.accept({ ...quiet, root: r28, id: tA.id });
    const aB2 = await I.accept({ ...quiet, root: r28, id: tB.id });
    R.check('[IN-28] 앞 작업을 받아들인 뒤에는 --into 없이 그 대상(main)으로 들인다', aB2.status === 'accepted' && S.readTask(r28, tB.id).accepted_into === 'main' && read(path.join(r28, 'b.txt')) === 'bee two\n', `${aB2.status} ${aB2.reason}`);

    // ── [2026-10-16 자동 이슈 #16] 편집기 · 빌드 서버가 남은 폴더를 잠가 accept 가 반복 거부됐다 — 그 자리를 못 비우면 옆 경로에 worktree 를 만들어 진행 ──
    {
      const r29 = mkRepo();
      const t29 = laneDone(r29, work());
      const P29 = halfRemoved(r29, t29);
      fs.mkdirSync(path.join(P29.wt, 'busy'), { recursive: true });
      // 이 폴더를 현재 디렉터리로 쓰는 프로세스(명령줄에는 경로가 없다 — 편집기 언어 서버처럼): Windows 에서는 폴더를 지울 수 없다
      const busy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: path.join(P29.wt, 'busy'), stdio: 'ignore', windowsHide: true });
      await new Promise(r => setTimeout(r, 400));
      const a29 = await I.accept({ ...quiet, root: r29, id: t29.id, removalWaitMs: 1500 });
      const alt = S.readLog(r29, t29.id).find(e => e.event === 'worktree_alt');
      const busyAlive = S.pidAlive(busy.pid);
      try { process.kill(busy.pid); } catch { /* 끝났다 */ }
      R.check('[IN-29] 잠긴 남은 폴더가 있어도 accept 는 진행한다(Windows: 옆 경로에 worktree 를 만든다) · 잠근 프로세스(편집기 같은)는 끝내지 않는다',
        a29.status === 'accepted' && (process.platform !== 'win32' || !!alt) && busyAlive, `${a29.status} ${a29.reason} ${JSON.stringify(alt)}`);
    }

    // 남은 폴더를 붙잡은 프로세스(폴더 안의 실행 파일 · 명령줄이 그 폴더를 가리킴 — 고아 testhost 같은)는 끝낸다
    const holdDir = path.join(base, 'hold-dir');
    write(path.join(holdDir, 'sleep.js'), 'setTimeout(()=>{},120000)');
    const holder = spawn(process.execPath, [path.join(holdDir, 'sleep.js')], { stdio: 'ignore', windowsHide: true });
    await new Promise(r => setTimeout(r, 500));
    const killed = require('../../harness/lib/git').killProcsIn(holdDir);
    await new Promise(r => setTimeout(r, 500));
    R.check('[IN-26] 폴더를 붙잡은 프로세스를 찾아 끝낸다(이 프로세스 · 조상은 빼고)', killed.some(k => k.pid === holder.pid) && !S.pidAlive(holder.pid), JSON.stringify(killed));
    // [2026-10-17 적대적 검증] 경로를 접두어로만 비교해 …/t-1 을 치우다 …/t-10(실제로는 <id> 와 옆 경로 <id>-2 의 살아 있는 작업)을 잡았다
    {
      const p1 = path.join(base, 'wt-pre', 't-1'), p10 = path.join(base, 'wt-pre', 't-1-2');
      write(path.join(p10, 'sleep.js'), 'setTimeout(()=>{},60000)'); fs.mkdirSync(p1, { recursive: true });
      const other = spawn(process.execPath, [path.join(p10, 'sleep.js')], { stdio: 'ignore', windowsHide: true });
      await new Promise(r => setTimeout(r, 500));
      const found = require('../../harness/lib/git').procsIn(p1);
      try { process.kill(other.pid); } catch { /* 끝났다 */ }
      R.check('[IN-26b] 프로세스 정리는 그 폴더만 — 이름이 접두어인 옆 폴더(<id> 대 <id>-2)의 프로세스는 잡지 않는다', !found.some(k => k.pid === other.pid), JSON.stringify(found));
    }

    // IN-30 [자동 이슈 #54] Windows: MAX_PATH 를 넘는 경로가 든 worktree — git 이 'Filename too long' 으로 등록만 지우고 폴더를 남겼다.
    //   저장소 설정이 아니라 명령줄(-c core.longpaths=true)로만 긴 경로를 켜고 커밋해, 설정이 없는 저장소를 흉내 낸다.
    if (process.platform === 'win32') {
      const GL = require('../../harness/lib/git');
      const rl = path.join(base, 'longpath'); fs.mkdirSync(rl, { recursive: true });
      git(rl, ['init', '-q', '-b', 'main']); git(rl, ['config', 'user.name', 't']); git(rl, ['config', 'user.email', 't@example.invalid']); git(rl, ['config', 'commit.gpgsign', 'false']);
      const deep = ['d'.repeat(60), 'e'.repeat(60), 'f'.repeat(60), 'g'.repeat(60), 'h'.repeat(60)].join('/') + '/long-file-name.txt';
      write(path.join(rl, 'a.txt'), 'a\n'); write(path.join(rl, deep), 'deep\n');
      git(rl, ['-c', 'core.longpaths=true', 'add', '-A']); git(rl, ['-c', 'core.longpaths=true', 'commit', '-qm', 'deep path']);
      const lwt = path.join(rl, '.harness-worktrees', 't-20261029-000000-abcd');
      git(rl, ['-c', 'core.longpaths=true', 'worktree', 'add', '-q', '-b', 'harness/t-20261029-000000-abcd', lwt, 'main']);
      const before30 = fs.existsSync(path.join(lwt, deep));
      const rm30 = GL.removeWorktree(rl, lwt);
      R.check('[IN-30] (#54) 긴 경로(MAX_PATH 초과)가 든 깨끗한 worktree 도 지운다 — 등록 · 폴더 모두 · 브랜치는 남는다',
        before30 && rm30.ok && !fs.existsSync(lwt) && !GL.worktreeRegistered(rl, lwt) && GL.branchExists(rl, 'harness/t-20261029-000000-abcd'), JSON.stringify({ before30, rm30, left: fs.existsSync(lwt) }));
      const left = path.join(base, 'rdtree'); write(path.join(left, deep), 'x\n');
      R.check('[IN-30] rdTree: 긴 경로가 섞인 폴더를 rd /s /q "\\\\?\\…" 로 지운다', GL.rdTree(left) === true && !fs.existsSync(left));
    }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

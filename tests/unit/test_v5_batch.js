'use strict';
// 묶음(batch) — 끝난 칸 여럿을 harness/batch/<bid> 에 합치고(충돌은 건너뜀) 검사를 한 번 · .harness/ 는 묶음 브랜치에 들어가지 않는다 ·
//   대상도 원래 같은 실패면 not-worse(대상 끝 기준선 · 캐시) · batch accept(구성원 accepted · 대상이 움직였으면 거부) · drop · status.
//   모델은 부르지 않는다. 모든 저장소는 임시 디렉터리에 있다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const Lane = require('../../harness/lib/lane');
const B = require('../../harness/lib/batch');
const I = require('../../harness/lib/integrate');
const R = makeReporter('묶음 — batch · batch accept');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-batch-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
const quiet = { log: () => {} };
let seq = 0;
// 검사: 돌 때마다 counter 에 한 줄 · bad*.txt 하나마다 실패 1 · slow.flag 가 있으면 5초
const checkJs = counter => `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'x\\n');
if(fs.existsSync('slow.flag')){const t=Date.now();while(Date.now()-t<5000){}}
const bad=fs.readdirSync('.').filter(f=>/^bad.*\\.txt$/.test(f)).length;
if(bad){console.log('AssertionError: '+bad+' bad file(s)');console.log('# pass 1\\n# fail '+bad);process.exit(1);}
console.log('# pass 2\\n# fail 0');`;
function mkRepo(files) {
  const dir = path.join(base, `r${++seq}`), counter = path.join(base, `count-${seq}.txt`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  write(path.join(dir, 'check.js'), checkJs(counter));
  write(path.join(dir, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\n```\n');
  write(path.join(dir, 'shared.txt'), 'line\n');
  for (const [f, t] of Object.entries(files || {})) write(path.join(dir, f), t);
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return { dir, counter, runs: () => (read(counter) || '').split('\n').filter(Boolean).length, reset: () => { try { fs.rmSync(counter); } catch { /* 없음 */ } } };
}
const commitIn = (wt, file, text) => { write(path.join(wt, file), text); git(wt, ['add', '-A']); git(wt, ['commit', '-qm', `edit ${file}`]); };
const lane = (repo, goal, edits) => { const l = Lane.start({ ...quiet, root: repo.dir, goal }); const wt = S.taskPaths(repo.dir, l.id).wt; for (const [f, t] of Object.entries(edits)) commitIn(wt, f, t); return { ...l, wt }; };
const parents = (cwd, ref) => git(cwd, ['rev-list', '--parents', '-n', '1', ref]).split(/\s+/).length - 1;

(async () => {
  try {
    // ── 칸 둘 + 충돌하는 칸 하나 + 작업 기록 없는 브랜치 → 합치고 · 건너뛰고 · 검사 한 번 ─
    const A = mkRepo();
    const la = lane(A, 'lane a adds a', { 'a.txt': 'a\n', 'shared.txt': 'from a\n' });
    commitIn(la.wt, `.harness/${la.id}/PLAN.md`, '# plan of a\n');   // 칸이 커밋한 계획 폴더 — 묶음 브랜치에 들어가면 안 된다
    const lb = lane(A, 'lane b adds b', { 'b.txt': 'b\n' });
    const lc = lane(A, 'lane c edits shared', { 'shared.txt': 'from c\n' });
    git(A.dir, ['branch', 'feature-x', 'main']);
    const fx = path.join(base, 'fx-wt'); git(A.dir, ['worktree', 'add', '-q', fx, 'feature-x']); commitIn(fx, 'x.txt', 'x\n'); git(A.dir, ['worktree', 'remove', fx]);
    const mainA = git(A.dir, ['rev-parse', 'main']);
    A.reset();
    const b1 = await B.create({ ...quiet, root: A.dir, ids: [la.id, lb.id, lc.id], branches: ['feature-x'] });
    const rec1 = B.readBatch(A.dir, b1.id);
    const st = id => (rec1.members.find(m => m.id === id || m.branch === id) || {}).status;
    R.check('[BA-01] 합침: a · b · feature-x / 건너뜀: c(충돌 — shared.txt) · 판정 pass', b1.verdict === 'pass' && st(la.id) === 'merged' && st(lb.id) === 'merged' && st('feature-x') === 'merged' && st(lc.id) === 'skipped'
      && (rec1.members.find(m => m.id === lc.id).conflicts || []).includes('shared.txt'), JSON.stringify(rec1.members.map(m => [m.id || m.branch, m.status, m.conflicts])));
    R.check('[BA-01] 검사는 묶음에서 정확히 한 번 돌았다', A.runs() === 1, `runs=${A.runs()}`);
    const files1 = git(A.dir, ['ls-tree', '-r', '--name-only', rec1.branch]).split(/\r?\n/);
    R.check('[BA-01] 묶음 브랜치에 a · b · x 가 있고 .harness/ 는 없다 · 계획은 작업 기록에 보관', ['a.txt', 'b.txt', 'x.txt'].every(f => files1.includes(f)) && !files1.some(f => f.startsWith('.harness/'))
      && read(path.join(S.taskPaths(A.dir, la.id).archiveDir, 'PLAN.md')) === '# plan of a\n', files1.join(','));
    R.check('[BA-01] 사용자 브랜치(main)는 그대로 · 구성원은 아직 open · 기록 파일 · 보고(합침 · 건너뜀 · 충돌 파일)', git(A.dir, ['rev-parse', 'main']) === mainA && S.readTask(A.dir, la.id).status === 'open'
      && fs.existsSync(path.join(S.paths(A.dir).harnessDir, 'batches', `${b1.id}.json`)) && /합침 3개/.test(b1.report) && /건너뜀 1개/.test(b1.report) && /shared\.txt/.test(b1.report), b1.report);

    // ── batch accept → main 에 병합 · 구성원 accepted(병합 커밋 = 묶음 안의 그 구성원 병합) · 묶음 작업 폴더 제거 · 브랜치 유지 ─
    const tipB1 = git(A.dir, ['rev-parse', rec1.branch]);
    const acc1 = await B.accept({ root: A.dir, bid: b1.id });
    const ta = S.readTask(A.dir, la.id), tb = S.readTask(A.dir, lb.id);
    R.check('[BA-02] batch accept → main 에 --no-ff 병합(첫 부모 = 이전 main · 둘째 = 묶음 브랜치 끝)', acc1.status === 'accepted' && !acc1.refused && parents(A.dir, 'main') === 2 && git(A.dir, ['rev-parse', 'main^1']) === mainA && git(A.dir, ['rev-parse', 'main^2']) === tipB1
      && read(path.join(A.dir, 'a.txt')) === 'a\n' && read(path.join(A.dir, 'x.txt')) === 'x\n' && !fs.existsSync(path.join(A.dir, '.harness')), `${acc1.status} ${acc1.reason}`);
    R.check('[BA-02] 구성원 a · b 는 accepted(accepted_via = 묶음 · 대상 main) · 건너뛴 c 는 open 그대로', ta.status === 'accepted' && ta.accepted_via === b1.id && ta.accepted_into === 'main' && tb.status === 'accepted' && S.readTask(A.dir, lc.id).status === 'open'
      && git(A.dir, ['rev-parse', `${ta.merge_commit}^2`]) === git(A.dir, ['rev-parse', la.branch]), JSON.stringify({ a: ta.status, via: ta.accepted_via, c: S.readTask(A.dir, lc.id).status }));
    R.check('[BA-02] 묶음 작업 폴더 · 구성원 작업 폴더는 지워지고 묶음 브랜치는 남는다', !fs.existsSync(rec1.worktree) && !fs.existsSync(la.wt) && !fs.existsSync(lb.wt) && git(A.dir, ['branch', '--list', rec1.branch]).includes(rec1.branch));
    const again = await B.accept({ root: A.dir, bid: b1.id });
    R.check('[BA-02] 두 번 batch accept 는 거부', again.refused === true && /already accepted/.test(again.reason), again.reason);
    // 구성원 하나만 되돌린다 — cancel 은 그 구성원의 묶음 안 병합만 revert 한다
    const ca = await I.cancel({ ...quiet, root: A.dir, id: la.id });
    R.check('[BA-03] 묶음으로 받아들인 구성원의 cancel → 그 구성원만 되돌린다(a.txt 사라짐 · b.txt · x.txt 그대로)', ca.status === 'cancelled' && read(path.join(A.dir, 'a.txt')) === null && read(path.join(A.dir, 'b.txt')) === 'b\n' && read(path.join(A.dir, 'x.txt')) === 'x\n', `${ca.status} ${ca.reason}`);

    // ── 대상이 움직였으면 batch accept 거부 · drop ───────────────────────
    const M = mkRepo();
    const ld = lane(M, 'lane d', { 'd.txt': 'd\n' });
    const b2 = await B.create({ ...quiet, root: M.dir, ids: [ld.id] });
    write(path.join(M.dir, 'user.txt'), 'user moved on\n'); git(M.dir, ['add', '-A']); git(M.dir, ['commit', '-qm', 'user commit']);
    const mainM = git(M.dir, ['rev-parse', 'main']);
    const acc2 = await B.accept({ root: M.dir, bid: b2.id });
    R.check('[BA-04] 묶은 뒤 대상(main)이 움직이면 batch accept 거부(다시 batch) · main 그대로 · 구성원 open', b2.verdict === 'pass' && acc2.refused === true && /moved/.test(acc2.reason) && /batch again/.test(acc2.reason) && git(M.dir, ['rev-parse', 'main']) === mainM && S.readTask(M.dir, ld.id).status === 'open', `${b2.verdict} ${acc2.reason}`);
    const dr = B.drop({ root: M.dir, bid: b2.id });
    R.check('[BA-05] batch drop → 묶음 작업 폴더 · 브랜치 삭제 · 구성원은 그대로(open · 브랜치 있음) · status 에 dropped', dr.status === 'dropped' && !fs.existsSync(B.readBatch(M.dir, b2.id).worktree) && git(M.dir, ['branch', '--list', `harness/batch/${b2.id}`]) === ''
      && S.readTask(M.dir, ld.id).status === 'open' && git(M.dir, ['branch', '--list', ld.branch]).includes(ld.branch) && /dropped/.test(B.status({ root: M.dir }).report), `${dr.status} ${dr.reason}`);

    // ── 대상도 원래 같은 실패 → not-worse(대상 끝을 재서) · 더 나빠지면 fail(캐시된 기준선) · CLI --all ─
    const N = mkRepo({ 'bad1.txt': 'known failure on main\n' });
    const le = lane(N, 'lane e', { 'e.txt': 'e\n' });
    const cliB = spawnSync(process.execPath, [CLI, 'batch', '--all', '--root', N.dir], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const resB = JSON.parse((/HARNESS_RESULT (\{.*\})/.exec(cliB.stdout) || [0, 'null'])[1]) || {};
    const recB = B.readBatch(N.dir, resB.id) || {};
    R.check('[BA-06] CLI batch --all: 대상(main)도 같은 실패면 not-worse · exit 0 · 기준선은 대상 끝에서 잼', cliB.status === 0 && resB.verdict === 'not-worse' && (resB.members || []).some(m => m.id === le.id && m.status === 'merged') && recB.baseline && recB.baseline.fail === 1 && !recB.baseline.cached,
      `${cliB.status} ${cliB.stdout.slice(-500)} ${cliB.stderr.slice(-300)}`);
    const lf = lane(N, 'lane f breaks more', { 'bad2.txt': 'new failure\n' });
    const bf = await B.create({ ...quiet, root: N.dir, ids: [lf.id] });
    const recF = B.readBatch(N.dir, bf.id);
    R.check('[BA-07] 더 나빠지면 verdict fail · 같은 대상 커밋의 기준선은 캐시에서 다시 쓴다 · batch accept 는 --force 없이 거부', bf.verdict === 'fail' && recF.baseline && recF.baseline.cached === true
      && (await B.accept({ root: N.dir, bid: bf.id })).refused === true, JSON.stringify({ v: bf.verdict, base: recF.baseline }));

    // ── 시간 초과뿐인 실패 → indeterminate(대상 끝은 재지 않는다) ─────────────
    const T = mkRepo();
    const ls = lane(T, 'slow lane', { 'slow.flag': 'x\n' });
    const bs = await B.create({ ...quiet, root: T.dir, ids: [ls.id], checkTimeoutMs: 1500 });
    R.check('[BA-08] 실패가 모두 시간 초과 → verdict indeterminate · 대상 끝을 재지 않는다 · 보고에 판정 불가', bs.verdict === 'indeterminate' && !B.readBatch(T.dir, bs.id).baseline && /판정 불가/.test(bs.report), `${bs.verdict} ${bs.report}`);

    // ── 맞지 않는 구성원은 아무것도 만들기 전에 거부 ────────────────────────
    let eAcc = null; try { await B.create({ ...quiet, root: A.dir, ids: [lb.id] }); } catch (e) { eAcc = e; }
    const cliNone = spawnSync(process.execPath, [CLI, 'batch', '--root', M.dir], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    R.check('[BA-09] 받아들인 작업을 묶으려 하면 USAGE 거부 · 구성원 없이 batch 는 exit 2', eAcc && eAcc.code === 'USAGE' && /accepted/.test(eAcc.message) && cliNone.status === 2, `${eAcc && eAcc.message} | ${cliNone.status} ${cliNone.stderr.slice(0, 200)}`);
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

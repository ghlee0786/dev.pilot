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

    // ── [2026-10-29 감사] 묶은 뒤 cancel 한 구성원 · 묶은 뒤 더한 커밋 · 판정 뒤 묶음 브랜치에 더한 커밋은 batch accept 가 거부한다 ─
    {
      const X = mkRepo();
      const xa = lane(X, 'xa', { 'xa.txt': 'a\n' }), xb = lane(X, 'xb', { 'xb.txt': 'b\n' });
      const bx = await B.create({ ...quiet, root: X.dir, ids: [xa.id, xb.id] });
      await I.cancel({ ...quiet, root: X.dir, id: xa.id });
      const mainX = git(X.dir, ['rev-parse', 'main']);
      const ax = await B.accept({ root: X.dir, bid: bx.id });
      R.check('[BA-10] 묶은 뒤 cancel 한 구성원이 있으면 batch accept 거부 · main 그대로 · 그 작업은 cancelled 그대로', ax.refused === true && /cancelled/.test(ax.reason) && git(X.dir, ['rev-parse', 'main']) === mainX && S.readTask(X.dir, xa.id).status === 'cancelled' && read(path.join(X.dir, 'xa.txt')) === null, `${ax.status} ${ax.reason}`);
      const xc = lane(X, 'xc', { 'xc.txt': 'c\n' });
      const bc = await B.create({ ...quiet, root: X.dir, ids: [xc.id] });
      commitIn(xc.wt, 'xc2.txt', 'later\n');
      const ac = await B.accept({ root: X.dir, bid: bc.id });
      R.check('[BA-11] 묶은 뒤 칸에 더한 커밋이 있으면 batch accept 거부(다시 batch) · 칸은 open · worktree 그대로', ac.refused === true && /since (it was )?batch/.test(ac.reason) && S.readTask(X.dir, xc.id).status === 'open' && fs.existsSync(xc.wt), `${ac.status} ${ac.reason}`);
      const xd = lane(X, 'xd', { 'xd.txt': 'd\n' });
      const bd = await B.create({ ...quiet, root: X.dir, ids: [xd.id] });
      commitIn(bd.worktree, 'bad9.txt', 'sneaked in after the checks\n');
      const ad = await B.accept({ root: X.dir, bid: bd.id });
      R.check('[BA-12] 판정 뒤 묶음 브랜치에 더한 커밋이 있으면 batch accept 거부 · main 에 bad9.txt 없음', bd.verdict === 'pass' && ad.refused === true && /checked/.test(ad.reason) && read(path.join(X.dir, 'bad9.txt')) === null, `${bd.verdict} ${ad.reason}`);
    }

    // ── [감사] 앞선 accept 가 남긴 충돌 병합 · 커밋하지 않은 대량 삭제는 묶지 않는다 · 빈 묶음은 치운다 ─
    {
      const Y = mkRepo(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`src/f${i}.txt`, `${i}\n`])));
      const ya = lane(Y, 'ya edits shared', { 'shared.txt': 'from a\n' });
      write(path.join(Y.dir, 'shared.txt'), 'from main\n'); git(Y.dir, ['add', '-A']); git(Y.dir, ['commit', '-qm', 'main edits shared']);
      const accY = await I.accept({ ...quiet, root: Y.dir, id: ya.id });
      const inProgress = git(ya.wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) !== '';
      const by = await B.create({ ...quiet, root: Y.dir, ids: [ya.id] });
      const my = B.readBatch(Y.dir, by.id).members[0];
      R.check('[BA-13] 칸에 충돌 표식이 남은 병합이 진행 중이면 그 구성원을 건너뛴다(커밋하지 않는다)', accY.refused && inProgress && my.status === 'skipped' && /conflict markers/.test(my.why) && !my.committed, JSON.stringify(my));
      R.check('[BA-14] 합친 것이 없으면(empty) 묶음 작업 폴더와 브랜치를 치우고 다음 할 일을 알린다', by.status === 'empty' && !fs.existsSync(by.worktree) && git(Y.dir, ['branch', '--list', by.branch]) === '' && /다시/.test(by.report), by.report);
      const yb = lane(Y, 'yb', { 'yb.txt': 'b\n' });
      for (let i = 0; i < 25; i++) fs.rmSync(path.join(yb.wt, 'src', `f${i}.txt`));
      const bdel = await B.create({ ...quiet, root: Y.dir, ids: [yb.id] });
      const mdel = B.readBatch(Y.dir, bdel.id).members[0];
      R.check('[BA-15] 칸의 커밋하지 않은 추적 파일 대량 삭제는 커밋하지 않고 그 구성원을 건너뛴다', mdel.status === 'skipped' && /tracked file/.test(mdel.why) && !mdel.committed && git(yb.wt, ['ls-tree', '-r', '--name-only', 'HEAD']).split(/\r?\n/).filter(f => f.startsWith('src/')).length === 25, JSON.stringify(mdel));
    }

    // ── [감사] 사용자 검사(--checks)는 원래 실패여도 not-worse 가 아니다(accept 와 같다) · lint_command 를 돌린다 ─
    {
      const U = mkRepo({ 'bad1.txt': 'known failure\n' });
      const ua = lane(U, 'ua', { 'ua.txt': 'a\n' });
      const bu = await B.create({ ...quiet, root: U.dir, ids: [ua.id], checks: ['node check.js'] });
      R.check('[BA-16] 사용자가 준 검사(--check)가 원래부터 실패면 verdict fail(not-worse 아님)', bu.verdict === 'fail', `${bu.verdict}`);
      const L = mkRepo({ 'AGENTS.md': '# p\n\n```yaml\ntest_command: "node check.js"\nlint_command: "node lint.js {files}"\n```\n',
        'lint.js': "const fs=require('fs');const bad=process.argv.slice(2).filter(f=>fs.existsSync(f)&&/LINTBAD/.test(fs.readFileSync(f,'utf8')));if(bad.length){console.log('Error: lint '+bad.join(','));process.exit(1);}\n" });
      const lg = lane(L, 'lg', { 'g.txt': 'LINTBAD\n' });
      const bl = await B.create({ ...quiet, root: L.dir, ids: [lg.id] });
      const lok = lane(L, 'lok', { 'ok.txt': 'fine\n' });
      const bok = await B.create({ ...quiet, root: L.dir, ids: [lok.id] });
      R.check('[BA-17] lint_command 가 묶음의 바뀐 파일에서 실패하면 verdict fail · 보고에 린트 · 깨끗하면 pass', bl.verdict === 'fail' && /린트/.test(bl.report) && /g\.txt/.test(bl.report) && bok.verdict === 'pass' && /린트/.test(bok.report), `${bl.verdict} ${bok.verdict} ${bl.report}`);
      const accL = await B.accept({ root: L.dir, bid: bl.id });
      R.check('[BA-17] 린트가 실패한 묶음은 --force 없이 받아들이지 않는다', accL.refused === true && read(path.join(L.dir, 'g.txt')) === null, accL.reason);
    }

    // ── [감사] --branch harness/<id> 는 그 작업으로 다룬다(받아들이면 accepted) · gc 는 ready · 만드는 중인 묶음을 지우지 않는다 ─
    {
      const W = mkRepo();
      const wa = lane(W, 'wa', { 'wa.txt': 'a\n' });
      const bw = await B.create({ ...quiet, root: W.dir, branches: [wa.branch] });
      const recW = B.readBatch(W.dir, bw.id);
      const St = require('../../harness/lib/status');
      const g1 = St.gc({ root: W.dir });
      R.check('[BA-19] gc 는 ready 묶음의 작업 폴더를 지우지 않는다', fs.existsSync(bw.worktree) && !g1.removed.some(x => x.worktree === bw.worktree), JSON.stringify(g1));
      // 만드는 중(batch-<bid> 잠금이 산 주인) — 기록을 building 으로 두고 잠금을 쥔다
      const recB = { ...recW, status: 'building' }; fs.writeFileSync(path.join(S.paths(W.dir).harnessDir, 'batches', `${bw.id}.json`), JSON.stringify(recB));
      const hb = S.acquire(W.dir, `batch-${bw.id}`);
      const g2 = St.gc({ root: W.dir });
      hb.release();
      fs.writeFileSync(path.join(S.paths(W.dir).harnessDir, 'batches', `${bw.id}.json`), JSON.stringify(recW));
      R.check('[BA-19] gc 는 만드는 중(잠금이 산) 묶음의 작업 폴더 · 등록을 건드리지 않는다', fs.existsSync(bw.worktree) && git(W.dir, ['worktree', 'list']).includes(bw.id) && g2.kept.some(k => k.worktree === bw.worktree), JSON.stringify(g2.kept));
      const aw = await B.accept({ root: W.dir, bid: bw.id });
      R.check('[BA-18] --branch harness/<id> 로 묶어 받아들이면 그 작업은 accepted(--branch 도 작업 구성원으로)', aw.status === 'accepted' && recW.members[0].id === wa.id && S.readTask(W.dir, wa.id).status === 'accepted', JSON.stringify({ st: aw.status, m: recW.members[0], t: S.readTask(W.dir, wa.id).status }));
      // 받아들인 묶음의 남은 작업 폴더(검사 산출물로 남겼다)는 gc 가 치운다
      const wb = lane(W, 'wb', { 'wb.txt': 'b\n' });
      const bw2 = await B.create({ ...quiet, root: W.dir, ids: [wb.id] });
      await B.accept({ root: W.dir, bid: bw2.id });
      git(W.dir, ['worktree', 'add', '-q', '--detach', bw2.worktree, 'main']);   // 남은 작업 폴더를 흉내 낸다
      write(path.join(bw2.worktree, 'out.log'), 'check output\n');
      const g3 = St.gc({ root: W.dir });
      R.check('[BA-19] 끝난(accepted) 묶음의 남은 작업 폴더는 gc 가 치운다', !fs.existsSync(bw2.worktree) && g3.removed.some(x => x.worktree === bw2.worktree), JSON.stringify(g3));
    }

    // ── [2026-10-29 조율] 칸의 worktree 에서 산 세션이 일하면 묶지 않는다(--force 면 묶는다) · batch accept 도 다시 본다 ─
    {
      process.env.HARNESS_AGENTS_JSON = path.join(base, 'no-agents.json');   // 진짜 claude agents 를 부르지 않는다 → last_seen 어림
      const V = mkRepo();
      const sess = (sid, wt) => write(path.join(S.paths(V.dir).sessionsDir, `${sid}.json`), JSON.stringify({ session_id: sid, runtime: 'claude', files: [], root: wt, cwd: wt, branch: 'x', last_seen: new Date().toISOString() }));
      const va = lane(V, 'va', { 'va.txt': 'a\n' });
      sess('live1111-aaaa', va.wt);
      const bv = await B.create({ ...quiet, root: V.dir, all: true });
      const mv = (B.readBatch(V.dir, bv.id).members || []).find(m => m.id === va.id) || {};
      R.check('[BA-20] 산 세션이 일하는 칸은 batch(--all)가 건너뛴다(why: live session)', mv.status === 'skipped' && /live session live1111/.test(mv.why), JSON.stringify(mv));
      const bvf = await B.create({ ...quiet, root: V.dir, ids: [va.id], force: true });
      R.check('[BA-20] --force 면 산 세션이 있어도 묶는다', (B.readBatch(V.dir, bvf.id).members[0] || {}).status === 'merged', JSON.stringify(B.readBatch(V.dir, bvf.id).members));
      B.drop({ root: V.dir, bid: bvf.id });
      const vb = lane(V, 'vb', { 'vb.txt': 'b\n' });
      const bb = await B.create({ ...quiet, root: V.dir, ids: [vb.id] });
      sess('live2222-bbbb', vb.wt);
      const ab = await B.accept({ root: V.dir, bid: bb.id });
      R.check('[BA-20] 묶은 뒤 그 칸에서 산 세션이 일하면 batch accept 거부 · --force 면 받아들인다', bb.verdict === 'pass' && ab.refused === true && /live session/.test(ab.reason)
        && (await B.accept({ root: V.dir, bid: bb.id, force: true })).status === 'accepted', `${ab.reason}`);
      delete process.env.HARNESS_AGENTS_JSON;
    }

    // ── [2026-10-29 조율 · baseline.js 와 같이] 시간 초과가 든 대상 끝 기준선은 캐시에 쓰지 않는다(다음 묶음이 다시 잰다) ─
    {
      const Z = mkRepo({ 'bad1.txt': 'known failure\n', 'slow.flag': 'x\n' });
      const zl = Lane.start({ ...quiet, root: Z.dir, goal: 'remove slow flag' }), zwt = S.taskPaths(Z.dir, zl.id).wt;
      fs.rmSync(path.join(zwt, 'slow.flag')); git(zwt, ['add', '-A']); git(zwt, ['commit', '-qm', 'drop slow flag']);
      const bz1 = await B.create({ ...quiet, root: Z.dir, ids: [zl.id], checkTimeoutMs: 2500 });
      const cacheDir = path.join(S.paths(Z.dir).harnessDir, 'baseline-cache');
      const cached = (() => { try { return fs.readdirSync(cacheDir).length; } catch { return 0; } })();
      B.drop({ root: Z.dir, bid: bz1.id });
      const bz2 = await B.create({ ...quiet, root: Z.dir, ids: [zl.id], checkTimeoutMs: 2500 });
      const rz2 = B.readBatch(Z.dir, bz2.id);
      R.check('[BA-21] 시간 초과로 잰 기준선은 캐시에 남기지 않고 다음 묶음은 다시 잰다', cached === 0 && rz2.baseline && rz2.baseline.cached === false, JSON.stringify({ cached, base: rz2.baseline }));
    }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

'use strict';
// light 칸 — start(worktree · 브랜치 · mode light · 미룬 검사 · 포트 · 같은 작업 안내 · --from 이어 가기) · light 칸의 accept(검사 한 번 · 나빠지면 거부 · 판정 불가는 따로).
//   모델은 부르지 않는다. 모든 저장소는 임시 디렉터리에 있다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const Lane = require('../../harness/lib/lane');
const I = require('../../harness/lib/integrate');
const R = makeReporter('light 칸 — start · accept');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-lane-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
const quiet = { log: () => {} };
let seq = 0;
// 검사: 돌 때마다 counter 에 한 줄 · bad.txt 가 있으면 실패 · slow.flag 가 있으면 5초 걸린다
const checkJs = counter => `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'x\\n');
if(fs.existsSync('slow.flag')){const t=Date.now();while(Date.now()-t<5000){}}
if(fs.existsSync('bad.txt')){console.log('AssertionError: bad.txt exists');console.log('# pass 1\\n# fail 1');process.exit(1);}
console.log('# pass 2\\n# fail 0');`;
function mkRepo() {
  const dir = path.join(base, `r${++seq}`), counter = path.join(base, `count-${seq}.txt`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  write(path.join(dir, 'check.js'), checkJs(counter));
  write(path.join(dir, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\n```\n');
  write(path.join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return { dir, counter, runs: () => (read(counter) || '').split('\n').filter(Boolean).length };
}
const commitIn = (wt, file, text, msg) => { write(path.join(wt, file), text); git(wt, ['add', '-A']); git(wt, ['commit', '-qm', msg || `edit ${file}`]); };
const parents = (cwd, ref) => git(cwd, ['rev-list', '--parents', '-n', '1', ref]).split(/\s+/).length - 1;

(async () => {
  try {
    // ── start: worktree · 브랜치 · 기록 ─────────────────────────────────
    const A = mkRepo();
    const mainA = git(A.dir, ['rev-parse', 'main']);
    const cli1 = spawnSync(process.execPath, [CLI, 'start', 'add the widget', '--root', A.dir], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const res1 = JSON.parse((/HARNESS_RESULT (\{.*\})/.exec(cli1.stdout) || [0, 'null'])[1]) || {};
    const t1 = S.readTask(A.dir, res1.id) || {};
    const P1 = S.taskPaths(A.dir, res1.id);
    R.check('[LA-01] CLI start: exit 0 · HARNESS_RESULT status open · 작업 폴더 · 브랜치', cli1.status === 0 && res1.status === 'open' && res1.branch === `harness/${res1.id}` && path.resolve(res1.worktree) === path.resolve(P1.wt), `${cli1.status} ${cli1.stdout.slice(-400)} ${cli1.stderr.slice(-300)}`);
    R.check('[LA-01] 기록: mode light · status open · owner null · 기준 main @ main 끝 · 검사 미룸(accept 때)',
      t1.mode === 'light' && t1.status === 'open' && t1.owner === null && t1.base_branch === 'main' && t1.base_commit === mainA && t1.checks.deferred === true && t1.checks.commands.length === 1 && !t1.checks.last,
      JSON.stringify({ mode: t1.mode, status: t1.status, owner: t1.owner, base: t1.base_branch, deferred: t1.checks && t1.checks.deferred }));
    R.check('[LA-01] worktree 가 그 브랜치로 있다 · 파일이 있다 · 사용자 브랜치(main)는 그대로 · 검사는 아직 돌지 않았다',
      git(P1.wt, ['rev-parse', '--abbrev-ref', 'HEAD']) === t1.branch && read(path.join(P1.wt, 'a.txt')) === 'one\n' && git(A.dir, ['rev-parse', 'main']) === mainA && A.runs() === 0);
    R.check('[LA-01] 안내: 그 폴더에서 Claude Code 를 여는 법 · accept · batch', /cd "[^"]+" ; claude/.test(cli1.stdout) && new RegExp(`accept ${res1.id}`).test(cli1.stdout) && /batch/.test(cli1.stdout), cli1.stdout.slice(0, 600));

    // 분리 HEAD 면 --base 없이 거부 · --base 를 주면 연다
    const D = mkRepo();
    git(D.dir, ['checkout', '-q', '--detach']);
    let eD = null; try { Lane.start({ ...quiet, root: D.dir, goal: 'x' }); } catch (e) { eD = e; }
    const okD = Lane.start({ ...quiet, root: D.dir, goal: 'x', base: 'main' });
    R.check('[LA-02] 메인 체크아웃이 분리 HEAD 면 --base 없이는 USAGE 거부 · --base main 이면 연다', eD && eD.code === 'USAGE' && /--base/.test(eD.message) && okD.status === 'open' && okD.base_branch === 'main', eD ? eD.message : 'no error');

    // ── 같은 요청: 막지 않고 이전 작업과 --from 안내를 보인다 ───────────────
    const dup = Lane.start({ ...quiet, root: A.dir, goal: 'add the widget' });
    R.check('[LA-03] 같은 목표를 다시 열어도 거부하지 않는다 · 이전 작업(id · 상태 · 브랜치)과 이어 가기(--from) 안내',
      dup.status === 'open' && dup.id !== res1.id && dup.related.some(r => r.id === res1.id && r.kind === 'same') && dup.report.includes(res1.id) && dup.report.includes(`harness/${res1.id}`) && dup.report.includes(`--from ${res1.id}`),
      dup.report);

    // ── --from: 이전 작업의 커밋을 이어 받는다 · 이전 작업에 continued_by ──────
    commitIn(P1.wt, 'widget.txt', 'half a widget\n', 'half widget');
    const tip1 = git(A.dir, ['rev-parse', t1.branch]);
    const cont = Lane.start({ ...quiet, root: A.dir, goal: 'finish the widget', from: res1.id });
    const Pc = S.taskPaths(A.dir, cont.id), tc = S.readTask(A.dir, cont.id), old = S.readTask(A.dir, res1.id);
    R.check('[LA-04] --from: 새 브랜치가 이전 브랜치 끝에서 시작한다(커밋이 이어진다) · 기준 브랜치는 이전 작업의 대상(main)',
      git(A.dir, ['rev-parse', `${cont.branch}`]) === tip1 && read(path.join(Pc.wt, 'widget.txt')) === 'half a widget\n' && tc.base_branch === 'main' && tc.continues === res1.id, JSON.stringify({ b: tc.base_branch, c: tc.continues }));
    R.check('[LA-04] 이전 작업은 continued_by 만 기록되고 상태는 그대로(open)', old.continued_by === cont.id && old.status === 'open', JSON.stringify({ by: old.continued_by, st: old.status }));

    // ── 포트 구역(resources.portBlock 이 있으면 그 결과를 기록 · 보고) ─────────
    const Rs = require('../../harness/lib/resources'), had = Rs.portBlock;
    const seen = [];
    Rs.portBlock = (root, id) => { seen.push(id); return { base: 21000, count: 20 }; };
    let tp; try { tp = Lane.start({ ...quiet, root: A.dir, goal: 'ports please' }); } finally { if (had) Rs.portBlock = had; else delete Rs.portBlock; }
    R.check('[LA-05] resources.portBlock 이 있으면 칸마다 부르고 기록 · 보고에 포트 범위', seen[0] === tp.id && S.readTask(A.dir, tp.id).ports.base === 21000 && tp.ports.count === 20 && /21000–21019/.test(tp.report), tp.report);

    // ── light 칸의 accept: 검사 한 번 · 남은 미커밋분을 커밋하고 무엇을 커밋했는지 보고 ─
    const B = mkRepo();
    const lb = Lane.start({ ...quiet, root: B.dir, goal: 'add feature' });
    const Pb = S.taskPaths(B.dir, lb.id);
    commitIn(Pb.wt, 'feature.txt', 'feature\n');
    write(path.join(Pb.wt, 'notes.txt'), 'still editing\n');   // 커밋하지 않은 변경
    const mainB = git(B.dir, ['rev-parse', 'main']);
    const ab = await I.accept({ ...quiet, root: B.dir, id: lb.id });
    const tb = S.readTask(B.dir, lb.id);
    R.check('[LA-06] 열린 light 칸은 --force 없이 accept → accepted · main 에 병합 커밋(부모 2) · 강제 표시 없음',
      ab.status === 'accepted' && !ab.refused && parents(B.dir, 'main') === 2 && git(B.dir, ['rev-parse', 'main^1']) === mainB && !tb.forced_from && /ACCEPTED$/m.test(ab.report.split('\n')[0]), `${ab.status} ${ab.reason} ${ab.report}`);
    R.check('[LA-06] 검사는 accept 때 정확히 한 번 · 기록에 남는다', B.runs() === 1 && tb.checks.last && tb.checks.last.ok === true, `runs=${B.runs()}`);
    R.check('[LA-06] 커밋되지 않았던 파일을 커밋해 함께 병합하고 보고에 그 파일 이름', read(path.join(B.dir, 'notes.txt')) === 'still editing\n' && /notes\.txt/.test(ab.report) && S.readLog(B.dir, lb.id).some(e => e.event === 'leftovers_committed' && e.files.includes('notes.txt')), ab.report);

    // ── 나빠지면 거부(main 그대로 · 칸은 open) ───────────────────────────
    const C = mkRepo();
    const lc = Lane.start({ ...quiet, root: C.dir, goal: 'break it' });
    commitIn(S.taskPaths(C.dir, lc.id).wt, 'bad.txt', 'oops\n');
    const mainC = git(C.dir, ['rev-parse', 'main']);
    const ac = await I.accept({ ...quiet, root: C.dir, id: lc.id });
    R.check('[LA-07] 검사가 작업 전보다 나빠지면 accept 거부 · main 그대로 · 칸은 open 으로 남는다',
      ac.refused === true && /worse than before/.test(ac.reason) && git(C.dir, ['rev-parse', 'main']) === mainC && S.readTask(C.dir, lc.id).status === 'open' && !/undetermined/.test(ac.reason), `${ac.status} ${ac.reason}`);

    // ── check <id> 로 미리 통과했어도, 그 뒤 커밋이 있으면 accept 가 다시 잰다(light 칸은 늘 다시) ─
    const E = mkRepo();
    const le = Lane.start({ ...quiet, root: E.dir, goal: 'preview then break' });
    const Pe = S.taskPaths(E.dir, le.id);
    commitIn(Pe.wt, 'ok.txt', 'fine\n');
    const ce = await I.check({ ...quiet, root: E.dir, id: le.id });
    commitIn(Pe.wt, 'bad.txt', 'broke after the preview\n');
    const mainE = git(E.dir, ['rev-parse', 'main']);
    const ae = await I.accept({ ...quiet, root: E.dir, id: le.id });
    R.check('[LA-08] check <id> 는 열린 light 칸에서 돈다 · 그 뒤 깨뜨린 커밋은 accept 가 다시 재서 거부한다',
      ce.status === 'checked' && ae.refused === true && /worse/.test(ae.reason) && git(E.dir, ['rev-parse', 'main']) === mainE, `${ce.status} ${ce.reason} | ${ae.status} ${ae.reason}`);

    // ── 판정 불가: 실패가 모두 시간 초과면 "나빠짐" 이 아니라 따로 거부 ───────────
    const F = mkRepo();
    const lf = Lane.start({ ...quiet, root: F.dir, goal: 'slow lane' });
    commitIn(S.taskPaths(F.dir, lf.id).wt, 'slow.flag', 'x\n');
    const mainF = git(F.dir, ['rev-parse', 'main']);
    const af = await I.accept({ ...quiet, root: F.dir, id: lf.id, checkTimeoutMs: 1500 });
    R.check('[LA-09] 시간 초과뿐인 실패 → "판정 불가" 로 거부(다시 하거나 --force) · "worse than before" 가 아니다 · main 그대로',
      af.refused === true && /undetermined/.test(af.reason) && /timed out/.test(af.reason) && /--force/.test(af.reason) && !/worse than before the task/.test(af.reason) && git(F.dir, ['rev-parse', 'main']) === mainF,
      `${af.status} ${af.reason}`);
    R.check('[LA-09] 판정 불가는 기록에도 indeterminate 로', S.readLog(F.dir, lf.id).some(e => e.event === 'checks' && e.phase === 'accept' && e.verdict === 'indeterminate'));
    const tf = S.readTask(F.dir, lf.id);
    R.check('[LA-09] 기준선을 재지 않는다 · 검사는 판정에서 빠지지 않는다(다음 accept 가 다시 잰다)', !S.readLog(F.dir, lf.id).some(e => e.event === 'baseline') && tf.checks.commands.length === 1 && !(tf.checks.dropped || []).length && tf.status === 'open',
      JSON.stringify({ cmds: tf.checks.commands.length, dropped: tf.checks.dropped, st: tf.status }));

    // ── 거부에 실패한 시험 이름(checks 의 failed_tests · 최대 10) ─────────────
    const K = require('../../harness/lib/checks'), realRun = K.runJudged;
    const names = Array.from({ length: 12 }, (_, i) => `suite.test_${i + 1}`);
    const prio = [];
    K.runJudged = async (cwd, cmds, opt) => { prio.push(opt && opt.priority); const r = await realRun(cwd, cmds, opt); if (!r.judged.ok) r.judged.failed_tests = names; return r; };
    let ag;
    try {
      const G2 = mkRepo();
      const lg = Lane.start({ ...quiet, root: G2.dir, goal: 'named failures' });
      commitIn(S.taskPaths(G2.dir, lg.id).wt, 'bad.txt', 'oops\n');
      ag = await I.accept({ ...quiet, root: G2.dir, id: lg.id });
    } finally { K.runJudged = realRun; }
    R.check('[LA-11] 거부 결과 · 보고에 실패한 시험 이름(최대 10) · accept 의 검사는 priority 0(검사 줄 맨 앞)',
      ag.refused === true && Array.isArray(ag.failed_tests) && ag.failed_tests.length === 10 && ag.failed_tests[0] === 'suite.test_1' && /suite\.test_10/.test(ag.report) && !/suite\.test_11/.test(ag.report) && prio[0] === 0,
      JSON.stringify({ ft: ag.failed_tests, prio, rep: ag.report }));

    // ── --from 은 받아들인 작업을 거부한다(그 일은 이미 대상 브랜치에 있다) ──────
    let eAcc = null; try { Lane.start({ ...quiet, root: B.dir, goal: 'again', from: lb.id }); } catch (e) { eAcc = e; }
    R.check('[LA-10] --from <받아들인 작업> → USAGE 거부', eAcc && eAcc.code === 'USAGE' && /already accepted/.test(eAcc.message), eAcc ? eAcc.message : 'no error');
    const cliBad = spawnSync(process.execPath, [CLI, 'start', '--root', A.dir], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    R.check('[LA-10] CLI start 에 목표가 없으면 exit 2', cliBad.status === 2 && /needs a goal/.test(cliBad.stderr), `${cliBad.status} ${cliBad.stderr.slice(0, 200)}`);

    // ── v7.0 — Light 에 남는 accept 가 지킬 것 ─────────────────────────
    // LA-20 [자동 이슈 #61] 강제로 끝난 git 작업 뒤 작업 폴더에서 추적 파일이 대량으로 사라졌다 — 그 "삭제" 를 커밋하지 않고 멈춘다
    const M = mkRepo();
    for (let i = 0; i < 25; i++) write(path.join(M.dir, 'many', `f${i}.txt`), `${i}\n`);
    git(M.dir, ['add', '-A']); git(M.dir, ['commit', '-qm', 'many files']);
    const lm = Lane.start({ ...quiet, root: M.dir, goal: 'edit one file' }), Pm = S.taskPaths(M.dir, lm.id);
    commitIn(Pm.wt, 'b.txt', 'b\n');
    fs.rmSync(path.join(Pm.wt, 'many'), { recursive: true, force: true });
    const headM = git(Pm.wt, ['rev-parse', 'HEAD']), mainM = git(M.dir, ['rev-parse', 'main']);
    const am = await I.accept({ ...quiet, root: M.dir, id: lm.id });
    R.check('[LA-20] (#61) 커밋 안 된 추적 파일 삭제 25개 → 커밋하지 않고 거부(되살리는 법 안내) · 칸 브랜치 · main 그대로',
      am.status !== 'accepted' && /missing 25 tracked file/.test(am.reason || '') && /checkout HEAD -- \./.test(am.reason || '') && git(Pm.wt, ['rev-parse', 'HEAD']) === headM && git(M.dir, ['rev-parse', 'main']) === mainM,
      `${am.status} ${am.reason}`);
    git(Pm.wt, ['checkout', '-q', 'HEAD', '--', '.']);
    const am2 = await I.accept({ ...quiet, root: M.dir, id: lm.id });
    R.check('[LA-20] 되살린 뒤 다시 accept 하면 받아들인다', am2.status === 'accepted', `${am2.status} ${am2.reason}`);

    // LA-21 [자동 이슈 #57] 검사가 추적 파일(산출물)을 다시 쓰고 실패하면 — 그 산출물을 칸 브랜치에 커밋하지 않고 HEAD 로 되돌린다
    const G7 = mkRepo();
    write(path.join(G7.dir, 'gen.txt'), 'generated v0\n');
    write(path.join(G7.dir, 'check.js'), `const fs=require('fs');fs.writeFileSync('gen.txt','generated '+Date.now()+'\\n');
if(fs.existsSync('bad.txt')){console.log('# pass 1\\n# fail 1');process.exit(1);}console.log('# pass 2\\n# fail 0');`);
    git(G7.dir, ['add', '-A']); git(G7.dir, ['commit', '-qm', 'check rewrites gen.txt']);
    const lg = Lane.start({ ...quiet, root: G7.dir, goal: 'break it' }), Pg = S.taskPaths(G7.dir, lg.id);
    commitIn(Pg.wt, 'bad.txt', 'bad\n');
    const a21 = await I.accept({ ...quiet, root: G7.dir, id: lg.id });
    const genCommitted = git(G7.dir, ['log', '--format=%h', `main..${lg.branch}`, '--', 'gen.txt']);
    R.check('[LA-21] (#57) 검사가 다시 쓴 추적 산출물은 거부돼도 칸 브랜치에 커밋되지 않고 HEAD 로 돌아간다 · 기록에 되돌린 파일',
      a21.status !== 'accepted' && !genCommitted && read(path.join(Pg.wt, 'gen.txt')) === 'generated v0\n' && S.readLog(G7.dir, lg.id).some(e => e.event === 'check_writes_undone' && e.files.includes('gen.txt')),
      JSON.stringify({ status: a21.status, reason: a21.reason, genCommitted, gen: read(path.join(Pg.wt, 'gen.txt')) }));

    // LA-22 [자동 이슈 #56] 검사 도중 대상 브랜치에 문서 커밋만 들어오면 — 들이기만 하고 전체 검사를 다시 돌리지 않는다
    const H = mkRepo();
    write(path.join(H.dir, 'check.js'), `const fs=require('fs'),cp=require('child_process');fs.appendFileSync(${JSON.stringify(H.counter)},'x\\n');
const flag=${JSON.stringify(path.join(base, 'docs-once.flag'))};
if(!fs.existsSync(flag)){fs.writeFileSync(flag,'1');const m=${JSON.stringify(H.dir)};fs.mkdirSync(m+'/docs',{recursive:true});fs.writeFileSync(m+'/docs/note.md','doc\\n');
cp.execFileSync('git',['-C',m,'add','docs/note.md']);cp.execFileSync('git',['-C',m,'commit','-qm','docs from another session']);}
console.log('# pass 2\\n# fail 0');`);
    git(H.dir, ['add', '-A']); git(H.dir, ['commit', '-qm', 'check commits docs once']);
    const lh = Lane.start({ ...quiet, root: H.dir, goal: 'feature h' }), Ph = S.taskPaths(H.dir, lh.id);
    commitIn(Ph.wt, 'h.txt', 'h\n');
    commitIn(H.dir, 'code.txt', 'main moved\n', 'code change on main');   // 칸이 대상 브랜치를 들여야 한다
    const runsH0 = H.runs();
    const ah = await I.accept({ ...quiet, root: H.dir, id: lh.id });
    R.check('[LA-22] (#56) 검사 중 대상 브랜치에 문서만 들어오면 들이기만 하고 다시 검사하지 않는다(검사 1회) · accepted · 문서도 main 에',
      ah.status === 'accepted' && H.runs() - runsH0 === 1 && read(path.join(H.dir, 'docs', 'note.md')) === 'doc\n' && S.readLog(H.dir, lh.id).some(e => e.event === 'checks' && e.skipped === 'docs only since the last check'),
      JSON.stringify({ status: ah.status, reason: ah.reason, runs: H.runs() - runsH0 }));

    // LA-23 충돌을 레인에 남긴 뒤, 레인 세션이 표식이 남은 파일을 git add 해 버려도(미병합 목록에서 빠진다) accept 는 표식을 찾아 거부한다
    const X = mkRepo();
    const lx = Lane.start({ ...quiet, root: X.dir, goal: 'edit a' }), Px = S.taskPaths(X.dir, lx.id);
    commitIn(Px.wt, 'a.txt', 'lane\n');
    commitIn(X.dir, 'a.txt', 'main\n', 'main edits a too');
    const ax1 = await I.accept({ ...quiet, root: X.dir, id: lx.id });
    git(Px.wt, ['add', 'a.txt']);   // 표식이 든 채로 스테이징
    const ax2 = await I.accept({ ...quiet, root: X.dir, id: lx.id });
    R.check('[LA-23] 표식이 남은 채 스테이징된 파일도 찾아 거부 · main 에 표식이 들어가지 않는다',
      ax1.status !== 'accepted' && /left in progress/.test(ax1.reason || '') && ax2.status !== 'accepted' && /still has conflict markers in a\.txt/.test(ax2.reason || '') && read(path.join(X.dir, 'a.txt')) === 'main\n',
      JSON.stringify({ r1: ax1.reason, r2: ax2.reason, main: read(path.join(X.dir, 'a.txt')) }));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

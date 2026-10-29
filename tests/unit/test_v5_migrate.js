'use strict';
// v6 → v7 이어 가기 — start --from <v6 작업> 은 남은 worktree 를 그 자리에서 레인으로 받는다(같은 id · 브랜치 · 폴더 · 기록) ·
//   작업자의 대화를 그대로 이어 가는 명령(claude --resume <세션> · codex resume <id>) · status 의 "v6 작업 — 이어 가기" ·
//   병합 뒤 취소된 작업은 분명히 거부 · harness/ 를 추적하지 않는 저장소의 레인에는 하네스 사본.
//   대화 기록은 가짜 HOME/USERPROFILE 아래에서만 찾는다(사용자의 ~/.claude 를 읽지 않는다). 모델 호출 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-migrate-'));
const home = path.join(base, 'home'); fs.mkdirSync(home, { recursive: true });
const gitGlobal = path.join(base, 'gitconfig'); fs.writeFileSync(gitGlobal, '');
process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR;
process.env.GIT_CONFIG_GLOBAL = gitGlobal;
process.env.HARNESS_PORTS_FILE = path.join(base, 'ports.json');
const S = require('../../harness/lib/state');
const Ln = require('../../harness/lib/lane');
const I = require('../../harness/lib/integrate');
const St = require('../../harness/lib/status');
const R = makeReporter('v6 → v7 이어 가기 — 그 자리에서 레인으로 · 대화 그대로');

const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
let seq = 0;
function repo(files) {
  const d = path.join(base, `r${++seq}`); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  for (const [f, t] of Object.entries(files)) write(path.join(d, f), t);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
// v6 무인 작업이 남긴 모양: harness/<id> 브랜치 · worktree · 작업자의 커밋 · 미커밋 작업 · mode thin/full · 주인 죽음
function v6Task(root, id, o) {
  const P = S.taskPaths(root, id), baseCommit = git(root, 'rev-parse', 'main');
  git(root, 'worktree', 'add', '-q', '-b', P.branch, P.wt, 'main');
  write(path.join(P.wt, `${id}.txt`), 'worker commit\n'); git(P.wt, 'add', '-A'); git(P.wt, 'commit', '-qm', 'worker turn');
  write(path.join(P.wt, 'wip.txt'), 'uncommitted work of the worker\n');
  S.writeTask(root, { ...S.newTask({ id, goal: o.goal || 'v6 worker goal', status: o.status || 'interrupted', mode: o.mode || 'thin' }), branch: P.branch, worktree: P.wt, base_branch: 'main', base_commit: baseCommit,
    owner: o.owner || { pid: 99999996, host: os.hostname() }, runtime: o.runtime || 'claude', session_id: o.session_id || null, checks: { source: 'none', commands: [], baseline: null, last: null } });
  S.log(root, id, { event: 'created', goal: o.goal || 'v6 worker goal' });
  return P;
}

(async () => {
  try {
    // MG-07 — 대화 기록 폴더 이름: [A-Za-z0-9] 아닌 글자는 모두 '-' (실제 폴더 이름과 같은 꼴)
    R.check('[MG-07] 대화 기록 폴더 이름 규칙: C:\\workspace\\app\\.harness-worktrees\\t-… → C--workspace-app--harness-worktrees-t-…',
      Ln.mangle('C:\\workspace\\app\\.harness-worktrees\\t-20261029-151958-d279') === 'C--workspace-app--harness-worktrees-t-20261029-151958-d279', Ln.mangle('C:\\workspace\\app\\.harness-worktrees\\t-20261029-151958-d279'));

    // MG-01 — 세션 id 가 기록된 v6 작업: 그 자리에서 레인으로(같은 id · 폴더 · 기록 · 미커밋 그대로) + claude --resume <세션>
    const r1 = repo({ 'a.txt': 'a\n' });
    const ID1 = 't-20261020-101010-c0de', SID1 = 'aaaaaaaa-1111-2222-3333-444444444444';
    const P1 = v6Task(r1, ID1, { session_id: SID1 });
    const st1 = St.status({ root: r1 }), tx1 = St.formatStatus({ ...st1, language: 'Korean' });
    R.check('[MG-06] status: "v6 작업 — 이어 가기" 에 start --from 과 대화를 이어 가는 명령', /v6 작업 — 이어 가기 \(1\)/.test(tx1) && tx1.includes(`node harness/cli.js start --from ${ID1}`) && tx1.includes(`cd "${P1.wt}" ; claude --resume ${SID1}`), tx1);
    const a1 = Ln.start({ ...quiet, root: r1, goal: 'continue the v6 work', from: ID1 });
    const t1 = S.readTask(r1, ID1), log1 = S.readLog(r1, ID1).map(e => e.event);
    R.check('[MG-01] 같은 id · 브랜치 · worktree 로 받는다(새 작업 · 새 worktree 없음)', a1.id === ID1 && a1.adopted === true && a1.worktree === P1.wt && a1.branch === P1.branch && S.listTasks(r1).length === 1 && fs.readdirSync(S.paths(r1).worktreesDir).length === 1, JSON.stringify({ id: a1.id, wt: a1.worktree }));
    R.check('[MG-01] 작업 기록: mode light · status open · adopted_from_status · adopted_at · 기록(log)은 이어진다', t1.mode === 'light' && t1.status === 'open' && t1.adopted_from_status === 'interrupted' && t1.adopted_from_mode === 'thin' && !!t1.adopted_at && t1.owner === null
      && log1[0] === 'created' && log1.includes('adopted'), JSON.stringify({ mode: t1.mode, st: t1.status, from: t1.adopted_from_status, log1 }));
    R.check('[MG-01] 미커밋 작업 · 작업자의 커밋은 그대로 · 포트 구역을 잡는다', read(path.join(P1.wt, 'wip.txt')) === 'uncommitted work of the worker\n' && read(path.join(P1.wt, `${ID1}.txt`)) === 'worker commit\n' && a1.ports && Number.isInteger(a1.ports.base), JSON.stringify(a1.ports));
    R.check('[MG-01] 보고: 그 대화를 그대로 이어 가는 명령(cd "<worktree>" ; claude --resume <세션>)', a1.report.includes(`cd "${P1.wt}" ; claude --resume ${SID1}`) && a1.resume && a1.resume.source === 'task', a1.report);
    const acc1 = await I.accept({ ...quiet, root: r1, id: ID1 });
    R.check('[MG-01] 받은 레인은 accept 로 병합된다(작업자의 커밋 · 미커밋분 모두 main 에)', acc1.status === 'accepted' && read(path.join(r1, `${ID1}.txt`)) === 'worker commit\n' && read(path.join(r1, 'wip.txt')) === 'uncommitted work of the worker\n', `${acc1.status} ${acc1.reason}`);

    // MG-02 — 세션 id 가 없는 v6 작업: 가짜 HOME 의 .claude/projects/<폴더 이름>/ 에서 가장 최근 대화
    const r2 = repo({ 'a.txt': 'a\n' });
    const ID2 = 't-20261020-111111-beef';
    const P2 = v6Task(r2, ID2, { status: 'failed', mode: 'full' });
    const proj = path.join(home, '.claude', 'projects', Ln.mangle(fs.realpathSync.native(P2.wt)));
    const OLD = '11111111-aaaa-bbbb-cccc-000000000001', NEW = '22222222-aaaa-bbbb-cccc-000000000002';
    write(path.join(proj, `${OLD}.jsonl`), '{}\n'); write(path.join(proj, `${NEW}.jsonl`), '{}\n'); write(path.join(proj, 'notes.txt'), 'x');
    fs.utimesSync(path.join(proj, `${OLD}.jsonl`), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
    const st2 = St.formatStatus(St.status({ root: r2 }));
    R.check('[MG-02] 세션 id 가 기록되지 않았으면 대화 기록 폴더에서 가장 최근 것(status 영어판에도)', /v6 tasks — continue \(1\)/.test(st2) && st2.includes(`cd "${P2.wt}" ; claude --resume ${NEW}`), st2);
    const a2 = Ln.start({ ...quiet, root: r2, goal: 'go on', from: ID2 });
    R.check('[MG-02] start --from 보고에도 그 대화', a2.id === ID2 && a2.report.includes(`claude --resume ${NEW}`) && a2.resume.source === 'transcript' && S.readTask(r2, ID2).adopted_from_status === 'failed', a2.report);

    // MG-03 — Codex 작업: codex resume <id>
    const r3 = repo({ 'a.txt': 'a\n' });
    const ID3 = 't-20261020-121212-0dd5', P3 = v6Task(r3, ID3, { runtime: 'codex', session_id: 'thread-0123456789ab', status: 'blocked' });
    const st3 = St.formatStatus(St.status({ root: r3 }));
    R.check('[MG-03] Codex 작업은 codex resume <id>', st3.includes(`cd "${P3.wt}" ; codex resume thread-0123456789ab`), st3);

    // MG-04 — 주인이 살아 있는 running 은 받지 않는다(USAGE)
    const r4 = repo({ 'a.txt': 'a\n' });
    const ID4 = 't-20261020-131313-a11e';
    v6Task(r4, ID4, { status: 'running', owner: { pid: process.pid, host: os.hostname(), heartbeat_at: new Date().toISOString() } });
    let e4 = null; try { Ln.start({ ...quiet, root: r4, goal: 'x', from: ID4 }); } catch (e) { e4 = e; }
    R.check('[MG-04] 주인이 살아 있는 작업은 받지 않는다(still running)', e4 && e4.code === 'USAGE' && /still running/.test(e4.message) && S.readTask(r4, ID4).status === 'running', String(e4 && e4.message));

    // MG-05 — worktree 가 없는 v6 작업은 전처럼 그 브랜치에서 새 레인
    const ID5 = 't-20261020-141414-f00d', P5 = v6Task(r4, ID5, { status: 'interrupted' });
    git(r4, 'worktree', 'remove', '--force', P5.wt);
    const a5 = Ln.start({ ...quiet, root: r4, goal: 'continue without worktree', from: ID5 });
    R.check('[MG-05] worktree 가 없으면 그 브랜치에서 새 레인(continues)', a5.id !== ID5 && a5.continues === ID5 && read(path.join(a5.worktree, `${ID5}.txt`)) === 'worker commit\n', JSON.stringify({ id: a5.id, c: a5.continues }));

    // MG-08 — 병합 뒤 취소(revert)된 작업은 분명히 거부하고 restore 를 알린다
    const r8 = repo({ 'a.txt': 'a\n' });
    const l8 = Ln.start({ ...quiet, root: r8, goal: 'feature' });
    write(path.join(l8.worktree, 'feature.txt'), 'f\n'); git(l8.worktree, 'add', '-A'); git(l8.worktree, 'commit', '-qm', 'f');
    await I.accept({ ...quiet, root: r8, id: l8.id }); await I.cancel({ ...quiet, root: r8, id: l8.id });
    let e8 = null; try { Ln.start({ ...quiet, root: r8, goal: 'again', from: l8.id }); } catch (e) { e8 = e; }
    R.check('[MG-08] 병합 뒤 취소된 작업에서 --from 은 거부 · restore 를 알린다(이어 받은 커밋이 accept 때 사라지지 않게)', e8 && e8.code === 'USAGE' && /reverted/.test(e8.message) && new RegExp(`restore ${l8.id}`).test(e8.message) && S.listTasks(r8).length === 1, String(e8 && e8.message));

    // MG-09 — harness/ · .claude/ 를 추적하지 않는(무시하는) 저장소: 레인에 하네스 사본 · accept 는 그 사본 때문에 worktree 를 남기지 않는다
    const r9 = repo({ 'a.txt': 'a\n', '.gitignore': '.claude/\n' });
    write(path.join(r9, '.git', 'info', 'exclude'), '/harness/\n');
    write(path.join(r9, 'harness', 'cli.js'), '// cli\n'); write(path.join(r9, 'harness', 'hooks', 'guard.js'), '// guard\n');
    write(path.join(r9, '.claude', 'settings.json'), '{"hooks":{}}\n'); write(path.join(r9, '.claude', 'skills', 'harness', 'SKILL.md'), '# skill\n');
    const l9 = Ln.start({ ...quiet, root: r9, goal: 'lane with harness copy' });
    R.check('[MG-09] 레인에 harness/ · .claude/settings.json · 스킬 사본(무시되는 것만) · 보고에 알림', read(path.join(l9.worktree, 'harness', 'cli.js')) === '// cli\n' && read(path.join(l9.worktree, 'harness', 'hooks', 'guard.js')) === '// guard\n'
      && read(path.join(l9.worktree, '.claude', 'settings.json')) === '{"hooks":{}}\n' && read(path.join(l9.worktree, '.claude', 'skills', 'harness', 'SKILL.md')) === '# skill\n' && /하네스:/.test(l9.report), l9.report);
    write(path.join(l9.worktree, 'b.txt'), 'b\n'); git(l9.worktree, 'add', '--', 'b.txt'); git(l9.worktree, 'commit', '-qm', 'b', '--', 'b.txt');
    const acc9 = await I.accept({ ...quiet, root: r9, id: l9.id });
    R.check('[MG-09] accept: 하네스 사본은 커밋되지 않고 worktree 도 남기지 않는다', acc9.status === 'accepted' && !fs.existsSync(l9.worktree) && !S.readTask(r9, l9.id).worktree_kept && git(r9, 'ls-files', 'harness') === '', `${acc9.status} ${S.readTask(r9, l9.id).worktree_kept || ''}`);
    const r10 = repo({ 'a.txt': 'a\n' });
    write(path.join(r10, 'harness', 'cli.js'), '// untracked, not ignored\n');
    const l10 = Ln.start({ ...quiet, root: r10, goal: 'lane where harness is neither tracked nor ignored' });
    R.check('[MG-09] 무시되지 않는 harness/ 는 복사하지 않고(커밋될 수 있다) 보고에 주의', !fs.existsSync(path.join(l10.worktree, 'harness')) && /주의: harness/.test(l10.report), l10.report);
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

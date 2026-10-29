'use strict';
// worktree 의 의존 — 서브모듈(gitlink) · 저장소 밖 형제 폴더(worktree_links).
//   [2026-10-03 · .NET 라이브러리 저장소] 서브모듈 OnvifSolution 이 하네스 worktree 에서 빈 폴더라 그것을 참조하는 프로젝트가 빌드되지 않는다.
//   [2026-10-03 · .NET 앱 저장소] csproj 가 ..\..\.NET 라이브러리 저장소 를 참조 — worktree(.harness-worktrees/<id>/)에서는 그 경로가 없다.
//   v7 Light: 작업 칸(lane.start)이 go 와 같은 worktree 준비를 한다 — 칸을 열고 · 그 폴더에서 커밋하고 · accept 로 들인다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const Ln = require('../../harness/lib/lane');
const I = require('../../harness/lib/integrate');
const G = require('../../harness/lib/git');
const S = require('../../harness/lib/state');
const St = require('../../harness/lib/status');
const R = makeReporter('worktree 의존 — 서브모듈 · 형제 폴더');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-deps-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
const cfg = d => { git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false'); };
const quiet = { log: () => {} };
// 칸 worktree 에서 자기 파일만 커밋한다(사람 · 대화형 세션이 하는 일)
const commitIn = (wt, files, msg) => { for (const [f, t] of Object.entries(files)) write(path.join(wt, f), t); git(wt, 'add', '--', ...Object.keys(files)); git(wt, 'commit', '-qm', msg || 'work', '--', ...Object.keys(files)); };

(async () => {
  try {
    // ── 서브모듈: 메인 체크아웃의 중첩 저장소(독립 .git)가 gitlink 로 기록돼 있다 ──
    const ws1 = path.join(base, 'ws1'), app = path.join(ws1, 'app');
    fs.mkdirSync(app, { recursive: true }); git(app, 'init', '-q', '-b', 'main'); cfg(app);
    const sub = path.join(app, 'lib');
    fs.mkdirSync(sub); git(sub, 'init', '-q', '-b', 'main'); cfg(sub);
    write(path.join(sub, 'lib.txt'), 'v1\n'); git(sub, 'add', '-A'); git(sub, 'commit', '-qm', 'lib v1');
    const pinned = git(sub, 'rev-parse', 'HEAD');
    write(path.join(sub, 'lib.txt'), 'v2\n'); git(sub, 'commit', '-qam', 'lib v2');   // 메인의 중첩 저장소는 기록된 커밋보다 앞서 있다
    git(sub, 'checkout', '-q', pinned);
    write(path.join(app, 'a.txt'), 'a\n');
    spawnSync('git', ['add', 'a.txt', 'lib'], { cwd: app, windowsHide: true });
    git(app, 'commit', '-qm', 'init with gitlink');
    git(sub, 'checkout', '-q', 'main');   // 메인의 서브모듈 체크아웃이 기록과 달라도 worktree 는 기록된 커밋을 받는다
    const r1 = Ln.start({ ...quiet, root: app, goal: 'x' });
    const lib1 = path.join(r1.worktree, 'lib', 'lib.txt');
    const seen1 = fs.existsSync(lib1) ? fs.readFileSync(lib1, 'utf8').trim() : null;
    R.check('[DP-01] 서브모듈: worktree 에 기록된 커밋(v1)으로 채워진다(메인의 중첩 저장소는 v2)', r1.status === 'open' && seen1 === 'v1', `${r1.status} ${seen1}`);
    commitIn(r1.worktree, { 'b.txt': 'b\n' });
    const a1 = await I.accept({ ...quiet, root: app, id: r1.id });
    R.check('[DP-02] 서브모듈: 결과 브랜치 · 들인 main 의 gitlink 는 그대로 · 작업은 accepted · worktree 는 지워진다',
      a1.status === 'accepted' && git(app, 'ls-tree', r1.branch, 'lib').includes(pinned) && git(app, 'ls-tree', 'main', 'lib').includes(pinned) && !S.readTask(app, r1.id).worktree_kept && !fs.existsSync(r1.worktree),
      `${a1.status} kept=${S.readTask(app, r1.id).worktree_kept} ${git(app, 'ls-tree', r1.branch, 'lib')} | ${a1.report}`);
    R.check('[DP-03] 서브모듈: 메인의 중첩 저장소는 그대로(v2 · HEAD main)', fs.readFileSync(path.join(sub, 'lib.txt'), 'utf8').trim() === 'v2' && git(sub, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main');
    // 칸에서 서브모듈 안의 추적 파일을 고쳤으면 worktree 를 지우지 않는다(그 변경은 결과 브랜치에 없으니 남겨 보고한다).
    const r1b = Ln.start({ ...quiet, root: app, goal: 'y' });
    write(path.join(r1b.worktree, 'lib', 'lib.txt'), 'edited\n');
    commitIn(r1b.worktree, { 'c.txt': 'c\n' });
    const a1b = await I.accept({ ...quiet, root: app, id: r1b.id });
    const editedFile = path.join(r1b.worktree, 'lib', 'lib.txt');
    const t1b = S.readTask(app, r1b.id);
    R.check('[DP-04] 서브모듈 안을 고쳤으면 worktree 를 남긴다(변경을 잃지 않는다) · 남긴 이유를 기록한다',
      a1b.status === 'accepted' && !!t1b.worktree_kept && fs.existsSync(editedFile) && fs.readFileSync(editedFile, 'utf8').trim() === 'edited',
      `${a1b.status} kept=${t1b.worktree_kept} | ${a1b.report}`);

    // ── 형제 폴더: worktree_links: ["../dep"] ──
    const ws2 = path.join(base, 'ws2'), app2 = path.join(ws2, 'app'), dep = path.join(ws2, 'dep');
    write(path.join(dep, 'd.txt'), 'dep\n');
    fs.mkdirSync(app2, { recursive: true }); git(app2, 'init', '-q', '-b', 'main'); cfg(app2);
    write(path.join(app2, 'AGENTS.md'), '# app\n\n```yaml\nworktree_links: ["../dep", "../../escape", "/abs", "../missing"]\n```\n');
    git(app2, 'add', '-A'); git(app2, 'commit', '-qm', 'init');
    const r2 = Ln.start({ ...quiet, root: app2, goal: 'x' });
    const f2 = path.resolve(r2.worktree, '..', 'dep', 'd.txt');
    const seen2 = fs.existsSync(f2) ? fs.readFileSync(f2, 'utf8').trim() : null;
    const wtDir = path.join(app2, '.harness-worktrees');
    R.check('[DP-05] worktree_links ../dep: worktree 에서 ../dep 이 메인의 형제 폴더를 가리킨다', seen2 === 'dep' && r2.status === 'open', `${seen2} ${r2.status}`);
    R.check('[DP-06] 저장소 위로 둘 이상 · 절대 경로 · 없는 대상은 만들지 않는다', !fs.existsSync(path.join(wtDir, 'escape')) && !fs.existsSync(path.join(base, 'escape')) && !fs.existsSync(path.join(wtDir, 'missing')) && !fs.existsSync(path.join(wtDir, 'abs')),
      JSON.stringify(fs.readdirSync(wtDir)));
    commitIn(r2.worktree, { 'b.txt': 'b\n' });
    const a2 = await I.accept({ ...quiet, root: app2, id: r2.id });
    R.check('[DP-07] 작업이 끝나도(accept) 링크는 남고(다음 작업이 쓴다) 대상은 그대로', a2.status === 'accepted' && fs.lstatSync(path.join(wtDir, 'dep')).isSymbolicLink() && fs.readFileSync(path.join(dep, 'd.txt'), 'utf8').trim() === 'dep', `${a2.status} | ${a2.report}`);
    const gcr = St.gc({ root: app2 });
    R.check('[DP-08] gc 는 링크를 건드리지 않고 "남김" 으로도 보고하지 않는다', fs.existsSync(path.join(dep, 'd.txt')) && fs.lstatSync(path.join(wtDir, 'dep')).isSymbolicLink() && !gcr.kept.some(k => /dep$/.test(String(k.worktree))), JSON.stringify(gcr.kept));
    R.check('[DP-09] 링크는 git 에 들어가지 않는다(메인 · 결과 브랜치)', !git(app2, 'status', '--porcelain').includes('dep') && !git(app2, 'ls-tree', '-r', '--name-only', r2.branch).includes('dep'), git(app2, 'status', '--porcelain'));
    // 두 번째 칸도 같은 링크를 쓴다
    const r3 = Ln.start({ ...quiet, root: app2, goal: 'z' });
    const seen3 = fs.existsSync(path.resolve(r3.worktree, '..', 'dep', 'd.txt'));
    R.check('[DP-10] 두 번째 칸도 링크를 본다', seen3 === true && r3.status === 'open');
    // ── .NET 빌드 산출물(obj/ · bin/Debug|Release/)은 git 밖 변경으로 치지 않는다 ──
    //   [2026-10-03 · .NET 라이브러리 · 웹 서비스] 검사(dotnet test)가 만든 bin/obj 4,000여 개 때문에 작업마다 worktree 가 남았다.
    const app4 = path.join(base, 'ws4'); fs.mkdirSync(app4); git(app4, 'init', '-q', '-b', 'main'); cfg(app4);
    write(path.join(app4, '.gitignore'), 'bin/\nobj/\nkeep/\n'); write(path.join(app4, 'p.cs'), 'x\n'); git(app4, 'add', '-A'); git(app4, 'commit', '-qm', 'i');
    write(path.join(app4, 'P', 'obj', 'project.assets.json'), '{}'); write(path.join(app4, 'P', 'bin', 'Debug', 'net8.0', 'P.dll'), 'x'); write(path.join(app4, 'P', 'bin', 'Release', 'P.dll'), 'x');
    write(path.join(app4, 'tools', 'bin', 'run.sh'), 'x'); write(path.join(app4, 'keep', 'data.db'), 'x');
    const ig4 = G.ignoredChanges(app4, []).sort();
    R.check('[DP-11] obj/ · bin/Debug · bin/Release 는 git 밖 변경이 아니다 · 그 밖의 무시된 파일(bin/ 의 스크립트 · 데이터)은 여전히 잡는다',
      !ig4.some(f => /\/obj\/|\/bin\/(Debug|Release)\//.test(f)) && ig4.some(f => /tools\/bin\/run\.sh/.test(f)) && ig4.some(f => /keep\/data\.db/.test(f)), JSON.stringify(ig4));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

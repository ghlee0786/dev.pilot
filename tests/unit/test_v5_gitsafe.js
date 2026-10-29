'use strict';
// git.js 의 정리 동작이 남의 것을 건드리지 않는다 — 감사 2026-10-29: rdTree 가 '&' 든 경로를 cmd 에서 잘라 형제 폴더를 지웠고,
//   clearWorktreeSlot(killProcsIn)이 남은 레인 폴더를 연 사용자 편집기를 트리째 끝냈다. 모델 호출 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { makeReporter } = require('../run.js');
const G = require('../../harness/lib/git');
const S = require('../../harness/lib/state');
const R = makeReporter('git 정리 — 형제 폴더 · 사용자 앱을 건드리지 않는다');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-gitsafe-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

(async () => {
  const kids = [];
  try {
    // GS-01 'm&s' 같은 경로(공백 없음) — cmd 가 '&' 에서 명령을 나눠 'm' 을 지웠다
    if (process.platform === 'win32') {
      const decoy = path.join(base, 'm', 'sub', 'precious.txt'); write(decoy, 'keep\n');
      const target = path.join(base, 'm&s', '.harness-worktrees', 't-20261029-000000-abcd'); write(path.join(target, 'f.txt'), 'x\n');
      const ok = G.rdTree(target);
      R.check("[GS-01] rdTree: '&' 가 든 경로는 그 폴더만 지운다 — 이름이 '&' 앞부분인 형제 폴더는 남는다",
        ok === true && !fs.existsSync(target) && fs.existsSync(decoy), JSON.stringify({ ok, target: fs.existsSync(target), decoy: fs.existsSync(decoy) }));
      const pct = path.join(base, '%PATH%', 'wt'); write(path.join(pct, 'f.txt'), 'x\n');
      const ok2 = G.rdTree(pct);
      R.check("[GS-02] rdTree: '%' 가 든 경로(cmd 가 따옴표 안에서도 펼친다)도 그 폴더만 지운다", ok2 === true && !fs.existsSync(pct) && fs.existsSync(path.join(base, '%PATH%')), JSON.stringify({ ok2 }));
    }

    // GS-03 남은 폴더를 연 사용자 편집기(이름이 Code.exe)는 끝내지 않는다 · 같은 폴더의 고아 프로세스는 끝낸다
    const hold = path.join(base, 'left', 't-20261029-000000-beef'); write(path.join(hold, 'sleep.js'), 'setTimeout(()=>{},60000)');
    const editorExe = path.join(base, 'Microsoft VS Code', process.platform === 'win32' ? 'Code.exe' : 'code');
    fs.mkdirSync(path.dirname(editorExe), { recursive: true }); fs.copyFileSync(process.execPath, editorExe);
    const editor = spawn(editorExe, ['-e', 'setTimeout(()=>{},60000)', hold], { stdio: 'ignore', windowsHide: true }); kids.push(editor);
    const orphan = spawn(process.execPath, [path.join(hold, 'sleep.js')], { stdio: 'ignore', windowsHide: true }); kids.push(orphan);
    await new Promise(r => setTimeout(r, 800));
    const seen = G.procsIn(hold);
    const killed = G.killProcsIn(hold);
    await new Promise(r => setTimeout(r, 800));
    R.check('[GS-03] killProcsIn: 폴더를 연 편집기(Code)는 끝내지 않는다', seen.some(p => p.pid === editor.pid) && !killed.some(p => p.pid === editor.pid) && S.pidAlive(editor.pid), JSON.stringify({ seen, killed }));
    R.check('[GS-04] killProcsIn: 같은 폴더의 고아 프로세스(node)는 끝낸다', killed.some(p => p.pid === orphan.pid) && !S.pidAlive(orphan.pid), JSON.stringify(killed));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally {
    for (const k of kids) { try { process.kill(k.pid); } catch { /* 끝났다 */ } }
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ }
  }
  R.done();
})();

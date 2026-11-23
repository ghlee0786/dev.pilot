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
    const orphanSpawnAt = Date.now();
    const orphan = spawn(process.execPath, [path.join(hold, 'sleep.js')], { stdio: 'ignore', windowsHide: true }); kids.push(orphan);
    // GS-04 관측 — 실패하면 pid 재사용 · 종료 실패 · 종료 지연을 구분할 수 있게 자기 자식의 exit 이벤트를 기록한다
    let orphanExit = null; orphan.on('exit', (code, signal) => { orphanExit = { code, signal, at: Date.now() }; });
    // 두 프로세스가 목록에 보일 때까지(상한 30초) — [2026-10-30 릴리스 CI] 부하 속에서 0.8초 뒤 목록에 아직 없었다(복사한 실행 파일 기동이 늦음)
    let seen = [];
    for (const until = Date.now() + 30000; Date.now() < until;) {
      seen = G.procsIn(hold);
      if (seen.some(p => p.pid === editor.pid) && seen.some(p => p.pid === orphan.pid)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!seen.some(p => p.pid === editor.pid)) console.log(`  (GS-03 대기: 30초 안에 편집기 pid ${editor.pid} 가 목록에 보이지 않았다 — ${JSON.stringify(seen)})`);
    const killAt = Date.now();
    const killed = G.killProcsIn(hold);
    await new Promise(r => setTimeout(r, 800));
    const orphanAlive = S.pidAlive(orphan.pid);   // 판정은 이 한 번 — 아래 관측은 판정에 쓰지 않는다
    R.check('[GS-03] killProcsIn: 폴더를 연 편집기(Code)는 끝내지 않는다', seen.some(p => p.pid === editor.pid) && !killed.some(p => p.pid === editor.pid) && S.pidAlive(editor.pid), JSON.stringify({ seen, killed }));
    const gs04 = killed.some(p => p.pid === orphan.pid) && !orphanAlive;
    let gs04Detail = { orphanPid: orphan.pid, orphanAlive, killed };
    if (!gs04) {
      let kill0 = 'ok'; try { process.kill(orphan.pid, 0); } catch (e) { kill0 = e.code; }
      gs04Detail = { ...gs04Detail, kill0, exitCode: orphan.exitCode, signalCode: orphan.signalCode,
        exitEvent: orphanExit && { code: orphanExit.code, signal: orphanExit.signal, msAfterKill: orphanExit.at - killAt }, spawnAt: new Date(orphanSpawnAt).toISOString(), killAt: new Date(killAt).toISOString() };
      if (orphanAlive && process.platform === 'win32') {
        // 지금 그 pid 를 가진 프로세스 — 생성 시각이 spawnAt 보다 뒤면 다른 프로세스(pid 재사용). 남의 명령줄은 적지 않는다(이 테스트 폴더를 가리킬 때만).
        const q = `Get-CimInstance Win32_Process -Filter "ProcessId=${orphan.pid}" | ForEach-Object { '{0}\t{1}\t{2}\t{3}' -f $_.Name, $_.CreationDate.ToUniversalTime().ToString('o'), $_.ParentProcessId, $_.CommandLine }`;
        const r = require('node:child_process').spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', q], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
        const [name, created, ppid, ...cmd] = String(r.stdout || '').trim().split('\t');
        const line = cmd.join('\t');
        gs04Detail.samePidNow = name ? { name, created, ppid: Number(ppid), ownTestProcess: line.toLowerCase().includes(hold.toLowerCase()), cmd: line.toLowerCase().includes(hold.toLowerCase()) ? line.slice(0, 300) : '(다른 프로세스 — 생략)' } : { none: true, status: r.status };
      }
    }
    R.check('[GS-04] killProcsIn: 같은 폴더의 고아 프로세스(node)는 끝낸다', gs04, JSON.stringify(gs04Detail));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally {
    for (const k of kids) { try { process.kill(k.pid); } catch { /* 끝났다 */ } }
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ }
  }
  R.done();
})();

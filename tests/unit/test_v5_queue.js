'use strict';
// 줄 선 잠금(S.acquireQueued) — 우선순위 0 이 줄 선 1 을 앞지른다 · 같은 우선순위는 먼저 온 순서 · 죽은 pid 의 번호표는 지운다 ·
//   끝나면 번호표와 잠금을 치운다 · 옛 acquire 주인과 서로 배제 · 기다리는 동안 이벤트 루프를 막지 않는다.
//   [2026-10-25 C++ 저장소 실측] 사용자의 accept 가 1초 폴링 잠금 뒤에서 무인 검사들을 2.5시간 기다렸다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const R = makeReporter('v5 줄 선 잠금 — 차례 · 우선순위 · 죽은 번호표 · 끝날 때 정리');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-queue-'));
const STATE = path.resolve(__dirname, '..', '..', 'harness', 'lib', 'state.js');
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
function mkRepo(name) {
  const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']); git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n'); git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return dir;
}
const deadPid = () => 99999996;   // 어느 OS 에서도 배정되지 않는 큰 값
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await wait(25); }
  console.log(`  (기다리다 상한: ${what})`);
  return false;
}
const qdir = repo => path.join(S.paths(repo).locksDir, 'checks.queue');
const tickets = repo => { try { return fs.readdirSync(qdir(repo)).filter(n => n.endsWith('.json')); } catch { return []; } };
// 자식 프로세스: 줄을 서서 잡으면 "got" 을 찍고 MODE 에 따라 행동한다(hold: 계속 쥠 · exit: 풀지 않고 끝남).
const child = (repo, env) => {
  const script = `const S=require(${JSON.stringify(STATE)});
    S.acquireQueued(process.env.REPO,'checks',{priority:Number(process.env.PRI||1),label:process.env.LABEL,pollMs:40}).then(h=>{
      console.log('got '+Date.now());
      if(process.env.MODE==='exit') process.exit(0);
      if(process.env.MODE==='release'){h.release();process.exit(0);}
      setTimeout(()=>{},60000);
    });`;
  const c = spawn(process.execPath, ['-e', script], { env: { ...process.env, REPO: repo, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  c.out = ''; c.stdout.on('data', d => { c.out += d; }); c.stderr.on('data', d => { c.out += d; });
  c.done = new Promise(r => c.on('close', code => r(code)));
  return c;
};

(async () => {
  const kids = [];
  try {
    const repo = mkRepo('q1');

    // ── 같은 프로세스: 우선순위 0 이 앞지르고 · 같은 우선순위는 먼저 온 순서 ──
    const h0 = await S.acquireQueued(repo, 'checks', { label: 'holder', pollMs: 30 });
    R.check('[Q-01] 줄이 비었으면 곧바로 잡는다 · 같은 잠금(checks.lock)의 주인이 된다', h0 && S.lockOwner(repo, 'checks') && S.lockOwner(repo, 'checks').pid === process.pid && typeof h0.release === 'function');
    const order = [];
    const take = (label, priority) => S.acquireQueued(repo, 'checks', { label, priority, pollMs: 30 }).then(h => { order.push(label); h.release(); });
    const pA = take('A', 1); await wait(20);
    const pB = take('B', 1); await wait(20);
    const pC = take('C', 0); await wait(20);
    const q = S.queueOf(repo, 'checks');
    R.check('[Q-02] queueOf — 번호표 차례대로(우선순위 0 → 먼저 온 1 — 잡은 이도 1 이면 그 자리) · pid · priority · label · at', q.map(x => `${x.priority}${x.label}`).join() === '0C,1holder,1A,1B' && q.every(x => x.pid === process.pid && !!x.at), JSON.stringify(q));
    // 창은 500ms — 부하가 큰 PC 에서 250ms 창은 막지 않아도 틱이 3~4 번에 그쳤다(2026-10-29 실측). 막는 구현이면 창 길이와 상관없이 틱이 거의 없다.
    let ticks = 0; const iv = setInterval(() => { ticks++; }, 20);
    await wait(500);
    clearInterval(iv);
    R.check('[Q-03] 기다리는 동안 이벤트 루프를 막지 않는다(타이머가 돈다) · 아직 아무도 잡지 못한다', ticks >= 5 && order.length === 0, `ticks=${ticks} order=${order}`);
    h0.release();
    await Promise.all([pA, pB, pC]);
    R.check('[Q-04] 풀리면 우선순위 0(C) 이 먼저 — 그다음 먼저 온 순서(A, B)', order.join() === 'C,A,B', order.join());
    R.check('[Q-04] 다 풀면 번호표 · 잠금이 남지 않는다', tickets(repo).length === 0 && !fs.existsSync(S.lockDir(repo, 'checks')), JSON.stringify(tickets(repo)));

    // ── 옛 acquire 주인과 서로 배제 ──
    const old = S.acquire(repo, 'checks');
    let got = null; const pq = S.acquireQueued(repo, 'checks', { pollMs: 30 }).then(h => { got = h; });
    await wait(300);
    R.check('[Q-05] 옛 S.acquire 가 쥔 잠금 — 줄 맨 앞이어도 기다린다', got === null);
    old.release();
    await until(() => got, 3000, 'old acquire release');
    R.check('[Q-05] 옛 주인이 풀면 잡는다', !!got && S.lockOwner(repo, 'checks').pid === process.pid);
    let plain = null; try { S.acquire(repo, 'checks'); } catch (e) { plain = e; }
    R.check('[Q-05] 줄로 잡은 동안 옛 S.acquire 는 LOCK_HELD', plain && plain.code === 'LOCK_HELD', plain && plain.message);
    got.release();

    // ── 죽은 pid 의 번호표 ──
    fs.mkdirSync(qdir(repo), { recursive: true });
    const deadTicket = path.join(qdir(repo), `0-${'0'.repeat(15)}-${String(deadPid()).padStart(10, '0')}-000001.json`);
    fs.writeFileSync(deadTicket, JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date().toISOString(), priority: 0, label: 'dead' }));
    R.check('[Q-06] queueOf 는 죽은 pid 의 번호표를 보이지 않는다', S.queueOf(repo, 'checks').length === 0, JSON.stringify(S.queueOf(repo, 'checks')));
    const t0 = Date.now();
    const hd = await Promise.race([S.acquireQueued(repo, 'checks', { pollMs: 30 }), wait(3000).then(() => null)]);
    R.check('[Q-06] 맨 앞의 죽은 pid 번호표(우선순위 0)는 지우고 곧바로 잡는다', !!hd && Date.now() - t0 < 2000 && !fs.existsSync(deadTicket), `${!!hd} ${Date.now() - t0}ms exists=${fs.existsSync(deadTicket)}`);
    if (hd) hd.release();

    // ── 다른 프로세스: 0 이 줄 선 1 을 앞지른다 ──
    const repo2 = mkRepo('q2');
    const hh = await S.acquireQueued(repo2, 'checks', { label: 'parent-holder' });
    const k1 = child(repo2, { PRI: '1', LABEL: 'k1', MODE: 'release' }); kids.push(k1);
    await until(() => S.queueOf(repo2, 'checks').some(x => x.label === 'k1'), 10000, 'k1 ticket');
    const k2 = child(repo2, { PRI: '1', LABEL: 'k2', MODE: 'release' }); kids.push(k2);
    await until(() => S.queueOf(repo2, 'checks').some(x => x.label === 'k2'), 10000, 'k2 ticket');
    let mine = 0; const pm = S.acquireQueued(repo2, 'checks', { priority: 0, label: 'accept', pollMs: 30 }).then(h => { mine = Date.now(); return h; });
    await until(() => S.queueOf(repo2, 'checks').some(x => x.label === 'accept'), 5000, 'accept ticket');
    hh.release();
    const hm = await pm;
    await wait(300);
    const k1Before = /got/.test(k1.out);
    hm.release();
    await Promise.all([k1.done, k2.done]);
    const at = c => Number((/got (\d+)/.exec(c.out) || [])[1]);
    R.check('[Q-07] 다른 프로세스 둘이 먼저 줄 서도 우선순위 0 이 먼저 잡는다 · 그다음 먼저 온 자식 순서', !k1Before && mine > 0 && at(k1) >= mine && at(k2) >= at(k1), `mine=${mine} k1=${at(k1)} k2=${at(k2)} out1=${k1.out.slice(0, 200)} out2=${k2.out.slice(0, 200)}`);
    R.check('[Q-07] 끝나면 번호표가 남지 않는다', tickets(repo2).length === 0, JSON.stringify(tickets(repo2)));

    // ── 끝날 때 정리: 풀지 않고 끝난 주인 · 강제로 죽은 주인 ──
    const repo3 = mkRepo('q3');
    const kx = child(repo3, { MODE: 'exit', LABEL: 'exiter' }); kids.push(kx);
    const codeX = await kx.done;
    R.check('[Q-08] 잡은 채 process.exit — 번호표와 잠금을 치우고 끝난다', codeX === 0 && /got/.test(kx.out) && tickets(repo3).length === 0 && !fs.existsSync(S.lockDir(repo3, 'checks')), `code=${codeX} out=${kx.out.slice(0, 200)} t=${JSON.stringify(tickets(repo3))} lock=${fs.existsSync(S.lockDir(repo3, 'checks'))}`);
    const kh = child(repo3, { MODE: 'hold', LABEL: 'holder' }); kids.push(kh);
    await until(() => /got/.test(kh.out), 10000, 'holder got');
    let after = null; const pa = S.acquireQueued(repo3, 'checks', { pollMs: 30 }).then(h => { after = h; });
    await wait(300);
    R.check('[Q-09] 다른 프로세스가 쥐고 있으면 기다린다', after === null && /got/.test(kh.out), kh.out.slice(0, 200));
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(kh.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else kh.kill('SIGKILL');
    await kh.done;
    await until(() => after, 5000, 'after kill');
    R.check('[Q-09] 강제로 죽은 주인 — 그 번호표는 지워지고 잠금은 빼앗겨 다음이 잡는다', !!after && S.queueOf(repo3, 'checks').length === 1 && tickets(repo3).length === 1, `${!!after} ${JSON.stringify(S.queueOf(repo3, 'checks'))}`);
    if (after) after.release();
    await pa;
    R.check('[Q-09] 풀면 남는 것이 없다', tickets(repo3).length === 0 && !fs.existsSync(S.lockDir(repo3, 'checks')));

    // ── [2026-10-29 감사] 강제 종료된 accept 의 번호표 · 잠금 + 그 pid 를 다른(산) 프로세스가 다시 받음 — 줄이 영영 막히면 안 된다 ──
    {
      const repo4 = mkRepo('q4');
      const spawnedAt = Date.now();
      const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); kids.push(other);
      await wait(300);
      const old = Date.now() - 3 * 86400000, oldIso = new Date(old).toISOString();
      fs.mkdirSync(qdir(repo4), { recursive: true });
      fs.writeFileSync(path.join(qdir(repo4), `1-${String(old).padStart(15, '0')}-${String(other.pid).padStart(10, '0')}-000001.json`), JSON.stringify({ pid: other.pid, host: os.hostname(), at: oldIso, started_at: oldIso, priority: 1, label: 'accept t-old' }));
      fs.mkdirSync(S.lockDir(repo4, 'checks'), { recursive: true });
      fs.writeFileSync(path.join(S.lockDir(repo4, 'checks'), 'owner.json'), JSON.stringify({ pid: other.pid, host: os.hostname(), at: oldIso, started_at: oldIso, token: 'deadbeef' }));
      // 시작 시각 기록이 없는 옛 판의 잠금도 — 신호가 사흘 멈췄으면 죽은 것
      fs.mkdirSync(S.lockDir(repo4, 'merge'), { recursive: true });
      fs.writeFileSync(path.join(S.lockDir(repo4, 'merge'), 'owner.json'), JSON.stringify({ pid: other.pid, host: os.hostname(), at: oldIso, token: 'oldmerge' }));
      const removed4 = S.removeDeadLocks(repo4);
      const t0 = Date.now();
      let got4 = null; const p4 = S.acquireQueued(repo4, 'checks', { priority: 0, pollMs: 50 }).then(h => { got4 = h; });
      await until(() => got4, 8000, 'acquire past the reused-pid ghost');
      const ms = Date.now() - t0, aliveStill = other.exitCode == null;
      R.check('[Q-10] 재사용된 pid 의 유령 잠금 · 번호표(사흘 전 · 시작 시각 다름) — 산 무관 프로세스가 있어도 곧바로 치우고 잡는다 · 옛 기록(시작 시각 없음)도 신호 나이로',
        !!got4 && aliveStill && ms < 6000 && removed4.includes('checks') && removed4.includes('merge') && !S.queueOf(repo4, 'checks').some(x => x.label === 'accept t-old'),
        JSON.stringify({ got: !!got4, ms, aliveStill, removed4, q: S.queueOf(repo4, 'checks') }));
      if (!got4) { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(other.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else other.kill('SIGKILL'); }
      await p4;
      got4.release();
      R.check('[Q-10] 새 잠금 · 번호표 기록에는 이 프로세스의 시작 시각(started_at)이 있다 — 산 주인은 그대로 산 것',
        (() => { const h = S.acquire(repo4, 'x'); const ok = !!S.lockOwner(repo4, 'x').started_at && S.ownerAlive(S.lockOwner(repo4, 'x')) && S.ownerAlive({ pid: other.pid, host: os.hostname(), at: new Date().toISOString(), started_at: new Date(spawnedAt).toISOString() }); h.release(); return ok; })());
    }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally {
    for (const k of kids) { try { if (k.exitCode == null) { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(k.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else k.kill('SIGKILL'); } } catch { /* 끝남 */ } }
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ }
  }
  R.done();
})();

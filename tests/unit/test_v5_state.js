'use strict';
// v5 상태 — 경로 · id · 원자 쓰기 · mkdir 잠금(죽은 주인 빼앗기 · 산 주인 거부 · 고아 잠금) · 동시 worktree 생성 직렬화
//   · .worktreeinclude 복사 · exclude · 커밋 신원 폴백 · index.lock 경합 재시도.
//   [v7 Light] heartbeat(무인 작업자의 주인 갱신 · startHeartbeat · ownerRecord)가 빠져 ST-07 을 뺐다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const G = require('../../harness/lib/git');
const R = makeReporter('v5 상태 — 잠금 · worktree · 기록');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-state-'));
const HARNESS = path.resolve(__dirname, '..', '..', 'harness');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
function mkRepo(name, files) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [f, t] of Object.entries(files || { 'README.md': '# r\n' })) write(path.join(dir, f), t);
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return dir;
}
// 끝난 프로세스의 pid 는 부하가 크면 곧 재사용된다(Windows) — 어느 OS 에서도 배정되지 않는 큰 값(4의 배수).
const deadPid = () => 99999996;
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore', windowsHide: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
function runChildren(n, script, env) {
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise(res => {
    const c = spawn(process.execPath, ['-e', script], { env: { ...process.env, ...env, CHILD_I: String(i) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('close', code => res({ code, out, err }));
  })));
}

(async () => {
  try {
    // ── id · 경로 ─────────────────────────────────────────────────────
    const id = S.newId(new Date(2026, 8, 29, 7, 5, 3));
    R.check('[ST-01] id 형식 t-yyyymmdd-HHMMss-4hex', /^t-20260929-070503-[0-9a-f]{4}$/.test(id) && S.validId(id), id);
    R.check('[ST-01] 잘못된 id 는 거부', !S.validId('../x') && !S.validId('t-1-2-zz'));
    const repo = mkRepo('r1');
    const P = S.taskPaths(repo, id);
    R.check('[ST-02] 상태는 <git-common-dir>/harness/ 아래', P.taskFile === path.join(fs.realpathSync.native(repo), '.git', 'harness', 'tasks', id, 'task.json') && P.locksDir === path.join(fs.realpathSync.native(repo), '.git', 'harness', 'locks'), P.taskFile);
    R.check('[ST-02] worktree 는 <repo>/.harness-worktrees/<id> · 브랜치 harness/<id> · 계획은 .harness/<id>/PLAN.md',
      P.wt === path.join(fs.realpathSync.native(repo), '.harness-worktrees', id) && P.branch === `harness/${id}` && P.planFile === path.join(P.wt, '.harness', id, 'PLAN.md'));

    // ── 원자 쓰기 · 기록 ─────────────────────────────────────────────
    const t = S.newTask({ id, goal: 'g' });
    S.writeTask(repo, t); t.reason = 'second'; S.writeTask(repo, t);
    const back = S.readTask(repo, id);
    const leftovers = fs.readdirSync(P.dir).filter(n => n.endsWith('.tmp'));
    R.check('[ST-03] task.json 은 임시 파일 + rename — 임시 파일이 남지 않고 마지막 값이 읽힌다', back && back.reason === 'second' && leftovers.length === 0, JSON.stringify(leftovers));
    R.check('[ST-03] task.json 스키마의 키가 모두 있다', ['id', 'goal', 'runtime', 'model', 'effort', 'status', 'reason', 'base_branch', 'base_commit', 'branch', 'worktree', 'session_id', 'owner', 'checks', 'caps', 'spent', 'commits', 'merge_commit', 'revert_commit', 'outside_git', 'tests_modified', 'created_at', 'updated_at'].every(k => k in back));
    S.log(repo, id, { event: 'x', n: 1 }); S.log(repo, id, { event: 'y' });
    const lg = S.readLog(repo, id);
    R.check('[ST-03] log.jsonl — 한 줄 한 사건, 시각 포함', lg.length === 2 && lg[0].event === 'x' && !!lg[0].at);
    R.check('[ST-03] listTasks 는 유효한 id 폴더만', S.listTasks(repo).map(x => x.id).join() === id);

    // ── 잠금 ─────────────────────────────────────────────────────────
    const h1 = S.acquire(repo, 'merge');
    let held = null; try { S.acquire(repo, 'merge'); } catch (e) { held = e; }
    R.check('[ST-04] 산 주인(이 프로세스)의 잠금은 LOCK_HELD', held && held.code === 'LOCK_HELD' && held.owner.pid === process.pid, held && held.message);
    const own = S.lockOwner(repo, 'merge');
    R.check('[ST-04] owner.json {pid, host, at}', own && own.pid === process.pid && own.host === os.hostname() && !!own.at);
    h1.release();
    R.check('[ST-04] 해제하면 디렉터리가 사라진다', !fs.existsSync(S.lockDir(repo, 'merge')));

    const dead = deadPid();
    write(path.join(S.lockDir(repo, 'task-x'), 'owner.json'), JSON.stringify({ pid: dead, host: os.hostname(), at: new Date().toISOString(), token: 'old' }));
    let took = false;
    const h2 = S.acquire(repo, 'task-x', { onTakeover: () => { took = true; } });
    R.check('[ST-05] 죽은 pid 의 잠금은 빼앗는다', took && S.lockOwner(repo, 'task-x').pid === process.pid, `dead=${dead}`);
    h2.release();

    const live = sleeper();
    await wait(100);
    write(path.join(S.lockDir(repo, 'task-y'), 'owner.json'), JSON.stringify({ pid: live.pid, host: os.hostname(), at: new Date().toISOString(), token: 'live' }));
    let liveErr = null; try { S.acquire(repo, 'task-y', { waitMs: 200 }); } catch (e) { liveErr = e; }
    R.check('[ST-05] 산 pid(다른 프로세스)의 잠금은 기다린 뒤에도 빼앗지 않는다', liveErr && liveErr.code === 'LOCK_HELD' && liveErr.owner.pid === live.pid);
    live.kill();
    await wait(300);
    let afterKill = null; try { afterKill = S.acquire(repo, 'task-y'); } catch (e) { afterKill = e; }
    R.check('[ST-05] 주인이 죽으면 빼앗을 수 있다', afterKill && typeof afterKill.release === 'function', afterKill && afterKill.message);
    if (afterKill && afterKill.release) afterKill.release();

    fs.mkdirSync(S.lockDir(repo, 'orphan'), { recursive: true });
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(S.lockDir(repo, 'orphan'), old, old);
    let orphan = null; try { orphan = S.acquire(repo, 'orphan'); } catch (e) { orphan = e; }
    R.check('[ST-05] owner.json 없이 오래된(고아) 잠금은 빼앗는다', orphan && typeof orphan.release === 'function', orphan && orphan.message);
    fs.mkdirSync(S.lockDir(repo, 'fresh-orphan'), { recursive: true });
    let fresh = null; try { S.acquire(repo, 'fresh-orphan'); } catch (e) { fresh = e; }
    R.check('[ST-05] 방금 만들어진 고아 잠금은 아직 빼앗지 않는다(쓰는 중일 수 있다)', fresh && fresh.code === 'LOCK_HELD');
    if (orphan && orphan.release) orphan.release();

    // 해제는 자기 토큰일 때만 — 빼앗긴 뒤의 늦은 해제가 새 주인을 지우지 않는다.
    const h3 = S.acquire(repo, 'tok');
    write(path.join(S.lockDir(repo, 'tok'), 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token: 'someone-else' }));
    h3.release();
    R.check('[ST-05] 남의 토큰이 된 잠금은 release 가 지우지 않는다', fs.existsSync(S.lockDir(repo, 'tok')));
    fs.rmSync(S.lockDir(repo, 'tok'), { recursive: true, force: true });

    // [M5] 빼앗기 경합(TOCTOU): B 가 죽은 잠금(token old)을 stale 로 본 뒤, B 가 빼앗기 전에 A 가 먼저 빼앗아 새로 잡는다.
    //      그다음 B 의 빼앗기는 A 의 산 잠금을 지우면 안 된다 — 주인은 A 하나.
    const raceDir = S.lockDir(repo, 'race');
    write(path.join(raceDir, 'owner.json'), JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date().toISOString(), token: 'old' }));
    const seenByB = S.lockOwner(repo, 'race');                  // B 가 stale 판정 때 본 주인
    const bJudgedStale = S.lockStale(raceDir);
    const hA = S.acquire(repo, 'race');                          // A 가 먼저 빼앗고 잡았다
    let bTook = null; try { bTook = S.takeOver(raceDir, seenByB); } catch (e) { bTook = e; }
    const afterB = S.lockOwner(repo, 'race');
    let bAcq = null; try { bAcq = S.acquire(repo, 'race'); } catch (e) { bAcq = e; }
    R.check('[ST-12][M5] 늦은 빼앗기(본 토큰 ≠ 지금 토큰)는 실패한다 · A 의 owner.json 이 그대로', bJudgedStale && bTook === false && afterB && afterB.token === hA.owner.token, `took=${bTook} after=${JSON.stringify(afterB)}`);
    R.check('[ST-12][M5] 그 뒤 B 의 acquire 는 LOCK_HELD — 주인은 하나', bAcq && bAcq.code === 'LOCK_HELD' && bAcq.owner && bAcq.owner.token === hA.owner.token, bAcq && (bAcq.message || 'acquired twice'));
    if (bAcq && bAcq.release) bAcq.release();
    hA.release();
    R.check('[ST-12][M5] A 가 해제하면 잠금이 사라진다', !fs.existsSync(raceDir));

    // [M5] acquire 경로에서의 같은 경합: stale 판정 직후(빼앗기 직전) 다른 주인이 먼저 빼앗아 잡는다.
    write(path.join(raceDir, 'owner.json'), JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date().toISOString(), token: 'old2' }));
    let hA2 = null;
    let bRes = null;
    try { bRes = S.acquire(repo, 'race', { beforeTakeover: () => { if (!hA2) hA2 = S.acquire(repo, 'race'); } }); } catch (e) { bRes = e; }
    R.check('[ST-12][M5] acquire 중 끼어든 빼앗기 — 늦은 쪽은 LOCK_HELD · 먼저 잡은 쪽의 토큰이 남는다', !!hA2 && bRes && bRes.code === 'LOCK_HELD' && S.lockOwner(repo, 'race').token === hA2.owner.token,
      `hA2=${!!hA2} b=${bRes && (bRes.code || 'acquired')} owner=${JSON.stringify(S.lockOwner(repo, 'race'))}`);
    if (bRes && bRes.release) bRes.release();
    if (hA2) hA2.release();

    // [M5] release: owner.json 이 없으면(빼앗긴 뒤 다른 주인이 mkdir 만 하고 아직 owner.json 을 쓰기 전) 지우지 않는다.
    const hR = S.acquire(repo, 'rel');
    const relDir = S.lockDir(repo, 'rel');
    fs.rmSync(relDir, { recursive: true, force: true });
    fs.mkdirSync(relDir);                                       // 새 주인의 mkdir — owner.json 은 아직
    hR.release();
    R.check('[ST-13][M5] owner.json 없는 잠금은 release 가 지우지 않는다(남의 것일 수 있다)', fs.existsSync(relDir));
    fs.rmSync(relDir, { recursive: true, force: true });

    // ── 동시성: 서로 다른 프로세스 4개가 같은 잠금 ─────────────────────
    const repoC = mkRepo('conc');
    const stamps = path.join(base, 'stamps');
    fs.mkdirSync(stamps);
    const lockScript = `const S=require(${JSON.stringify(path.join(HARNESS, 'lib', 'state.js'))});const fs=require('fs'),p=require('path');
      const start=Number(process.env.T0);while(Date.now()<start){}
      S.withLockSync(process.env.REPO,'worktree',()=>{const a=Date.now();S.sleepSync(150);const b=Date.now();fs.writeFileSync(p.join(process.env.STAMPS,process.env.CHILD_I+'.json'),JSON.stringify([a,b]));},{waitMs:20000});`;
    const lr = await runChildren(4, lockScript, { REPO: repoC, STAMPS: stamps, T0: String(Date.now() + 700) });
    const iv = fs.readdirSync(stamps).map(f => JSON.parse(fs.readFileSync(path.join(stamps, f), 'utf8'))).sort((a, b) => a[0] - b[0]);
    const disjoint = iv.every((x, i) => i === 0 || x[0] >= iv[i - 1][1]);
    R.check('[ST-06] 잠금 아래 구간 4개가 겹치지 않는다(프로세스 4개 동시 시작)', lr.every(x => x.code === 0) && iv.length === 4 && disjoint, JSON.stringify({ iv, errs: lr.map(x => x.err.slice(0, 200)) }));

    const wtScript = `const G=require(${JSON.stringify(path.join(HARNESS, 'lib', 'git.js'))});const p=require('path');
      const start=Number(process.env.T0);while(Date.now()<start){}
      const i=process.env.CHILD_I;G.addWorktree(process.env.REPO,p.join(process.env.REPO,'.harness-worktrees','w'+i),{branch:'harness/w'+i,base:'HEAD'});`;
    const wr = await runChildren(4, wtScript, { REPO: repoC, T0: String(Date.now() + 700) });
    const branches = git(repoC, ['branch', '--list', 'harness/*']).split(/\r?\n/).filter(Boolean);
    const listed = G.worktreeList(repoC).length;
    R.check('[ST-06] worktree 4개 동시 생성 — 전부 성공(잠금 경합 없음)', wr.every(x => x.code === 0) && branches.length === 4 && listed === 5, JSON.stringify({ codes: wr.map(x => x.code), errs: wr.map(x => x.err.slice(0, 300)), branches, listed }));
    const ex = fs.readFileSync(path.join(repoC, '.git', 'info', 'exclude'), 'utf8');
    R.check('[ST-06] .harness-worktrees/ 가 .git/info/exclude 에 한 번만 등록된다', (ex.match(/^\.harness-worktrees\/$/gm) || []).length === 1, ex);
    R.check('[ST-06] 메인 체크아웃 git status 에 worktree 폴더가 보이지 않는다', git(repoC, ['status', '--porcelain']) === '');

    // ── .worktreeinclude ─────────────────────────────────────────────
    const repoI = mkRepo('inc', { '.gitignore': '.env\nsecret/\n*.log\n', '.worktreeinclude': '# copy these\n.env\nsecret/\ntracked.txt\n', 'tracked.txt': 'tracked\n' });
    write(path.join(repoI, '.env'), 'TOKEN=1\n');
    write(path.join(repoI, 'secret', 'key.txt'), 'k\n');
    write(path.join(repoI, 'noise.log'), 'log\n');
    const wtI = path.join(repoI, '.harness-worktrees', 'x');
    G.addWorktree(repoI, wtI, { branch: 'harness/x', base: 'HEAD' });
    const copied = G.copyWorktreeInclude(repoI, wtI).map(x => x.path).sort();
    R.check('[ST-08] .worktreeinclude: 패턴에 맞고 무시된 파일만 복사(.env · secret/key.txt)', copied.join() === '.env,secret/key.txt' && fs.readFileSync(path.join(wtI, '.env'), 'utf8') === 'TOKEN=1\n', JSON.stringify(copied));
    R.check('[ST-08] 목록에 없는 무시된 파일(noise.log)은 복사하지 않는다', !fs.existsSync(path.join(wtI, 'noise.log')));
    R.check('[ST-08] .worktreeinclude 가 없으면 아무것도 복사하지 않는다', G.copyWorktreeInclude(repo, path.join(base, 'nowhere')).length === 0);

    // ── 저장소 준비 · 커밋 ──────────────────────────────────────────
    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty);
    const top = G.ensureRepo(empty);
    R.check('[ST-09] git 저장소가 아니면 init + 빈 첫 커밋', G.samePath(top, empty) && git(empty, ['rev-list', '--count', 'HEAD']) === '1');

    const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    const blankCfg = path.join(base, 'blank.gitconfig'); write(blankCfg, '');
    const repoN = path.join(base, 'noid'); fs.mkdirSync(repoN);
    process.env.GIT_CONFIG_GLOBAL = blankCfg; process.env.GIT_CONFIG_NOSYSTEM = '1';
    let author = '';
    try {
      git(repoN, ['init', '-q']);
      write(path.join(repoN, 'a.txt'), 'a');
      G.commitAll(repoN, 'first');
      author = git(repoN, ['log', '-1', '--format=%an <%ae>']);
    } finally {
      if (savedEnv.g == null) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedEnv.g;
      if (savedEnv.s == null) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = savedEnv.s;
    }
    R.check('[ST-09] 신원이 없는 저장소: -c user.name=harness -c user.email=harness@localhost', author === 'harness <harness@localhost>', author);
    R.check('[ST-09] 신원이 있으면 저장소 설정을 쓴다', (() => { write(path.join(repo, 'b.txt'), 'b'); G.commitAll(repo, 'b'); return git(repo, ['log', '-1', '--format=%an']) === 't'; })());
    R.check('[ST-09] 변경이 없으면 commitAll 은 null', G.commitAll(repo, 'nothing') === null);

    // index.lock 경합: 다른 프로세스가 0.5초 뒤 잠금을 푼다 → 재시도로 성공.
    const lockFile = path.join(repo, '.git', 'index.lock');
    write(lockFile, '');
    spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').unlinkSync(${JSON.stringify(lockFile)}),500)`], { stdio: 'ignore', windowsHide: true });
    write(path.join(repo, 'c.txt'), 'c');
    let sha = null, cErr = null;
    const tc = Date.now();
    try { sha = G.commitAll(repo, 'c under contention'); } catch (e) { cErr = e; }
    R.check('[ST-10] index.lock 경합 — 백오프 재시도 뒤 커밋 성공', !!sha && git(repo, ['log', '-1', '--format=%s']) === 'c under contention' && Date.now() - tc >= 300, cErr && cErr.message);

    // 죽은 잠금 정리
    write(path.join(S.lockDir(repo, 'dead-one'), 'owner.json'), JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date().toISOString(), token: 'd' }));
    const keep = S.acquire(repo, 'alive-one');
    const removed = S.removeDeadLocks(repo);
    R.check('[ST-11] removeDeadLocks: 죽은 잠금만 지운다', removed.includes('dead-one') && !removed.includes('alive-one') && fs.existsSync(S.lockDir(repo, 'alive-one')), JSON.stringify(removed));
    keep.release();

    // [2026-10-29 감사] 같은 호스트의 주인 — pid 가 살아 있어도(EPERM · 재사용) 신호가 사흘 멈췄거나 시작 시각이 다르면 죽은 것
    {
      const sl = sleeper(), spawnedAt = Date.now();
      await wait(300);
      const host = os.hostname(), old = new Date(Date.now() - 3 * 86400000).toISOString(), fresh = new Date().toISOString();
      const v6 = S.ownerAlive({ pid: sl.pid, host, heartbeat_at: old });
      const reused = S.ownerAlive({ pid: sl.pid, host, at: fresh, started_at: old });
      const real = S.ownerAlive({ pid: sl.pid, host, at: old, started_at: new Date(spawnedAt).toISOString() });
      const nowFresh = S.ownerAlive({ pid: sl.pid, host, heartbeat_at: fresh });
      const selfStart = S.procStartMs(process.pid);
      // [2026-10-29 설치 전 점검] 시작 시각이 없는 옛 기록 — 재부팅 뒤 같은 pid 를 받은 프로세스(svchost)가 마지막 신호 뒤에 시작됐다 → 다른 프로세스
      const rebooted = S.ownerAlive({ pid: sl.pid, host, heartbeat_at: new Date(spawnedAt - 3600000).toISOString() });
      R.check('[ST-15] 시작 시각이 없는 옛 기록: 그 pid 의 프로세스가 마지막 신호 뒤에 시작됐으면 죽은 주인(pid 재사용)', rebooted === false, JSON.stringify({ rebooted }));
      R.check('[ST-14] 같은 호스트: 신호가 사흘 멈춘 옛 기록 → 죽음 · 시작 시각이 다른(재사용된) pid → 죽음 · 시작 시각이 맞으면 오래 쥐어도 산 것 · 새 신호면 산 것 · 없는 pid 는 none',
        !v6 && !reused && real && nowFresh && typeof selfStart === 'number' && Math.abs(selfStart - Date.parse(S.PROC_STARTED_AT)) < 10000 && S.procStartMs(deadPid()) === 'none',
        JSON.stringify({ v6, reused, real, nowFresh, selfStart, started: S.PROC_STARTED_AT }));
      sl.kill();
    }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

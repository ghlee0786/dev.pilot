'use strict';
// update — 배포된 릴리스(GitHub Releases)로 설치된 하네스를 갈아 끼운다(CD 의 받는 쪽). 가짜 GitHub(이 PC 안)로만.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const { makeReporter } = require('../run.js');
const U = require('../../harness/lib/update');
const R = makeReporter('update — 릴리스 비교 · 내려받기 · 설치');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-update-'));
const SRC = path.resolve(__dirname, '..', '..', 'harness');
const CLI = path.join(SRC, 'cli.js');
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const copyDir = (s, d) => { fs.mkdirSync(d, { recursive: true }); for (const e of fs.readdirSync(s, { withFileTypes: true })) { const a = path.join(s, e.name), b = path.join(d, e.name); if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b); } };
const cli = (args, env) => new Promise(res => { const c = spawn(process.execPath, [CLI, ...args], { env, windowsHide: true }); let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; }); c.on('close', code => res({ code, out })); });

(async () => {
  try {
    R.check('[UP-01] 판 비교: 숫자 · v 접두 · dev 는 언제나 낡았다', U.newer('v5.1.0', 'dev') && U.newer('5.2.0', '5.1.9') && !U.newer('v5.1.0', '5.1.0') && !U.newer('5.0.9', '5.1.0') && U.newer('5.10.0', '5.9.0'));

    // 릴리스 묶음: 지금 하네스 + VERSION 9.9.9
    const pkg = path.join(base, 'pkg'); copyDir(SRC, path.join(pkg, 'harness'));
    fs.writeFileSync(path.join(pkg, 'harness', 'VERSION'), '9.9.9\n');
    const t = spawnSync('tar', ['-czf', 'harness-9.9.9.tar.gz', 'harness'], { cwd: pkg, encoding: 'utf8', windowsHide: true });
    const tgz = fs.readFileSync(path.join(pkg, 'harness-9.9.9.tar.gz'));
    let latest = 'v9.9.9';
    const srv = http.createServer((req, res) => {
      if (req.url === '/repos/o/r/releases/latest') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ tag_name: latest, assets: [{ name: 'harness-9.9.9.tar.gz', browser_download_url: `http://127.0.0.1:${srv.address().port}/dl/harness-9.9.9.tar.gz` }] })); }
      if (req.url === '/dl/harness-9.9.9.tar.gz') { res.setHeader('content-type', 'application/octet-stream'); return res.end(tgz); }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const env = { ...process.env, HARNESS_GITHUB_API: `http://127.0.0.1:${srv.address().port}`, HARNESS_UPDATE_REPO: 'o/r', HARNESS_BUG_REPORT: 'off' };

    // 설치된 저장소(판 dev)
    const repo = path.join(base, 'app'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'user.email', 't@example.invalid');
    fs.writeFileSync(path.join(repo, 'README.md'), '# a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i');
    spawnSync(process.execPath, [CLI, 'install', '--root', repo], { encoding: 'utf8', windowsHide: true, env });
    const v0 = fs.readFileSync(path.join(repo, 'harness', 'VERSION'), 'utf8').trim();
    const d1 = await cli(['update', '--dry-run', '--root', repo], env);
    R.check('[UP-02] update --dry-run: 새 판이 있다고만 알리고 바꾸지 않는다', t.status === 0 && v0 === 'dev' && /새 판이 있다 — 지금 dev → 9\.9\.9/.test(d1.out) && fs.readFileSync(path.join(repo, 'harness', 'VERSION'), 'utf8').trim() === 'dev', `${t.stderr} ${d1.out}`);
    const u1 = await cli(['update', '--root', repo], env);
    R.check('[UP-03] update: 릴리스를 내려받아 설치 — harness/VERSION 9.9.9 · 관리 블록 그대로', u1.code === 0 && fs.readFileSync(path.join(repo, 'harness', 'VERSION'), 'utf8').trim() === '9.9.9' && /harness:begin/.test(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')), u1.out.slice(-400));
    const u2 = await cli(['update', '--root', repo], env);
    R.check('[UP-04] 이미 최신이면 아무것도 하지 않는다', u2.code === 0 && /최신이다/.test(u2.out), u2.out);
    // 실행 중인 작업이 있으면 install 이 거부 → update 도 바꾸지 않는다(주인 = 이 테스트 프로세스 — v7 에서 S.ownerRecord 가 빠져 직접 적는다)
    latest = 'v10.0.0';
    const S = require('../../harness/lib/state');
    const id = 't-20261013-000000-abcd';
    S.writeTask(repo, { ...S.newTask({ id, goal: 'g', runtime: 'claude', model: 'opus', base_branch: 'main', base_commit: git(repo, 'rev-parse', 'HEAD'), branch: `harness/${id}`, worktree: path.join(repo, '.harness-worktrees', id), owner: { pid: process.pid, host: os.hostname(), heartbeat_at: new Date().toISOString() }, caps: { budget_usd: 1, wall_min: 1, max_continuations: 1 } }), status: 'running' });
    const u3 = await cli(['update', '--root', repo], env);
    R.check('[UP-05] 실행 중인 작업이 있으면 갈아 끼우지 않는다(install 이 거부)', u3.code !== 0 && fs.readFileSync(path.join(repo, 'harness', 'VERSION'), 'utf8').trim() === '9.9.9' && /설치하지 않았다/.test(u3.out), u3.out.slice(0, 400));

    // ── 자동 갱신(사용 시점 · 하루 한 번 · 작업 중엔 건너뜀 · 하네스 파일만 커밋) — [2026-10-13 사용자 결정 A] ──
    const u4 = await cli(['update', '--auto', '--root', repo], env);
    R.check('[UP-06] update --auto: 실행 중인 작업이 있으면 조용히 건너뛴다(exit 0 · 그대로)', u4.code === 0 && fs.readFileSync(path.join(repo, 'harness', 'VERSION'), 'utf8').trim() === '9.9.9', u4.out.slice(0, 300));
    // [2026-10-15 실측] 작업 중이라 미룬 갱신이 하루 뒤에야 다시 시도됐다 — 옛 판(셸 상한에 죽는)이 그동안 계속 쓰였다. 1시간 뒤 다시 본다.
    {
      const AU0 = require('../../harness/lib/autoupdate'), now0 = Date.now(), seen = [];
      const soon = AU0.maybe(repo, { spawn: r => seen.push(r), now: now0 + 10 * 60000 });
      const later = AU0.maybe(repo, { spawn: r => seen.push(r), now: now0 + 70 * 60000 });
      R.check('[UP-06b] 작업 중이라 미룬 자동 갱신은 하루가 아니라 1시간 뒤 다시 시도한다', !soon && later && seen.length === 1, JSON.stringify({ soon, later, state: AU0.readState(repo) }));
      AU0.writeState(repo, {});
    }
    // 하네스 파일을 git 에 넣어 둔 저장소 — 갱신은 하네스 파일만 따로 커밋, 사용자의 미커밋 변경은 그대로
    const repo2 = path.join(base, 'tracked'); fs.mkdirSync(repo2); git(repo2, 'init', '-q', '-b', 'main'); git(repo2, 'config', 'user.name', 't'); git(repo2, 'config', 'user.email', 't@example.invalid'); git(repo2, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo2, 'README.md'), '# t\n'); git(repo2, 'add', '-A'); git(repo2, 'commit', '-qm', 'init');
    spawnSync(process.execPath, [CLI, 'install', '--root', repo2], { encoding: 'utf8', windowsHide: true, env });
    git(repo2, 'add', '-A'); git(repo2, 'commit', '-qm', 'harness');
    fs.writeFileSync(path.join(repo2, 'README.md'), '# t\nuser edit\n');
    const u5 = await cli(['update', '--auto', '--root', repo2], env);
    const files5 = git(repo2, 'show', '--name-only', '--format=%s', 'HEAD').split(/\r?\n/);
    R.check('[UP-07] 자동 갱신: 설치 · 하네스 파일만 커밋(메시지 "자동 갱신") · 사용자의 미커밋 README 는 그대로',
      u5.code === 0 && fs.readFileSync(path.join(repo2, 'harness', 'VERSION'), 'utf8').trim() === '9.9.9' && /자동 갱신/.test(files5[0]) && files5.includes('harness/VERSION') && !files5.includes('README.md') && /README\.md/.test(git(repo2, 'status', '--porcelain')),
      `${u5.code} ${u5.out.slice(-300)} | ${files5.join(',')} | ${git(repo2, 'status', '--porcelain')}`);
    // [2026-10-13 실측 · .NET 저장소 3곳] AGENTS.md 는 추적하고 harness/ 는 무시하는 저장소 — 갱신된 관리 블록이 미커밋으로 남았다
    const repo3 = path.join(base, 'agents-only'); fs.mkdirSync(repo3); git(repo3, 'init', '-q', '-b', 'main'); git(repo3, 'config', 'user.name', 't'); git(repo3, 'config', 'user.email', 't@example.invalid'); git(repo3, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo3, '.gitignore'), 'harness/\n.claude/\n.codex/\n.agents/\n');
    spawnSync(process.execPath, [CLI, 'install', '--root', repo3], { encoding: 'utf8', windowsHide: true, env });
    const ag3 = path.join(repo3, 'AGENTS.md');
    fs.writeFileSync(ag3, fs.readFileSync(ag3, 'utf8').replace('### 언어', '### 언어(옛 판)'));   // 옛 관리 블록
    fs.writeFileSync(path.join(repo3, 'README.md'), '# t\n');
    git(repo3, 'add', '-A'); git(repo3, 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo3, 'README.md'), '# t\nuser edit\n');
    const u6 = await cli(['update', '--auto', '--root', repo3], env);
    const files6 = git(repo3, 'show', '--name-only', '--format=%s', 'HEAD').split(/\r?\n/);
    R.check('[UP-11] harness/ 를 추적하지 않아도 추적 중인 관리 파일(AGENTS.md)의 갱신은 커밋한다 · 사용자 README 는 그대로',
      u6.code === 0 && /자동 갱신/.test(files6[0]) && files6.includes('AGENTS.md') && !files6.includes('README.md') && !/AGENTS\.md/.test(git(repo3, 'status', '--porcelain')) && /README\.md/.test(git(repo3, 'status', '--porcelain')),
      `${u6.code} ${u6.out.slice(-300)} | ${files6.join(',')} | ${git(repo3, 'status', '--porcelain')}`);

    // 언제 확인하나 — 설치된 사본에서만 · 하루 한 번 · auto_update: off 면 안 한다(실제로 띄우는 대신 기록만 받는다)
    const AU = require('../../harness/lib/autoupdate');
    const spawned = []; const spy = (root) => spawned.push(root);
    const m1 = AU.maybe(repo2, { spawn: spy, now: 1000 });
    const m2 = AU.maybe(repo2, { spawn: spy, now: 1000 + 3600 * 1000 });
    const m3 = AU.maybe(repo2, { spawn: spy, now: 1000 + 25 * 3600 * 1000 });
    R.check('[UP-08] 하루 한 번만 확인한다(첫 호출 · 25시간 뒤 → 띄움 · 1시간 뒤 → 안 띄움)', m1 && !m2 && m3 && spawned.length === 2, JSON.stringify([m1, m2, m3, spawned.length]));
    fs.writeFileSync(path.join(repo2, 'CLAUDE.md'), '```yaml\nauto_update: off\n```\n');
    R.check('[UP-09] auto_update: off 면 확인하지 않는다', !AU.maybe(repo2, { spawn: spy, now: 1000 + 60 * 3600 * 1000 }) && spawned.length === 2);
    const plain = path.join(base, 'plain'); fs.mkdirSync(plain); git(plain, 'init', '-q');
    R.check('[UP-10] 하네스가 설치되지 않은 곳(원본 · 저장소만)은 확인하지 않는다', !AU.maybe(plain, { spawn: spy, now: 1 }) && !AU.maybe(path.resolve(__dirname, '..', '..'), { spawn: spy, now: 1 }) && spawned.length === 2);

    // ── [2026-10-29 감사] v7: 'running' 작업이 없어도 accept · batch 의 잠금이 살아 있으면 자동 갱신은 미룬다 · 끝나지 않은 v6 작업은 자동으로 이행하지 않는다 ──
    {
      const repo4 = path.join(base, 'busy'); fs.mkdirSync(repo4); git(repo4, 'init', '-q', '-b', 'main'); git(repo4, 'config', 'user.name', 't'); git(repo4, 'config', 'user.email', 't@example.invalid');
      fs.writeFileSync(path.join(repo4, 'README.md'), '# b\n'); git(repo4, 'add', '-A'); git(repo4, 'commit', '-qm', 'i');
      spawnSync(process.execPath, [CLI, 'install', '--root', repo4], { encoding: 'utf8', windowsHide: true, env });
      const ver = () => fs.readFileSync(path.join(repo4, 'harness', 'VERSION'), 'utf8').trim();
      const h = S.acquire(repo4, 'merge');
      const t0 = Date.now();
      const a1 = await cli(['update', '--auto', '--root', repo4], env);
      h.release();
      const st = AU.readState(repo4);
      R.check('[UP-12] 병합 잠금이 살아 있으면(accept 도중) 자동 갱신은 조용히 미룬다(exit 0 · 그대로) · 1시간 뒤 다시 보게 확인 시각을 당긴다',
        a1.code === 0 && ver() === 'dev' && /미룸/.test(a1.out) && /merge/.test(a1.out) && st.checked_at && Math.abs(st.checked_at - (t0 - AU.DAY_MS + AU.RETRY_MS)) < 120000, `${a1.code} ${a1.out.slice(0, 300)} ${JSON.stringify(st)}`);
      const id6 = 't-20261026-095354-6951', wt6 = path.join(repo4, '.harness-worktrees', id6), td6 = path.join(repo4, '.git', 'harness', 'tasks', id6);
      fs.mkdirSync(wt6, { recursive: true }); fs.mkdirSync(td6, { recursive: true });
      fs.writeFileSync(path.join(td6, 'task.json'), JSON.stringify({ id: id6, status: 'interrupted', mode: 'thin', goal: 'v6 goal', branch: `harness/${id6}`, worktree: wt6, session_id: 'sess-v6' }));
      const old = new Date(Date.now() - 2 * 86400000); fs.utimesSync(path.join(td6, 'task.json'), old, old);
      const a2 = await cli(['update', '--auto', '--root', repo4], env);
      const mig = path.join(repo4, '.git', 'harness', 'v7-migration.md');
      R.check('[UP-13] 끝나지 않은 v6 작업이 있으면 자동 갱신은 이행하지 않고 미룬다(GitHub 의 Pre-release 표시에 기대지 않는다)', a2.code === 0 && ver() === 'dev' && /v6/.test(a2.out) && !fs.existsSync(mig), a2.out.slice(0, 300));
      const a3 = await cli(['update', '--root', repo4], env);
      R.check('[UP-14] 손으로 update(--migrate 없음)는 거부하며 --migrate 를 알린다', a3.code !== 0 && ver() === 'dev' && /--migrate/.test(a3.out), a3.out.slice(0, 400));
      const a4 = await cli(['update', '--migrate', '--root', repo4], env);
      R.check('[UP-15] update --migrate: 이어 가는 법(start --from · claude --resume)을 적고 설치한다', a4.code === 0 && ver() === '9.9.9' && fs.existsSync(mig) && /start --from t-20261026-095354-6951/.test(fs.readFileSync(mig, 'utf8')) && /claude --resume sess-v6/.test(fs.readFileSync(mig, 'utf8')), a4.out.slice(-400));
    }
    srv.close();
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

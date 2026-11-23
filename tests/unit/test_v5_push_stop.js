'use strict';
// push — 버그 2026-10-01(Python 서비스 저장소)의 공식 경로.
//   push: guard 가 에이전트의 git push 를 무조건 막는데 AGENTS.md 는 "명시한 뒤에만" 이라 적었다 → 좁힌 하네스 명령으로 허락의 길.
//   [v7 Light] stop(무인 작업 멈추기)은 무인 작업자와 함께 빠졌다 — ST-* 를 빼고, 뺀 명령이 exit 2 와 대체 명령을 알리는지(RM-*)를 본다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { makeReporter } = require('../run.js');
const Push = require('../../harness/lib/push.js');
const R = makeReporter('push — 허락의 길 · v7 에서 뺀 명령');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-pushstop-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const cfg = d => { git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false'); };

(async () => {
  try {
    // ── push ──
    const bare = path.join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', bare);
    const a = path.join(base, 'a');
    git(base, 'clone', '-q', bare, a); cfg(a);
    write(path.join(a, 'x.txt'), '1\n'); git(a, 'add', '-A'); git(a, 'commit', '-qm', 'one'); git(a, 'push', '-q', '-u', 'origin', 'main');
    write(path.join(a, 'x.txt'), '2\n'); git(a, 'commit', '-qam', 'two');
    const dry = Push.push({ root: a, dryRun: true });
    R.check('[PS-01] dry-run: 올릴 커밋을 보여 주고 원격은 그대로', dry.ok && dry.dryRun && dry.ahead === 1 && dry.remote === 'origin' && git(bare, 'rev-parse', 'main') !== git(a, 'rev-parse', 'main'), JSON.stringify(dry).slice(0, 200));
    const cli = spawnSync(process.execPath, [CLI, 'push', '--root', a], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    R.check('[PS-02] CLI push: 빨리감기면 올린다(원격 = 로컬) · exit 0', cli.status === 0 && git(bare, 'rev-parse', 'main') === git(a, 'rev-parse', 'main') && /PUSHED/.test(cli.stdout), `${cli.status} ${cli.stdout} ${cli.stderr}`);
    const nothing = Push.push({ root: a });
    R.check('[PS-03] 올릴 것이 없으면 아무것도 하지 않는다', nothing.ok && !nothing.pushed && /nothing to push/.test(nothing.reason));
    // 원격이 앞서면(다른 클론이 먼저 올림) 강제로 덮지 않고 거부
    const b = path.join(base, 'b');
    git(base, 'clone', '-q', bare, b); cfg(b);
    write(path.join(b, 'y.txt'), 'b\n'); git(b, 'add', '-A'); git(b, 'commit', '-qm', 'from b'); git(b, 'push', '-q', 'origin', 'main');
    write(path.join(a, 'x.txt'), '3\n'); git(a, 'commit', '-qam', 'three');
    const behind = Push.push({ root: a });
    const remoteNow = git(bare, 'rev-parse', 'main');
    R.check('[PS-04] 원격이 앞서면 거부(강제 push 없음) · 원격 그대로', behind.refused && /not a fast-forward/.test(behind.reason) && remoteNow === git(b, 'rev-parse', 'main'), behind.reason);
    git(a, 'branch', 'harness/t-20261001-000000-abcd');
    let e1 = null; try { Push.push({ root: a, branch: 'harness/t-20261001-000000-abcd' }); } catch (e) { e1 = e; }
    R.check('[PS-05] 결과 브랜치(harness/*)는 올리지 않는다(USAGE)', e1 && e1.code === 'USAGE' && /accept it/.test(e1.message), e1 && e1.message);
    const guard = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'harness', 'hooks', 'guard.js')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: a, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }), encoding: 'utf8', windowsHide: true });
    R.check('[PS-06] guard 는 git push 를 막고 이유에 `node harness/cli.js push` 를 안내한다', /deny/.test(guard.stdout) && /harness\/cli\.js push/.test(guard.stdout), guard.stdout.slice(0, 300));
    const guardOk = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'harness', 'hooks', 'guard.js')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: a, tool_name: 'Bash', tool_input: { command: 'node harness/cli.js push origin main' } }), encoding: 'utf8', windowsHide: true });
    R.check('[PS-06] guard 는 하네스 push 명령은 통과시킨다(사람의 승인은 Claude Code 권한 프롬프트가 받는다)', !/deny/.test(guardOk.stdout), guardOk.stdout);
    const authOut = Push.format({ ok: false, remote: 'gitea', branch: 'main', reason: 'would push 1 commit(s)', fetchError: "remote: Failed to authenticate user\nfatal: Authentication failed for 'http://h/r.git/'" });
    const plainOut = Push.format({ ok: false, remote: 'gitea', branch: 'main', reason: 'git push failed: fatal: unable to access: Could not resolve host' });
    R.check('[PS-07] 인증 실패면 자기 터미널에서 자격을 저장하라고 안내한다 · 다른 실패에는 안내하지 않는다', /hint: authentication to gitea failed — run `git fetch gitea`/.test(authOut) && !/hint:/.test(plainOut), authOut + '\n--\n' + plainOut);
    // PS-07b [2026-10-29 사용자 지시 중계] "토큰을 오래 보유하고 계속 요청하지 마라" — 원격 git 호출은 자격 증명 창을 띄우지 않는다(저장된 토큰만 쓴다) ·
    //   fetch 가 인증에서 막히면 push 를 시도하지 않고 한 번만 알린다. 401 을 주는 서버(자식 프로세스) · 받은 환경을 적는 자격 증명 도우미로 본다 — 진짜 창은 뜨지 않는다.
    {
      const srv = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>{r.writeHead(401,{'WWW-Authenticate':'Basic realm=\"x\"'});r.end()});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const port = await new Promise(res => srv.stdout.once('data', d => res(Number(String(d).trim()))));
      const envLog = path.join(base, 'helper-env.jsonl').replace(/\\/g, '/');
      const helper = path.join(base, 'helper.js').replace(/\\/g, '/');
      write(helper, `require('fs').appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({ gcm: process.env.GCM_INTERACTIVE || null, prompt: process.env.GIT_TERMINAL_PROMPT || null, op: process.argv[2] }) + '\\n');\n`);
      const c = path.join(base, 'auth'); fs.mkdirSync(c); git(c, 'init', '-q', '-b', 'main'); cfg(c);
      git(c, 'config', 'credential.helper', ''); git(c, 'config', '--add', 'credential.helper', `!node "${helper}"`);
      git(c, 'remote', 'add', 'gitea', `http://127.0.0.1:${port}/r.git`);
      write(path.join(c, 'f.txt'), 'f\n'); git(c, 'add', '-A'); git(c, 'commit', '-qm', 'f');
      let ra; try { ra = Push.push({ root: c, remote: 'gitea', branch: 'main' }); } finally { srv.kill(); }
      const calls = fs.existsSync(envLog) ? fs.readFileSync(envLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
      const gets = calls.filter(x => x.op === 'get');
      R.check('[PS-07b] 원격 git 호출은 창을 띄우지 않는다(GCM_INTERACTIVE=never · GIT_TERMINAL_PROMPT=0) · fetch 가 인증에서 막히면 push 를 시도하지 않고 한 번 알린다',
        gets.length >= 1 && gets.every(x => x.gcm === 'never' && x.prompt === '0') && ra && !ra.ok && !ra.pushed && /authentication/i.test(Push.format(ra)) && !/git push failed/.test(ra.reason || ''),
        JSON.stringify({ calls, reason: ra && ra.reason }));
    }

    // ── 태그 push(릴리스) — 덮어쓰지 않는다 · 강제 없음 ──
    //   [2026-10-13] dev.harness 릴리스(v 태그 → release.yml)를 올릴 길이 없었다 — guard 는 git push 를 막고 하네스 push 는 브랜치만 올렸다.
    git(a, 'tag', 'v1.0.0');
    const tg1 = spawnSync(process.execPath, [CLI, 'push', 'origin', '--tag', 'v1.0.0', '--root', a], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    R.check('[PS-08] push --tag: 원격에 없는 태그를 올린다(원격 태그 = 로컬 태그)', tg1.status === 0 && /PUSHED/.test(tg1.stdout) && git(bare, 'rev-parse', 'v1.0.0^{}') === git(a, 'rev-parse', 'v1.0.0^{}'), `${tg1.status} ${tg1.stdout} ${tg1.stderr}`);
    const tg2 = Push.push({ root: a, remote: 'origin', tag: 'v1.0.0' });
    R.check('[PS-09] 같은 태그가 이미 같은 커밋이면 아무것도 하지 않는다', tg2.ok && !tg2.pushed && /already/.test(tg2.reason), tg2.reason);
    const tg2d = Push.push({ root: a, remote: 'origin', tag: 'v1.0.0', dryRun: true });
    R.check('[PS-09] (#86 리뷰 N2 · 재리뷰 N4) 같은 태그가 이미 있어도 dry-run 은 쓰기 권한을 확인한다(write ok · 보낸 것 없음)', tg2d.ok && tg2d.dryRun && tg2d.write === 'ok' && !tg2d.pushed && /already/.test(tg2d.reason), JSON.stringify([tg2d.write, tg2d.reason]));
    git(b, 'fetch', '-q', 'origin'); git(b, 'tag', 'v2.0.0', 'origin/main'); git(b, 'push', '-q', 'origin', 'v2.0.0');
    git(a, 'tag', 'v2.0.0', 'HEAD');
    const remoteV2 = git(bare, 'rev-parse', 'v2.0.0');
    const tg3 = Push.push({ root: a, remote: 'origin', tag: 'v2.0.0' });
    R.check('[PS-10] 원격의 같은 이름 태그가 다른 커밋이면 거부(덮어쓰지 않는다)', tg3.refused && /different commit/.test(tg3.reason) && git(bare, 'rev-parse', 'v2.0.0') === remoteV2, tg3.reason);
    let e11 = null; try { Push.push({ root: a, remote: 'origin', tag: 'v9.9.9' }); } catch (e) { e11 = e; }
    R.check('[PS-11] 로컬에 없는 태그 → USAGE', e11 && e11.code === 'USAGE' && /no such tag/.test(e11.message), e11 && e11.message);

    // ── [dev.pilot #86] push --dry-run 이 쓰기 권한까지 확인한다(전송 0) · 실패면 원격 · 자격 증명 도우미 · 계정 · 비밀은 보이지 않는다 · 상한 ──
    //   격리: 사용자 · 시스템 git 설정과 실제 자격 저장소를 쓰지 않는다(임시 HOME · GIT_CONFIG_NOSYSTEM) · 원격은 임시 bare 와 127.0.0.1 의 Node 서버뿐.
    {
      const KEEP = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_SSH_COMMAND', 'HARNESS_PUSH_TIMEOUT_MS', 'GIT_HTTP_LOW_SPEED_LIMIT', 'GIT_HTTP_LOW_SPEED_TIME'];
      const saved = Object.fromEntries(KEEP.map(k => [k, process.env[k]]));
      const home = path.join(base, 'home86'); fs.mkdirSync(home, { recursive: true });
      Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' });
      for (const k of ['GIT_SSH_COMMAND', 'HARNESS_PUSH_TIMEOUT_MS', 'GIT_HTTP_LOW_SPEED_LIMIT', 'GIT_HTTP_LOW_SPEED_TIME']) delete process.env[k];
      const servers = [];
      try {
        const bare2 = path.join(base, 'r86.git'); git(base, 'init', '-q', '--bare', '-b', 'main', bare2);
        const w = path.join(base, 'w86'); git(base, 'clone', '-q', bare2, w); cfg(w); git(w, 'config', 'credential.helper', '');
        write(path.join(w, 'y.txt'), '1\n'); git(w, 'add', '-A'); git(w, 'commit', '-qm', 'y1'); git(w, 'push', '-q', '-u', 'origin', 'main');
        const remoteBefore = git(bare2, 'rev-parse', 'main');
        const d0 = Push.push({ root: w, dryRun: true });
        write(path.join(w, 'y.txt'), '2\n'); git(w, 'commit', '-qam', 'y2');
        const d1 = Push.push({ root: w, dryRun: true });
        R.check('[PS-12] dry-run 은 쓰기 권한을 확인한다(write ok · 전송 0) — 올릴 것이 없어도(ahead 0) · 올릴 것이 있어도 · bare 는 그대로',
          d0.ok && d0.dryRun && d0.write === 'ok' && d0.ahead === 0 && /nothing to push/.test(d0.reason) && d1.ok && d1.write === 'ok' && d1.ahead === 1 && /would push 1/.test(d1.reason) &&
          /write: ok \(dry run — nothing was sent\)/.test(Push.format(d1)) && git(bare2, 'rev-parse', 'main') === remoteBefore, JSON.stringify({ d0: [d0.write, d0.reason], d1: [d1.write, d1.reason] }));

        // 읽기는 되는데 쓰기 주소(pushurl)가 없는 곳 — "would push" 가 아니라 쓰기 확인 실패(반증 짝: PS-12)
        git(w, 'config', 'remote.origin.pushurl', path.join(base, 'no-such-remote.git'));
        const d2 = Push.push({ root: w, dryRun: true });
        const cli2 = spawnSync(process.execPath, [CLI, 'push', '--dry-run', '--root', w], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: process.env });
        R.check('[PS-13] fetch 는 되고 pushurl 이 없는 곳이면 dry-run 이 실패한다(write unreachable · exit 1) · bare 그대로 · 원격 · 도우미 · 계정 줄',
          !d2.ok && d2.dryRun && d2.write === 'unreachable' && !/would push/.test(d2.reason) && /nothing was sent/.test(d2.reason) && cli2.status === 1 &&
          /remote: origin → .*no-such-remote\.git/.test(cli2.stdout) && /credential helper: none/.test(cli2.stdout) && /account: unknown/.test(cli2.stdout) && git(bare2, 'rev-parse', 'main') === remoteBefore,
          `${JSON.stringify([d2.write, d2.reason])} ${cli2.status} ${cli2.stdout.slice(0, 500)}`);

        // receive-pack 을 거부하는 서버: 인증 없으면 401 · 인증하면 403(denied to alice) — 도우미는 받은 환경만 적고 비밀을 돌려준다
        const srvJs = "const s=require('http').createServer((q,r)=>{if(!/git-receive-pack/.test(q.url)){r.writeHead(404);return r.end();}if(!q.headers.authorization){r.writeHead(401,{'WWW-Authenticate':'Basic realm=\"x\"'});return r.end();}r.writeHead(403,{'Content-Type':'text/plain'});r.end('Permission to o/r.git denied to alice.\\n')});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))";
        const srv = spawn(process.execPath, ['-e', srvJs], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); servers.push(srv);
        const port = await new Promise(res => srv.stdout.once('data', d => res(Number(String(d).trim()))));
        const envLog = path.join(base, 'helper86-env.jsonl').replace(/\\/g, '/'), helper = path.join(base, 'helper86.js').replace(/\\/g, '/');
        write(helper, `require('fs').appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({ gcm: process.env.GCM_INTERACTIVE || null, prompt: process.env.GIT_TERMINAL_PROMPT || null, op: process.argv[2] }) + '\\n');\nif (process.argv[2] === 'get') process.stdout.write('username=alice\\npassword=SEKRET-XYZ-123\\n');\n`);
        git(w, 'config', '--add', 'credential.helper', `!node "${helper}"`);
        git(w, 'config', 'credential.username', 'alice');
        git(w, 'config', 'remote.origin.pushurl', `http://127.0.0.1:${port}/o/r.git`);
        const d3 = Push.push({ root: w, dryRun: true });
        const cli3 = spawnSync(process.execPath, [CLI, 'push', '--dry-run', '--json', '--root', w], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: process.env });
        const all3 = `${Push.format(d3)}\n${JSON.stringify(d3)}\n${cli3.stdout}\n${cli3.stderr}`;
        R.check('[PS-14] 쓰기가 거부되면 write denied · 계정(credential.username 출처) · 도우미 custom(node) · 원격 URL 을 보고한다 · 비밀(도우미가 준 비밀번호)은 어디에도 없다',
          !d3.ok && d3.write === 'denied' && d3.diagnose && d3.diagnose.account === 'alice' && d3.diagnose.accountFrom === 'credential.username' && d3.diagnose.helpers.includes('custom(node) (local)') &&
          d3.diagnose.url === `http://127.0.0.1:${port}/o/r.git` && /account: alice \(from credential\.username\)/.test(Push.format(d3)) && !/SEKRET-XYZ-123/.test(all3), all3.slice(0, 900));
        // URL 의 user(bob · hex 토큰)와 다른 credential.username(carol)을 두어, 계정이 URL 이 아니라 설정에서 온다는 것을 실제 값으로 고정한다
        git(w, 'config', 'credential.username', 'carol');
        git(w, 'config', 'remote.origin.pushurl', `http://bob:TOK-999@127.0.0.1:${port}/o/r.git`);
        const d4 = Push.push({ root: w, dryRun: true });
        const all4 = `${Push.format(d4)}\n${JSON.stringify(d4)}`;
        R.check('[PS-14] URL 에 user:token@ 이 있어도 토큰은 보이지 않는다 — 계정은 credential.username 의 carol(URL 의 bob 이 아니다 · 재리뷰 S5) · 원격 URL 은 userinfo 없이',
          !d4.ok && d4.diagnose && d4.diagnose.account === 'carol' && d4.diagnose.accountFrom === 'credential.username' && d4.diagnose.url === `http://127.0.0.1:${port}/o/r.git` && !/TOK-999/.test(all4) && !/\bbob\b/.test(all4), all4.slice(0, 700));
        const hex = '0123456789abcdef0123456789abcdef01234567';
        git(w, 'config', 'remote.origin.pushurl', `http://${hex}:x-oauth-basic@127.0.0.1:${port}/o/r.git`);
        const d4h = Push.push({ root: w, dryRun: true });
        const all4h = `${Push.format(d4h)}\n${JSON.stringify(d4h)}`;
        R.check('[PS-14] (재리뷰 S5) 접두 없는 40자 hex 토큰을 user 자리에 둔 <토큰>:x-oauth-basic@ 꼴도 계정 · 출력 · JSON 어디에도 없다 — 계정은 carol(credential.username)',
          !d4h.ok && d4h.diagnose && d4h.diagnose.account === 'carol' && d4h.diagnose.accountFrom === 'credential.username' && !all4h.includes(hex) && d4h.diagnose.url === `http://127.0.0.1:${port}/o/r.git`, all4h.slice(0, 700));
        git(w, 'config', '--unset', 'credential.username');
        // ssh 는 URL 의 user@ 를 계정으로 읽는다(ssh://alice@host · scp alice@host:) — 접속하지 않는 diagnose 만 본다
        git(w, 'remote', 'add', 'sshr', 'ssh://alice@host.example/o/r.git'); git(w, 'remote', 'add', 'scpr', 'alice@host.example:o/r.git');
        const ds = Push.diagnose(w, 'sshr', ''), dc = Push.diagnose(w, 'scpr', '');
        git(w, 'remote', 'remove', 'sshr'); git(w, 'remote', 'remove', 'scpr');
        R.check('[PS-14] (재리뷰 nit) ssh://alice@host · alice@host:o/r 는 계정 alice(remote URL 출처)', ds.account === 'alice' && ds.accountFrom === 'remote URL' && dc.account === 'alice' && dc.accountFrom === 'remote URL', JSON.stringify({ ds, dc }));
        const calls = fs.existsSync(envLog) ? fs.readFileSync(envLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
        R.check('[PS-15] 쓰기 확인도 창을 띄우지 않는다 — 도우미가 받은 환경 GIT_TERMINAL_PROMPT=0 · GCM_INTERACTIVE=never', calls.some(x => x.op === 'get') && calls.every(x => x.gcm === 'never' && x.prompt === '0'), JSON.stringify(calls).slice(0, 400));
        const e1 = Push.noPromptEnv(w, 60000);
        git(w, 'config', 'core.sshCommand', 'node fake-ssh.js');
        const e2 = Push.noPromptEnv(w, 60000);
        process.env.GIT_HTTP_LOW_SPEED_TIME = '999';
        const e3 = Push.noPromptEnv(w, 60000); delete process.env.GIT_HTTP_LOW_SPEED_TIME;
        git(w, 'config', '--unset', 'core.sshCommand');
        process.env.GIT_SSH = path.join(base, 'plink-fake.exe');
        const e4 = Push.noPromptEnv(w, 60000); delete process.env.GIT_SSH;
        git(w, 'config', 'ssh.variant', 'plink');
        const e5 = Push.noPromptEnv(w, 60000); git(w, 'config', '--unset', 'ssh.variant');
        git(w, 'config', `http.http://127.0.0.1:${port}/.lowSpeedTime`, '600');
        const e6 = Push.noPromptEnv(w, 60000); git(w, 'config', '--unset', `http.http://127.0.0.1:${port}/.lowSpeedTime`);
        R.check('[PS-15] SSH: 사용자가 ssh 명령을 정하지 않았으면 BatchMode=yes + ConnectTimeout · ServerAlive(같은 상한) · core.sshCommand 를 정했으면 덮지 않는다 · HTTP 도우미 상한은 사용자가 정한 env 가 있으면 덮지 않는다',
          e1.GIT_SSH_COMMAND === 'ssh -o BatchMode=yes -o ConnectTimeout=60 -o ServerAliveInterval=15 -o ServerAliveCountMax=4' && e1.GIT_HTTP_LOW_SPEED_TIME === '60' && e1.GIT_HTTP_LOW_SPEED_LIMIT === '1' && !('GIT_SSH_COMMAND' in e2) && e2.GIT_TERMINAL_PROMPT === '0' && !('GIT_HTTP_LOW_SPEED_TIME' in e3),
          JSON.stringify({ e1, e2, e3 }));
        R.check('[PS-15] (#86 리뷰 S3 · N1) GIT_SSH(plink 등) · ssh.variant 가 있으면 GIT_SSH_COMMAND 를 넣지 않는다 · git 설정 http.<url>.lowSpeedTime 이 있으면 HTTP 상한 env 를 넣지 않는다',
          !('GIT_SSH_COMMAND' in e4) && !('GIT_SSH_COMMAND' in e5) && e4.GIT_TERMINAL_PROMPT === '0' && !('GIT_HTTP_LOW_SPEED_TIME' in e6) && !('GIT_HTTP_LOW_SPEED_LIMIT' in e6) && 'GIT_SSH_COMMAND' in e6, JSON.stringify({ e4, e5, e6 }));

        // [#86 리뷰 B1] 콜론 없는 userinfo(https://<토큰>@host)는 계정이 아니다 — 출력 · --json · 하네스 기록 어디에도 토큰이 없다
        for (const tok of ['TOK-999-NOCOLON', 'ghp_ABCDEFGHIJKL123456']) {
          git(w, 'config', 'remote.origin.pushurl', `http://${tok}@127.0.0.1:${port}/o/r.git`);
          const d6 = Push.push({ root: w, dryRun: true });
          const cli6 = spawnSync(process.execPath, [CLI, 'push', '--dry-run', '--json', '--root', w], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: process.env });
          const cli6t = spawnSync(process.execPath, [CLI, 'push', '--dry-run', '--root', w], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: process.env });
          const walk = d => { let out = ''; let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return ''; } for (const e of names) { const p = path.join(d, e.name); out += e.isDirectory() ? walk(p) : (() => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } })(); } return out; };
          const all6 = `${Push.format(d6)}\n${JSON.stringify(d6)}\n${cli6.stdout}\n${cli6.stderr}\n${cli6t.stdout}\n${cli6t.stderr}\n${walk(path.join(w, '.git', 'harness'))}`;
          R.check(`[PS-18] 콜론 없는 userinfo 토큰(${tok.slice(0, 4)}…)은 계정으로 쓰지 않고 어디에도 보이지 않는다 — 원격 URL 은 userinfo 없이`,
            !d6.ok && d6.diagnose && d6.diagnose.account !== tok && !all6.includes(tok) && d6.diagnose.url === `http://127.0.0.1:${port}/o/r.git`, all6.slice(0, 700));
        }
        git(w, 'config', 'remote.origin.pushurl', `http://127.0.0.1:${port}/o/r.git`);

        // [#86 리뷰 S2] 쓰기 확인은 로컬 pre-push 훅을 돌리지 않는다(실제 push 는 그대로)
        const hookMark = path.join(base, 'pre-push-ran.txt').replace(/\\/g, '/');
        write(path.join(w, '.git', 'hooks', 'pre-push'), `#!/bin/sh\necho ran > "${hookMark}"\nexit 0\n`);
        try { fs.chmodSync(path.join(w, '.git', 'hooks', 'pre-push'), 0o755); } catch { /* Windows */ }
        git(w, 'config', '--unset', 'remote.origin.pushurl');
        git(w, 'push', '--dry-run', 'origin', 'main');
        const hookRunsPlain = fs.existsSync(hookMark); try { fs.rmSync(hookMark); } catch { /* 없음 */ }
        const d7 = Push.push({ root: w, dryRun: true });
        R.check('[PS-19] push --dry-run 의 쓰기 확인은 pre-push 훅을 돌리지 않는다(--no-verify) · 확인은 ok — 반증 짝: 맨 git push --dry-run 은 그 훅을 돌린다',
          hookRunsPlain && d7.ok && d7.write === 'ok' && !fs.existsSync(hookMark), JSON.stringify({ hookRunsPlain, ok: d7.ok, write: d7.write, ran: fs.existsSync(hookMark) }));
        const p7 = Push.push({ root: w });
        R.check('[PS-19] (짝) 실제 push 는 pre-push 훅을 그대로 돌린다 — 확인만 훅을 건너뛴다', p7.ok && p7.pushed && fs.existsSync(hookMark) && git(bare2, 'rev-parse', 'main') === git(w, 'rev-parse', 'main'), JSON.stringify({ ok: p7.ok, pushed: p7.pushed, reason: p7.reason, ran: fs.existsSync(hookMark) }));
        fs.rmSync(path.join(w, '.git', 'hooks', 'pre-push'));
        git(w, 'config', 'remote.origin.pushurl', `http://127.0.0.1:${port}/o/r.git`);

        // 상한: 연결을 받고 응답하지 않는 서버(10초 뒤 스스로 닫음) — 확인이 상한 근처에서 timeout 으로 끝나고 힌트를 보인다
        const mute = spawn(process.execPath, ['-e', "const s=require('net').createServer(c=>{setTimeout(()=>c.destroy(),10000)});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); servers.push(mute);
        const mport = await new Promise(res => mute.stdout.once('data', d => res(Number(String(d).trim()))));
        git(w, 'config', 'remote.origin.pushurl', `http://127.0.0.1:${mport}/o/r.git`);
        process.env.HARNESS_PUSH_TIMEOUT_MS = '2000';
        // 시간은 쓰기 확인(probe) 구간만 잰다 — fetch(로컬 bare) · 진단 git 호출은 넣지 않는다. 서버는 10초 뒤 스스로 닫으므로 9.5초를 넘기면 상한이 듣지 않은 것이다
        const t0 = Date.now(), pr5 = Push.probe(w, 'origin', 'refs/heads/main:refs/heads/main'), ms5 = Date.now() - t0;
        // push --dry-run 은 먼저 로컬 bare 에서 fetch 하고 같은 상한을 쓴다 — 부하 속 Windows 에서 그 fetch 가 2초를 넘겨 쓰기 확인 전에 끝났다(전체 실행). 5초여도 10초 서버보다 짧다
        process.env.HARNESS_PUSH_TIMEOUT_MS = '5000';
        const d5 = Push.push({ root: w, dryRun: true });
        delete process.env.HARNESS_PUSH_TIMEOUT_MS;
        R.check('[PS-16] 응답 없는 원격 — 쓰기 확인이 상한(2초) 근처에서 timeout 으로 끝난다(10초 서버를 기다리지 않는다) · push --dry-run 보고에 timeout 과 힌트',
          pr5.write === 'timeout' && ms5 < 9500 && !d5.ok && d5.write === 'timeout' && /did not answer in time/.test(Push.format(d5)),
          JSON.stringify({ probe: pr5.write, ms5, write: d5.write, reason: d5.reason, detail: d5.writeDetail }));
        const G = require('../../harness/lib/git.js');
        const tg = Date.now(), rt = G.git(w, ['-c', 'alias.slow=!node -e "setTimeout(()=>{},4000)"', 'slow'], { allowFail: true, timeout: 1000 }), msg = Date.now() - tg;
        R.check('[PS-16] git.run 은 넘긴 상한을 지킨다 — 시간 초과면 ok false · timedOut · err "timed out after"', !rt.ok && rt.timedOut === true && /timed out after 1s/.test(rt.err), JSON.stringify({ rt, msg }));
      } finally {
        for (const s of servers) { try { s.kill(); } catch { /* 끝남 */ } }
        for (const k of KEEP) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      }
    }

    // ── redactSecrets(진단용 비밀 가리기) · sanitize 는 그대로 · board.maskSecrets 의 빠진 꼴(#84 리뷰 N1) ──
    {
      const { redactSecrets, sanitize } = require('../../harness/lib/bugreport.js');
      const BD = require('../../harness/hooks/board.js');
      const src = "Authorization: Bearer abcdefghijklmnop · ghp_ABCDEFGH12345678 · https://u:p4ss@h.example/r.git · password=hunter22 · run --password s3cr3tVal · docker login -u me -p dckrPass1 · https://acct.blob.core.windows.net/c?sv=2020&sig=SASsig123%3D · remote: Permission to o/r.git denied to alice. · origin";
      const rd = redactSecrets(src);
      R.check('[PS-17] redactSecrets — Bearer · 토큰 · URL 비밀번호 · password= · --password 값 · login -p 값 · sig= 를 가리고, 계정 이름(denied to alice) · 원격 이름 · 호스트는 남긴다 · http(s) userinfo 는 통째로 <secret>@(재리뷰 S5)',
        !/abcdefghijklmnop|ghp_ABCDEFGH|p4ss|hunter22|s3cr3tVal|dckrPass1|SASsig123/.test(rd) && /denied to alice/.test(rd) && /origin/.test(rd) && /https:\/\/<secret>@h\.example\/r\.git/.test(rd), rd);
      const hx = 'https://0123456789abcdef0123456789abcdef01234567:x-oauth-basic@h.example/r.git · ssh://git@host.example/r.git';
      R.check('[PS-17] (재리뷰 S5) 접두 없는 40자 hex:x-oauth-basic@ — redactSecrets · maskSecrets 모두 user 까지 가린다 · ssh 의 git@ 은 그대로',
        [redactSecrets(hx), BD.maskSecrets(hx)].every(x => !/0123456789abcdef/.test(x) && /https:\/\/<secret>@h\.example/.test(x) && /ssh:\/\/git@host\.example/.test(x)), `${redactSecrets(hx)} || ${BD.maskSecrets(hx)}`);
      const sz = sanitize(src);
      R.check('[PS-17] sanitize 는 redactSecrets 를 먼저 부르고 URL 까지 가린다(발행용 · 기존보다 덜 가리지 않는다)', !/abcdefghijklmnop|ghp_ABCDEFGH|p4ss|hunter22|s3cr3tVal|dckrPass1|SASsig123|h\.example/.test(sz) && /<url>/.test(sz), sz);
      const ms = BD.maskSecrets('run --password s3cr3tVal · docker login -u me -p dckrPass1 · https://x/c?sv=1&sig=SASsig123 · mkdir -p some/dir · --pass=xx9pass');
      R.check('[PS-17] maskSecrets(#84 리뷰 N1) — 공백 구분 --password 값 · docker login … -p 값 · sig= 를 가린다 · login 이 아닌 -p(mkdir -p)는 그대로',
        !/s3cr3tVal|dckrPass1|SASsig123|xx9pass/.test(ms) && /mkdir -p some\/dir/.test(ms), ms);
      const nc = 'fatal: unable to access \'https://AZPATabc123xyz@dev.example/o/_git/r/\' · ssh://git@host.example/o/r.git · git@host.example:o/r.git · https://u:pw9@h.example/x';
      const rn = redactSecrets(nc), mn = BD.maskSecrets(nc);
      R.check('[PS-17] (#86 리뷰 S1) http(s) 의 콜론 없는 userinfo(토큰)는 가린다 — redactSecrets · maskSecrets 모두 · ssh 의 git@ 은 그대로',
        !/AZPATabc123xyz/.test(rn) && !/AZPATabc123xyz/.test(mn) && /https:\/\/<secret>@dev\.example/.test(rn) && /ssh:\/\/git@host\.example/.test(rn) && /git@host\.example:o\/r\.git/.test(rn) && /ssh:\/\/git@host\.example/.test(mn) && !/pw9/.test(rn) && !/pw9/.test(mn),
        `${rn} || ${mn}`);
      const n3 = BD.maskSecrets('[login test] mkdir -p out/x · ssh login -p 2222 host · find . -print');
      R.check('[PS-17] (#86 리뷰 N3) maskSecrets 의 login -p 는 레지스트리 login 만 — mkdir -p 경로 · ssh -p 포트 · -print 는 그대로', n3 === '[login test] mkdir -p out/x · ssh login -p 2222 host · find . -print', n3);
    }

    // ── v7 에서 뺀 명령: exit 2 · 무엇으로 바뀌었는지 알린다(옛 안내를 따르는 세션이 있다) ──
    const removedCli = (...args) => spawnSync(process.execPath, [CLI, ...args, '--root', a], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const go = removedCli('go', 'x');
    R.check('[RM-01] CLI go x: exit 2 · 뺐다고 알리고 대체 명령(start · claude --bg)을 적는다 · 작업을 만들지 않는다',
      go.status === 2 && /pilot go: removed in v7/.test(go.stderr) && /use start "<goal>"/.test(go.stderr) && /claude --bg/.test(go.stderr) && !fs.existsSync(path.join(a, '.harness-worktrees')),
      `${go.status} ${go.stderr.slice(0, 300)}`);
    const gone = [['resume', /use start --from <id>/], ['stop', /pilot stop: removed in v7/], ['factory', /use several lanes \(start\) \+ batch/], ['cleanup-legacy', /use gc/], ['metrics', /pilot metrics: removed in v7/]]
      .map(([cmd, re]) => { const r = removedCli(cmd, 't-20261001-000000-abcd'); return [cmd, r.status === 2 && re.test(r.stderr), r.status]; });
    R.check('[RM-02] resume · stop · factory · cleanup-legacy · metrics 도 exit 2 · 뺐다는 말과(있으면) 대체 명령', gone.every(x => x[1]), JSON.stringify(gone));

    // ── [2026-10-29 감사] start --owns 는 아무것도 막지 않았다(기록만) — 사용법에서 빼고 받지 않는다 ──
    const { parse, USAGE } = require(CLI);
    let ownsErr = null; try { parse(['start', 'x', '--owns', 'src/**']); } catch (e) { ownsErr = e; }
    const ownsCli = removedCli('start', 'lane A', '--owns', 'src/**');
    R.check('[RM-03] --owns: USAGE 에 없고 · parse 가 unknown option 으로 거부 · CLI 는 exit 2 · 레인을 만들지 않는다',
      !/--owns/.test(USAGE) && ownsErr && /unknown option: --owns/.test(ownsErr.message) && ownsCli.status === 2 && !fs.existsSync(path.join(a, '.harness-worktrees')), `${ownsErr && ownsErr.message} ${ownsCli.status}`);
    R.check('[RM-04] USAGE: 백그라운드 세션의 길(claude --bg -w → batch --branch → batch accept) · 목표 넘기는 법 · --check-timeout-min · --migrate · --repo',
      /claude --bg -w <name>/.test(USAGE) && /batch --branch <its branch> → batch accept <bid>/.test(USAGE) && /"<short goal>"/.test(USAGE) && /--goal-file/.test(USAGE) && /--check-timeout-min <n>/.test(USAGE) && /--migrate/.test(USAGE) && /--repo <owner\/name>/.test(USAGE) && parse(['install', '--migrate']).migrate === true, USAGE);

    // ── [2026-10-29] cancel · check 는 레인에서 산 세션이 일하면 거부한다(integrate) — CLI 가 --force 를 넘긴다(accept 처럼) ──
    {
      const IP = require.resolve('../../harness/lib/integrate');
      const savedMod = require.cache[IP];
      const seen = [];
      require.cache[IP] = { id: IP, filename: IP, loaded: true, exports: { cancel: async o => { seen.push(['cancel', o.force, o.skipChecks]); return { id: o.id, status: 'cancelled' }; }, check: async o => { seen.push(['check', o.force]); return { id: o.id, status: 'checked' }; } } };
      const { main } = require(CLI), io = { out: () => {}, err: () => {} }, tid = 't-20261029-000000-abcd';
      try {
        await main(['cancel', tid, '--force', '--root', a], io); await main(['check', tid, '--force', '--root', a], io);
        await main(['cancel', tid, '--root', a], io); await main(['check', tid, '--root', a], io);
      } finally { if (savedMod) require.cache[IP] = savedMod; else delete require.cache[IP]; }
      // batch 묶기 · batch accept 도 --force 를 넘긴다(산 세션이 일하는 레인은 force 없이 묶지 않는다 — batch 가 판단)
      const BP = require.resolve('../../harness/lib/batch'), savedB = require.cache[BP], bseen = [];
      require.cache[BP] = { id: BP, filename: BP, loaded: true, exports: { create: async o => { bseen.push(['create', o.force]); return { verdict: 'pass', report: 'ok' }; }, accept: async o => { bseen.push(['accept', o.force]); return { report: 'ok' }; } } };
      try { await main(['batch', tid, '--force', '--root', a], io); await main(['batch', '--all', '--root', a], io); await main(['batch', 'accept', 'b-1', '--force', '--root', a], io); }
      finally { if (savedB) require.cache[BP] = savedB; else delete require.cache[BP]; }
      R.check('[RM-06] batch(묶기) · batch accept 는 --force 를 넘긴다(없으면 false) · USAGE 에 적는다', JSON.stringify(bseen) === JSON.stringify([['create', true], ['create', false], ['accept', true]]) && /\[--check "<cmd>"\]\.\.\. \[--force\]/.test(USAGE), JSON.stringify(bseen));
      R.check('[RM-05] cancel · check 는 --force 를 integrate 로 넘긴다(없으면 false) · USAGE 에 적는다', JSON.stringify(seen) === JSON.stringify([['cancel', true, false], ['check', true], ['cancel', false, false], ['check', false]])
        && /check <id> \[--force\]/.test(USAGE) && /cancel <id> \[--skip-checks\] \[--force\]/.test(USAGE), JSON.stringify(seen));
    }

    // ── [2026-10-29 사용자 요청] 모든 명령의 예기치 못한 예외를 결함으로 기록하고 · 끝에 쌓인 보고를 올린다(start · batch · status · gc · toolkit 도) ──
    {
      const stub = (rel, exp) => { const p = require.resolve(rel); const saved = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; return () => { if (saved) require.cache[p] = saved; else delete require.cache[p]; }; };
      const Bg = require('../../harness/lib/bugreport'), origAuto = Bg.autoReport, posts = [];
      Bg.autoReport = async r => { posts.push(r); return { posted: [] }; };
      const restore = [stub('../../harness/lib/lane', { start: () => { const x = null; return x.boom; } }),
        stub('../../harness/lib/status', { status: () => { throw new RangeError('status exploded'); }, gc: () => { throw Object.assign(new Error('held'), { code: 'LOCK_HELD' }); } })];
      const { main } = require(CLI), errs = [], io = { out: () => {}, err: s => errs.push(s) };
      const rb = path.join(base, 'bugs-repo'); git(base, 'init', '-q', '-b', 'main', rb);
      const bugs = () => { try { return fs.readdirSync(path.join(rb, '.git', 'harness', 'bugs')).filter(n => /^[0-9a-f]{12}\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(rb, '.git', 'harness', 'bugs', n), 'utf8'))); } catch { return []; } };
      let codes;
      try {
        codes = [await main(['start', 'some goal', '--root', rb], io), await main(['status', '--root', rb], io), await main(['gc', '--root', rb], io), await main(['start', 'x', '--goal-file', 'g.txt', '--root', rb], io)];
      } finally { for (const f of restore) f(); Bg.autoReport = origAuto; }
      const b = bugs();
      R.check('[BG-01] start · status 의 예기치 못한 예외 → .git/harness/bugs 에 결함 기록 · report-bug 안내 · 운영 오류(LOCK_HELD · USAGE)는 기록하지 않는다 · 명령마다 끝에 보고 발행을 시도한다',
        JSON.stringify(codes) === '[1,1,1,2]' && b.length === 2 && b.some(e => e.code === null && /TypeError|null/.test(e.message + JSON.stringify(e.frames))) && b.some(e => /status exploded/.test(e.message))
          && errs.filter(s => /하네스 결함으로 보입니다.*\n?.*report-bug/.test(s)).length === 2 && posts.length === 4, JSON.stringify({ codes, bugs: b.map(e => [e.kind, e.code, e.message]), posts: posts.length, errs: errs.map(s => s.slice(0, 120)) }));
    }

    // ── [2026-10-29 감사] Stop 의 "이어서 하겠다" 감지 — v7 의 이어 가는 길(claude --bg · start · batch)을 띄운 차례는 통과 · 뺀 명령(go · resume · factory)은 띄운 것이 아니다 ──
    {
      const SP = require(path.resolve(__dirname, '..', '..', 'harness', 'hooks', 'stop.js'));
      const tr = (name, cmd) => {
        const f = path.join(base, `tr-${name}.jsonl`);
        const rows = [{ type: 'user', message: { role: 'user', content: '계속해' } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '백그라운드 세션을 띄웠습니다. 다음 단계는 바로 이어서 진행하겠습니다.' }] } }];
        fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return f;
      };
      const res = [['bg', 'claude --bg "로그인 기능 만들기"'], ['bgw', 'claude --bg -w login "x"; echo done'], ['start', 'node harness/cli.js start --goal-file g.txt'], ['batch', 'node harness/cli.js batch --branch worktree-login'],
        ['go', 'node harness/cli.js go "x"'], ['resume', 'node harness/cli.js resume t-20261001-000000-abcd'], ['plain', 'npm test'], ['echo', 'echo "claude 는 --bg 로"']]
        .map(([n, c]) => [n, !!SP.promiseWithoutAction({ transcript_path: tr(n, c) })]);
      const blocked = Object.fromEntries(res);
      R.check('[SP-01] claude --bg · start · batch 를 띄운 차례는 통과 · 뺀 go · resume · 아무것도 아닌 명령은 되돌려 보냄 · SP 내보내기에 쓰이지 않는 firstLine 없음',
        !blocked.bg && !blocked.bgw && !blocked.start && !blocked.batch && blocked.go && blocked.resume && blocked.plain && blocked.echo && SP.firstLine === undefined, JSON.stringify(blocked));
    }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 무시 */ } }
  R.done();
})();

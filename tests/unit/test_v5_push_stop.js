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
    git(b, 'fetch', '-q', 'origin'); git(b, 'tag', 'v2.0.0', 'origin/main'); git(b, 'push', '-q', 'origin', 'v2.0.0');
    git(a, 'tag', 'v2.0.0', 'HEAD');
    const remoteV2 = git(bare, 'rev-parse', 'v2.0.0');
    const tg3 = Push.push({ root: a, remote: 'origin', tag: 'v2.0.0' });
    R.check('[PS-10] 원격의 같은 이름 태그가 다른 커밋이면 거부(덮어쓰지 않는다)', tg3.refused && /different commit/.test(tg3.reason) && git(bare, 'rev-parse', 'v2.0.0') === remoteV2, tg3.reason);
    let e11 = null; try { Push.push({ root: a, remote: 'origin', tag: 'v9.9.9' }); } catch (e) { e11 = e; }
    R.check('[PS-11] 로컬에 없는 태그 → USAGE', e11 && e11.code === 'USAGE' && /no such tag/.test(e11.message), e11 && e11.message);

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

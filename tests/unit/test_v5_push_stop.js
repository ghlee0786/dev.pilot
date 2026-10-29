'use strict';
// push — 버그 2026-10-01(Python 서비스 저장소)의 공식 경로.
//   push: guard 가 에이전트의 git push 를 무조건 막는데 AGENTS.md 는 "명시한 뒤에만" 이라 적었다 → 좁힌 하네스 명령으로 허락의 길.
//   [v7 Light] stop(무인 작업 멈추기)은 무인 작업자와 함께 빠졌다 — ST-* 를 빼고, 뺀 명령이 exit 2 와 대체 명령을 알리는지(RM-*)를 본다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 무시 */ } }
  R.done();
})();

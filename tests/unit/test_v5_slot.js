'use strict';
// v5 검사 줄의 범위와 slot — serial_checks: on(저장소마다) | machine(PC 공용) | off · `cli.js slot -- <명령>` 은 줄에 서서 명령을 돌리고 놓는다 ·
//   종료 코드 그대로 · 상한 초과 124 · HARNESS_SLOT_HELD 재진입 · status 의 checks_slot.
//   [dev.pilot #85] 저장소를 넘는 무거운 검사의 차례를 총괄이 손 장부와 GO 메시지로 넘겼다.
//   PC 공용 폴더는 HARNESS_TMP_BASE 아래 — 이 시험의 임시 폴더만 쓴다(사용자의 실제 임시 폴더는 건드리지 않는다).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-slot-'));
process.env.HARNESS_TMP_BASE = path.join(base, 'tmpbase');   // 자식(CLI)도 물려받는다
delete process.env.HARNESS_SLOT_HELD;
const S = require('../../harness/lib/state');
const K = require('../../harness/lib/checks');
const Rs = require('../../harness/lib/resources');
const St = require('../../harness/lib/status');
const R = makeReporter('v5 검사 줄 범위 · slot — PC 공용 줄 · 종료 코드 그대로 · 상한 · 재진입 · status');

const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const IS_WIN = process.platform === 'win32';
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
function mkRepo(name, serial) {
  const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']); git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  if (serial) fs.writeFileSync(path.join(dir, 'AGENTS.md'), `# a\n\nserial_checks: ${serial}\n`);
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return dir;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await wait(25); }
  console.log(`  (기다리다 상한: ${what})`);
  return false;
}
const mdir = () => Rs.machineLocksDir();
const machineTickets = () => { try { return fs.readdirSync(path.join(mdir(), 'checks.queue')).filter(n => n.endsWith('.json')); } catch { return []; } };
// CLI slot 을 띄운다 — 출력을 모으고 끝나면 { code, out, err }
function slot(cwd, args, env) {
  const c = spawn(process.execPath, [CLI, 'slot', ...args], { cwd, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  c.out = ''; c.err = ''; c.stdout.on('data', d => { c.out += d; }); c.stderr.on('data', d => { c.err += d; });
  c.done = new Promise(r => c.on('close', code => r(code)));
  return c;
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

(async () => {
  const kids = [];
  try {
    // ── serialScope: 값 파싱 · 첫 값 우선 ──
    {
      const d = v => { const x = path.join(base, `scope-${v || 'none'}`); fs.mkdirSync(x, { recursive: true }); if (v) fs.writeFileSync(path.join(x, 'AGENTS.md'), `serial_checks: ${v}\n`); return x; };
      const got = ['', 'on', 'off', 'false', 'no', 'machine', 'MACHINE', 'Off'].map(v => `${v || 'none'}=${K.serialScope(d(v))}`).join();
      R.check('[SC-01] serialScope — 없음·on → repo · off/false/no(대소문자 무시) → null · machine → machine',
        got === 'none=repo,on=repo,off=null,false=null,no=null,machine=machine,MACHINE=machine,Off=null', got);
      R.check('[SC-01] 여러 곳이면 값이 있는 첫 곳이 정한다 · serialChecksOn 은 범위가 있으면 켬(기존 의미)',
        K.serialScope(d('machine'), d('off')) === 'machine' && K.serialScope(d(''), d('off')) === null && K.serialChecksOn(d('machine')) === true && K.serialChecksOn(d('off')) === false);
    }

    const repoM = mkRepo('repo-m', 'machine'), repoM2 = mkRepo('repo-m2', 'machine'), repoOn = mkRepo('repo-on'), repoOff = mkRepo('repo-off', 'off');
    const heldM = S.lockDir(repoM, 'checks', mdir());

    // ── inQueue(machine): PC 공용 폴더의 checks.lock 을 잡고 · 자식 검사에 HARNESS_SLOT_HELD 를 넘긴다 ──
    {
      let inside = null;
      await K.inQueue({ serialRoot: repoM, label: 'accept t-x', timeoutMs: 120000 }, async q => { inside = { lock: fs.existsSync(heldM), owner: S.lockOwner(repoM, 'checks', mdir()), slotHeld: q.slotHeld, repoLock: fs.existsSync(S.lockDir(repoM, 'checks')) }; });
      R.check('[SC-02] machine 이면 HARNESS_TMP_BASE/harness/locks/checks.lock 을 잡는다(저장소 locks 가 아니다) · 주인 기록에 repo · label · timeout_ms',
        inside && inside.lock && !inside.repoLock && heldM === path.join(process.env.HARNESS_TMP_BASE, 'harness', 'locks', 'checks.lock') && inside.owner.repo === S.paths(repoM).root && inside.owner.label === 'accept t-x' && inside.owner.timeout_ms === 120000 && inside.slotHeld === heldM,
        JSON.stringify(inside));
      R.check('[SC-02] 끝나면 놓는다', !fs.existsSync(heldM) && machineTickets().length === 0);
      const r = await K.runAll(repoM, [['node', '-e', 'console.log("HELD=" + (process.env.HARNESS_SLOT_HELD || ""))']], { serialRoot: repoM });
      R.check('[SC-02] 줄에 선 검사의 자식은 HARNESS_SLOT_HELD 로 그 잠금 폴더를 받는다', r.results[0].output.includes(`HELD=${heldM}`), r.results[0].output.slice(0, 300));
      const r2 = await K.runAll(repoOn, [['node', '-e', 'console.log("HELD=" + (process.env.HARNESS_SLOT_HELD || ""))']], {});
      R.check('[SC-02] 줄 밖의 검사에는 넘기지 않는다', /HELD=\s*$/m.test(r2.results[0].output), r2.results[0].output.slice(0, 200));
    }

    // ── 재진입: 이미 그 줄을 쥔 이의 자식(HARNESS_SLOT_HELD 같은 폴더 · 표기만 다름)은 줄 없이 · 다른 폴더면 줄을 선다 ──
    {
      const hold = await S.acquireQueued(repoM, 'checks', { label: 'outer', pollMs: 30, dir: mdir() });
      process.env.HARNESS_SLOT_HELD = IS_WIN ? heldM.toUpperCase() : heldM;
      let ran = false;
      const pIn = K.inQueue({ serialRoot: repoM }, async () => { ran = true; });
      await until(() => ran, 3000, 'reentrant inQueue');
      R.check('[SC-03] 재진입 — 같은 잠금 폴더(Windows 는 대소문자만 다른 표기)를 쥔 이의 자식이면 줄 없이 곧바로 돈다(교착 없음)', ran);
      await pIn;
      process.env.HARNESS_SLOT_HELD = path.join(base, 'other', 'checks.lock');
      let ran2 = false;
      const pOther = K.inQueue({ serialRoot: repoM }, async () => { ran2 = true; });
      await wait(400);
      const waited = !ran2;
      hold.release();
      await until(() => ran2, 3000, 'inQueue after release');
      R.check('[SC-03] 다른 폴더의 HARNESS_SLOT_HELD 면 평소처럼 줄을 서서 기다린다', waited && ran2);
      await pOther;
      delete process.env.HARNESS_SLOT_HELD;
    }

    // ── [#85 리뷰 S1 · N1] 늦은 기준선(baseline.queued)의 검사 자식도 HARNESS_SLOT_HELD 를 받는다 · 줄의 명령당 상한은 checkTimeoutMs ──
    //   받지 못하면 slot 으로 감싼 test_command 가 기준선에서 조부모가 쥔 같은 줄을 기다려 검사 상한까지 교착한다.
    {
      const B = require('../../harness/lib/baseline');
      const outFile = path.join(base, 'baseline-held.txt');
      const probe = 'const f=require("fs"),h=process.env.HARNESS_SLOT_HELD||"";let t="";try{t=JSON.parse(f.readFileSync(require("path").join(h,"owner.json"),"utf8")).timeout_ms}catch{}f.writeFileSync(process.argv[1],h+"|"+t)';
      const task = { id: 't-20261106-000000-abcd', checks: { source: 'user', commands: [['node', '-e', probe, outFile]] }, worktree_include: [] };
      const head = git(repoOn, ['rev-parse', 'HEAD']).stdout.trim();
      await B.measureBaseline(repoOn, task, { source: 'user', commands: task.checks.commands.slice() }, repoOn, { checkTimeoutMs: 120000, freshBaseline: true }, () => {}, head);
      const got = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
      R.check('[SC-04] 기준선 검사의 자식이 그 줄의 잠금 폴더(HARNESS_SLOT_HELD)를 받는다 · 줄의 timeout_ms 는 checkTimeoutMs(120000) · 끝나면 놓는다',
        got === `${S.lockDir(repoOn, 'checks')}|120000` && !fs.existsSync(S.lockDir(repoOn, 'checks')) && task.checks.baseline && task.checks.baseline.ok === true, JSON.stringify({ got, baseline: task.checks.baseline }));
    }

    // ── S-01 · S-06: 종료 코드 그대로 · 출력이 그대로 보인다 · 끝나면 남는 것이 없다 ──
    {
      const a = slot(repoM, ['--', 'node', '-e', 'console.log("marker-" + 41); process.exit(3)']); kids.push(a);
      const ca = await a.done;
      const b = slot(repoM, ['--label', 'zero', '--', 'node', '-e', 'process.exit(0)']); kids.push(b);
      const cb = await b.done;
      R.check('[S-01] slot 은 명령의 종료 코드를 그대로 돌려준다(3 · 0) — 하네스가 성패를 판정하지 않는다', ca === 3 && cb === 0, `a=${ca} ${a.err.slice(0, 300)} b=${cb} ${b.err.slice(0, 300)}`);
      R.check('[S-06] 명령의 출력이 그대로 보인다(inherit) · HARNESS_RESULT 같은 하네스 줄을 더하지 않는다', a.out.includes('marker-41') && !/HARNESS_RESULT/.test(a.out), a.out.slice(0, 300));
      R.check('[S-06] 끝나면 PC 공용 잠금 · 번호표가 남지 않는다 · 저장소 locks 에 checks 잠금을 만들지 않는다',
        !fs.existsSync(heldM) && machineTickets().length === 0 && !fs.existsSync(S.lockDir(repoM, 'checks')), JSON.stringify(machineTickets()));
    }

    // ── S-02: 다른 이가 쥔 동안 기다리고, 놓이면 곧바로 실행된다(자동 인계) ──
    {
      const hold = await S.acquireQueued(repoM2, 'checks', { label: 'accept t-other', pollMs: 30, dir: mdir(), meta: { repo: repoM2 } });
      const c = slot(repoM, ['--label', 'build', '--', 'node', '-e', 'console.log("ran " + Date.now())']); kids.push(c);
      await until(() => /waiting/.test(c.err), 10000, 'slot waiting line');
      await wait(300);
      const before = /ran \d+/.test(c.out);
      const t = Date.now(); hold.release();
      const code = await c.done;
      const ranAt = Number((/ran (\d+)/.exec(c.out) || [])[1]);
      R.check('[S-02] 다른 저장소가 쥔 동안에는 기다리며 차례 · 지금 주인을 한 번 알린다', !before && /waiting \(1 ahead\) — now accept t-other · repo-m2/.test(c.err) && (c.err.match(/waiting/g) || []).length === 1, c.err.slice(0, 400));
      R.check('[S-02] 놓이면 곧바로 이어 받아 실행한다(≤2초) · 종료 코드 0', code === 0 && ranAt > 0 && ranAt - t < 2000, `code=${code} delta=${ranAt - t} out=${c.out.slice(0, 200)}`);
    }

    // ── S-03: 상한을 넘으면 자식과 손자까지 끊고 124 · 잠금과 번호표가 남지 않는다 ──
    {
      const pidFile = path.join(base, 'grandchild.pid');
      const inner = `require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`;
      const outer = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(inner)}, process.argv[1]], { stdio: "ignore" }); setInterval(() => {}, 1000)`;
      const c = slot(repoM, ['--timeout-min', '0.05', '--', 'node', '-e', outer, pidFile]); kids.push(c);
      const code = await c.done;
      const gpid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : 0);
      await until(() => !gpid || !pidAlive(gpid), 5000, 'grandchild gone');
      R.check('[S-03] 상한(--timeout-min) 초과 → 124 · 알림 한 줄', code === 124 && /ran past/.test(c.err), `code=${code} err=${c.err.slice(0, 300)}`);
      R.check('[S-03] 손자(명령이 다시 띄운 node)까지 끊는다 · 잠금과 번호표가 남지 않는다', gpid > 0 && !pidAlive(gpid) && !fs.existsSync(heldM) && machineTickets().length === 0, `gpid=${gpid} alive=${gpid && pidAlive(gpid)}`);
      if (gpid && pidAlive(gpid)) { try { process.kill(gpid); } catch { /* 끝남 */ } }
    }

    // ── S-04: slot 안에서 다시 slot(중첩) — 재진입으로 교착 없이 끝난다 ──
    {
      const c = slot(repoM, ['--', 'node', CLI, 'slot', '--', 'node', '-e', 'console.log("inner-ok")']); kids.push(c);
      const code = await Promise.race([c.done, wait(30000).then(() => 'hung')]);
      R.check('[S-04] slot 안의 slot(같은 줄) — 교착 없이 안쪽 명령까지 돌고 0', code === 0 && c.out.includes('inner-ok') && !/waiting/.test(c.err), `code=${code} out=${c.out.slice(0, 200)} err=${c.err.slice(0, 300)}`);
    }

    // ── S-05: '--' 없음 → 2 · serial_checks: off → 줄 없이 실행하고 알림 한 줄 · 기본(on) → 저장소 줄 ──
    {
      const a = slot(repoM, ['node', '-e', '1']); kids.push(a);
      const ca = await a.done;
      R.check('[S-05] "--" 없이 부르면 사용법 오류 2', ca === 2 && /slot needs the command after --/.test(a.err), `code=${ca} ${a.err.slice(0, 200)}`);
      const t = slot(repoM, ['--timeout-min', 'x', '--', 'node', '-e', '1']); kids.push(t);
      R.check('[S-05] --timeout-min 이 숫자가 아니면 2', (await t.done) === 2);
      const st = spawnSync(process.execPath, [CLI, 'status', '--', 'x'], { cwd: repoM, encoding: 'utf8', windowsHide: true });
      R.check('[S-05] slot 밖의 명령은 "--" 뒤를 예전처럼 거부한다(2 · unknown option) — 조용히 버리지 않는다(#85 리뷰 N3)', st.status === 2 && /unknown option: --/.test(st.stderr), `${st.status} ${String(st.stderr).slice(0, 120)}`);
      const b = slot(repoOff, ['--', 'node', '-e', 'console.log("off-ran"); process.exit(5)']); kids.push(b);
      const cb = await b.done;
      R.check('[S-05] serial_checks: off — 줄 없이 실행하고 그렇다고 한 줄 알린다 · 종료 코드 그대로', cb === 5 && b.out.includes('off-ran') && /serial_checks is off/.test(b.err) && !fs.existsSync(S.lockDir(repoOff, 'checks')), `code=${cb} ${b.err.slice(0, 200)}`);
      const hold = await S.acquireQueued(repoM, 'checks', { pollMs: 30, dir: mdir() });
      const c = slot(repoOn, ['--', 'node', '-e', 'console.log("repo-ran")']); kids.push(c);
      const cc = await Promise.race([c.done, wait(15000).then(() => 'hung')]);
      hold.release();
      R.check('[S-05] 기본(on)은 저장소 줄 — PC 공용 줄을 다른 이가 쥐고 있어도 기다리지 않는다', cc === 0 && c.out.includes('repo-ran') && !/waiting/.test(c.err), `code=${cc} ${c.err.slice(0, 200)}`);
    }

    // ── status: checks_slot { scope, dir, holder, queue } · 텍스트 줄 · 줄이 비면 표시 없음 ──
    {
      const idle = St.status({ root: repoM });
      R.check('[ST-01] 줄이 비면 checks_slot 은 범위 · 폴더만(쥔 이 없음 · 대기 없음) · 텍스트에 검사 줄 표시가 없다',
        idle.checks_slot.scope === 'machine' && idle.checks_slot.dir === mdir() && idle.checks_slot.holder === null && idle.checks_slot.queue.length === 0 && !/checks queue/.test(St.formatStatus(idle)),
        JSON.stringify(idle.checks_slot));
      R.check('[ST-01] 기본(on) 저장소는 scope repo · 그 저장소의 locks · off 는 scope off',
        St.status({ root: repoOn }).checks_slot.scope === 'repo' && St.status({ root: repoOn }).checks_slot.dir === S.paths(repoOn).locksDir && St.status({ root: repoOff }).checks_slot.scope === 'off');
      const hold = await S.acquireQueued(repoM, 'checks', { label: 'slot dotnet', pollMs: 30, dir: mdir(), meta: { repo: S.paths(repoM).root, kind: 'slot', timeout_ms: 600000 } });
      const pa = S.acquireQueued(repoM2, 'checks', { label: 'batch b-1', pollMs: 30, dir: mdir(), meta: { repo: repoM2 } }).then(h => h.release()); await wait(30);
      const pb = S.acquireQueued(repoM, 'checks', { label: 'accept t-2', priority: 0, pollMs: 30, dir: mdir(), meta: { repo: repoM } }).then(h => h.release()); await wait(30);
      const s = St.status({ root: repoM2 }), c = s.checks_slot;
      const until10 = c.holder && Date.parse(c.holder.until) - Date.parse(c.holder.at);
      R.check('[ST-02] --json checks_slot — 다른 저장소에서 봐도 같은 줄: 쥔 이(label · repo · timeout_ms · slot 은 until = 잡은 시각 + 상한) · 대기 차례(우선순위 0 먼저)',
        c.scope === 'machine' && c.holder && c.holder.pid === process.pid && c.holder.label === 'slot dotnet' && c.holder.repo === S.paths(repoM).root && c.holder.timeout_ms === 600000 && until10 === 600000 &&
        c.queue.map(x => x.label).join() === 'accept t-2,slot dotnet,batch b-1', JSON.stringify(c));
      const txt = St.formatStatus(s), ko = St.formatStatus({ ...s, language: 'Korean' });
      R.check('[ST-02] 텍스트 — 범위 · 폴더 · 지금 쥔 이 · 대기 2(쥔 이는 대기에서 뺀다)',
        new RegExp(`checks queue \\(per PC · ${mdir().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\): now pid ${process.pid} · slot dotnet · repo-m`).test(txt) && /waiting 2: 1\) accept t-2 · repo-m \d\d:\d\d {2}2\) batch b-1 · repo-m2 \d\d:\d\d/.test(txt) && /until \d\d:\d\d \(limit\)/.test(txt) &&
        /검사 줄\(PC 공용 · .*\): 지금 pid \d+ · slot dotnet · repo-m · \d\d:\d\d부터 · \d\d:\d\d까지\(상한\)/.test(ko) && /대기 2: /.test(ko), `${txt.split('\n').filter(l => /checks queue|waiting/.test(l)).join(' / ')} || ${ko.split('\n').filter(l => /검사 줄|대기/.test(l)).join(' / ')}`);
      hold.release();
      await Promise.all([pa, pb]);
      const done = St.status({ root: repoM });
      R.check('[ST-03] 다 끝나면 다시 표시 없음 · 남은 번호표 없음', !/checks queue/.test(St.formatStatus(done)) && done.checks_slot.queue.length === 0 && done.checks_slot.holder === null);
      // accept · batch 검사(kind 없음)는 끝나는 시각을 지어내지 않는다 — 명령당 상한만
      await K.inQueue({ serialRoot: repoM, label: 'accept t-3', timeoutMs: 1200000 }, async () => {
        const t3 = St.formatStatus(St.status({ root: repoM })), h3 = St.status({ root: repoM }).checks_slot.holder;
        R.check('[ST-04] accept · batch 검사는 until 없이 "명령당 상한" 으로만 적는다', h3 && h3.until === undefined && /limit 20 min per command/.test(t3) && !/until/.test(t3), t3.split('\n').filter(l => /checks queue/.test(l)).join(' / '));
      });
    }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally {
    for (const k of kids) { try { if (k.exitCode == null) { if (IS_WIN) spawnSync('taskkill', ['/PID', String(k.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else k.kill('SIGKILL'); } } catch { /* 끝남 */ } }
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ }
  }
  R.done();
})();

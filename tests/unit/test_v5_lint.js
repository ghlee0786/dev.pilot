'use strict';
// 린트 — 테스트 다음의 두 번째 결정적 검사(프로젝트 블록 lint_command).
//   [2026-10-13 사용자 지시 · 영상 "쓰레기 코드 없애는 법"] 지시문(“깔끔하게 짜라”)은 무시될 수 있지만 실패하는 린트 명령은 무시할 수 없다.
//   {files} 가 있으면 작업이 바꾼 파일만 린트한다(저장소의 옛 린트 빚과 상관없이) · 없으면 저장소 전체.
//   [v7 Light] 무인 루프(go)가 빠졌다 — 린트는 레인(start)의 accept 단계에서 돈다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const Lane = require('../../harness/lib/lane');
const I = require('../../harness/lib/integrate');
const K = require('../../harness/lib/checks');
const R = makeReporter('린트 — lint_command · {files} · accept 의 린트 · 직렬 검사');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-lint-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
// 린트: 인자로 받은 .js 파일(없으면 저장소의 모든 .js) 중 console.log 가 있으면 실패.
const LINT_JS = `const fs=require('fs'),p=require('path');let files=process.argv.slice(2);
if(!files.length){const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.name.startsWith('.')||e.name==='node_modules'?[]:e.isDirectory()?walk(p.join(d,e.name)):[p.join(d,e.name)]);files=walk('.');}
const bad=files.filter(f=>/\\.js$/.test(f)&&!/lint\\.js$|check\\.js$/.test(f)&&fs.existsSync(f)&&/console\\.log/.test(fs.readFileSync(f,'utf8')));
if(bad.length){for(const f of bad)console.log(f+': no-console — remove console.log');process.exit(1);}console.log('lint ok');`;
const CHECK_JS = "console.log('# pass 1\\n# fail 0')";
const yamlBlock = lines => `# p\n\n\`\`\`yaml\n${lines.join('\n')}\n\`\`\`\n`;
let seq = 0;
function repo(lintCmd, extra) {
  const d = path.join(base, `r${++seq}`); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  write(path.join(d, 'lint.js'), LINT_JS); write(path.join(d, 'check.js'), CHECK_JS);
  write(path.join(d, 'AGENTS.md'), yamlBlock(['test_command: "node check.js"', ...(lintCmd ? [`lint_command: "${lintCmd}"`] : [])]));
  for (const [f, t] of Object.entries(extra || {})) write(path.join(d, f), t);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
// 레인을 열고 그 worktree 에 파일 하나를 커밋한다(사람이 레인에서 한 일)
const laneWork = (root, file, text) => {
  const l = Lane.start({ ...quiet, root, goal: `add ${file}` });
  const wt = S.taskPaths(root, l.id).wt;
  write(path.join(wt, file), text); git(wt, 'add', '-A'); git(wt, 'commit', '-qm', `add ${file}`);
  return l;
};

(async () => {
  try {
    // LT-06 — 레인(start)이 프로젝트 블록의 lint_command 를 작업에 기록한다({files} 여부) · 린트가 없으면 기록하지 않는다
    const r6 = repo('node lint.js {files}'), r6n = repo(null);
    const t6 = S.readTask(r6, Lane.start({ ...quiet, root: r6, goal: 'record lint' }).id);
    const t6n = S.readTask(r6n, Lane.start({ ...quiet, root: r6n, goal: 'no lint' }).id);
    R.check('[LT-06] start 는 lint_command 를 작업에 기록한다({files} → files: true) · 린트가 없으면 기록하지 않는다',
      t6.checks.lint && t6.checks.lint.command === 'node lint.js {files}' && t6.checks.lint.files === true && !t6n.checks.lint,
      JSON.stringify([t6.checks.lint, t6n.checks.lint]));

    // LT-08 — {files} 치환: 바뀐 파일이 없으면 린트를 돌리지 않는다 · 경로에 공백이 있어도 한 인자
    R.check('[LT-08] {files} 치환 — 공백 경로는 따옴표 · 빈 목록이면 null', K.lintArgv('node lint.js {files}', ['a b.js', 'c.js']).join('|') === 'node lint.js "a b.js" c.js' && K.lintArgv('node lint.js {files}', []) === null,
      JSON.stringify([K.lintArgv('node lint.js {files}', ['a b.js', 'c.js']), K.lintArgv('node lint.js {files}', [])]));
    // [2026-10-18 자동 이슈 #18] Windows: --check '.venv/Scripts/python -m pytest' 처럼 실행 파일 경로가 슬래시면 cmd 가 '/Scripts' 를 스위치로 읽어 매번 실패했다
    {
      const dc = path.join(base, 'slash-check'); fs.mkdirSync(path.join(dc, 'tools', 'bin'), { recursive: true });
      const isWin = process.platform === 'win32';
      const script = path.join(dc, 'tools', 'bin', isWin ? 'ok.cmd' : 'ok.cmd');
      fs.writeFileSync(script, isWin ? '@echo # pass 1\r\n@echo # fail 0\r\n' : '#!/bin/sh\necho "# pass 1"\necho "# fail 0"\n'); if (!isWin) fs.chmodSync(script, 0o755);
      const r1 = await K.runCheck(dc, ['tools/bin/ok.cmd --flag'], { timeoutMs: 20000 });
      const r2 = await K.runCheck(dc, ['tools/bin/ok.cmd', '--flag'], { timeoutMs: 20000 });
      const r3 = await K.runCheck(dc, ['echo start && tools/bin/ok.cmd'], { timeoutMs: 20000 });
      R.check('[LT-09] 실행 파일 경로를 슬래시로 적어도(셸 문자열 · argv · && 뒤) 돈다 — Windows cmd 가 /경로 를 스위치로 읽지 않게', r1.ok && r2.ok && r3.ok && /pass 1/.test(r1.output), JSON.stringify([r1.ok, r1.exit_code, String(r1.output).slice(0, 120), r2.ok, r3.ok]));
    }

    // ── [2026-10-15 자동 이슈 #4] 같은 시험 DB 를 쓰는 작업 둘이 동시에 검사하면 서로 멈췄다 — serial_checks: true 면 프로젝트 단위로 하나씩 ──
    const rs = repo(null);
    const SLOW = `const fs=require('fs');fs.appendFileSync(process.argv[1]+'.log','start '+Date.now()+'\\n');setTimeout(()=>{fs.appendFileSync(process.argv[1]+'.log','end '+Date.now()+'\\n');console.log('# pass 1\\n# fail 0')},700)`;
    const spans = async (serialRoot, tag) => {
      const f = path.join(base, `slow-${tag}.js`); write(f, SLOW);
      await Promise.all([1, 2].map(() => K.runAll(rs, [['node', f]], { serialRoot })));
      const ev = fs.readFileSync(`${f}.log`, 'utf8').trim().split('\n').map(l => l.split(' ')).map(([k, t]) => ({ k, t: Number(t) })).sort((a, b) => a.t - b.t);
      return ev.map(e => e.k).join(',');
    };
    const serial = await spans(rs, 'on'), parallel = await spans(null, 'off');
    R.check('[SC-01] serialRoot 가 있으면 같은 프로젝트의 검사가 겹치지 않는다(start,end,start,end) · 없으면 겹친다', serial === 'start,end,start,end' && parallel === 'start,start,end,end', `${serial} | ${parallel}`);
    // [2026-10-25 Light 1단계] 직렬이 기본 — 없으면 켬 · serial_checks: off 일 때만 끈다(예전: 없으면 꺼짐). accept 는 serialRootOf 로 지금 값을 읽는다.
    const rs2 = repo(null, { 'CLAUDE.md': yamlBlock(['serial_checks: true']) });
    const rs3 = repo(null, { 'CLAUDE.md': yamlBlock(['serial_checks: off']) });
    const t2 = S.readTask(rs2, Lane.start({ ...quiet, root: rs2, goal: 'x' }).id);
    const sc = [K.serialChecksOn(rs), K.serialChecksOn(rs2), K.serialChecksOn(rs3), t2.checks.serial, I.serialRootOf(rs, {}) === rs, I.serialRootOf(rs3, { checks: { serial: true } })];
    R.check('[SC-02] serial_checks: 없으면 켬(기본) · true 면 켬(start 가 작업에 기록) · off 면 꺼짐 — accept 의 serialRootOf 도 지금 값을 따른다',
      JSON.stringify(sc) === '[true,true,false,true,true,null]', JSON.stringify(sc));

    // LT-10 — [자동 이슈 #38] accept 는 프로젝트 블록의 지금 lint_command 를 따른다 · --force 는 린트를 건너뛴다
    //   [2026-10-29 감사 G2 #20] 예전 이 시험은 "옛 빚(old.js)으로 저장소 전체 린트가 막는다" 를 전제로 했다 — v7 은 린트 기준선을 재지 않아
    //   작업 전부터 빨간 전체 린트가 모든 accept 를 막았다. 이제 전체 린트는 대상 끝에서도 실패하면 막지 않는다(LT-12). 여기서는 레인이 깨뜨린 경우로 잰다.
    const r9 = repo('node lint.js', { 'ok.js': 'process.exit(0)\n' });
    const g9 = laneWork(r9, 'x.js', 'console.log(2);\n');
    const a9 = await I.accept({ root: r9, id: g9.id, log: () => {} });
    write(path.join(r9, 'AGENTS.md'), yamlBlock(['test_command: "node check.js"', 'lint_command: "node ok.js"'])); git(r9, 'commit', '-qam', 'another lint');
    const a9b = await I.accept({ root: r9, id: g9.id, log: () => {} });
    const r9f = repo('node lint.js');
    const g9f = laneWork(r9f, 'x.js', 'console.log(2);\n');
    const a9f = await I.accept({ root: r9f, id: g9f.id, log: () => {}, force: true });
    R.check('[LT-10] (#38) 레인이 저장소 전체 린트를 깨뜨리면 거절({files} 안내) · lint_command 를 바꾸면 accept 가 지금 값을 따른다 · --force 는 린트를 건너뛴다(기록)',
      a9.refused === true && /lint fails/.test(a9.reason) && /\{files\}/.test(a9.reason) && a9b.status === 'accepted' && a9f.status === 'accepted'
        && S.readLog(r9, g9.id).some(e => e.event === 'lint_command_changed') && S.readLog(r9f, g9f.id).some(e => e.event === 'lint' && e.skipped === 'force'),
      JSON.stringify({ a: [a9.status, String(a9.reason).slice(0, 160)], b: [a9b.status, String(a9b.reason).slice(0, 100)], f: [a9f.status, String(a9f.reason).slice(0, 100)] }));

    // LT-12 — [2026-10-29 감사 G2 #20] 작업 전부터 빨간 저장소 전체 린트(옛 빚 old.js)는 accept 를 막지 않는다 — 대상 끝에서도 실패하면 보고만
    const r12 = repo('node lint.js', { 'old.js': 'console.log("legacy")\n' });
    const g12 = laneWork(r12, 'y.js', 'module.exports=3;\n');
    const a12 = await I.accept({ root: r12, id: g12.id, log: () => {} });
    R.check('[LT-12] (#20) 작업 전부터 실패하던 저장소 전체 린트는 막지 않는다 · 기록 · 보고에 남긴다',
      a12.status === 'accepted' && S.readLog(r12, g12.id).some(e => e.event === 'lint' && e.pre_existing === true) && /lint/.test(a12.report || ''),
      JSON.stringify({ st: a12.status, reason: a12.reason, report: a12.report }));

    // LT-11 — {files} 린트: 작업이 바꾼 파일이 린트를 어기면 accept 거절(main 그대로) → 고치면 합친다 · 저장소의 옛 빚(old.js)은 보지 않는다
    const r11 = repo('node lint.js {files}', { 'old.js': 'console.log("legacy")\n' });
    const main11 = git(r11, 'rev-parse', 'main');
    const g11 = laneWork(r11, 'feat.js', 'module.exports=()=>{console.log("x");return 1};\n');
    const a11 = await I.accept({ root: r11, id: g11.id, log: () => {} });
    const refusedKept = a11.refused === true && /lint fails/.test(a11.reason) && /no-console/.test(a11.reason) && git(r11, 'rev-parse', 'main') === main11;
    const wt11 = S.taskPaths(r11, g11.id).wt;
    write(path.join(wt11, 'feat.js'), 'module.exports=()=>1;\n'); git(wt11, 'add', '-A'); git(wt11, 'commit', '-qm', 'fix lint');
    const a11b = await I.accept({ root: r11, id: g11.id, log: () => {} });
    R.check('[LT-11] {files} 린트가 바꾼 파일에서 실패하면 accept 거절(main 그대로) · 고치면 accepted(옛 빚 old.js 는 보지 않는다)',
      refusedKept && a11b.status === 'accepted' && git(r11, 'rev-parse', 'main') !== main11,
      JSON.stringify({ a: [a11.status, String(a11.reason).slice(0, 200)], b: [a11b.status, String(a11b.reason).slice(0, 200)] }));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

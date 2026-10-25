'use strict';
// 린트 — 테스트 다음의 두 번째 결정적 검사(프로젝트 블록 lint_command).
//   [2026-10-13 사용자 지시 · 영상 "쓰레기 코드 없애는 법"] 지시문(“깔끔하게 짜라”)은 무시될 수 있지만 실패하는 린트 명령은 무시할 수 없다.
//   {files} 가 있으면 작업이 바꾼 파일만 린트한다(저장소의 옛 린트 빚과 상관없이) · 없으면 저장소 전체(작업 전부터 빨갛다면 경고만).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const L = require('../../harness/lib/loop');
const K = require('../../harness/lib/checks');
const R = makeReporter('린트 — lint_command · {files} · 기준선 · 보고');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-lint-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {}, mode: 'full' };   // 린트 · 중복 · 품질 되돌려 보내기는 full 모드의 기능(기본 thin 은 보고만)
// 린트: 인자로 받은 .js 파일(없으면 저장소의 모든 .js) 중 console.log 가 있으면 실패.
const LINT_JS = `const fs=require('fs'),p=require('path');let files=process.argv.slice(2);
if(!files.length){const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.name.startsWith('.')||e.name==='node_modules'?[]:e.isDirectory()?walk(p.join(d,e.name)):[p.join(d,e.name)]);files=walk('.');}
const bad=files.filter(f=>/\\.js$/.test(f)&&!/lint\\.js$|check\\.js$/.test(f)&&fs.existsSync(f)&&/console\\.log/.test(fs.readFileSync(f,'utf8')));
if(bad.length){for(const f of bad)console.log(f+': no-console — remove console.log');process.exit(1);}console.log('lint ok');`;
const CHECK_JS = "console.log('# pass 1\\n# fail 0')";
let seq = 0;
function repo(lintCmd, extra) {
  const d = path.join(base, `r${++seq}`); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  write(path.join(d, 'lint.js'), LINT_JS); write(path.join(d, 'check.js'), CHECK_JS);
  write(path.join(d, 'AGENTS.md'), `# p\n\n\`\`\`yaml\ntest_command: "node check.js"\n${lintCmd ? `lint_command: "${lintCmd}"\n` : ''}\`\`\`\n`);
  for (const [f, t] of Object.entries(extra || {})) write(path.join(d, f), t);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
const steps = list => { const calls = []; const run = async o => { const n = calls.length; calls.push({ ...o, signal: undefined }); await list[Math.min(n, list.length - 1)](o); return { ok: true, is_error: false, session_id: o.sessionId || o.newSessionId || 's', session_confirmed: true, final_text: 'done', cost_usd: 0.1, permission_denials: [] }; }; run.calls = calls; return run; };

(async () => {
  try {
    // LT-01 — 작업이 린트를 어기면 작업자에게 돌려보낸다 → 고치면 done
    const r1 = repo('node lint.js {files}');
    const f1 = steps([o => write(path.join(o.cwd, 'feat.js'), 'module.exports=()=>{console.log("x");return 1};\n'), o => write(path.join(o.cwd, 'feat.js'), 'module.exports=()=>1;\n')]);
    const g1 = await L.go({ ...quiet, root: r1, goal: 'add feat', run: f1 });
    R.check('[LT-01] 테스트는 통과해도 린트가 실패하면 작업자에게 린트 출력을 돌려보낸다 → 고치면 done', g1.status === 'done' && f1.calls.length === 2 && /no-console/.test(f1.calls[1].prompt) && /lint/i.test(f1.calls[1].prompt), `${g1.status} calls=${f1.calls.length} ${f1.calls[1] && f1.calls[1].prompt.slice(0, 300)}`);
    R.check('[LT-01] 보고에 린트 결과(통과)가 있다', /lint: PASS/.test(g1.report), g1.report);

    // LT-02 — {files}: 작업이 바꾼 파일만 — 저장소의 옛 린트 빚(old.js)은 막지 않는다
    const r2 = repo('node lint.js {files}', { 'old.js': 'console.log("legacy")\n' });
    const f2 = steps([o => write(path.join(o.cwd, 'clean.js'), 'module.exports=1;\n')]);
    const g2 = await L.go({ ...quiet, root: r2, goal: 'add clean', run: f2 });
    R.check('[LT-02] {files} 는 바뀐 파일만 린트한다 — 옛 빚이 있어도 done', g2.status === 'done' && f2.calls.length === 1, `${g2.status} ${g2.reason}`);

    // LT-03 — 저장소 전체 린트가 작업 전부터 빨갰으면 막지 않고 경고만
    const r3 = repo('node lint.js', { 'old.js': 'console.log("legacy")\n' });
    const f3 = steps([o => write(path.join(o.cwd, 'x.js'), 'module.exports=2;\n')]);
    const g3 = await L.go({ ...quiet, root: r3, goal: 'add x', run: f3 });
    R.check('[LT-03] 전체 린트가 작업 전부터 빨갛다 → 막지 않고(done) 보고에 "작업 전부터" 를 적는다', g3.status === 'done' && f3.calls.length === 1 && /lint: FAIL .*baseline/.test(g3.report), g3.report.split('\n').filter(l => /lint/.test(l)).join(' | '));

    // LT-04 — 같은 린트 실패가 두 번 연속이면 stalled
    const r4 = repo('node lint.js {files}');
    const bad = o => write(path.join(o.cwd, 'b.js'), 'console.log(1)\n');
    const g4 = await L.go({ ...quiet, root: r4, goal: 'add b', run: steps([bad, bad]) });
    R.check('[LT-04] 같은 린트 실패 두 번 → stalled', g4.status === 'stalled' && /lint/.test(g4.reason), `${g4.status} ${g4.reason}`);

    // LT-05 — 테스트가 없어도 린트는 판정한다
    const r5 = path.join(base, 'r5'); fs.mkdirSync(r5); git(r5, 'init', '-q', '-b', 'main'); git(r5, 'config', 'user.name', 't'); git(r5, 'config', 'user.email', 't@example.invalid'); git(r5, 'config', 'core.autocrlf', 'false');
    write(path.join(r5, 'lint.js'), LINT_JS); write(path.join(r5, 'AGENTS.md'), '# p\n\n```yaml\nlint_command: "node lint.js {files}"\n```\n'); git(r5, 'add', '-A'); git(r5, 'commit', '-qm', 'i');
    const f5 = steps([o => write(path.join(o.cwd, 'c.js'), 'console.log(2)\n'), o => write(path.join(o.cwd, 'c.js'), 'module.exports=2\n')]);
    const g5 = await L.go({ ...quiet, root: r5, goal: 'add c', run: f5 });
    R.check('[LT-05] 테스트 없이 린트만 있어도 린트로 돌려보낸다', g5.status === 'done' && f5.calls.length === 2, `${g5.status} ${f5.calls.length}`);

    // LT-06 — 프롬프트가 린트 명령을 알리고 · 작업자가 그 프로그램을 돌릴 수 있다
    R.check('[LT-06] 첫 프롬프트에 린트 명령 · 작업자 허용에 린트 프로그램', /node lint\.js/.test(f1.calls[0].prompt) && (f1.calls[0].allowCommands || []).includes('node'), f1.calls[0].prompt.slice(-600));

    // LT-07 — 한국어 작업의 보고
    const r7 = repo('node lint.js {files}');
    const g7 = await L.go({ ...quiet, root: r7, goal: '깨끗한 기능 추가', run: steps([o => write(path.join(o.cwd, 'k.js'), 'module.exports=3\n')]) });
    R.check('[LT-07] 한국어 보고에 "린트:" 줄', /^린트: 통과/m.test(g7.report), g7.report);

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
    const rs2 = repo(null, { 'CLAUDE.md': '```yaml\nserial_checks: true\n```\n' });
    const ts2 = await L.go({ ...quiet, root: rs2, goal: 'x', run: async o => { write(path.join(o.cwd, 'f.txt'), 'x\n'); return { ok: true, session_id: 's', final_text: 'ok', cost_usd: 0, is_error: false, permission_denials: [] }; } });
    const ts1 = await L.go({ ...quiet, root: rs, goal: 'x', run: async o => { write(path.join(o.cwd, 'f.txt'), 'x\n'); return { ok: true, session_id: 's', final_text: 'ok', cost_usd: 0, is_error: false, permission_denials: [] }; } });
    R.check('[SC-02] 프로젝트 블록 serial_checks: true → 작업에 기록(resume · accept 도 같은 값) · 없으면 꺼짐', S.readTask(rs2, ts2.id).checks.serial === true && !S.readTask(rs, ts1.id).checks.serial, `${ts2.status} ${JSON.stringify(S.readTask(rs2, ts2.id).checks.serial)} ${JSON.stringify(S.readTask(rs, ts1.id).checks.serial)}`);

    // ── [2026-10-16 사용자 지시 · 영상 「쓰레기 코드 없애는 법」] 중복 코드 — 작업이 더한 코드가 있는 코드를 블록째 베꼈는가 ──
    const Dup = require('../../harness/lib/dup');
    const FN = ['function total(items) {', '  let sum = 0;', '  for (const it of items) {', '    if (!it || it.skip) continue;', '    const v = Number(it.price) * Number(it.qty || 1);', '    if (Number.isNaN(v)) throw new Error("bad item");', '    sum += v;', '  }', '  const tax = Math.round(sum * 0.1);', '  return sum + tax;', '}', ''].join('\n');
    const dupRepo = () => { const d = repo(null, { 'src/a.js': `${FN}module.exports = { total };\n` }); return d; };
    const commitIn = (d, files) => { for (const [f, t] of Object.entries(files)) write(path.join(d, f), t); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'work'); };
    {
      const d1 = dupRepo(), b1 = git(d1, 'rev-parse', 'HEAD');
      commitIn(d1, { 'src/b.js': `// copied\n${FN.replace('function total', 'function total2')}module.exports = { total2 };\n` });
      const f1 = Dup.find(d1, b1);
      R.check('[DU-01] 작업이 있는 함수를 그대로 베끼면(이름만 바꿔도 나머지 줄) 위치와 원본을 찾는다', f1.length === 1 && f1[0].file === 'src/b.js' && /src\/a\.js:\d+-\d+/.test(f1[0].other) && f1[0].lines >= 8, JSON.stringify(f1));
      const d2 = dupRepo(), b2 = git(d2, 'rev-parse', 'HEAD');
      commitIn(d2, { 'src/c.js': 'const { total } = require("./a");\nmodule.exports = items => total(items.filter(Boolean));\n' });
      R.check('[DU-02] 있는 함수를 불러 쓰면 중복이 아니다', Dup.find(d2, b2).length === 0);
      const d3 = repo(null), b3 = git(d3, 'rev-parse', 'HEAD');
      commitIn(d3, { 'src/n.js': `${FN}${FN.replace('function total', 'function again')}` });
      R.check('[DU-03] 새로 더한 코드 안에서 같은 블록을 두 번 쓴 것도 찾는다', Dup.find(d3, b3).length === 1, JSON.stringify(Dup.find(d3, b3)));
      const d4 = dupRepo(), b4 = git(d4, 'rev-parse', 'HEAD');
      commitIn(d4, { 'tests/a.test.js': FN, 'src/a.generated.js': FN });
      R.check('[DU-04] 테스트 · 생성 파일은 보지 않는다', Dup.find(d4, b4).length === 0, JSON.stringify(Dup.find(d4, b4)));
    }
    {
      // 루프: 베낀 첫 턴 → 하네스가 한 번 돌려보냄 → 둘째 턴에 재사용으로 고침 → done · 중복 없음
      const d5 = dupRepo();
      const f5 = fake5 => fake5;
      const calls5 = [];
      const run5 = async o => { calls5.push(o.prompt); if (calls5.length === 1) write(path.join(o.cwd, 'src/b.js'), `${FN.replace('function total', 'function total2')}module.exports = { total2 };\n`); else write(path.join(o.cwd, 'src/b.js'), 'const { total } = require("./a");\nmodule.exports = { total2: total };\n'); return { ok: true, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.1, is_error: false, permission_denials: [] }; };
      const t5 = await L.go({ ...quiet, root: d5, goal: 'add total2', run: run5 });
      R.check('[DU-05] 루프: 중복을 만든 턴은 위치를 알려 한 번 돌려보내고, 고치면 done(보고에 중복 없음)', t5.status === 'done' && calls5.length === 2 && /duplicat/i.test(calls5[1]) && /src\/a\.js/.test(calls5[1]) && /duplicate code: none/.test(t5.report), `${t5.status} ${calls5.length} ${t5.report.slice(0, 400)}`);
      const d6 = dupRepo(); const calls6 = [];
      const run6 = async o => { calls6.push(o.prompt); write(path.join(o.cwd, 'src/b.js'), `${FN.replace('function total', 'function total2')}module.exports = { total2 };\n`); return { ok: true, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.1, is_error: false, permission_denials: [] }; };
      const t6 = await L.go({ ...quiet, root: d6, goal: 'add total2', run: run6 });
      R.check('[DU-06] 돌려보내도 남으면 막지 않고(done · 정체 아님) 보고 맨 위 주의에 남긴다', t6.status === 'done' && calls6.length === 2 && /중복|duplicate/i.test(t6.report.split('\n').slice(0, 6).join('\n')), `${t6.status} ${calls6.length} ${t6.report.slice(0, 500)}`);
      const d7 = repo(null, { 'src/a.js': `${FN}module.exports = { total };\n`, 'CLAUDE.md': '```yaml\ndup_check: off\nquality: off\n```\n' }); const calls7 = [];   // 품질 규칙(쓰이지 않는 새 정의)도 끈다 — 중복만 보는 시나리오
      const t7 = await L.go({ ...quiet, root: d7, goal: 'add total2', run: async o => { calls7.push(o.prompt); write(path.join(o.cwd, 'src/b.js'), FN.replace('function total', 'function total2')); return { ok: true, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.1, is_error: false, permission_denials: [] }; } });
      // [2026-10-17 적대적 검증] 커밋 전(추적되지 않은) 새 파일은 "더한 줄" 을 세지 못해 베낀 코드를 놓쳤다
      const d8 = repo(null, { 'src/a.js': `${FN}module.exports = { total };\n` }), b8 = git(d8, 'rev-parse', 'HEAD');
      write(path.join(d8, 'src', '새 파일.js'), FN.replace('function total', 'function untracked').replace(/\n/g, '\r\n'));
      R.check('[DU-08] 추적되지 않은 새 파일(한글 · 공백 이름 · CRLF)의 베낀 코드도 찾는다', Dup.find(d8, b8).length === 1, JSON.stringify(Dup.find(d8, b8)));
      R.check('[DU-07] dup_check: off 면 보지 않는다', t7.status === 'done' && calls7.length === 1, `${t7.status} ${calls7.length}`);
    }

    // ── [2026-10-17 사용자 지시] 린트를 세분화해 정책으로 — 하네스 내장 품질 규칙(작업이 새로 더한 줄만 · 한 번 돌려보내고 남으면 보고) ──
    const Q = require('../../harness/lib/quality');
    const qrepo = files => { const d = repo(null, files); return { d, b: git(d, 'rev-parse', 'HEAD') }; };
    const rulesOf = fs2 => [...new Set(fs2.map(f => f.rule))].sort().join(',');
    {
      const { d, b } = qrepo({ 'src/app.js': 'export function used() { return 1; }\n', 'src/main.js': 'import { used } from "./app";\nused();\n', 'tests/a.test.js': 'test("a", () => { expect(1).toBe(1); });\n', 'src/svc.py': 'def run():\n    return 1\n', 'src/Svc.cs': 'class Svc {\n  public int Run() { return 1; }\n}\n', 'src/hard.txt': 'ok\n' });
      write(path.join(d, 'src/app.js'), [
        'export function used() { return 1; }',
        'export function helperNobodyCalls(x) { return x * 2; }',   // 쓰이지 않는 새 정의
        'console.log("debug here");',                                  // 디버그 흔적
        'debugger;',
        '// TODO: handle errors later',                                // 남긴 할 일
        '// eslint-disable-next-line no-unused-vars',                  // 검사 억누르기
        '// const old = compute(a, b);',                               // 주석 처리된 코드 3줄
        '// if (old > 0) { run(old); }',
        '// return old;',
        'const home = "C:\\\\Users\\\\gh\\\\data";',                   // 하드코딩된 개인 경로
        'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',   // 비밀 모양
        ''].join('\n'));
      write(path.join(d, 'tests/a.test.js'), 'test.skip("a", () => { expect(1).toBe(1); });\nit.only("b", () => {});\n');   // 테스트 약화
      write(path.join(d, 'src/svc.py'), 'def run():\n    breakpoint()\n    return 1  # type: ignore\n');
      write(path.join(d, 'src/Svc.cs'), 'class Svc {\n#pragma warning disable CS0168\n  public int Run() { return 1; }\n  private void NeverCalled() { }\n}\n');
      write(path.join(d, 'src/main.js'), 'import { used } from "./app";\n  used();\n');   // 들여쓰기만 바뀜
      const f = Q.find(d, b);
      const R1 = rulesOf(f);
      R.check('[QL-01] 규칙별로 잡는다: 쓰이지 않는 새 정의 · 디버그 흔적 · 남긴 할 일 · 주석 처리된 코드 · 검사 억누르기 · 테스트 약화 · 하드코딩 · 형식만 바뀐 파일',
        ['unused', 'debug', 'todo', 'commented', 'suppress', 'test-weaken', 'hardcoded', 'format-only'].every(r => R1.split(',').includes(r)), `${R1} | ${JSON.stringify(f.map(x => [x.rule, x.file, x.line, x.text]).slice(0, 20))}`);
      R.check('[QL-01] 위치(파일:줄)와 걸린 줄을 알려 준다', f.every(x => x.file && (x.line > 0 || x.rule === 'format-only')), JSON.stringify(f.slice(0, 3)));
      R.check('[QL-01] 쓰이지 않는 새 정의: 부르지 않는 함수 · 메서드만(이미 쓰이는 것 · 테스트는 아니다)', f.filter(x => x.rule === 'unused').map(x => x.text).sort().join(',') === 'NeverCalled,helperNobodyCalls', JSON.stringify(f.filter(x => x.rule === 'unused')));
    }
    {
      // 잡으면 안 되는 것: 기존 코드의 옛 흔적(새로 더한 줄이 아님) · 쓰이는 새 함수 · 문서 파일의 TODO · 끈 규칙
      const { d, b } = qrepo({ 'src/old.js': 'console.log("legacy");\n// TODO legacy\n', 'README.md': 'x\n' });
      write(path.join(d, 'src/old.js'), 'console.log("legacy");\n// TODO legacy\nexport function add(a, b) { return a + b; }\n');
      write(path.join(d, 'src/use.js'), 'import { add } from "./old";\nexport const total = add(1, 2);\n');
      write(path.join(d, 'README.md'), 'x\nTODO: write docs\n');
      const f = Q.find(d, b);
      R.check('[QL-02] 기존 코드의 옛 흔적 · 쓰이는 새 함수 · 문서 파일은 잡지 않는다', f.length === 0, JSON.stringify(f));
      write(path.join(d, 'src/use.js'), 'import { add } from "./old";\nexport const total = add(1, 2);\nconsole.log(total);\n');
      R.check('[QL-03] 규칙을 끌 수 있다(quality_off: ["debug"])', Q.find(d, b, { off: ['debug'] }).length === 0 && Q.find(d, b).some(x => x.rule === 'debug'), JSON.stringify(Q.find(d, b)));
    }
    {
      // [2026-10-19 현장 오탐] 프레임워크가 부르는 정의(@router.get · [HttpGet] · @Get()) · 사유를 단 억누르기 · 테스트 파일의 억누르기는 군더더기가 아니다
      const { d, b } = qrepo({ 'src/api.py': 'x = 1\n', 'src/Ctl.cs': 'class Ctl {\n}\n', 'src/c.ts': 'export const a = 1;\n' });
      write(path.join(d, 'src/api.py'), ['x = 1', '@router.get(', '    "/items",', '    response_model=Items,', ')', 'async def list_items():', '    return []', '',
        '@app.post("/x")', 'def make_x():', '    try:', '        return 1', '    except Exception:  # noqa: BLE001 — 외부 SDK 가 아무 예외나 던진다', '        return 0', '',
        'def orphan_helper():', '    return 2', 'y = 1  # noqa: E501', ''].join('\n'));
      write(path.join(d, 'src/Ctl.cs'), 'class Ctl {\n  [HttpGet("items")]\n  public IActionResult ListItems() { return Ok(); }\n#pragma warning disable CS0618 // 옛 API 를 바꾸면 소비자가 깨진다\n}\n');
      write(path.join(d, 'src/c.ts'), 'export const a = 1;\nclass K {\n  @Get()\n  public async findAll() { return []; }\n}\nexport const k = new K();\n// eslint-disable-next-line no-console -- CLI 출력이다\nexport const z = 2;\n');
      write(path.join(d, 'tests/test_api.py'), 'import sys\nsys.path.insert(0, ".")\nfrom src import api  # noqa: E402\n');
      const f = Q.find(d, b);
      const un = f.filter(x => x.rule === 'unused').map(x => x.text).sort().join(','), sup = f.filter(x => x.rule === 'suppress').map(x => `${x.file}:${x.line}`).join(',');
      R.check('[QL-07] 데코레이터 · 어트리뷰트가 붙은 정의는 쓰이지 않는 정의로 잡지 않는다(그냥 남긴 함수는 잡는다)', un === 'orphan_helper', JSON.stringify(f.filter(x => x.rule === 'unused')));
      R.check('[QL-07] 사유를 단 억누르기 · 테스트 파일의 억누르기는 잡지 않는다(사유 없는 것은 잡는다)', sup === 'src/api.py:18', JSON.stringify(f.filter(x => x.rule === 'suppress')));
    }
    {
      // [자동 이슈 #47] 설치된 하네스 사본(harness/.harness-version)이 대상 브랜치에서 들어와 바뀌어도 품질 규칙이 지적하지 않는다 · 표식 없는 harness/(원본)와 작업 코드는 그대로 본다
      const { d, b } = qrepo({ 'harness/.harness-version': 'harness 5\n', 'harness/lib/quality.js': 'const A = 1;\n' });
      write(path.join(d, 'harness/lib/quality.js'), 'const A = 1;\nconst SUPPRESS = /eslint-disable|@ts-ignore/;\nconsole.log(SUPPRESS);\n');
      write(path.join(d, 'src/x.ts'), '// @ts-ignore\nexport const x = 1;\n');
      const f = Q.find(d, b), files = [...new Set(f.map(x => x.file))].join(',');
      fs.rmSync(path.join(d, 'harness/.harness-version'));
      const f2 = Q.find(d, b);
      R.check('[QL-08] (#47) 설치된 하네스 사본(harness/)의 변경은 품질 규칙 대상이 아니다 · 작업 코드는 잡는다 · 표식이 없으면 harness/ 도 본다', files === 'src/x.ts' && f2.some(x => x.file === 'harness/lib/quality.js' && x.rule === 'suppress'), JSON.stringify({ f: f.map(x => [x.rule, x.file]), f2: f2.map(x => [x.rule, x.file]) }));
    }
    {
      // 루프: 품질 규칙 · 중복은 한 번에 모아 한 번만 돌려보낸다 → 고치면 done · 남겨도 done(정체 아님) · 보고에 규칙별로
      const d9 = dupRepo(); const calls9 = [];
      const run9 = async o => { calls9.push(o.prompt); write(path.join(o.cwd, 'src/b.js'), calls9.length === 1 ? `${FN.replace('function total', 'function total2')}console.log("x");\ndebugger;\nmodule.exports = { total2 };\n` : 'const { total } = require("./a");\nmodule.exports = { total2: total };\n'); return { ok: true, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.1, is_error: false, permission_denials: [] }; };
      const t9 = await L.go({ ...quiet, root: d9, goal: 'add total2', run: run9 });
      R.check('[QL-04] 루프: 중복 · 디버그 흔적을 한 메시지에 모아 한 번만 돌려보내고, 고치면 done · 보고에 품질 검사 결과', t9.status === 'done' && calls9.length === 2 && /duplicat/i.test(calls9[1]) && /debug/i.test(calls9[1]) && /(quality|품질)/i.test(t9.report), `${t9.status} ${calls9.length} ${t9.report.slice(0, 600)}`);
      const d10 = repo(null); const calls10 = [];
      const t10 = await L.go({ ...quiet, root: d10, goal: 'x', run: async o => { calls10.push(o.prompt); write(path.join(o.cwd, 'src/c.js'), 'export const v = 1;\nconsole.log(v);\n'); return { ok: true, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.1, is_error: false, permission_denials: [] }; } });
      R.check('[QL-05] 돌려보내도 남으면 done(정체 아님) · 보고 맨 위 주의에 규칙별로', t10.status === 'done' && calls10.length === 2 && /디버그|debug/i.test(t10.report.split('\n').slice(0, 6).join('\n')), `${t10.status} ${calls10.length} ${t10.report.slice(0, 500)}`);
      const d11 = repo(null, { 'CLAUDE.md': '```yaml\nquality: off\n```\n' }); const calls11 = [];
      await L.go({ ...quiet, root: d11, goal: 'x', run: async o => { calls11.push(o.prompt); write(path.join(o.cwd, 'src/c.js'), 'console.log(1);\n'); return { ok: true, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.1, is_error: false, permission_denials: [] }; } });
      R.check('[QL-06] quality: off 면 내장 규칙을 돌리지 않는다', calls11.length === 1, String(calls11.length));
    }
    // LT-10 — [자동 이슈 #38] thin 작업(기준선 없음)을 전체 린트가 옛 빚으로 막은 뒤 사용자가 lint_command 를 {files} 로 바꾸면 accept 가 지금 값을 따른다 · --force 는 린트를 건너뛴다
    const I = require('../../harness/lib/integrate');
    const r9 = repo('node lint.js', { 'old.js': 'console.log("legacy")\n' });
    const g9 = await L.go({ ...quiet, mode: 'thin', root: r9, goal: 'add x', run: steps([o => write(path.join(o.cwd, 'x.js'), 'module.exports=2;\n')]) });
    write(path.join(r9, 'other.txt'), 'x\n'); git(r9, 'add', 'other.txt'); git(r9, 'commit', '-qm', 'main moved on');   // 대상이 앞서 나가 accept 가 대상을 들이고 린트를 돌린다
    const a9 = await I.accept({ root: r9, id: g9.id, log: () => {} });
    write(path.join(r9, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\nlint_command: "node lint.js {files}"\n```\n'); git(r9, 'commit', '-qam', 'lint only changed files');
    const a9b = await I.accept({ root: r9, id: g9.id, log: () => {} });
    const r9f = repo('node lint.js', { 'old.js': 'console.log("legacy")\n' });
    const g9f = await L.go({ ...quiet, mode: 'thin', root: r9f, goal: 'add x', run: steps([o => write(path.join(o.cwd, 'x.js'), 'module.exports=2;\n')]) });
    write(path.join(r9f, 'other.txt'), 'x\n'); git(r9f, 'add', 'other.txt'); git(r9f, 'commit', '-qm', 'main moved on');
    const a9f = await I.accept({ root: r9f, id: g9f.id, log: () => {}, force: true });
    R.check('[LT-10] (#38) accept 는 바뀐 lint_command({files})를 따른다 — 처음엔 옛 빚으로 거절 · 바꾼 뒤 합친다 · --force 는 린트를 건너뛴다', g9.status === 'done' && a9.refused === true && /lint fails/.test(a9.reason) && a9b.status === 'accepted' && a9f.status === 'accepted',
      JSON.stringify({ g: g9.status, a: [a9.status, String(a9.reason).slice(0, 100)], b: [a9b.status, String(a9b.reason).slice(0, 100)], f: [a9f.status, String(a9f.reason).slice(0, 100)] }));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

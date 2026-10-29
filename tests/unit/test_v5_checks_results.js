'use strict';
// 검사 결과 — 실패한 테스트 이름(failed_tests) · 시간 초과로만 실패(indeterminate) · 발췌 맨 앞의 이름 · 직렬 검사 기본 켬 · 줄 선 검사.
//   [2026-10-25 C++ 저장소 실측] 실패 출력의 앞 1,500자가 vcpkg 잡음뿐이라 테스트 이름이 없었고, 시간 초과만 난 검사가 일반 실패로 세어져
//   좋은 카드 10장이 되돌려졌다. 사용자의 accept 는 1초 폴링 잠금 뒤에서 2.5시간 기다렸다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const K = require('../../harness/lib/checks');
const R = makeReporter('v5 검사 결과 — failed_tests · indeterminate · serial 기본 · 줄');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-chkres-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
function mkRepo(name, files) {
  const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']); git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [f, t] of Object.entries(files || { 'README.md': '# r\n' })) write(path.join(dir, f), t);
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return dir;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 러너별 실제 모양의 실패 출력
const CTEST = [
  '-- vcpkg: installing zlib:x64-windows... ' + 'noise '.repeat(50),
  '      Start  3: CameraPool.Reconnect',
  ' 3/12 Test  #3: CameraPool.Reconnect ..............***Failed    0.42 sec',
  ' 7/12 Test  #7: Recorder_Rollover .................***Timeout  60.01 sec',
  ' 9/12 Test  #9: Ok.Test ...........................   Passed    0.01 sec',
  '',
  '83% tests passed, 2 tests failed out of 12',
  '',
  'The following tests FAILED:',
  '\t  3 - CameraPool.Reconnect (Failed)',
  '\t  7 - Recorder_Rollover (Timeout)',
  '\t 11 - Decoder.H265 Basic (SEGFAULT)',
  'Errors while running CTest',
].join('\r\n');
const GTEST = [
  '[==========] Running 3 tests from 1 test suite.',
  '[ RUN      ] StreamTest.Opens',
  '[       OK ] StreamTest.Opens (0 ms)',
  '[ RUN      ] StreamTest.Closes',
  'stream_test.cpp(42): error: Expected equality of these values:',
  '[  FAILED  ] StreamTest.Closes (1 ms)',
  '[  FAILED  ] Inst/ParamTest.Works/0, where GetParam() = 3 (0 ms)',
  '[==========] 3 tests from 1 test suite ran. (2 ms total)',
  '[  FAILED  ] 2 tests, listed below:',
  '[  FAILED  ] StreamTest.Closes',
  '[  FAILED  ] Inst/ParamTest.Works/0, where GetParam() = 3',
  '',
  ' 2 FAILED TESTS',
].join('\n');
const PYTEST = [
  'tests/test_api.py::test_login PASSED                                     [ 33%]',
  'tests/test_api.py::test_logout FAILED                                    [ 66%]',
  '=========================== short test summary info ============================',
  'FAILED tests/test_api.py::test_logout - AssertionError: assert 401 == 200',
  'FAILED tests/test_db.py::TestRepo::test_save[sqlite] - KeyError',
  'ERROR tests/test_db.py::test_conn - ConnectionError',
  '==================== 3 failed, 10 passed in 1.23s ====================',
].join('\n');
const DOTNET = [
  '  Passed MyApp.Tests.CalcTests.Adds [3 ms]',
  '  Failed MyApp.Tests.CalcTests.Divides [12 ms]',
  '  Error Message:',
  '   Assert.Equal() Failure',
  '  실패 MyApp.Tests.KoTests.한글 [< 1 ms]',
  'Failed!  - Failed:     2, Passed:     9, Skipped:     0, Total:    11, Duration: 1 s - MyApp.Tests.dll (net8.0)',
].join('\r\n');
const NODE_TAP = ['TAP version 13', '# Subtest: parses', 'ok 1 - parses', 'not ok 2 - rejects bad input', '  ---', 'not ok 3 - later # TODO not yet', '    not ok 1 - nested case', '1..3', '# pass 1', '# fail 2'].join('\n');
const NODE_SPEC = ['▶ suite', '  ✔ works (0.5ms)', '  ✖ breaks on empty (1.25ms)', '✖ failing tests:', '', 'test at x.js:3:1', '✖ breaks on empty (1.25ms)'].join('\n');
const REPO_OWN = ['── v5 상태 ──', '  ✅ [ST-01] id 형식', '  ❌ [ST-02] 상태는 <git-common-dir>/harness/ 아래 — C:\\x\\task.json', '', '  결과: 1 PASS / 1 FAIL', '  ❌ test_v5_state.js  1/2  (3.1s)'].join('\n');
const JEST = [' FAIL  src/sum.test.js', '  sum', '    ✓ adds (2 ms)', '    ✕ subtracts (5 ms)', '    ✕ handles NaN', '', 'Tests:       2 failed, 1 passed, 3 total'].join('\n');
const GO = ['=== RUN   TestParse', '--- FAIL: TestParse (0.00s)', '=== RUN   TestParse/empty', '    --- FAIL: TestParse/empty (0.00s)', '--- PASS: TestOk (0.00s)', 'FAIL', 'FAIL\tgithub.com/x/y\t0.01s'].join('\n');

(async () => {
  try {
    // ── 러너별 실패 이름 ──
    const cases = [
      ['ctest', CTEST, ['CameraPool.Reconnect', 'Recorder_Rollover', 'Decoder.H265 Basic']],
      ['GoogleTest', GTEST, ['StreamTest.Closes', 'Inst/ParamTest.Works/0']],
      ['pytest', PYTEST, ['tests/test_api.py::test_logout', 'tests/test_db.py::TestRepo::test_save[sqlite]', 'tests/test_db.py::test_conn']],
      ['dotnet test', DOTNET, ['MyApp.Tests.CalcTests.Divides', 'MyApp.Tests.KoTests.한글']],
      ['node tap', NODE_TAP, ['rejects bad input', 'nested case']],
      ['node spec', NODE_SPEC, ['breaks on empty']],
      ['이 저장소의 ❌', REPO_OWN, ['[ST-02] 상태는 <git-common-dir>/harness/ 아래', 'test_v5_state.js']],
      ['jest', JEST, ['subtracts', 'handles NaN']],
      ['go', GO, ['TestParse', 'TestParse/empty']],
    ];
    for (const [name, text, want] of cases) {
      const got = K.failedTests(text);
      R.check(`[CR-01] failedTests — ${name}`, eq(got, want), JSON.stringify(got));
    }
    R.check('[CR-01] 통과 줄 · 요약 줄 · 잡음은 이름이 아니다', K.failedTests('ok 1 - fine\n[       OK ] A.B (0 ms)\n--- PASS: TestX\n  ✔ good\n  ✓ good\n100% tests passed, 0 tests failed out of 3\n').length === 0);
    R.check('[CR-02] ANSI 색 코드를 벗긴다', eq(K.failedTests('\x1b[31m[  FAILED  ] \x1b[0mColor.Test (1 ms)\n\x1b[31m✕\x1b[39m red one (2 ms)'), ['Color.Test', 'red one']), JSON.stringify(K.failedTests('\x1b[31m[  FAILED  ] \x1b[0mColor.Test (1 ms)\n\x1b[31m✕\x1b[39m red one (2 ms)')));
    const many = Array.from({ length: 80 }, (_, i) => `--- FAIL: TestN${i} (0.00s)`).join('\n') + '\n--- FAIL: TestN1 (0.00s)';
    const mg = K.failedTests(many);
    R.check('[CR-02] 중복 제거 · 최대 50개', mg.length === 50 && new Set(mg).size === 50 && mg[0] === 'TestN0' && mg[49] === 'TestN49', mg.length);
    R.check('[CR-02] 빈 입력 · null 은 빈 목록', eq(K.failedTests(''), []) && eq(K.failedTests(null), []));

    // ── [2026-10-29 감사 G2] 요약 · 이름 · 판정의 구멍 ──
    // 출력 하나로 판정 객체를 만든다(실제 runCheck 의 모양)
    const judged = (out, exit) => { const s = K.parseSummary(out); const ok = exit === 0 && !(s.found && s.fail > 0); return K.summarize([{ command: 'c', argv: ['c'], exit_code: exit, timed_out: false, found: s.found, pass: s.found ? s.pass : (ok ? 1 : 0), fail: s.found ? s.fail : (ok ? 0 : 1), ok, output: out, ms: 1 }]); };
    // CR-10 (#16) ANSI 색이 있어도 요약을 읽는다 — 같은 빨강은 not_worse
    const nodeColor = '\x1b[34mℹ tests 2\x1b[39m\n\x1b[34mℹ pass 1\x1b[39m\n\x1b[34mℹ fail 1\x1b[39m\n';
    const pyColor = '\x1b[31mFAILED\x1b[0m test_a.py::test_b - assert 0\n\x1b[31m========================= \x1b[31m\x1b[1m1 failed\x1b[0m, \x1b[32m1 passed\x1b[0m\x1b[31m in 0.05s\x1b[0m\x1b[31m ==========================\x1b[0m\n';
    const pn = K.parseSummary(nodeColor), pp = K.parseSummary(pyColor);
    R.check('[CR-10] (#16) parseSummary 는 ANSI 색을 벗긴다(node spec · pytest --color=yes) · 같은 빨간 결과는 not_worse',
      eq(pn, { found: true, pass: 1, fail: 1 }) && eq(pp, { found: true, pass: 1, fail: 1 }) && K.judge(judged(pyColor, 1), K.brief(judged(pyColor, 1))).verdict === 'not_worse', JSON.stringify([pn, pp]));
    // CR-11 (#18) vitest · GoogleTest 요약
    const vt = K.parseSummary(' Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)\n   Start at  10:00:00\n'), gt = K.parseSummary('[==========] 3 tests from 1 test suite ran. (2 ms total)\n[  PASSED  ] 2 tests.\n[  FAILED  ] 1 test, listed below:\n[  FAILED  ] Foo.Bar\n');
    R.check('[CR-11] (#18) vitest(Tests  1 failed | 1 passed) · GoogleTest([  PASSED  ] 2 tests · [  FAILED  ] 1 test) 요약을 읽는다', eq(vt, { found: true, pass: 1, fail: 1 }) && eq(gt, { found: true, pass: 2, fail: 1 }), JSON.stringify([vt, gt]));
    // CR-12 (#19 · #18) Windows jest · vitest 의 × · 공백이 든 pytest 파라미터 id
    const ft = [K.failedTests('    × breaks (3 ms)\nTests:       1 failed, 1 passed, 2 total'), K.failedTests('   × src/a.test.ts > suite > fails 3ms'), K.failedTests('FAILED tests/t.py::test_p[a b] - assert 0'), K.failedTests('tests/t.py::test_q[x y] FAILED                [ 50%]')];
    R.check('[CR-12] (#19) failedTests — × 표시(Windows jest · vitest) · 공백이 든 pytest id 를 자르지 않는다', eq(ft, [['breaks'], ['src/a.test.ts > suite > fails'], ['tests/t.py::test_p[a b]'], ['tests/t.py::test_q[x y]']]), JSON.stringify(ft));
    // CR-13 (#14) Go: 새 패키지의 빌드 실패([build failed])도 실패로 센다 → 나빠짐
    const goBase = '--- FAIL: TestA (0.00s)\nFAIL\tex/a\t0.01s\nok  \tex/b\t0.01s\n', goCur = goBase + '# ex/c\nc/c.go:3:2: undefined: nope\nFAIL\tex/c [build failed]\n';
    R.check('[CR-13] (#14) go — FAIL pkg [build failed] 를 센다 · 빨간 기준선에서 빌드가 깨진 패키지가 생기면 fail', K.parseSummary(goCur).fail === K.parseSummary(goBase).fail + 1 && K.judge(judged(goCur, 1), K.brief(judged(goBase, 1))).verdict === 'fail',
      JSON.stringify([K.parseSummary(goBase), K.parseSummary(goCur)]));
    // CR-14 (#3) 실패 수가 같아도 다른 시험이 새로 실패하면 나빠짐 · 이름이 한쪽에만 없으면 수로 판정 · 같은 시험이 그대로 실패하면 not_worse
    const tapB = 'ok 1 - X\nnot ok 2 - Y\nok 3 - Z\n# pass 2\n# fail 1\n', tapC = 'not ok 1 - X\nok 2 - Y\nok 3 - Z\n# pass 2\n# fail 1\n';
    const v1 = K.judge(judged(tapC, 1), K.brief(judged(tapB, 1))), v2 = K.judge(judged(tapB, 1), K.brief(judged(tapB, 1))), v3 = K.judge(judged(tapC, 1), K.brief(judged('# pass 2\n# fail 1\n', 1)));
    R.check('[CR-14] (#3) judge — 기준선에서 통과하던 시험이 새로 실패하면 fail(수는 같아도) · 그 이름을 이유에 · 같은 실패는 not_worse · 기준선에 이름이 없으면 수로',
      v1.verdict === 'fail' && /X/.test(v1.why) && v2.verdict === 'not_worse' && v3.verdict === 'not_worse', JSON.stringify([v1, v2.verdict, v3.verdict]));
    // CR-15 (#22) YAML 큰따옴표 문자열의 이스케이프(\") · 작은따옴표의 '' 를 푼다
    const y1 = K.yamlTestCommandOf('test_command: "node -e \\"process.exit(0)\\""\r\n'), y2 = K.yamlTestCommandOf("test_command: 'echo ''hi'''\n"), y3 = K.yamlTestCommandOf('test_command: "npm test"  # 주석\n');
    R.check('[CR-15] (#22) test_command 의 YAML 이스케이프를 푼다', y1 === 'node -e "process.exit(0)"' && y2 === "echo 'hi'" && y3 === 'npm test', JSON.stringify([y1, y2, y3]));

    // ── summarize · brief · indeterminate ──
    const r = (o) => ({ command: 'c', argv: ['c'], exit_code: 1, timed_out: false, found: false, pass: 0, fail: 1, ok: false, output: '', ms: 1, ...o });
    const sAll = K.summarize([r({ command: 'a', output: GO }), r({ command: 'b', output: '--- FAIL: TestParse (0s)\n--- FAIL: TestOther (0s)' }), r({ command: 'ok', ok: true, exit_code: 0, pass: 1, fail: 0, output: '--- FAIL: NotCounted' })]);
    R.check('[CR-03] summarize — failed_tests 는 실패한 검사들의 합집합(중복 없이) · 통과한 검사의 출력은 보지 않는다', eq(sAll.failed_tests, ['TestParse', 'TestParse/empty', 'TestOther']), JSON.stringify(sAll.failed_tests));
    R.check('[CR-04] 일반 실패가 섞이면 indeterminate=false', sAll.indeterminate === false);
    const sTo = K.summarize([r({ timed_out: true, exit_code: null }), r({ command: 'ok', ok: true, exit_code: 0, pass: 1, fail: 0 })]);
    R.check('[CR-04] 실패한 검사가 모두 시간 초과뿐이면 indeterminate=true', sTo.indeterminate === true && sTo.ok === false);
    const sMix = K.summarize([r({ timed_out: true, exit_code: null }), r({ command: 'b' })]);
    R.check('[CR-04] 시간 초과 하나 + 일반 실패 하나 → indeterminate=false', sMix.indeterminate === false);
    const sOk = K.summarize([r({ ok: true, exit_code: 0, pass: 1, fail: 0 })]);
    R.check('[CR-04] 모두 통과 → indeterminate=false · failed_tests 빈 목록', sOk.indeterminate === false && eq(sOk.failed_tests, []));
    R.check('[CR-04] judge 는 그대로 — 시간 초과뿐이어도 fail', K.judge(sTo, null).verdict === 'fail');
    const b = K.brief(sTo), b2 = K.brief(sAll);
    R.check('[CR-05] brief 가 failed_tests · indeterminate 를 남긴다(출력은 버린다)', b.indeterminate === true && eq(b2.failed_tests, sAll.failed_tests) && b2.indeterminate === false && !('output' in b2.results[0]), JSON.stringify(b2).slice(0, 300));
    R.check('[CR-05] 옛 판정 객체(필드 없음)의 brief 도 깨지지 않는다', eq(K.brief({ ok: false, pass: 0, fail: 1, results: [] }).failed_tests, []) && K.brief({ ok: false, pass: 0, fail: 1, results: [] }).indeterminate === false);

    // ── 발췌 맨 앞의 이름 ──
    const noisy = 'vcpkg noise '.repeat(400) + '\n' + CTEST;
    const ex = K.failureExcerpt(K.summarize([r({ command: 'ctest', output: noisy })]));
    R.check('[CR-06] failureExcerpt — 실패한 테스트 이름이 맨 앞(출력 앞부분이 잡음이어도)', ex.startsWith('failed tests: CameraPool.Reconnect, Recorder_Rollover, Decoder.H265 Basic\n'), ex.slice(0, 200));
    const exOld = K.failureExcerpt({ results: [r({ command: 'x', output: 'not ok 1 - old shape' })] });
    R.check('[CR-06] failed_tests 가 없는 옛 판정 객체도 출력에서 이름을 뽑아 맨 앞에', exOld.startsWith('failed tests: old shape\n'), exOld.slice(0, 120));
    const exNone = K.failureExcerpt({ results: [r({ command: 'x', output: 'boom' })], failed_tests: [] });
    R.check('[CR-06] 이름이 없으면 예전처럼 ### 부터', exNone.startsWith('### `x`'), exNone.slice(0, 80));

    // ── 실제 실행: runJudged 의 failed_tests · 시간 초과만이면 indeterminate ──
    const dir = path.join(base, 'run'); fs.mkdirSync(dir);
    write(path.join(dir, 'fail.js'), "console.log('TAP version 13\\nok 1 - a\\nnot ok 2 - beta breaks\\n# pass 1\\n# fail 1');process.exit(1)");
    write(path.join(dir, 'slow.js'), 'setTimeout(()=>{},30000)');
    const j1 = (await K.runJudged(dir, [['node', 'fail.js']], { timeoutMs: 20000 })).judged;
    R.check('[CR-07] runJudged — 실패한 검사의 테스트 이름이 judged.failed_tests 에(다시 돌린 뒤에도)', eq(j1.failed_tests, ['beta breaks']) && j1.indeterminate === false, JSON.stringify({ f: j1.failed_tests, i: j1.indeterminate }));
    const j2 = (await K.runJudged(dir, [['node', 'slow.js']], { timeoutMs: 1000 })).judged;
    R.check('[CR-07] runJudged — 시간 초과로만 실패 → indeterminate=true', j2.ok === false && j2.results[0].timed_out === true && j2.indeterminate === true, JSON.stringify(K.brief(j2)));

    // ── 직렬 검사 기본 켬 ──
    const rDef = mkRepo('def'), rOff = mkRepo('off', { 'AGENTS.md': '# p\n\n```yaml\nserial_checks: off\n```\n' }), rNo = mkRepo('no', { 'CLAUDE.md': '```yaml\r\nserial_checks: "no"\r\n```\r\n' }), rOn = mkRepo('on', { 'AGENTS.md': '```yaml\nserial_checks: true # 켬\n```\n' });
    R.check('[CR-08] serialChecksOn — 프로젝트 블록에 없으면 켬', K.serialChecksOn(rDef) === true);
    R.check('[CR-08] serial_checks: off · "no"(CRLF) → 끔 · true → 켬', K.serialChecksOn(rOff) === false && K.serialChecksOn(rNo) === false && K.serialChecksOn(rOn) === true);
    R.check('[CR-08] 여러 곳 — 값이 있는 첫 곳이 정한다(부른 체크아웃 off 가 worktree 의 기본을 이긴다) · 빈 인자는 건너뛴다', K.serialChecksOn(rOff, rDef) === false && K.serialChecksOn(rDef, rOff) === false && K.serialChecksOn(rOn, rOff) === true && K.serialChecksOn(null, rDef) === true);

    // ── runAll 이 줄을 선다: 우선순위 · 이름 · 검사 이름은 그대로 ──
    const rq = mkRepo('queue');
    write(path.join(dir, 'pass.js'), "console.log('# pass 1\\n# fail 0')");
    const hold = S.acquire(rq, 'checks');
    let res = null;
    const p = K.runAll(dir, [['node', 'pass.js']], { serialRoot: rq, priority: 0, label: 'accept t-x', timeoutMs: 20000 }).then(x => { res = x; });
    let q = [];
    for (let i = 0; i < 80 && !q.length; i++) { await wait(25); q = S.queueOf(rq, 'checks'); }
    R.check('[CR-09] runAll(serialRoot, priority, label) — 줄에 우선순위 0 · 이름으로 선다 · 옛 잠금이 풀릴 때까지 돌지 않는다', q.length === 1 && q[0].priority === 0 && q[0].label === 'accept t-x' && res === null, JSON.stringify(q));
    hold.release();
    await p;
    R.check('[CR-09] 풀리면 돈다 · 검사 이름은 명령(줄 이름이 아니다) · 끝나면 줄이 빈다', res && res.ok && res.results[0].command === 'node pass.js' && S.queueOf(rq, 'checks').length === 0 && !fs.existsSync(S.lockDir(rq, 'checks')), JSON.stringify(res && res.results.map(x => x.command)));
    const hold2 = S.acquire(rq, 'checks');
    let res2 = null;
    const p2 = K.runJudged(dir, [['node', 'pass.js']], { serialRoot: rq, timeoutMs: 20000 }).then(x => { res2 = x; });
    let q2 = [];
    for (let i = 0; i < 80 && !q2.length; i++) { await wait(25); q2 = S.queueOf(rq, 'checks'); }
    R.check('[CR-09] runJudged 도 줄을 선다 · 우선순위를 주지 않으면 1', q2.length === 1 && q2[0].priority === 1 && res2 === null, JSON.stringify(q2));
    hold2.release();
    await p2;
    R.check('[CR-09] runJudged 결과', res2 && res2.judged.ok === true && eq(res2.judged.failed_tests, []));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

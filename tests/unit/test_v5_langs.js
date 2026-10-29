'use strict';
// 언어 팩(PRD R5) — 감지 · 테스트 명령 · 허용 프로그램 · 테스트 요약이 언어마다 같은 방식으로(C/C++ · Java · Go · Rust 포함). 모델 호출 없음.
//   [v7 Light] 품질 규칙(quality.js — 쓰레기 패턴)이 빠져 LG-03 을 뺐다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { makeReporter } = require('../run.js');
const Lg = require('../../harness/lib/langs');
const K = require('../../harness/lib/checks');
const R = makeReporter('언어 팩 — 감지 · 명령 · 요약');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-langs-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
let seq = 0;
const dir = files => { const d = path.join(base, `d${++seq}`); for (const [f, t] of Object.entries(files)) write(path.join(d, f), t); fs.mkdirSync(d, { recursive: true }); return d; };
const IS_WIN = process.platform === 'win32';

try {
  // LG-01 — 감지 · 테스트 명령 · 우선순위
  const cmd = files => { const t = Lg.testCommand(dir(files)); return t ? `${t.pack}:${t.commands.map(c => c.join(' ')).join(' ; ')}` : null; };
  const cases = [
    [{ 'package.json': '{"scripts":{"test":"node t.js"}}' }, 'node:npm test'],
    [{ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' }, null],
    [{ 'pytest.ini': '[pytest]\n' }, 'python:python -m pytest'],
    [{ 'App.sln': '' }, 'dotnet:dotnet test'],
    [{ 'go.mod': 'module x\n' }, 'go:go test ./...'],
    [{ 'Cargo.toml': '[package]\n' }, 'rust:cargo test'],
    [{ 'pom.xml': '<project/>' }, 'java:mvn -q test'],
    [{ 'build.gradle': '', [IS_WIN ? 'gradlew.bat' : 'gradlew']: '' }, `java:${IS_WIN ? 'gradlew.bat' : './gradlew'} test`],
    [{ 'CMakeLists.txt': 'project(x)\nenable_testing()\nadd_test(NAME a COMMAND a)\n' }, 'cpp:cmake -S . -B .harness-build && cmake --build .harness-build && ctest --test-dir .harness-build --output-on-failure'],
    [{ 'CMakeLists.txt': 'project(x)\n' }, null],
    [{ 'Makefile': 'all:\n\tcc x.c\ntest:\n\t./t\n' }, 'cpp:make test'],
    [{ 'package.json': '{"scripts":{"test":"jest"}}', 'CMakeLists.txt': 'enable_testing()\n' }, 'node:npm test'],
  ];
  const got = cases.map(([f, want]) => [want, cmd(f)]);
  R.check('[LG-01] 언어마다 테스트 명령(node · python · dotnet · go · rust · java(maven · gradle 래퍼) · c/c++(cmake+ctest · make)) · 테스트가 없으면 null · 순서가 우선순위', got.every(([w, g]) => w === g), JSON.stringify(got.filter(([w, g]) => w !== g)));
  R.check('[LG-01] checks.discover 가 언어 팩을 쓴다(c/c++ 는 셸 문자열 · 프로젝트 블록이 있으면 그것이 먼저)', K.discover(dir({ 'CMakeLists.txt': 'enable_testing()\n' })).commands[0][0].startsWith('cmake -S') && K.discover(dir({ 'go.mod': '', 'AGENTS.md': '```yaml\ntest_command: "go test ./pkg/..."\n```\n' })).commands[0].join(' ') === 'go test ./pkg/...');
  const kinds = K.repoKinds(dir({ 'CMakeLists.txt': '', 'pom.xml': '' }));
  R.check('[LG-01] 저장소 종류(감지 순서 = 팩 순서)', JSON.stringify(kinds) === JSON.stringify(['java', 'cpp']), JSON.stringify(kinds));

  // LG-02 — 테스트 요약(언어별 러너)
  const ps = t => { const s = K.parseSummary(t); return `${s.found}:${s.pass}/${s.fail}`; };
  const sums = [
    [ps('running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored\n\ntest result: FAILED. 1 passed; 2 failed; 0 ignored\n'), 'true:4/2'],
    [ps('90% tests passed, 1 tests failed out of 10\n'), 'true:9/1'],
    [ps('[INFO] Results:\n[WARNING] Tests run: 12, Failures: 1, Errors: 1, Skipped: 2\n'), 'true:8/2'],
    [ps('ok  \tgithub.com/x/a\t0.01s\n--- FAIL: TestB (0.00s)\nFAIL\tgithub.com/x/b\t0.02s\nok  \tgithub.com/x/c\t0.01s\n'), 'true:2/2'],
    [ps('== 1 failed, 3 passed in 0.5s =='), 'true:3/1'],
  ];
  R.check('[LG-02] 요약 읽기: cargo(크레이트 합) · ctest · maven/surefire · go(패키지) · 기존 pytest 그대로', sums.every(([g, w]) => g === w), JSON.stringify(sums));

  R.check('[LG-04] 팩 목록: 모든 팩이 같은 모양(id · 감지 · 테스트 명령) · 7개 언어', Lg.PACKS.every(p => typeof p.id === 'string' && typeof p.detect === 'function' && typeof p.test === 'function') && Lg.PACKS.length === 7, Lg.PACKS.map(p => p.id).join(','));
} catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
R.done();

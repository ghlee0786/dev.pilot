'use strict';
// 언어 팩(PRD R5) — 하네스가 언어에 따라 달라지는 것을 한곳에: 저장소 감지 · 테스트 명령 ·
//   테스트 요약 읽기 · 멈춘 테스트 떼어 내기(pytest).
//   [2026-10-20 사용자 지시] 특정 언어에 치우치지 않는다(Python · .NET · C++ · JS · Go …) — 언어의 차이는 여기에만 둔다.
//   새 언어 = 팩 하나를 더한다. 감지 순서가 곧 우선순위다(한 저장소에 여러 언어가 있으면 앞의 팩이 테스트 명령을 정한다).
const fs = require('node:fs'), path = require('node:path');
const IS_WIN = process.platform === 'win32';

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const readText = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
const NPM_DEFAULT_TEST = /no test specified/i;

const PACKS = [
  { id: 'node',
    detect: names => names.includes('package.json'),
    test: root => {
      if (!exists(root, 'package.json')) return null;
      let pkg = null; try { pkg = JSON.parse(readText(root, 'package.json')); } catch { /* 깨진 package.json */ }
      const t = pkg && pkg.scripts && pkg.scripts.test;
      return typeof t === 'string' && t.trim() && !NPM_DEFAULT_TEST.test(t) ? { commands: [['npm', 'test']], from: 'package.json' } : null;
    } },
  { id: 'python',
    detect: names => ['pyproject.toml', 'pytest.ini', 'setup.py', 'requirements.txt', 'tox.ini'].some(n => names.includes(n)),
    test: root => exists(root, 'pytest.ini') || /^\s*\[tool\.pytest/m.test(readText(root, 'pyproject.toml')) || /^\s*\[(tool:)?pytest\]/m.test(readText(root, 'setup.cfg') + '\n' + readText(root, 'tox.ini'))
      ? { commands: [['python', '-m', 'pytest']], from: 'pytest' } : null,
    // 멈춘 테스트 떼어 내기(checks.isolateHangs) — 출력이 멈춘 자리의 테스트를 --deselect 로 뺀다. -q 출력이면 먼저 -v 로 다시 돌려 이름을 얻는다.
    //   병렬(-n · xdist)은 출력 순서가 달라 멈춘 테스트를 짚을 수 없다 — 건드리지 않는다.
    hang: {
      applies: argv => (/(^|[\\/])py\.?test(\.exe)?$/i.test(argv[0]) || (/(^|[\\/])(python[\d.]*|py)(\.exe)?$/i.test(argv[0]) && argv[1] === '-m' && argv[2] === 'pytest'))
        && !argv.some(a => /^(-n|--numprocesses|--dist)(=|$)|^-n\d/.test(a)),
      //   [2026-10-29 감사 G2 #17] -q 의 끝 줄은 파일 이름 없이 "." 뿐이라 짚지 못했다 · -q 위에 -v 를 더하면 서로 지워 기본 출력이 된다 —
      //   진행 점 줄이면 -q 를 빼고 -v 로. 공백이 든 파라미터 id(test_p[a b])도 이름 그대로. (addopts 의 -q 는 argv 에 없어 여기서 알 수 없다.)
      next: (argv, output) => {
        const lines = String(output || '').split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(Boolean), last = lines[lines.length - 1] || '';
        const id = /^(\S+\.py::.+)$/.exec(last);
        if (id && !/\s(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)(\s+\[\s*\d+%\])?$/.test(last)) return { argv: [...argv, '--deselect', id[1]], exclude: id[1] };
        if (/^(\S+\.py )?[.FEsxX]+(\s+\[\s*\d+%\])?$|^\S+\.py ?$/.test(last) && !argv.some(a => /^(-v+|--verbose)$/.test(a))) return { argv: [...argv.filter(a => !/^(-q+|--quiet)$/.test(a)), '-v'] };
        return null;
      } } },
  { id: 'dotnet',
    detect: names => names.some(n => /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(n)),
    test: (root, names) => { const f = names.find(n => /\.slnx?$/i.test(n)) || names.find(n => /\.(csproj|fsproj|vbproj)$/i.test(n)); return f ? { commands: [['dotnet', 'test']], from: f } : null; } },
  { id: 'go',
    detect: names => names.includes('go.mod'),
    test: root => exists(root, 'go.mod') ? { commands: [['go', 'test', './...']], from: 'go.mod' } : null },
  { id: 'rust',
    detect: names => names.includes('Cargo.toml'),
    test: root => exists(root, 'Cargo.toml') ? { commands: [['cargo', 'test']], from: 'Cargo.toml' } : null },
  { id: 'java',
    detect: names => ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some(n => names.includes(n)),
    test: (root, names) => {
      if (names.includes('pom.xml')) return { commands: [names.includes(IS_WIN ? 'mvnw.cmd' : 'mvnw') ? [IS_WIN ? 'mvnw.cmd' : './mvnw', '-q', 'test'] : ['mvn', '-q', 'test']], from: 'pom.xml' };
      if (names.some(n => /^build\.gradle(\.kts)?$/.test(n))) return { commands: [names.includes(IS_WIN ? 'gradlew.bat' : 'gradlew') ? [IS_WIN ? 'gradlew.bat' : './gradlew', 'test'] : ['gradle', 'test']], from: names.find(n => /^build\.gradle/.test(n)) };
      return null;
    } },
  { id: 'cpp',
    detect: names => names.includes('CMakeLists.txt') || names.includes('meson.build') || names.some(n => /^(GNU)?makefile$/i.test(n)),
    test: (root, names) => {
      // CMake: 테스트를 선언한 저장소만(enable_testing · add_test · gtest_discover_tests) — 하네스 전용 빌드 폴더에 설정 · 빌드 · ctest
      if (names.includes('CMakeLists.txt') && /\b(enable_testing|add_test|gtest_discover_tests|catch_discover_tests|doctest_discover_tests)\s*\(/i.test(readText(root, 'CMakeLists.txt')))
        return { commands: [['cmake -S . -B .harness-build && cmake --build .harness-build && ctest --test-dir .harness-build --output-on-failure']], from: 'CMakeLists.txt' };
      if (names.includes('meson.build')) return { commands: [['meson setup .harness-build --reconfigure && meson test -C .harness-build']], from: 'meson.build' };
      const mk = names.find(n => /^(GNU)?makefile$/i.test(n));
      if (mk && /^(test|check)\s*:/m.test(readText(root, mk))) return { commands: [['make', /^test\s*:/m.test(readText(root, mk)) ? 'test' : 'check']], from: mk };
      return null;
    } },
];

const listRoot = root => { try { return fs.readdirSync(root); } catch { return []; } };
function detect(root) { const names = listRoot(root); return PACKS.filter(p => p.detect(names)).map(p => p.id); }
// 저장소에서 찾은 테스트 명령 — 팩 순서대로 처음 것
function testCommand(root) {
  const names = listRoot(root);
  for (const p of PACKS) { const t = p.test(root, names); if (t) return { ...t, pack: p.id }; }
  return null;
}
// 이 검사 명령(argv)의 멈춘 테스트를 떼어 낼 줄 아는 팩 — 셸 문자열(argv 길이 1 · 공백)은 고칠 수 없으니 없음
const hangFor = argv => (Array.isArray(argv) && argv.length && !(argv.length === 1 && /\s/.test(argv[0])) ? (PACKS.find(p => p.hang && p.hang.applies(argv)) || {}).hang || null : null);

// 테스트 요약 — 하네스 공용 형식 다음으로 언어별 러너(cargo · go · ctest · maven/surefire · GoogleTest 실행 파일)
//   [2026-10-29 감사 G2 #14 · #18] go 의 "FAIL pkg [build failed]"(시간 표기 없음)를 세지 않아 컴파일 안 되는 패키지가 not_worse 로 합쳐졌다 ·
//   gtest 실행 파일을 직접 준 검사는 요약을 못 읽어 빨간 기준선에서 not_worse 가 나올 수 없었다.
function parseSummary(s) {
  const cargo = [...s.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return { found: true, pass: cargo.reduce((a, m) => a + Number(m[1]), 0), fail: cargo.reduce((a, m) => a + Number(m[2]), 0) };
  const ctest = [...s.matchAll(/(\d+)% tests passed, (\d+) tests? failed out of (\d+)/g)].pop();
  if (ctest) return { found: true, pass: Number(ctest[3]) - Number(ctest[2]), fail: Number(ctest[2]) };
  const mvn = [...s.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/gm)].pop();
  if (mvn) { const run = Number(mvn[1]), f = Number(mvn[2]) + Number(mvn[3]); return { found: true, pass: run - f - Number(mvn[4]), fail: f }; }
  const gtP = [...s.matchAll(/^\[\s+PASSED\s+\]\s+(\d+)\s+tests?\b/gm)], gtF = [...s.matchAll(/^\[\s+FAILED\s+\]\s+(\d+)\s+tests?,\s+listed below/gm)];
  if (gtP.length || gtF.length) return { found: true, pass: gtP.reduce((a, m) => a + Number(m[1]), 0), fail: gtF.reduce((a, m) => a + Number(m[1]), 0) };
  const goOk = [...s.matchAll(/^ok\s+\S+/gm)].length, goFail = [...s.matchAll(/^(FAIL\s+\S+\s+([\d.]+s|\[(build|setup) failed\])|--- FAIL:)/gm)].length;
  if (goOk || goFail) return { found: true, pass: goOk, fail: goFail };
  return null;
}

module.exports = { PACKS, detect, testCommand, hangFor, parseSummary };

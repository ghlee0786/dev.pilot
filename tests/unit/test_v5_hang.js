'use strict';
// 멈춘 테스트 떼어 내기 — 출력 없이 멈춘 검사를 상한(15분)까지 기다리지 않고 끊고, 언어 팩이 멈춘 테스트를 짚어 빼고 다시 잰다.
//   [2026-10-20 실측 · 음성 비서 Python 저장소] 오디오 장치를 기다리는 테스트 하나가 2% 지점에서 영원히 멈춰 전체 pytest 가 매번 상한에 걸렸다. 모델 호출 없음.
process.env.HARNESS_CHECK_STALL_MS = '8000';   // 멈춤 판정 8초(실제 5분 — 부하가 큰 PC 에서도 pytest 의 시작 출력 사이보다 길게) — checks 를 불러오기 전에
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const K = require('../../harness/lib/checks');
const Langs = require('../../harness/lib/langs');
const Ln = require('../../harness/lib/lane');
const I = require('../../harness/lib/integrate');
const S = require('../../harness/lib/state');
const R = makeReporter('멈춘 테스트 떼어 내기 — 멈춤 감지 · 팩이 짚기 · 기준선');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-hang-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();

// 가짜 러너 — pytest 처럼: -q 면 "tests/a.py .." 뒤에 test_b 에서 멈추고, -v 면 이름 줄을 찍고 멈춘다. --deselect tests/a.py::test_b 면 끝까지.
const fake = path.join(base, 'fakepytest.js');
write(fake, [
  "const a = process.argv.slice(2), v = a.includes('-v'), skip = a.includes('tests/a.py::test_b');",
  "const out = s => process.stdout.write(s);",
  "out('collected 3 items\\n');",
  "if (v) out('tests/a.py::test_a PASSED\\n'); else out('tests/a.py .');",
  "if (!skip) { if (v) out('tests/a.py::test_b \\n'); setInterval(() => {}, 1e6); }",
  "else { if (v) out('tests/a.py::test_c PASSED\\n'); else out('.\\n'); out('# pass 2\\n# fail 0\\n'); }",
].join('\n'));
const FAKE_HANG = { applies: () => true, next: Langs.PACKS.find(p => p.id === 'python').hang.next };

(async () => {
  try {
    // HG-01 — 어느 명령을 고칠 줄 아는가: pytest 의 여러 모양 · 병렬(-n)과 셸 문자열은 아니다
    const H = Langs.hangFor;
    R.check('[HG-01] pytest 모양(python -m pytest · pytest · 가상환경 python.exe -m pytest)은 떼어 낼 줄 안다',
      !!H(['python', '-m', 'pytest']) && !!H(['pytest', 'tests/', '-v']) && !!H(['.venv/Scripts/python.exe', '-m', 'pytest', '-q']) && !!H(['python3', '-m', 'pytest']));
    R.check('[HG-01] 병렬(-n 4 · -n4 · --numprocesses) · 셸 문자열 · 다른 러너는 건드리지 않는다',
      !H(['pytest', '-n', '4']) && !H(['pytest', '-n4']) && !H(['pytest', '--numprocesses=2']) && !H(['pytest tests/ && echo ok']) && !H(['npm', 'test']) && !H(['dotnet', 'test']) && !H(['python', 'app.py']));

    // HG-02 — 출력에서 멈춘 테스트 짚기
    const next = Langs.PACKS.find(p => p.id === 'python').hang.next;
    const n1 = next(['pytest', '-v'], 'collected 3\ntests/a.py::test_a PASSED [ 33%]\ntests/a.py::TestX::test_b[x-1] \n');
    const n2 = next(['pytest'], 'collected 3\ntests/a.py ..F.');
    const n3 = next(['pytest', '-v'], 'collected 3\ntests/a.py ..F.');
    const n4 = next(['pytest'], '===== 3 passed in 1.0s =====\n');
    R.check('[HG-02] -v 출력의 끝 줄이 결과 없는 테스트 이름이면 그것을 --deselect', n1 && n1.exclude === 'tests/a.py::TestX::test_b[x-1]' && n1.argv.slice(-2).join(' ') === '--deselect tests/a.py::TestX::test_b[x-1]', JSON.stringify(n1));
    R.check('[HG-02] -q 출력이면 먼저 -v 로(이름을 얻으려고) · 이미 -v 인데 이름이 없거나 멈춘 자리가 아니면 포기', n2 && n2.argv.join(' ') === 'pytest -v' && !n2.exclude && n3 === null && n4 === null, JSON.stringify([n2, n3, n4]));

    // HG-03 — 멈춤 감지: 출력이 멈추면 상한(60초)까지 기다리지 않고 끊는다 · 출력이 이어지면 끊지 않는다
    const sleeper = path.join(base, 'sleep.js'); write(sleeper, "process.stdout.write('start\\n'); setInterval(() => {}, 1e6);");
    const ticker = path.join(base, 'tick.js'); write(ticker, "let i = 0; const t = setInterval(() => { process.stdout.write('.'); if (++i > 8) { clearInterval(t); console.log('\\n# pass 1\\n# fail 0'); } }, 500);");
    const t0 = Date.now();
    const r3 = await K.runCheck(base, ['node', sleeper], { timeoutMs: 60000, stallMs: 1500 });
    const r3b = await K.runCheck(base, ['node', ticker], { timeoutMs: 60000, stallMs: 1500 });
    R.check('[HG-03] 출력 없이 멈춘 검사는 멈춤 시간에 끊긴다(timed_out · stalled) — 상한까지 기다리지 않는다', r3.timed_out && r3.stalled === true && Date.now() - t0 < 30000, JSON.stringify({ t: r3.timed_out, s: r3.stalled, ms: r3.ms }));
    R.check('[HG-03] 출력이 이어지는 긴 검사(4초 · 0.5초마다 출력)는 멈춤 시간(1.5초)이 지나도 끊지 않는다', r3b.ok && !r3b.timed_out, JSON.stringify({ ok: r3b.ok, t: r3b.timed_out }));
    const r3c = await K.runCheck(base, ['node', sleeper], { timeoutMs: 4000 });
    R.check('[HG-03] 떼어 낼 줄 모르는 명령(node …)은 멈춤 감지를 쓰지 않는다 — 상한에서 끝난다(stalled 없음)', r3c.timed_out && !r3c.stalled && r3c.ms >= 3500, JSON.stringify({ s: r3c.stalled, ms: r3c.ms }));

    // HG-04 — 떼어 내기: -q 로 멈춤 → -v 로 다시 → 이름을 짚어 --deselect → 끝까지 돈다
    const iso = await K.isolateHangs(base, ['node', fake], { timeoutMs: 60000, hang: FAKE_HANG });
    R.check('[HG-04] 멈춘 테스트를 짚어 빼고 다시 돌린 명령 · 뺀 테스트 · 그 결과(통과)를 돌려준다',
      iso && iso.excluded.join() === 'tests/a.py::test_b' && iso.argv.includes('-v') && iso.argv.join(' ').endsWith('--deselect tests/a.py::test_b') && iso.result.ok, JSON.stringify(iso && { ex: iso.excluded, argv: iso.argv, ok: iso.result.ok }));
    const iso2 = await K.isolateHangs(base, ['node', sleeper], { timeoutMs: 60000, hang: FAKE_HANG });
    R.check('[HG-04] 멈춘 자리를 짚을 수 없으면 null(검사는 원래대로 시간 초과로 남는다)', iso2 === null);

    // HG-05 — 실제 pytest(있을 때): 작업 칸의 검사가 멈추면 늦은 기준선(작업 시작 커밋)에서 멈추는 테스트를 짚어 빼고 판정 · 기록에 남긴다
    //   v7 Light: 무인 루프가 없다 — 칸을 열고(lane.start) 커밋한 뒤 check <id> 가 늦은 기준선(baseline.ensureBaseline)을 잰다. accept 는 그 명령으로 들인다.
    const py = spawnSync('python', ['-m', 'pytest', '--version'], { windowsHide: true, encoding: 'utf8' });
    if (!py.error && py.status === 0) {
      const d = path.join(base, 'repo'); fs.mkdirSync(d, { recursive: true });
      git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
      write(path.join(d, 'pytest.ini'), '[pytest]\naddopts = -p no:cacheprovider\n');
      write(path.join(d, 'tests', 'test_a.py'), 'import time\n\ndef test_ok():\n    assert 1 + 1 == 2\n\ndef test_device():\n    time.sleep(10**6)\n\ndef test_ok2():\n    assert True\n');
      git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
      const logs = [], log = m => logs.push(String(m));
      const lane = Ln.start({ root: d, goal: 'README 를 더하라', log });
      write(path.join(lane.worktree, 'README.md'), '# x\n'); git(lane.worktree, 'add', '--', 'README.md'); git(lane.worktree, 'commit', '-qm', 'readme', '--', 'README.md');
      const ck = await I.check({ root: d, id: lane.id, log });
      const task = S.readTask(d, lane.id);
      R.check('[HG-05] 실제 pytest — 기준선에서 멈춘 test_device 를 빼고 검사를 지킨다(버리지 않음) · 검사는 통과',
        ck.status === 'checked' && ck.verdict !== 'fail' && (task.checks.hung || []).some(h => /tests\/test_a\.py::test_device$/.test(h.test)) && !(task.checks.dropped || []).length && task.checks.commands.length === 1 && task.checks.commands[0].includes('--deselect'),
        JSON.stringify({ st: ck.status, v: ck.verdict, hung: task.checks.hung, dropped: task.checks.dropped, cmds: task.checks.commands, report: ck.report }));
      R.check('[HG-05] 뺀 테스트를 알린다(조용히 빼지 않는다) — 진행 기록에 그 테스트 이름', logs.some(l => /excluded tests that hung before the task/.test(l) && /test_device/.test(l)), logs.filter(l => /hung|멈/.test(l)).join(' | ') || logs.join(' | '));
      const acc = await I.accept({ root: d, id: lane.id, log });
      R.check('[HG-05] accept 는 멈춘 테스트를 뺀 명령으로 검사해 들인다(상한까지 멈추지 않는다)', acc.status === 'accepted', `${acc.status} | ${acc.report} | last: ${JSON.stringify((S.readTask(d, lane.id).checks || {}).last || null).slice(0, 1500)}`);   // 실패하면 무엇이 실패했는지(부하에서 한 번 흔들렸다 — 2026-10-29)
    } else console.log('  ℹ [HG-05] python -m pytest 가 없는 환경 — 실제 pytest 경로는 재지 않았다(HG-02 · HG-04 가 짚기 · 떼어 내기를 덮는다)');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  R.done();
})();

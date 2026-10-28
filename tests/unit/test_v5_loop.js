'use strict';
// v5 루프 — 검사 발견 · 기준선 · 판정 · 이어 가기 · 정체 · BLOCKED · 질문 1회 · 상한 · 한도 → 재개 · 주인 생존 거부 · 보고 · CLI.
//   모델은 부르지 않는다: 가짜 러너가 worktree 에 파일을 쓰고 r 을 돌려준다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const K = require('../../harness/lib/checks');
const Pr = require('../../harness/lib/prompts');
const L = require('../../harness/lib/loop');
const R = makeReporter('v5 루프 — go · resume · 판정 · 상한');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-loop-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
const wait = ms => new Promise(r => setTimeout(r, ms));
let seq = 0;
function mkRepo(files) {
  const dir = path.join(base, `r${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [f, t] of Object.entries(files)) write(path.join(dir, f), t);
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return dir;
}
// impl.txt 가 good 이면 통과. 아니면 그 값을 실패 메시지에 싣는다(값이 바뀌면 서명도 바뀐다).
const CHECK_JS = `const fs=require('fs');const v=fs.existsSync('impl.txt')?fs.readFileSync('impl.txt','utf8').trim():'';
if(v==='good'){console.log('# pass 1\\n# fail 0');process.exit(0);}
console.log('AssertionError: expected good, got '+JSON.stringify(v));console.log('# pass 0\\n# fail 1');process.exit(1);`;
const checkRepo = extra => mkRepo({ 'check.js': CHECK_JS, 'README.md': '# r\n', ...(extra || {}) });
function fake(steps) {
  const calls = [];
  const run = async o => {
    const n = calls.length;
    calls.push({ ...o, signal: undefined });
    const step = steps[Math.min(n, steps.length - 1)];
    const extra = (step && await step(o, n)) || {};
    return { ok: !extra.is_error, session_id: o.sessionId || o.newSessionId || 'thread-1', final_text: 'Done.', cost_usd: 0.5, tokens: null, exit_code: 0,
      is_error: false, error_kind: null, error_message: null, permission_denials: [], stderr_tail: '', ...extra };
  };
  run.calls = calls;
  return run;
}
const impl = v => o => { write(path.join(o.cwd, 'impl.txt'), v + '\n'); };
const plan = (o, id) => write(path.join(o.cwd, '.harness', id, 'PLAN.md'), '# plan\n- [x] done\n');
// 기존 테스트는 작업 전 기준선(eager)을 전제로 쓰였다 — 그 경로를 계속 지킨다. 기본인 늦은 기준선(lazy)은 LP-LZ 가 따로 잰다.
const quiet = { log: () => {}, mode: 'full', eagerBaseline: true };   // 이 파일은 full 모드의 루프(반복 되돌려 보내기 · 정체 · 기준선)를 본다 — thin 은 test_v5_thin.js
const go = (root, extra) => L.go({ ...quiet, root, goal: 'make impl.txt say good', checks: ['node check.js'], ...extra });

(async () => {
  try {
    // ── 검사 발견 ────────────────────────────────────────────────────
    const d = n => { const dir = path.join(base, 'disc', n); fs.mkdirSync(dir, { recursive: true }); return dir; };
    const dn = d('node'); write(path.join(dn, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const dnd = d('node-default'); write(path.join(dnd, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    const dpy = d('py'); write(path.join(dpy, 'pytest.ini'), '[pytest]\n');
    const dpp = d('pyproject'); write(path.join(dpp, 'pyproject.toml'), '[project]\nname="x"\n[tool.pytest.ini_options]\naddopts="-q"\n');
    const ddn = d('dotnet'); write(path.join(ddn, 'App.csproj'), '<Project/>');
    const dgo = d('go'); write(path.join(dgo, 'go.mod'), 'module x\n');
    const dcl = d('claude'); write(path.join(dcl, 'CLAUDE.md'), '```yaml\ntest_command: "node tests/run.js"\n```\n'); write(path.join(dcl, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    const dnone = d('none'); write(path.join(dnone, 'README.md'), '#');
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    R.check('[LP-01] node: package.json scripts.test → npm test', eq(K.discover(dn), { source: 'detected', commands: [['npm', 'test']], from: 'package.json' }), JSON.stringify(K.discover(dn)));
    R.check('[LP-01] npm 기본 문구(no test specified)는 검사가 아니다', K.discover(dnd).source === 'none');
    R.check('[LP-01] python: pytest.ini · pyproject [tool.pytest] → python -m pytest', eq(K.discover(dpy).commands, [['python', '-m', 'pytest']]) && eq(K.discover(dpp).commands, [['python', '-m', 'pytest']]));
    R.check('[LP-01] dotnet: *.csproj → dotnet test', eq(K.discover(ddn).commands, [['dotnet', 'test']]));
    R.check('[LP-01] go.mod → go test ./...', eq(K.discover(dgo).commands, [['go', 'test', './...']]));
    R.check('[LP-01] CLAUDE.md yaml test_command 이 package.json 보다 먼저', eq(K.discover(dcl), { source: 'detected', commands: [['node', 'tests/run.js']], from: 'CLAUDE.md' }), JSON.stringify(K.discover(dcl)));
    R.check('[LP-01] 아무것도 없으면 none', eq(K.discover(dnone), { source: 'none', commands: [] }));
    R.check('[LP-01] --check 가 있으면 source user (발견보다 우선)', eq(K.discover(dn, ['node x.js --flag "a b"']), { source: 'user', commands: [['node', 'x.js', '--flag', 'a b']] }));
    R.check('[LP-01] 셸 연산자가 있는 --check 는 셸 문자열 하나로', eq(K.splitCommand('npm run build && npm test'), ['npm run build && npm test']));
    const allowOf = (dir, ch) => K.allowCommands(dir, ch || K.discover(dir)).sort().join(',');
    R.check('[LP-02] allowCommands: node 저장소 → node npm npx', allowOf(dn) === 'node,npm,npx', allowOf(dn));
    R.check('[LP-02] allowCommands: python → py pytest python', allowOf(dpy) === 'py,pytest,python', allowOf(dpy));
    R.check('[LP-02] allowCommands: dotnet · go', allowOf(ddn) === 'dotnet' && allowOf(dgo) === 'go');
    // 사양 변경(평가 2026-10-02, LP-51): 검사도 저장소 종류도 없으면(그린필드) 빈 목록이 아니라 기본 프로그램 — 빈 목록이면 작업자가 만든 코드를 못 돌려 BLOCKED 로 멈췄다.
    R.check('[LP-02] allowCommands: 검사 없음 · 종류 없음 → 기본 프로그램(셸 · git 없음)', allowOf(dnone) === [...K.DEFAULT_ALLOW].sort().join(',') && !/\b(bash|sh|git|cmd|powershell)\b/.test(allowOf(dnone)), allowOf(dnone));
    R.check('[LP-02] allowCommands: 사용자 검사 argv[0] 포함(경로·확장자 제거)', allowOf(dnone, { source: 'user', commands: [['C:\\tools\\make.exe', 'check']] }) === 'make');

    // ── 요약 · 판정 ──────────────────────────────────────────────────
    R.check('[LP-03] 요약: tap · pytest · dotnet · jest', eq(K.parseSummary('# pass 3\n# fail 1\n'), { found: true, pass: 3, fail: 1 })
      && eq(K.parseSummary('===== 2 failed, 5 passed in 0.3s =====\n'), { found: true, pass: 5, fail: 2 })
      && eq(K.parseSummary('Failed!  - Failed:     1, Passed:     9, Skipped: 0'), { found: true, pass: 9, fail: 1 })
      && eq(K.parseSummary('Tests:       1 failed, 4 passed, 5 total'), { found: true, pass: 4, fail: 1 }));
    // 기록(brief)과 같은 모양: 요약을 읽었고(found) 종료 코드가 있다.
    const J = (ok, fail, pass) => ({ ok, pass: pass || 0, fail, results: [{ ok, fail, pass: pass || 0, found: true, exit_code: ok ? 0 : 1, timed_out: false }] });
    R.check('[LP-03] 판정: 기준선이 빨갛고 실패 수가 늘지 않으면 not_worse', K.judge(J(false, 2, 1), J(false, 3)).verdict === 'not_worse' && K.judge(J(false, 3), J(false, 3)).verdict === 'not_worse');
    R.check('[LP-03] 판정: 기준선보다 실패가 늘면 fail · 기준선이 초록이면 실패는 fail', K.judge(J(false, 4), J(false, 3)).verdict === 'fail' && K.judge(J(false, 1), J(true, 0, 5)).verdict === 'fail');
    R.check('[LP-03] 판정: 사용자 검사(notWorse=false)는 기준선이 빨개도 통과해야 한다', K.judge(J(false, 1), J(false, 1), { notWorse: false }).verdict === 'fail' && K.judge(J(true, 0, 1), J(false, 1), { notWorse: false }).verdict === 'pass');
    R.check('[LP-03] 질문 판별', Pr.isQuestion('Should I proceed with option A?') && Pr.isQuestion('이렇게 진행할까요') && Pr.isQuestion('Would you like me to also add docs.') && !Pr.isQuestion('Implemented and tested.'));

    // ── 첫 턴 통과 → done ────────────────────────────────────────────
    const r1 = checkRepo();
    const mainHead = git(r1, ['rev-parse', 'HEAD']);
    let seenInclude = null;
    const f1 = fake([o => { const id = path.basename(o.cwd); plan(o, id); impl('good')(o); seenInclude = fs.existsSync(path.join(o.cwd, 'check.js')); }]);
    const a = await go(r1, { run: f1, goal: 'make impl.txt say good\n(second line)' });
    const t1 = S.readTask(r1, a.id);
    const c0 = f1.calls[0];
    R.check('[LP-04] 첫 턴에 검사 통과 → done · 러너 1회', a.status === 'done' && f1.calls.length === 1 && t1.status === 'done', `${a.status} ${a.reason}`);
    R.check('[LP-04] 프롬프트: 목표 원문 · 범위 · PLAN.md · 자율 정책 · 검사 · BLOCKED · git 쓰기 금지', c0.prompt.includes('make impl.txt say good\n(second line)') && /complete specification/.test(c0.prompt) && /do not expand scope/i.test(c0.prompt)
      && c0.prompt.includes(`.harness/${a.id}/PLAN.md`) && /No human is available/.test(c0.prompt) && /Irreversible actions are forbidden/.test(c0.prompt) && c0.prompt.includes('`node check.js`')
      && c0.prompt.includes(`.harness/${a.id}/BLOCKED.md`) && /Do not run git commands that write/.test(c0.prompt), c0.prompt);
    R.check('[LP-04] 러너 인자: cwd=worktree · 새 세션 uuid · systemAppend · allowCommands(node) · 상한', G_same(c0.cwd, path.join(r1, '.harness-worktrees', a.id)) && /^[0-9a-f-]{36}$/.test(c0.newSessionId) && c0.sessionId === null
      && /No human is available/.test(c0.systemAppend) && c0.allowCommands.includes('node') && c0.budgetUsd === 20 && c0.model === 'opus' && c0.runtime === 'claude' && c0.timeoutMs > 0, JSON.stringify({ ...c0, prompt: undefined }));
    R.check('[LP-04] 새 worktree 에 저장소 파일이 있다', seenInclude === true);
    R.check('[LP-04] 결과 브랜치에 커밋(impl.txt · PLAN.md) · 사용자 브랜치는 그대로', git(r1, ['show', `${t1.branch}:impl.txt`]) === 'good' && git(r1, ['show', `${t1.branch}:.harness/${a.id}/PLAN.md`]).startsWith('# plan')
      && git(r1, ['rev-parse', 'main']) === mainHead && !fs.existsSync(path.join(r1, 'impl.txt')) && git(r1, ['status', '--porcelain']) === '');
    // [2026-10-21] 예전 "checkpoint 1" 로는 git log 에서 무엇을 왜 했는지 알 수 없었다 — 제목은 턴 + 작업자 보고 첫 줄, 본문은 보고
    R.check('[LP-04] 턴 커밋 메시지: 제목 harness(<id>): turn 1: <보고 첫 줄> · 커밋 1개', git(r1, ['log', '-1', '--format=%s', t1.branch]) === `harness(${a.id}): turn 1: Done.` && t1.commits.length === 1, git(r1, ['log', '-1', '--format=%s', t1.branch]));
    R.check('[LP-04] worktree 는 커밋 뒤 제거된다', !fs.existsSync(path.join(r1, '.harness-worktrees', a.id)) && a.worktree === null && !git(r1, ['worktree', 'list']).includes(a.id));
    R.check('[LP-04] 기준선 기록(빨강 1) · 마지막 검사(초록)', t1.checks.baseline.ok === false && t1.checks.baseline.fail === 1 && t1.checks.last.ok === true && t1.checks.source === 'user');
    R.check('[LP-04] 보고: 상태 · 브랜치@커밋 · 검사 · 바뀐 파일 수 · 기존 테스트 · git 밖 · 비용 · accept/cancel', /DONE/.test(a.report) && a.report.includes(`${t1.branch} @ `) && /last: PASS/.test(a.report) && /changed files: 1/.test(a.report)
      && /existing test files modified: none/.test(a.report) && /outside git: nothing/.test(a.report) && /\$0\.50 of \$20\.00/.test(a.report) && a.report.includes(`accept: node harness/cli.js accept ${a.id}`) && a.report.includes(`cancel: node harness/cli.js cancel ${a.id}`), a.report);
    R.check('[LP-04] 소유 잠금이 풀린다', !fs.existsSync(S.lockDir(r1, `task-${a.id}`)));
    const ev = S.readLog(r1, a.id).map(e => e.event);
    R.check('[LP-04] log.jsonl: created · baseline · turn · commit · checks · end', ['created', 'baseline', 'turn', 'commit', 'checks', 'end'].every(e => ev.includes(e)), ev.join());

    // ── 실패 → 같은 세션 이어 가기(발췌) → 통과 ───────────────────────
    const r2 = checkRepo();
    const f2 = fake([impl('bad'), impl('good')]);
    const b = await go(r2, { run: f2 });
    const t2 = S.readTask(r2, b.id);
    R.check('[LP-05] 실패 → 이어 가기 → 통과 → done · 이어 가기 1회', b.status === 'done' && f2.calls.length === 2 && t2.spent.continuations === 1, `${b.status} ${f2.calls.length}`);
    R.check('[LP-05] 이어 가기는 같은 세션(sessionId = 첫 세션)', f2.calls[1].sessionId === f2.calls[0].newSessionId && !f2.calls[1].newSessionId);
    R.check('[LP-05] 재개 호출에 직전 세션 누계 비용을 넘긴다(새 세션 0 → 0.5)', f2.calls[0].priorSessionCostUsd === 0 && f2.calls[1].priorSessionCostUsd === 0.5 && t2.session_cost_usd === 1, `${f2.calls[1].priorSessionCostUsd} ${t2.session_cost_usd}`);
    R.check('[LP-05] 이어 가기 메시지에 실패 명령과 출력 발췌 · 남은 상한', /node check\.js/.test(f2.calls[1].prompt) && /expected good, got "bad"/.test(f2.calls[1].prompt) && /Remaining \(enforced by the harness\)/.test(f2.calls[1].prompt), f2.calls[1].prompt);
    R.check('[LP-05] 턴마다 체크포인트 커밋 2개', t2.commits.length === 2 && git(r2, ['rev-list', '--count', `main..${t2.branch}`]) === '2');
    const big = K.failureExcerpt({ results: [{ ok: false, command: 'x', exit_code: 1, output: 'H'.repeat(3000) + 'M'.repeat(5000) + 'T'.repeat(3000), found: false }] });
    R.check('[LP-05] 발췌는 머리 1.5KB + 꼬리 2.5KB', /H{1500}\n…\[7000 chars omitted\]…\nM*T{2500}/.test(big) && !/H{1501}/.test(big));

    // ── 같은 실패 2회 → stalled ─────────────────────────────────────
    const r3 = checkRepo();
    const f3 = fake([impl('bad')]);
    const c = await go(r3, { run: f3 });
    R.check('[LP-06] 같은 실패 서명 2회 연속 → stalled', c.status === 'stalled' && f3.calls.length === 2 && /same check failure twice/.test(c.reason), `${c.status} ${f3.calls.length} ${c.reason}`);
    R.check('[LP-06] stalled 보고에 resume 안내', c.report.includes(`resume: node harness/cli.js resume ${c.id}`));

    // ── BLOCKED.md → blocked ───────────────────────────────────────
    const r4 = checkRepo();
    const f4 = fake([o => { write(path.join(o.cwd, '.harness', path.basename(o.cwd), 'BLOCKED.md'), 'The spec says impl must be both good and bad.\n'); }]);
    const bl = await go(r4, { run: f4 });
    R.check('[LP-07] BLOCKED.md → blocked (이유 = 그 파일)', bl.status === 'blocked' && /both good and bad/.test(bl.reason) && f4.calls.length === 1, `${bl.status} ${bl.reason}`);
    R.check('[LP-07] BLOCKED.md 도 브랜치에 커밋된다', git(r4, ['show', `harness/${bl.id}:.harness/${bl.id}/BLOCKED.md`]).includes('both good'));

    // ── 검사 없음: 질문이면 1회만 이어 가기 ─────────────────────────
    const r5 = mkRepo({ 'README.md': '# none\n' });
    const notes = o => write(path.join(o.cwd, 'notes.md'), `notes ${Date.now()}\n`);
    const f5 = fake([o => { notes(o); return { final_text: 'I drafted two options. Should I proceed with option A?' }; }]);
    const q = await L.go({ ...quiet, root: r5, goal: 'write notes', run: f5 });
    const t5 = S.readTask(r5, q.id);
    R.check('[LP-08] 검사 없음 + 질문 → "사람이 없다" 이어 가기는 1회만 → done', q.status === 'done' && f5.calls.length === 2 && /No human is available to answer/.test(f5.calls[1].prompt) && t5.nudged === true, `${q.status} ${f5.calls.length}`);
    R.check('[LP-08] 보고에 신뢰할 검사 없음 명시 · 기준선 없음', /checks: none found/.test(q.report) && t5.checks.source === 'none' && t5.checks.baseline === null);
    const f5b = fake([o => { notes(o); return { final_text: 'Implemented it.' }; }]);
    const q2 = await L.go({ ...quiet, root: r5, goal: 'write more notes', run: f5b });
    R.check('[LP-08] 검사 없음 + 질문 아님 → 바로 done', q2.status === 'done' && f5b.calls.length === 1);

    // ── 상한 ─────────────────────────────────────────────────────────
    const r6 = checkRepo();
    const f6 = fake([(o, n) => { impl('bad-' + n)(o); return { cost_usd: 15 }; }]);
    const cap1 = await go(r6, { run: f6 });
    R.check('[LP-09] 비용 상한 $20: 15 + 15 → capped (러너 2회)', cap1.status === 'capped' && f6.calls.length === 2 && /budget/.test(cap1.reason) && cap1.cost_usd === 30, `${cap1.status} ${f6.calls.length} ${cap1.reason}`);
    // [H4 실측 2026-09-30 · 2.1.283 · haiku] 재개 호출의 --max-budget-usd 는 세션 누계가 아니라 그 호출(프로세스)분과 비교된다:
    //   세션 누계 $0.2776 인 세션을 --max-budget-usd 0.05 로 재개 → 3턴 success(호출분 $0.032) · 0.015(→$0.02) 로 재개 → 3턴 뒤
    //   error_max_budget_usd(호출분 $0.0217). 그래서 재개에도 "남은 예산" 만 넘긴다(누계를 더하지 않는다).
    R.check('[LP-09] 러너에 남은 예산을 넘긴다(20 → 5) · 재개 호출도 남은 예산만(누계 15 를 더하지 않는다)', f6.calls[0].budgetUsd === 20 && f6.calls[1].budgetUsd === 5 && f6.calls[1].sessionId === f6.calls[0].newSessionId);
    const r7 = checkRepo();
    const f7 = fake([async (o, n) => { impl('bad-' + n)(o); await wait(o.timeoutMs + 200); }]);
    const cap2 = await go(r7, { run: f7, wallMin: 0.1 });   // 0.03(1.8초)은 부하가 크면 기준선 검사만으로 지나 작업자를 한 번도 못 불렀다
    R.check('[LP-09] 벽시계 상한 → capped', cap2.status === 'capped' && f7.calls.length === 1 && /wall clock/.test(cap2.reason), `${cap2.status} ${f7.calls.length} ${cap2.reason}`);
    const r8 = checkRepo();
    const f8 = fake([(o, n) => impl('bad-' + n)(o)]);
    const cap3 = await go(r8, { run: f8, maxContinuations: 2 });
    R.check('[LP-09] 이어 가기 상한 2 → 러너 3회 뒤 capped', cap3.status === 'capped' && f8.calls.length === 3 && /continuations/.test(cap3.reason) && cap3.continuations === 2, `${cap3.status} ${f8.calls.length} ${cap3.reason}`);
    R.check('[LP-09] capped 보고에 더 큰 상한으로 resume 안내', /resume: node harness\/cli\.js resume .* --budget-usd/.test(cap3.report));
    const r8b = checkRepo();
    const f8b = fake([(o, n) => { impl('bad-' + n)(o); return { tokens: { input: 900 * (n + 1), output: 300 * (n + 1), total: 1200 * (n + 1) } }; }]);
    const cap4 = await go(r8b, { run: f8b, runtime: 'codex', tokenBudget: 2000 });
    R.check('[LP-09] Codex 토큰 상한(누계): 1200 → 2400 → capped', cap4.status === 'capped' && /token budget/.test(cap4.reason) && f8b.calls.length === 2 && f8b.calls[0].runtime === 'codex' && !f8b.calls[0].newSessionId, `${cap4.status} ${cap4.tokens} ${f8b.calls.length}`);

    // ── 한도 → interrupted → resume 이 같은 세션을 이어 간다 ───────────
    const r9 = checkRepo();
    const f9 = fake([o => { impl('half')(o); return { is_error: true, error_kind: 'quota', error_message: "You've hit your usage limit", session_id: 'S-quota' }; }]);
    const intr = await go(r9, { run: f9, quotaWait: false });   // 한도 → interrupted 경로(quota_wait: off) — 기다리는 기본 동작은 test_v5_quota
    const t9 = S.readTask(r9, intr.id);
    R.check('[LP-10] 사용량 한도 → interrupted(이유에 원문) · 작업은 커밋됨', intr.status === 'interrupted' && /usage limit/.test(intr.reason) && t9.session_id === 'S-quota' && git(r9, ['show', `${t9.branch}:impl.txt`]) === 'half', `${intr.status} ${intr.reason}`);
    const f9b = fake([impl('good')]);
    const res = await L.resume({ ...quiet, root: r9, id: intr.id, run: f9b });
    R.check('[LP-10] resume: worktree 를 브랜치에서 다시 만들고 같은 세션으로 이어 가 → done', res.status === 'done' && f9b.calls.length === 1 && f9b.calls[0].sessionId === 'S-quota' && /interrupted/.test(f9b.calls[0].prompt) && /PLAN\.md/.test(f9b.calls[0].prompt), `${res.status} ${JSON.stringify(f9b.calls.map(x => x.sessionId))}`);
    R.check('[LP-10] resume 은 기존 작업 기록을 이어 쓴다(커밋 누적 · 비용 누적)', S.readTask(r9, intr.id).commits.length === 2 && res.cost_usd === 1);
    const again = await L.resume({ ...quiet, root: r9, id: intr.id, run: fake([impl('x')]) });
    R.check('[LP-10] done 인 작업은 resume 하지 않는다', again.refused === true && again.status === 'done');

    // ── 늦은 기준선(기본 · D2): 검사가 통과하면 기준선을 재지 않는다 · 원래부터 실패하던 저장소면 그때 작업 시작 시점에서 잰다 ──
    //   [2026-10-21 평가 2단계] 빠른 모델은 맨 실행 2~8분인데 하네스가 작업 전 전체 테스트에 17~44분을 써 상한에 걸렸다.
    const lazyQ = { log: () => {}, mode: 'full' };   // 늦은 기준선은 full 모드의 작업 중 검사(thin 은 작업 중에 재지 않고 accept · check 가 같은 기준선을 쓴다)
    const rLz = checkRepo();
    let checkRunsBeforeTurn = null;
    const fLz = fake([o => { checkRunsBeforeTurn = !!S.readTask(rLz, path.basename(o.cwd)).checks.baseline; impl('good')(o); }]);
    const aLz = await L.go({ ...lazyQ, root: rLz, goal: 'make impl.txt say good', checks: ['node check.js'], run: fLz });
    const tLz = S.readTask(rLz, aLz.id);
    R.check('[LP-LZ1] 기본(lazy): 첫 턴 전에 기준선을 재지 않고 · 검사가 통과하면 끝까지 기준선 없이 done · 임시 기준선 worktree 없음',
      aLz.status === 'done' && checkRunsBeforeTurn === false && !tLz.checks.baseline && tLz.checks.baseline_mode === 'lazy' && !fs.existsSync(path.join(rLz, '.harness-worktrees', `${aLz.id}-base`)),
      JSON.stringify({ st: aLz.status, before: checkRunsBeforeTurn, b: tLz.checks.baseline, mode: tLz.checks.baseline_mode }));
    // 원래부터 실패하던 저장소: 저장소에서 찾은 검사(npm test)가 작업 전부터 1개 실패 — 작업이 그 실패를 늘리지 않으면 not_worse 로 done
    const rLz2 = mkRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node check.js' } }), 'check.js': "console.log('# pass 1\\n# fail 1');process.exit(1);\n", 'README.md': '# r\n' });
    const aLz2 = await L.go({ ...lazyQ, root: rLz2, goal: 'add docs', run: fake([o => { write(path.join(o.cwd, 'docs.md'), '# d\n'); }]) });
    const tLz2 = S.readTask(rLz2, aLz2.id);
    R.check('[LP-LZ2] lazy · 원래 빨간 저장소: 검사 실패 → 그때 작업 시작 시점(별도 worktree)에서 기준선을 재 not_worse 로 done · 기준선 worktree 는 지운다',
      aLz2.status === 'done' && tLz2.checks.baseline && tLz2.checks.baseline.fail === 1 && tLz2.checks.verdict === 'not_worse' && !fs.existsSync(path.join(rLz2, '.harness-worktrees', `${aLz2.id}-base`)) && !git(rLz2, ['worktree', 'list']).includes(`${aLz2.id}-base`),
      JSON.stringify({ st: aLz2.status, r: aLz2.reason, b: tLz2.checks.baseline, v: tLz2.checks.verdict }));

    // ── 새 세션 이어 가기(--fresh-session): 이전 대화 없이 기록만으로 — 평가 2단계 C 칸 · 대화 맥락이 사라진 현장 ──
    const r9f = checkRepo();
    const intrF = await go(r9f, { run: fake([o => { impl('half')(o); return { is_error: true, error_kind: 'quota', error_message: "You've hit your usage limit", session_id: 'S-old' }; }]), quotaWait: false });
    const f9f = fake([impl('good')]);
    const resF = await L.resume({ ...quiet, root: r9f, id: intrF.id, run: f9f, freshSession: true });
    const tF = S.readTask(r9f, intrF.id), cF = f9f.calls[0] || {};
    R.check('[LP-10f] --fresh-session: 이전 세션을 잇지 않고 새 세션 · 목표 전체 + "이어 가기" 지시(PLAN · DECISIONS · git 을 먼저 읽어라) → done · 이전 세션 id 기록',
      resF.status === 'done' && !cF.sessionId && !!cF.newSessionId && /# Goal/.test(cF.prompt || '') && /# Continuing earlier work/.test(cF.prompt || '') && /PLAN\.md/.test(cF.prompt || '') && (tF.previous_sessions || []).includes('S-old'),
      JSON.stringify({ st: resF.status, sid: cF.sessionId, nsid: !!cF.newSessionId, prev: tF.previous_sessions }));

    // ── 주인 생존 거부 · 죽은 주인은 빼앗는다 ──────────────────────────
    const r10 = checkRepo();
    const f10 = fake([() => ({ is_error: true, error_kind: 'quota', error_message: 'usage limit', session_id: 'S10' })]);
    const i10 = await go(r10, { run: f10, quotaWait: false });
    const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', windowsHide: true });
    await wait(100);
    write(path.join(S.lockDir(r10, `task-${i10.id}`), 'owner.json'), JSON.stringify({ pid: live.pid, host: os.hostname(), at: new Date().toISOString(), token: 'z' }));
    const f10b = fake([impl('good')]);
    const refused = await L.resume({ ...quiet, root: r10, id: i10.id, run: f10b });
    R.check('[LP-11] 주인 pid 가 살아 있으면 resume 을 거부 · 아무것도 바뀌지 않음', refused.refused === true && /live process/.test(refused.reason) && f10b.calls.length === 0 && S.readTask(r10, i10.id).status === 'interrupted', JSON.stringify(refused.reason));
    live.kill();
    await wait(300);
    const took = await L.resume({ ...quiet, root: r10, id: i10.id, run: f10b });
    R.check('[LP-11] 주인이 죽으면 잠금을 빼앗아 이어 간다', took.status === 'done' && f10b.calls.length === 1, `${took.status} ${took.reason}`);
    const t10 = S.readTask(r10, i10.id);
    t10.status = 'running'; t10.owner = { pid: process.pid + 0, host: 'other-host', heartbeat_at: new Date().toISOString() };
    S.writeTask(r10, t10);
    const foreign = await L.resume({ ...quiet, root: r10, id: i10.id, run: fake([impl('good')]) });
    R.check('[LP-11] 다른 호스트의 최근 주인(running)은 살아 있다고 보고 거부', foreign.refused === true && /being run/.test(foreign.reason), foreign.reason);

    // ── 기준선이 빨간 저장소: 나빠지지 않으면 done, 나빠지면 아님 ──────
    const RED = `const fs=require('fs');const extra=fs.existsSync('broke.txt')?1:0;console.log('# pass 4\\n# fail '+(2+extra));process.exit(1);`;
    const REDREPO = { 'check.js': RED, 'AGENTS.md': '```yaml\ntest_command: "node check.js"\n```\n' };
    const r11 = mkRepo(REDREPO);
    const f11 = fake([o => { write(path.join(o.cwd, 'feature.txt'), 'x'); }]);
    const nw = await go(r11, { run: f11, checks: undefined });
    R.check('[LP-12] 기준선이 빨간(2 fail) 저장소의 발견된 검사 — 실패가 늘지 않으면 done(not worse)', nw.status === 'done' && /not worse/.test(nw.reason) && nw.checks.baseline_fail === 2 && nw.checks.source === 'detected', `${nw.status} ${nw.reason}`);
    R.check('[LP-12] 보고에 기준선과 마지막 결과가 함께', /last: FAIL — 4 pass \/ 2 fail · baseline before the task: FAIL — 4 pass \/ 2 fail/.test(nw.report), nw.report);
    const r12 = mkRepo(REDREPO);
    const f12 = fake([o => { write(path.join(o.cwd, 'broke.txt'), 'x'); }]);
    const wz = await go(r12, { run: f12, checks: undefined });
    R.check('[LP-12] 기준선보다 실패가 늘면 done 이 아니다(이어 가기 → stalled)', wz.status === 'stalled' && f12.calls.length === 2, `${wz.status}`);
    const r12b = mkRepo(REDREPO);
    const f12b = fake([() => ({})]);
    const usr = await go(r12b, { run: f12b, checks: ['node check.js'] });
    R.check('[LP-12] 같은 빨간 검사라도 사용자가 준 것이면 "나빠지지 않음" 으로 끝나지 않는다', usr.status === 'stalled' && f12b.calls.length === 2, `${usr.status} ${usr.reason}`);

    // ── 보고: 기존 테스트 변경 · git 밖 변경 · .worktreeinclude ──────
    const r13 = checkRepo({ 'tests/app.test.js': '// original\n', '.gitignore': '*.log\n.env\n', '.worktreeinclude': '.env\n' });
    write(path.join(r13, '.env'), 'SECRET=1\n');
    let envSeen = null;
    const f13 = fake([o => { envSeen = fs.existsSync(path.join(o.cwd, '.env')); impl('good')(o); write(path.join(o.cwd, 'tests', 'app.test.js'), '// weakened\n'); write(path.join(o.cwd, 'debug.log'), 'x'); write(path.join(o.cwd, 'tests', 'new.test.js'), '// new\n'); }]);
    const rep = await go(r13, { run: f13 });
    R.check('[LP-13] .worktreeinclude 의 .env 가 새 worktree 에 복사된다', envSeen === true);
    R.check('[LP-13] tests_modified = 기존 테스트 파일 변경만(새 테스트 제외)', JSON.stringify(rep.tests_modified) === '["tests/app.test.js"]' && /existing test files modified: tests\/app\.test\.js/.test(rep.report), JSON.stringify(rep.tests_modified));
    R.check('[LP-13] outside_git: 무시된 파일 변경(debug.log) · 복사만 된 .env 는 제외', JSON.stringify(rep.outside_git.ignored_changed) === '["debug.log"]' && /ignored files changed in the worktree: debug\.log/.test(rep.report), JSON.stringify(rep.outside_git));

    // ── 오류: 세션이 시작되지 않음 ─────────────────────────────────
    const r14 = checkRepo();
    const f14 = fake([() => ({ is_error: true, error_kind: 'crash', error_message: 'spawn ENOENT', session_id: null })]);
    const er = await go(r14, { run: f14, runtime: 'codex' });
    R.check('[LP-14] 세션이 시작되지 않으면 error (이유 포함) · 잠금 해제', er.status === 'error' && /did not start/.test(er.reason) && !fs.existsSync(S.lockDir(r14, `task-${er.id}`)), `${er.status} ${er.reason}`);

    // ── 연결된 worktree 에서 부른 go ─────────────────────────────────
    const r16 = checkRepo();
    const side = path.join(base, 'side16');
    git(r16, ['worktree', 'add', '-q', '-b', 'feature', side]);
    const f16 = fake([impl('good')]);
    const s16 = await go(side, { run: f16 });
    const t16 = S.readTask(r16, s16.id);
    R.check('[LP-16] 연결된 worktree 에서 부른 go: 기준 = 그 체크아웃의 브랜치 · 작업 경로 = 주 worktree 아래', s16.status === 'done' && t16 && t16.base_branch === 'feature'
      && G_same(path.dirname(f16.calls[0].cwd), path.join(r16, '.harness-worktrees')) && !fs.existsSync(path.join(side, '.harness-worktrees')), JSON.stringify({ st: s16.status, cwd: f16.calls[0].cwd }));
    const res16 = await L.resume({ ...quiet, root: side, id: s16.id, run: fake([impl('good')]) });
    R.check('[LP-16] 연결된 worktree 에서도 같은 작업 기록을 찾는다(resume 은 done 이라 거부)', res16.refused === true && res16.id === s16.id);

    // ── H1: 러너 오류(crash · model)로 끝난 턴은 판정하지 않는다 ─────────
    const r20 = checkRepo();
    const f20 = fake([o => { impl('good')(o); return { is_error: true, error_kind: 'crash', error_message: 'TypeError: boom', session_id: o.newSessionId || o.sessionId }; }]);
    const e20 = await go(r20, { run: f20 });
    const t20 = S.readTask(r20, e20.id);
    R.check('[LP-20] (H1) crash 턴은 검사가 초록이어도 done 이 아니다 — 1회 재시도 뒤 error', e20.status === 'error' && f20.calls.length === 2 && /crash/.test(e20.reason), `${e20.status} ${f20.calls.length} ${e20.reason}`);
    R.check('[LP-20] (H1) 확인되지 않은 세션 id(미리 정한 uuid)는 저장하지 않는다 — 재시도는 새 세션', t20.session_id == null && f20.calls.length === 2 && f20.calls[1].sessionId === null && !!f20.calls[1].newSessionId && f20.calls[1].newSessionId !== f20.calls[0].newSessionId,
      JSON.stringify({ sid: t20.session_id, c1: f20.calls[1] && [f20.calls[1].sessionId, f20.calls[1].newSessionId] }));
    const r20b = checkRepo();
    const f20b = fake([o => { impl('good')(o); return { is_error: true, error_kind: 'model', error_message: 'API Error: 500', session_confirmed: true }; }, () => ({})]);
    const e20b = await go(r20b, { run: f20b });
    R.check('[LP-20] (H1) 확인된 세션의 model 오류 → 같은 세션으로 1회 이어 간 뒤에야 판정(done)', e20b.status === 'done' && f20b.calls.length === 2 && f20b.calls[1].sessionId === f20b.calls[0].newSessionId && /ended with an error/.test(f20b.calls[1].prompt),
      `${e20b.status} ${f20b.calls.length} ${f20b.calls[1] && f20b.calls[1].prompt}`);
    const r20c = checkRepo();
    const f20c = fake([o => { impl('bad')(o); return { is_error: true, error_kind: 'model', error_message: 'Reached maximum budget ($5.00)', budget_exhausted: true, session_confirmed: true }; }]);
    const e20c = await go(r20c, { run: f20c });
    R.check('[LP-20] (H1) CLI 가 예산으로 멈춘 턴(budget_exhausted) → capped', e20c.status === 'capped' && f20c.calls.length === 1 && /budget/.test(e20c.reason), `${e20c.status} ${f20c.calls.length} ${e20c.reason}`);

    // ── H2: 아무것도 안 한 턴은 검사가 초록이어도 done 이 아니다 ─────────
    const r21 = checkRepo({ 'impl.txt': 'good\n' });   // 기준선부터 초록
    const f21 = fake([() => ({ final_text: 'Everything already works.' })]);
    const n21 = await go(r21, { run: f21 });
    R.check('[LP-21] (H2) 변경 0 → 검사가 초록이어도 1회 넛지 → 여전히 0 이면 failed', n21.status === 'failed' && f21.calls.length === 2 && /no changes/i.test(f21.calls[1].prompt) && /no files changed/.test(n21.reason),
      `${n21.status} ${f21.calls.length} ${n21.reason}`);
    const r21b = checkRepo();
    const f21b = fake([o => { impl('good')(o); return { final_text: 'Implemented. Should I also add docs?' }; }, () => ({ final_text: 'Done.' })]);
    const n21b = await go(r21b, { run: f21b });
    R.check('[LP-21] (H2) 검사 통과여도 마지막 말이 질문이면 1회 넛지 뒤 done', n21b.status === 'done' && f21b.calls.length === 2 && /No human is available to answer/.test(f21b.calls[1].prompt), `${n21b.status} ${f21b.calls.length}`);

    // ── H3: "나빠지지 않음" 의 구멍 ─────────────────────────────────
    const rr = o => ({ ok: false, found: true, pass: 0, fail: 0, exit_code: 1, timed_out: false, ...o });
    const B = rs => ({ ok: rs.every(x => x.ok), pass: rs.reduce((s, x) => s + x.pass, 0), fail: rs.reduce((s, x) => s + x.fail, 0), results: rs });
    R.check('[LP-22] (H3-A) 기준선·현재 모두 요약 없음(exit 1) → not_worse 가 아니다', K.judge(B([rr({ found: false, fail: 1 })]), B([rr({ found: false, fail: 1 })])).verdict === 'fail');
    R.check('[LP-22] (H3-B) 기준선은 요약(5 fail) · 현재는 요약 없음(러너를 깸) → fail', K.judge(B([rr({ found: false, fail: 1 })]), B([rr({ pass: 3, fail: 5 })])).verdict === 'fail');
    R.check('[LP-22] (H3-C) 요약은 0 fail 인데 exit≠0 → fail', K.judge(B([rr({ pass: 6, fail: 0, exit_code: 1 })]), B([rr({ pass: 4, fail: 2 })])).verdict === 'fail');
    R.check('[LP-22] (H3-D) 실패 테스트 삭제(4/2 → 4/1) → fail · 고침(4/2 → 5/1) → not_worse',
      K.judge(B([rr({ pass: 4, fail: 1 })]), B([rr({ pass: 4, fail: 2 })])).verdict === 'fail' && K.judge(B([rr({ pass: 5, fail: 1 })]), B([rr({ pass: 4, fail: 2 })])).verdict === 'not_worse');
    R.check('[LP-22] (H3) 기준선에 없던 시간 초과 → fail', K.judge(B([rr({ pass: 4, fail: 2, timed_out: true, exit_code: null })]), B([rr({ pass: 4, fail: 2 })])).verdict === 'fail');
    R.check('[LP-22] (H3) not_worse 로 끝난 작업은 이유에 "baseline was red" 를 앞세운다', /^baseline was red/.test(nw.reason), nw.reason);

    // ── H5: 비밀 파일은 하네스 커밋에 들어가지 않는다 ──────────────────
    const r23 = checkRepo();
    const f23 = fake([o => { impl('good')(o); write(path.join(o.cwd, '.env'), 'TOKEN=abc\n'); write(path.join(o.cwd, 'certs', 'server.pem'), 'k\n'); }]);
    const s23 = await go(r23, { run: f23 });
    const t23 = S.readTask(r23, s23.id);
    const tree23 = git(r23, ['ls-tree', '-r', '--name-only', t23.branch]);
    R.check('[LP-23] (H5) .env · *.pem 은 결과 브랜치에 커밋되지 않는다(다른 변경은 커밋)', !/(^|\n)\.env$|server\.pem/m.test(tree23) && /(^|\n)impl\.txt$/m.test(tree23), tree23);
    R.check('[LP-23] (H5) 걸러 낸 비밀 파일을 보고에 남기고 worktree 는 지우지 않는다', JSON.stringify(s23.secrets_excluded) === '[".env","certs/server.pem"]' && /secret/i.test(s23.report)
      && !!s23.worktree_kept && fs.existsSync(path.join(r23, '.harness-worktrees', s23.id, '.env')), JSON.stringify({ ex: s23.secrets_excluded, kept: s23.worktree_kept }));

    // ── M4: 무시된 파일이 바뀐 worktree 는 지우지 않는다 ────────────────
    const r24 = checkRepo({ '.gitignore': 'build/\n' });
    const f24 = fake([o => { impl('good')(o); write(path.join(o.cwd, 'build', 'out.bin'), 'artifact'); }]);
    const k24 = await go(r24, { run: f24 });
    R.check('[LP-24] (M4) 무시된 산출물이 있으면 worktree 를 남기고 이유를 적는다', k24.status === 'done' && /ignored/.test(k24.worktree_kept || '') && fs.existsSync(path.join(r24, '.harness-worktrees', k24.id, 'build', 'out.bin')),
      `${k24.status} ${k24.worktree_kept}`);

    // ── M6: 검사 정의 파일 변경 ─────────────────────────────────────
    const r25 = checkRepo({ 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { test: 'node check.js' } }) });
    const f25 = fake([o => { impl('bad')(o); write(path.join(o.cwd, 'ok.js'), 'process.exit(0)\n'); write(path.join(o.cwd, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'node ok.js' } })); }]);
    const m25 = await go(r25, { run: f25, checks: ['npm test'] });
    R.check('[LP-25] (M6) 모델이 scripts.test 를 바꿔도 판정은 기준의 정의(node check.js)로 — done 이 아니다', m25.status !== 'done' && (m25.checks_modified || []).includes('package.json'), `${m25.status} ${JSON.stringify(m25.checks_modified)}`);
    const r25b = checkRepo();
    const f25b = fake([o => { impl('bad')(o); write(path.join(o.cwd, 'check.js'), "console.log('# pass 1\\n# fail 0')\n"); }]);
    const m25b = await go(r25b, { run: f25b });
    R.check('[LP-25] (M6) 검사 명령이 가리키는 파일(check.js)을 고치면 checks_modified 로 보고', JSON.stringify(m25b.checks_modified) === '["check.js"]' && /check definitions modified by the task: check\.js/.test(m25b.report), `${JSON.stringify(m25b.checks_modified)}`);

    // ── M7: 요약 없이 빨간 기준선 → 환경 경고 ───────────────────────────
    const r26 = mkRepo({ 'AGENTS.md': '```yaml\ntest_command: "node needs-dep.js"\n```\n', 'needs-dep.js': "require('left-pad-not-installed');\n" });
    const m26 = await go(r26, { run: fake([o => write(path.join(o.cwd, 'x.txt'), 'x')]), checks: undefined, maxContinuations: 1 });
    const t26 = S.readTask(r26, m26.id);
    R.check('[LP-26] (M7) 기준선이 요약 없이 exit 만 빨가면 "환경 문제일 수 있음" 경고를 기록·보고', /environment/.test(t26.checks.baseline_warning || '') && /environment/.test(m26.report), `${t26.checks.baseline_warning}`);

    // ── M8: 워커 허용 목록에서 셸·env·git 은 늘 뺀다 ────────────────────
    R.check('[LP-27] (M8) allowCommands: 사용자 검사라도 bash·sh·cmd·powershell·pwsh·env·git 은 넣지 않는다',
      allowOf(dnone, { source: 'user', commands: [['bash', 'x.sh'], ['sh', '-c', 'x'], ['C:\\Windows\\System32\\cmd.exe', '/c', 'x'], ['powershell', '-c', 'x'], ['pwsh.exe', 'x'], ['env', 'X=1', 'node'], ['git', 'status'], ['bash x.sh && echo ok']] }) === '',
      allowOf(dnone, { source: 'user', commands: [['bash', 'x.sh'], ['sh', '-c', 'x'], ['C:\\Windows\\System32\\cmd.exe', '/c', 'x'], ['powershell', '-c', 'x'], ['pwsh.exe', 'x'], ['env', 'X=1', 'node'], ['git', 'status'], ['bash x.sh && echo ok']] }));

    // ── L1: 체크포인트 커밋 실패가 실행 전체를 죽이지 않는다 ─────────────
    const r28 = checkRepo();
    const f28 = fake([o => { impl('good')(o); fs.mkdirSync(path.join(o.cwd, 'sub'), { recursive: true }); git(path.join(o.cwd, 'sub'), ['init', '-q']); }]);
    const k28 = await go(r28, { run: f28 });
    const t28 = S.readTask(r28, k28.id);
    R.check('[LP-28] (L1) git add 가 못 넣는 경로(커밋 없는 중첩 저장소)는 빼고 커밋하고 계속 → done', k28.status === 'done' && git(r28, ['show', `${t28.branch}:impl.txt`]) === 'good' && JSON.stringify(t28.commit_skipped) === '["sub"]' && /sub/.test(k28.report),
      `${k28.status} ${k28.reason} ${JSON.stringify(t28.commit_skipped)}`);

    // ── L2: 충돌 표지는 <<<<<<< 와 >>>>>>> 가 모두 있을 때만 ────────────
    const G = require('../../harness/lib/git');
    const mk = path.join(base, 'markers'); fs.mkdirSync(mk, { recursive: true });
    write(path.join(mk, 'title.rst'), 'Title\n=======\n\ntext\n');
    write(path.join(mk, 'conf.txt'), 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n');
    R.check('[LP-29] (L2) rst 제목 밑줄(=======)만 있으면 충돌 아님 · 양쪽 표지가 있으면 충돌', !G.hasConflictMarkers(path.join(mk, 'title.rst')) && G.hasConflictMarkers(path.join(mk, 'conf.txt')));

    // ── L5: task id 검증 ────────────────────────────────────────────
    let e30 = null; try { await L.resume({ ...quiet, root: r1, id: '..\\..\\x', run: fake([impl('x')]) }); } catch (e) { e30 = e; }
    R.check('[LP-30] (L5) resume: 형식이 아닌 id 는 USAGE 로 거부', e30 && e30.code === 'USAGE', String(e30 && (e30.code + ' ' + e30.message)));
    let e30b = null; try { await L.go({ ...quiet, root: r1, id: '../evil', goal: 'x', run: fake([impl('x')]) }); } catch (e) { e30b = e; }
    R.check('[LP-30] (L5) go: 형식이 아닌 id 는 USAGE 로 거부', e30b && e30b.code === 'USAGE', String(e30b && e30b.message));
    const cliId = spawnSync(process.execPath, [CLI, 'resume', '../../x', '--root', r1], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    R.check('[LP-30] (L5) CLI resume ../../x → exit 2', cliId.status === 2 && /task id/.test(cliId.stderr), `${cliId.status} ${cliId.stderr.slice(0, 200)}`);

    // ── L7: 잘못된 --root 에 저장소를 만들지 않는다 ─────────────────────
    const nowhere = path.join(base, 'no', 'such');
    let e32 = null; try { await L.go({ ...quiet, root: nowhere, goal: 'x', run: fake([impl('good')]) }); } catch (e) { e32 = e; }
    R.check('[LP-32] (L7) 없는 경로는 만들지 않고 USAGE(--init 안내)', e32 && e32.code === 'USAGE' && /--init/.test(e32.message) && !fs.existsSync(nowhere), String(e32 && e32.message));
    const plainDir = path.join(base, 'plain'); fs.mkdirSync(plainDir);
    let e32b = null; try { await L.go({ ...quiet, root: plainDir, goal: 'x', run: fake([impl('good')]) }); } catch (e) { e32b = e; }
    R.check('[LP-32] (L7) 저장소가 아닌 폴더에 git init 하지 않는다', e32b && e32b.code === 'USAGE' && !fs.existsSync(path.join(plainDir, '.git')), String(e32b && e32b.message));
    const i32 = await L.go({ ...quiet, root: plainDir, goal: 'x', init: true, run: fake([impl('good')]) });
    R.check('[LP-32] (L7) --init 이면 init + 빈 첫 커밋 뒤 진행', i32.status === 'done' && fs.existsSync(path.join(plainDir, '.git')), `${i32.status} ${i32.reason}`);

    // ── L8 · L9: 보고 문구 ───────────────────────────────────────────
    R.check('[LP-33] (L8) capped 보고: 상한은 추가분이 아니라 작업 전체의 총 한도', /caps are totals for the whole task/.test(cap3.report) && /--budget-usd <new total>/.test(cap3.report), cap3.report);
    const r34 = checkRepo();
    const f34 = fake([o => { impl('good')(o); return { cost_usd: null }; }]);
    const u34 = await go(r34, { run: f34 });
    const t34 = S.readTask(r34, u34.id);
    R.check('[LP-34] (L9) 비용을 모르는 Claude 호출을 세고 보고한다', t34.spent.unknown_cost_calls === 1 && /cost unknown for 1 call/.test(u34.report), `${t34.spent.unknown_cost_calls} ${u34.report}`);

    // ── CLI: 러너 모듈 주입으로 끝까지 ──────────────────────────────
    const r15 = checkRepo();
    const fakeMod = path.join(base, 'fake-runner.js');
    write(fakeMod, `const fs=require('fs'),p=require('path');exports.run=async o=>{fs.writeFileSync(p.join(o.cwd,'impl.txt'),'good');return{ok:true,session_id:o.newSessionId,final_text:'ok',cost_usd:0.25,is_error:false,error_kind:null,permission_denials:[]};};`);
    const cli = spawnSync(process.execPath, [CLI, 'go', 'make it good', '--check', 'node check.js', '--root', r15, '--budget-usd', '3'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HARNESS_RUNNER_MODULE: fakeMod }, timeout: 30000 });
    const line = (cli.stdout.split(/\r?\n/).find(l => l.startsWith('HARNESS_RESULT ')) || '').slice(15);
    let jr = null; try { jr = JSON.parse(line); } catch { /* 없음 */ }
    R.check('[LP-15] CLI go: exit 0 · 마지막 줄 HARNESS_RESULT {json} · done', cli.status === 0 && jr && jr.status === 'done' && jr.cost_usd === 0.25 && /HARNESS_RESULT /.test(cli.stdout.trim().split(/\r?\n/).pop()), `${cli.status} ${cli.stderr.slice(-400)} ${cli.stdout.slice(-300)}`);
    const cliBad = spawnSync(process.execPath, [CLI, 'go'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    R.check('[LP-15] CLI: 목표 없는 go 는 사용법과 함께 exit 2', cliBad.status === 2 && /usage/.test(cliBad.stderr));
    const cliHelp = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    R.check('[LP-15] CLI help: exit 0 · 기본값 안내', cliHelp.status === 0 && /runtime claude · model opus · budget \$20 · wall 120 min · max continuations 8/.test(cliHelp.stdout));
    const cliUnknown = spawnSync(process.execPath, [CLI, 'go', 'x', '--bogus'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    R.check('[LP-15] CLI: 모르는 옵션은 exit 2', cliUnknown.status === 2 && /unknown option/.test(cliUnknown.stderr));
    // L6: 목표 원문은 셸을 거치지 않고 파일·stdin 으로.
    const tricky = 'make impl.txt say good — keep "quotes", $(whoami), `ticks` and $HOME literal\nsecond line';
    const goalFile = path.join(base, 'goal.txt'); write(goalFile, tricky + '\n');
    const r31 = checkRepo();
    const cliFile = spawnSync(process.execPath, [CLI, 'go', '--goal-file', goalFile, '--check', 'node check.js', '--root', r31], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HARNESS_RUNNER_MODULE: fakeMod }, timeout: 30000 });
    const j31 = (() => { try { return JSON.parse((cliFile.stdout.split(/\r?\n/).find(l => l.startsWith('HARNESS_RESULT ')) || '').slice(15)); } catch { return null; } })();
    R.check('[LP-31] (L6) CLI go --goal-file: 원문 그대로(따옴표·$()·백틱·줄바꿈)', cliFile.status === 0 && j31 && S.readTask(r31, j31.id).goal === tricky, `${cliFile.status} ${cliFile.stderr.slice(-300)}`);
    const r31b = checkRepo();
    const cliStdin = spawnSync(process.execPath, [CLI, 'go', '-', '--check', 'node check.js', '--root', r31b], { input: tricky, encoding: 'utf8', windowsHide: true, env: { ...process.env, HARNESS_RUNNER_MODULE: fakeMod }, timeout: 30000 });
    const j31b = (() => { try { return JSON.parse((cliStdin.stdout.split(/\r?\n/).find(l => l.startsWith('HARNESS_RESULT ')) || '').slice(15)); } catch { return null; } })();
    R.check('[LP-31] (L6) CLI go - : stdin 에서 원문', cliStdin.status === 0 && j31b && S.readTask(r31b, j31b.id).goal === tricky, `${cliStdin.status} ${cliStdin.stderr.slice(-300)}`);
    const cliBoth = spawnSync(process.execPath, [CLI, 'go', 'x', '--goal-file', goalFile, '--root', r31b], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    R.check('[LP-31] (L6) 목표를 인자와 --goal-file 로 동시에 주면 exit 2', cliBoth.status === 2, `${cliBoth.status} ${cliBoth.stderr.slice(0, 200)}`);
    const cliStalled = spawnSync(process.execPath, [CLI, 'resume', c.id, '--root', r3], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HARNESS_RUNNER_MODULE: fakeMod }, timeout: 30000 });
    R.check('[LP-15] CLI resume(stalled → 더 해서 done): exit 0', cliStalled.status === 0 && /"status":"done"/.test(cliStalled.stdout), `${cliStalled.status} ${cliStalled.stdout.slice(-300)} ${cliStalled.stderr.slice(-300)}`);

    // ── [2026-10-02 · 2026-10-15 실측] 세션이 go 를 백그라운드 셸로 띄우면 셸의 시간 상한에 작업이 함께 죽었다(running · 주인 없음).
    //    --detach: 셸과 분리된 프로세스로 띄우고 id 를 바로 돌려준다 · wait <id>: 끝날 때까지 기다려 보고를 낸다(wait 가 죽어도 작업은 산다). ──
    {
    const slowMod = path.join(base, 'slow-runner.js');
    write(slowMod, `const fs=require('fs'),p=require('path');exports.run=async o=>{await new Promise(r=>setTimeout(r,1500));fs.writeFileSync(p.join(o.cwd,'impl.txt'),'good');return{ok:true,session_id:o.newSessionId,final_text:'ok',cost_usd:0.25,is_error:false,error_kind:null,permission_denials:[]};};`);
    const rd = checkRepo();
    const td = Date.now();
    const dd = spawnSync(process.execPath, [CLI, 'go', '-', '--detach', '--check', 'node check.js', '--root', rd], { input: 'make it "good" $(x)', encoding: 'utf8', windowsHide: true, env: { ...process.env, HARNESS_RUNNER_MODULE: slowMod }, timeout: 60000 });
    const jd = (() => { try { return JSON.parse((dd.stdout.split(/\r?\n/).find(l => l.startsWith('HARNESS_RESULT ')) || '').slice(15)); } catch { return null; } })();
    const taskd = jd && S.readTask(rd, jd.id);
    R.check('[LP-60] go --detach: 작업이 끝나기 전에 id 와 running 을 돌려준다(exit 0) · 주인은 다른 프로세스 · 목표 원문(stdin) 그대로',
      dd.status === 0 && jd && jd.status === 'running' && taskd && taskd.owner && taskd.owner.pid !== dd.pid && taskd.goal === 'make it "good" $(x)' && Date.now() - td < 30000,
      `${dd.status} ${dd.stdout.slice(-300)} ${dd.stderr.slice(-300)}`);
    const wd = jd ? spawnSync(process.execPath, [CLI, 'wait', jd.id, '--root', rd], { encoding: 'utf8', windowsHide: true, timeout: 90000 }) : { status: null, stdout: '', stderr: 'no id' };
    R.check('[LP-61] wait <id>: 끝날 때까지 기다려 보고와 HARNESS_RESULT(done)를 낸다 · exit 0', wd.status === 0 && /"status":"done"/.test(wd.stdout),
      `${wd.status} ${wd.stdout.slice(-300)} ${wd.stderr.slice(-300)}`);
    const wd2 = spawnSync(process.execPath, [CLI, 'wait', c.id, '--root', r3, '--timeout-min', '0.01'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    R.check('[LP-62] wait: 이미 끝난 작업은 바로 보고한다', wd2.status === 0 && /"status":"done"/.test(wd2.stdout), `${wd2.status} ${wd2.stdout.slice(-200)}`);
    }

    // ── [2026-10-16 실측] 갱신 전에 시작한 세션은 옛 안내대로 --detach 없이 go 를 셸 안에서 돌렸다 — 세션의 안내와 상관없이
    //    go 는 늘 분리된 프로세스로 작업을 띄우고 끝날 때까지 기다린다. 부른 쪽이 죽어도 작업은 끝까지 간다. ──
    {
      const slow3 = path.join(base, 'slow3-runner.js');
      write(slow3, `const fs=require('fs'),p=require('path');exports.run=async o=>{await new Promise(r=>setTimeout(r,4000));fs.writeFileSync(p.join(o.cwd,'impl.txt'),'good');return{ok:true,session_id:o.newSessionId,final_text:'ok',cost_usd:0.1,is_error:false,error_kind:null,permission_denials:[]};};`);
      const rf = checkRepo();
      const caller = spawn(process.execPath, [CLI, 'go', 'make impl.txt say good', '--check', 'node check.js', '--root', rf], { env: { ...process.env, HARNESS_RUNNER_MODULE: slow3 }, stdio: 'ignore', windowsHide: true });
      let id = null;
      for (let i = 0; i < 300 && !id; i++) { await new Promise(r => setTimeout(r, 100)); const ts = S.listTasks(rf).filter(t => t.status === 'running'); if (ts.length) id = ts[0].id; }
      caller.kill('SIGKILL');   // 세션 셸의 시간 상한 흉내 — 부른 프로세스가 죽는다
      const wf = id ? spawnSync(process.execPath, [CLI, 'wait', id, '--root', rf, '--timeout-min', '2'], { encoding: 'utf8', windowsHide: true, timeout: 150000 }) : { status: null, stdout: 'no task' };
      R.check('[LP-63] --detach 없이 부른 go 도 부른 프로세스가 죽어도 작업은 끝까지 간다(done) · wait 로 보고를 받는다', !!id && wf.status === 0 && /"status":"done"/.test(wf.stdout), `${id} ${wf.status} ${String(wf.stdout).slice(-300)}`);
      const fg = spawnSync(process.execPath, [CLI, 'go', 'make impl.txt say good', '--check', 'node check.js', '--root', checkRepo()], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HARNESS_RUNNER_MODULE: slow3 }, timeout: 120000 });
      R.check('[LP-64] 부른 쪽이 살아 있으면 지금처럼 끝날 때까지 기다려 보고와 HARNESS_RESULT(done)를 낸다', fg.status === 0 && /"status":"done"/.test(fg.stdout) && /검사|checks/.test(fg.stdout), `${fg.status} ${fg.stdout.slice(-300)} ${fg.stderr.slice(-300)}`);
    }

    // ── [2026-10-16 사용자 지시] 작업자 명령을 거부하지 않는다(open 기본) — 프로젝트 블록 worker_permissions: strict 면 예전 허용 목록 ──
    {
      const fo = fake([impl('good')]);
      const to = await go(checkRepo(), { run: fo });
      const fs2 = fake([impl('good')]);
      const ts = await go(checkRepo({ 'AGENTS.md': '```yaml\nworker_permissions: strict\n```\n' }), { run: fs2 });
      R.check('[LP-95] 기본은 open(러너에 workerPermissions=open · 지시문은 "아무 명령이나") · worker_permissions: strict 면 strict(지시문은 "허용 목록 밖은 거부")',
        to.status === 'done' && fo.calls[0].workerPermissions === 'open' && /any command/.test(fo.calls[0].prompt) && !/refused automatically/.test(fo.calls[0].prompt)
        && ts.status === 'done' && fs2.calls[0].workerPermissions === 'strict' && /refused automatically/.test(fs2.calls[0].prompt),
        `${fo.calls[0] && fo.calls[0].workerPermissions} ${fs2.calls[0] && fs2.calls[0].workerPermissions}`);
    }

    // ── [2026-10-17 자동 보고 5d6643b86c24] Windows 작업자가 LF 파일을 CRLF 로 저장해 변경 규모가 몇 배로 부풀고 메인과 파일 전체가 충돌했다.
    //    하네스가 커밋하기 전에, 원래 줄바꿈과 통째로 달라진 파일은 원래 줄바꿈으로 되돌린다(git 이 줄바꿈을 바꾸는 저장소는 그대로). ──
    {
      const LFTXT = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
      const re = checkRepo({ 'big.txt': LFTXT, 'win.txt': LFTXT.replace(/\n/g, '\r\n') });
      const te = await go(re, { run: fake([o => { impl('good')(o); write(path.join(o.cwd, 'big.txt'), LFTXT.replace('line 5', 'line five').replace(/\n/g, '\r\n')); write(path.join(o.cwd, 'win.txt'), LFTXT.replace('line 7', 'line seven')); }]) });
      const blob = f => spawnSync('git', ['show', `${te.branch}:${f}`], { cwd: re }).stdout;
      const k = S.readTask(re, te.id);
      R.check('[LP-97] 커밋 전 줄바꿈 복원: LF 파일을 CRLF 로 · CRLF 파일을 LF 로 통째로 바꿔도 원래 줄바꿈으로 커밋 · 실제 바꾼 줄만 변경 규모에',
        te.status === 'done' && !blob('big.txt').includes(Buffer.from('\r\n')) && blob('big.txt').toString().includes('line five') && blob('win.txt').toString().split('\r\n').length > 40 && k.diff && k.diff.insertions <= 3,
        `${te.status} ${JSON.stringify(k.diff)} big:${blob('big.txt').includes(Buffer.from('\r\n'))}`);
    }
    // ── [2026-10-17 자동 이슈 #17] 작업이 새 시험 파일을 더했는데 검사 명령이 그 프로젝트를 돌리지 않아 판정에서 빠졌다 — 시험 수가 그대로면 알린다 ──
    {
      const rt = checkRepo();
      const tt = await go(rt, { run: fake([o => { impl('good')(o); write(path.join(o.cwd, 'tests', 'new.test.js'), 'test("x", () => {});\n'); }]) });
      R.check('[LP-98] 새 시험 파일을 더했는데 검사의 시험 수(통과+실패)가 작업 전과 같으면 보고 맨 위 주의에 알린다', tt.status === 'done' && /new\.test\.js/.test(tt.report.split('\n').slice(0, 6).join('\n')) && /(시험 수|test count)/.test(tt.report), tt.report.slice(0, 700));
    }

    // ── [2026-10-16 자동 보고 00b4667cbf35] "이번 작업에서 만들지 않은 파일은 지우지 말라" 때문에 앞 작업이 만든 파일의 이름을 바꾸지 못해
    //    확장자를 남기고 빌드 설정에 예외를 넣었다. worktree 안의 삭제 · 이름 바꾸기는 하네스가 턴마다 커밋해 되돌릴 수 있다 — 막는 것은 worktree 밖. ──
    {
      const ap = require('../../harness/lib/prompts').taskPrompt({ id: 't-x', goal: 'g', checks: { commands: [] }, runtime: 'claude' });
      R.check('[LP-96] 작업자 지시: worktree 안의 삭제 · 이름 바꾸기는 목표가 필요로 하면 해도 된다 · 금지는 worktree 밖 삭제', !/did not create in this task/.test(ap) && /outside this worktree/.test(ap) && /(delet|renam)[^.]*inside this worktree/i.test(ap), ap.slice(0, 1200));
    }

    // ── [2026-10-16 자동 이슈 #13] 저장소에서 찾은 검사가 새 worktree 에서 작업 전부터 시간 초과 — 작업과 무관하게 같은 실패 2회로 정체됐다.
    //    자동으로 찾은 검사가 기준선에서 시간 초과면 판정에서 빼고 알린다. 사용자가 준 검사(--check)는 빼지 않는다. ──
    {
      const SLOW = "setTimeout(()=>console.log('# pass 1\\n# fail 0'),8000)";
      const r90 = mkRepo({ 'slow.js': SLOW, 'AGENTS.md': '```yaml\ntest_command: "node slow.js"\n```\n' });
      const t90 = await L.go({ ...quiet, root: r90, goal: 'make impl.txt say good', checkTimeoutMs: 1500, run: fake([impl('good')]) });
      const k90 = S.readTask(r90, t90.id);
      R.check('[LP-90] 자동으로 찾은 검사가 기준선부터 시간 초과면 판정에서 빼고(정체되지 않는다) 보고에 알린다',
        t90.status === 'done' && (k90.checks.dropped || []).length === 1 && !k90.checks.commands.length && /node slow\.js/.test(t90.report) && /(dropped|뺐다)/.test(t90.report), `${t90.status} ${t90.reason} ${JSON.stringify(k90.checks.dropped)}`);
      const r91 = mkRepo({ 'slow.js': SLOW });
      const t91 = await L.go({ ...quiet, root: r91, goal: 'make impl.txt say good', checks: ['node slow.js'], checkTimeoutMs: 1500, run: fake([impl('good')]) });
      const k91 = S.readTask(r91, t91.id);
      R.check('[LP-91] 사용자가 준 검사(--check)는 기준선에서 시간 초과여도 빼지 않는다', !(k91.checks.dropped || []).length && k91.checks.commands.length === 1, JSON.stringify(k91.checks));
    }

    // ── [2026-10-15 자동 이슈 #9] 진행 중에 요구사항을 덧붙일 길이 없어 stop → cancel → 다시 go 를 되풀이했다 — note <id> 로 넣는다 ──
    {
      const rn = checkRepo();
      let nid = null;
      const fn = fake([o => { nid = path.basename(o.cwd); impl('good')(o); L.addNote(rn, nid, '버튼 색은 파랑으로'); }, o => impl('good')(o)]);
      const tn1 = await L.go({ ...quiet, root: rn, goal: 'make impl.txt say good', checks: ['node check.js'], run: fn });
      R.check('[LP-80] 도는 중에 넣은 추가 지시: 검사가 통과해 끝나려던 참이면 그 지시를 담은 턴을 한 번 더 돈다',
        tn1.status === 'done' && fn.calls.length === 2 && /버튼 색은 파랑으로/.test(fn.calls[1].prompt) && S.readLog(rn, tn1.id).some(e => e.event === 'notes_delivered'), `${tn1.status} ${fn.calls.length} ${String(fn.calls[1] && fn.calls[1].prompt).slice(0, 300)}`);
      L.addNote(rn, tn1.id, '제목도 바꿔 줘');
      const fn2 = fake([o => impl('good')(o)]);
      const rs2 = await L.resume({ ...quiet, root: rn, id: tn1.id, run: fn2 });
      R.check('[LP-81] 끝난(done) 작업도 전달하지 않은 추가 지시가 있으면 resume 으로 이어 가 첫 메시지에 담는다',
        rs2.status === 'done' && fn2.calls.length === 1 && /제목도 바꿔 줘/.test(fn2.calls[0].prompt), `${rs2.status} ${rs2.reason} ${String(fn2.calls[0] && fn2.calls[0].prompt).slice(0, 300)}`);
      const rs3 = await L.resume({ ...quiet, root: rn, id: tn1.id, run: fake([o => impl('good')(o)]) });
      R.check('[LP-82] 전달할 지시가 없는 done 작업의 resume 은 여전히 거부한다', rs3.refused && /status is done/.test(rs3.reason), JSON.stringify(rs3).slice(0, 200));
      const nf = path.join(base, 'note.txt'); write(nf, '로그 레벨은 INFO');
      const cn = spawnSync(process.execPath, [CLI, 'note', tn1.id, '--file', nf, '--root', rn], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      R.check('[LP-83] CLI note <id> --file: 지시를 쌓고 언제 전달되는지 말한다', cn.status === 0 && /resume/.test(cn.stdout) && L.pendingNotes(rn, tn1.id).some(n => /INFO/.test(n.text)), `${cn.status} ${cn.stdout} ${cn.stderr}`);
    }

    // ── [2026-10-16 사용자 지시] 시작 때 묻지 않고 지시를 바탕으로 끝까지 스스로 판단 — 결과를 바꾼 갈림길만 완성 뒤 보고에 정리한다 ──
    {
      const DEC = '# 결정\n\n## 1. 날짜 형식\n- 선택지: ISO 8601 / 로캘 형식\n- 고른 것: ISO 8601\n- 이유: 기존 API 가 ISO 를 쓴다\n- 결과: 응답이 2026-10-16 형태 · 바꾸려면 formatDate 한 곳\n\n## 2. 빈 목록 처리\n- 고른 것: 빈 배열(오류 아님)\n- 이유: 호출부가 길이로 분기한다\n';
      const rk = checkRepo();
      const tk = await L.go({ ...quiet, root: rk, goal: '목록 응답에 날짜를 넣어 줘', checks: ['node check.js'], run: fake([o => { impl('good')(o); write(path.join(o.cwd, '.harness', path.basename(o.cwd), 'DECISIONS.md'), DEC); }]) });
      const tkk = S.readTask(rk, tk.id);
      R.check('[LP-70] 작업자가 쓴 DECISIONS.md 의 분기점을 작업에 기록한다(제목 · 내용) — worktree 를 지운 뒤에도 남는다',
        tk.status === 'done' && tkk.decisions && tkk.decisions.length === 2 && tkk.decisions[0].title === '날짜 형식' && tkk.decisions[0].body.some(l => /ISO 8601/.test(l)), JSON.stringify(tkk.decisions));
      R.check('[LP-71] 한국어 보고: 맨 위 요약 다음에 "결정 분기점 2곳" 과 각 분기점의 선택 · 이유가 있다',
        /결정 분기점: 2곳/.test(tk.report) && /1\. 날짜 형식/.test(tk.report) && /고른 것: ISO 8601/.test(tk.report) && tk.report.indexOf('결정 분기점') < tk.report.indexOf('브랜치:'), tk.report.slice(0, 900));
      // [2026-10-16 자동 이슈 #14] 보고는 "resume 으로 지시하라" 고 했지만 resume 은 지시를 받지 못했다 — 실제로 되는 명령을 적는다.
      R.check('[LP-75] 결정 분기점을 바꾸는 방법은 실제 명령으로(resume <id> --note · note <id> --file)', new RegExp(`resume ${tk.id} --note`).test(tk.report) && new RegExp(`note ${tk.id} --file`).test(tk.report), tk.report.slice(0, 900));
      const tn = await go(checkRepo(), { run: fake([impl('good')]) });
      R.check('[LP-72] 갈림길이 없었으면 보고에 없다고 분명히 적는다', /decision points: none/.test(tn.report), tn.report.slice(0, 500));
      const pr = require('../../harness/lib/prompts').taskPrompt({ id: 't-x', goal: 'g', checks: { commands: [] }, language: 'Korean' });
      // [2026-10-16 실측] PowerShell 도구의 파이프(`… | Select-String`)는 어떤 허용 규칙으로도 통과하지 않았다(PowerShell(*) 만) — Bash 파이프는 통과.
      const prc = require('../../harness/lib/prompts').taskPrompt({ id: 't-x', goal: 'g', checks: { commands: [] }, runtime: 'claude', worker_permissions: 'strict' });   // 허용 목록 모드의 안내
      R.check('[LP-74] 작업자 지시(Claude): 파이프 · 출력 거르기는 Bash 도구로 — PowerShell 파이프는 거부된다', /pipe/i.test(prc) && /Bash tool/.test(prc) && /PowerShell/.test(prc), prc.slice(-1500));
      R.check('[LP-73] 작업자 지시: 묻지 말고 스스로 고르고, 결과를 바꾼 갈림길만 DECISIONS.md 에(선택지 · 고른 것 · 이유 · 결과)', /DECISIONS\.md/.test(pr) && /never ask/.test(pr) && /options/.test(pr) && /why/.test(pr), pr.slice(0, 1500));
    }

    // ── [2026-09-30 실측 · Python 서비스 저장소] 전체 회귀 20분+ — 검사 상한은 프로젝트 블록에서, 기준선은 같은 기준 커밋이면 다시 쓴다 ──
    const counter = path.join(base, 'baseline-counter.txt');
    const COUNT_JS = `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x\\n');console.log('# pass 1\\n# fail 0');`;
    const rb = mkRepo({ 'count.js': COUNT_JS, 'AGENTS.md': '```yaml\ncheck_timeout_min: 45\n```\n' });
    const runs = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
    const b1 = await L.go({ ...quiet, root: rb, goal: 'touch a', checks: ['node count.js'], run: fake([impl('a')]) });
    const n1 = runs();
    R.check('[LP-35] 검사 상한: --check-timeout-min 이 없으면 AGENTS.md 의 check_timeout_min', S.readTask(rb, b1.id).checks.timeout_ms === 45 * 60000, JSON.stringify(S.readTask(rb, b1.id).checks.timeout_ms));
    const b2 = await L.go({ ...quiet, root: rb, goal: 'touch b', checks: ['node count.js'], run: fake([impl('b')]) });
    const n2 = runs();
    R.check('[LP-36] 같은 기준 커밋 · 같은 검사면 기준선을 다시 돌리지 않는다(판정 1회만)', b1.status === 'done' && b2.status === 'done' && n1 === 2 && n2 === 3 && S.readTask(rb, b2.id).checks.baseline_cached === true, `n1=${n1} n2=${n2}`);
    const b3 = await L.go({ ...quiet, root: rb, goal: 'touch c', checks: ['node count.js'], freshBaseline: true, run: fake([impl('c')]) });
    R.check('[LP-36] --fresh-baseline 이면 기준선을 다시 돌린다', b3.status === 'done' && runs() === n2 + 2, `runs=${runs()}`);

    // ── [2026-09-30 실측 · Python 서비스 저장소] 대형 저장소에서 드러난 네 가지 ──
    // [2026-10-03 실측 · 한국어 Windows · dotnet 10.0.401] VSTest 요약이 현지화되고, 테스트 프로젝트마다 한 줄씩 나온다 — 마지막 줄만 읽으면 한 프로젝트만 센다.
    const dnKo = '  실패 FailTests.Bad [93 ms]\n실패!  - 실패:     1, 통과:     1, 건너뜀:     1, 전체:     3, 기간: 97 ms - t2.dll (net10.0)\n통과!  - 실패:     0, 통과:    57, 건너뜀:     0, 전체:    57, 기간: 1 s - t1.dll (net8.0)\n';
    const dnEn = 'Failed!  - Failed:     1, Passed:     1, Skipped:     1, Total:     3, Duration: 19 ms - t2.dll (net10.0)\nPassed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 5 ms - t1.dll (net10.0)\n';
    R.check('[LP-52] dotnet: 한국어 요약을 읽고 프로젝트별 줄을 모두 더한다', eq(K.parseSummary(dnKo), { found: true, pass: 58, fail: 1 }) && eq(K.parseSummary(dnEn), { found: true, pass: 2, fail: 1 }),
      JSON.stringify([K.parseSummary(dnKo), K.parseSummary(dnEn)]));
    R.check('[LP-52] dotnet 10(MTP) 의 "Test summary: total …" 줄도 읽는다', eq(K.parseSummary('Test summary: total: 12, failed: 2, succeeded: 9, skipped: 1, duration: 3.1s\n'), { found: true, pass: 9, fail: 2 }));
    R.check('[LP-37] pytest -q 의 테두리 없는 요약 줄(-n auto 포함)을 읽는다', JSON.stringify(K.parseSummary('...\n2 failed, 7070 passed, 66 skipped in 312.45s (0:05:12)\n')) === JSON.stringify({ found: true, pass: 7070, fail: 2 }) && K.parseSummary('3 passed, 1 error in 2.00s\n').fail === 1);
    const rp = checkRepo({ '.gitignore': 'plan.md\n__pycache__/\n' });
    const pr = await go(rp, { run: fake([o => { impl('good')(o); plan(o, o.cwd.split(/[\\/]/).pop()); write(path.join(o.cwd, 'pkg', '__pycache__', 'x.pyc'), 'b'); }]) });
    const prFiles = git(rp, ['show', '--name-only', '--format=', pr.branch]) + '\n' + git(rp, ['log', '--name-only', '--format=', pr.branch]);
    R.check('[LP-38] 저장소가 plan.md 를 무시해도(Windows 대소문자) .harness/<id>/PLAN.md 는 커밋된다', pr.status === 'done' && new RegExp(`\\.harness/${pr.id}/PLAN\\.md`).test(prFiles), prFiles.slice(0, 300));
    R.check('[LP-39] __pycache__ 는 git 밖 산출물로 치지 않는다(worktree 를 붙잡지 않는다)', !((S.readTask(rp, pr.id).outside_git || {}).ignored_changed || []).some(p => /__pycache__/.test(p)) && !S.readTask(rp, pr.id).worktree_kept, JSON.stringify(S.readTask(rp, pr.id).outside_git));
    // [2026-09-30 실측 · Python 서비스 저장소] 폴더째 무시되는 경로로 복사한 파일(.claude/rules/, docs/ 한 파일)이 "git 밖 변경" 으로 잡혔다 · 테스트 DB 도.
    const ri = checkRepo({ '.gitignore': '.claude/\ndocs/\ndata/*.db\n', '.worktreeinclude': '/.claude/rules/\n/docs/prds/spec.md\n', 'AGENTS.md': '```yaml\noutside_git_ok: ["data/*.db"]\n```\n' });
    write(path.join(ri, '.claude', 'rules', 'r.md'), 'rule\n'); write(path.join(ri, 'docs', 'prds', 'spec.md'), 'spec\n'); write(path.join(ri, 'docs', 'other.md'), 'not copied\n');
    const pi = await go(ri, { run: fake([o => { impl('good')(o); write(path.join(o.cwd, 'data', 'app.db'), 'db'); }]) });
    const pit = S.readTask(ri, pi.id);
    R.check('[LP-41] .worktreeinclude 로 복사한 파일은 폴더째 무시돼도 git 밖 변경이 아니다 · outside_git_ok 의 런타임 부산물도', pi.status === 'done' && ((pit.outside_git || {}).ignored_changed || []).length === 0 && !pit.worktree_kept, JSON.stringify(pit.outside_git) + ' kept=' + pit.worktree_kept);
    const tp = require('../../harness/lib/prompts.js').taskPrompt({ id: 't-x', goal: 'g', checks: { source: 'detected', commands: [['python', '-m', 'pytest']], baseline: { ok: false, pass: 7070, fail: 2 } } }, {});
    R.check('[LP-40] 기준선이 빨가면 프롬프트가 그것을 알리고 "원래 실패 때문에 BLOCKED 하지 말라" 고 한다', /already failed \(baseline: 2 failing, 7070 passing\)/.test(tp) && /do not write BLOCKED\.md because of them/.test(tp), tp.slice(-400));

    // ── [2026-10-01 · Python 서비스 저장소] 무인 작업자가 인프라 단계(docker build · cp -r)를 못 해 BLOCKED — 작업·프로젝트 단위 허용 · blocked 재개 · 거부 보고 ──
    const DOCKER = 'Bash(docker build:*)';
    const ra = checkRepo({ 'AGENTS.md': '```yaml\nworker_permissions: strict\n```\n' });   // 허용 목록 모드(--allow 가 의미 있는 곳)
    const fa = fake([o => { impl('good')(o); }]);
    const al = await go(ra, { run: fa, allow: [DOCKER] });
    const ta = S.readTask(ra, al.id);
    R.check('[LP-42] go --allow: task.allow 에 기록 · 러너(allowRules)로 넘긴다 · 프롬프트가 미리 허용된 규칙과 "그 밖은 거부 → BLOCKED.md 에 필요한 명령" 을 알린다',
      al.status === 'done' && JSON.stringify(ta.allow) === JSON.stringify([DOCKER]) && (fa.calls[0].allowRules || []).includes(DOCKER)
      && fa.calls[0].prompt.includes(DOCKER) && /refused automatically/.test(fa.calls[0].prompt) && /exact commands/.test(fa.calls[0].prompt), JSON.stringify({ allow: ta.allow, rules: fa.calls[0].allowRules }));
    const rw = checkRepo({ 'AGENTS.md': '```yaml\ntest_command: "node check.js"\nworker_allow: ["Bash(cp:*)", \'Bash(python scripts/verify_component_data_bank.py:*)\']\n```\n' });
    const fw = fake([impl('good')]);
    const aw = await go(rw, { run: fw, allow: [DOCKER, 'Bash(cp:*)'] });
    const tw = S.readTask(rw, aw.id);
    R.check('[LP-43] 프로젝트 블록 worker_allow 와 --allow 를 합친다(중복 없이) · 러너까지', aw.status === 'done'
      && JSON.stringify(tw.allow) === JSON.stringify(['Bash(cp:*)', 'Bash(python scripts/verify_component_data_bank.py:*)', DOCKER])
      && ['Bash(cp:*)', DOCKER, 'Bash(python scripts/verify_component_data_bank.py:*)'].every(x => fw.calls[0].allowRules.includes(x)), JSON.stringify(tw.allow));
    R.check('[LP-43] yamlList: 흐름형 · 블록형 목록 · 없으면 null', JSON.stringify(K.yamlListOf('worker_allow:\n  - "Bash(a:*)"\n  - Bash(b c:*)\nnext: 1\n', 'worker_allow')) === '["Bash(a:*)","Bash(b c:*)"]'
      && JSON.stringify(K.yamlListOf('worker_allow: ["x, y", \'z\']  # note', 'worker_allow')) === '["x, y","z"]' && K.yamlListOf('test_command: x', 'worker_allow') === null);
    const P0 = require('../../harness/lib/policy');
    const BAD = ['Bash(git push:*)', 'Bash(git push origin main)', 'Bash(*)', 'Bash', 'Bash(bash:*)', 'Bash(git commit -m:*)', 'Bash(git:*)', 'Bash(git *)', 'PowerShell(*)', 'PowerShell(pwsh:*)',
      'Bash(sh -c:*)', 'Bash(cmd.exe /c:*)', 'Bash(env git push:*)', 'Bash(git reset --hard:*)', 'Bash(git checkout:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(git branch -D:*)',
      'Bash(git tag:*)', 'Bash(git update-ref:*)', 'Bash(git clean -fd:*)', 'Bash(git stash:*)', 'Bash(* build:*)', 'Bash(docker build && git push:*)', 'Task(x)', 'Bash()'];
    const GOOD = [DOCKER, 'Bash(cp:*)', 'Bash(python scripts/verify_component_data_bank.py:*)', 'PowerShell(docker build:*)', 'Bash(git log:*)', 'Read(//c/data/**)', 'Edit(docs/evidence/**)', 'Write(docs/evidence/**)', 'WebFetch(domain:example.com)'];
    const badOk = BAD.filter(x => !P0.validateAllowRule(x)), goodBad = GOOD.filter(x => P0.validateAllowRule(x));
    R.check('[LP-44] 허용 규칙 검증: git 쓰기 · Bash(*) · 셸 · 형식 밖은 거부, 인프라 명령 · 읽기 git · 경로 도구는 통과', !badOk.length && !goodBad.length, JSON.stringify({ accepted: badOk, rejected: goodBad.map(x => [x, P0.validateAllowRule(x)]) }));
    let e44 = null; try { await go(checkRepo(), { run: fake([impl('good')]), allow: ['Bash(git push:*)'] }); } catch (e) { e44 = e; }
    R.check('[LP-44] go: 금지 규칙은 USAGE 로 거부(작업을 만들지 않는다)', e44 && e44.code === 'USAGE' && /git push/.test(e44.message), String(e44 && e44.message));
    const rbad = checkRepo({ 'AGENTS.md': '```yaml\nworker_allow: ["Bash(git commit:*)"]\n```\n' });
    let e44b = null; try { await go(rbad, { run: fake([impl('good')]) }); } catch (e) { e44b = e; }
    R.check('[LP-44] go: 프로젝트 블록 worker_allow 의 금지 규칙도 USAGE · 작업 기록 없음', e44b && e44b.code === 'USAGE' && /worker_allow/.test(e44b.message) && S.listTasks(rbad).length === 0, String(e44b && e44b.message));
    const rcli = checkRepo();
    const cliCodes = ['Bash(git push:*)', 'Bash(*)', 'Bash(bash:*)', 'Bash(git commit:*)'].map(rule =>
      spawnSync(process.execPath, [CLI, 'go', 'x', '--check', 'node check.js', '--root', rcli, '--allow', rule], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HARNESS_RUNNER_MODULE: fakeMod }, timeout: 15000 }));
    R.check('[LP-44] CLI go --allow <금지 규칙> → exit 2 (git push · Bash(*) · bash · git commit) · 작업 없음', cliCodes.every(x => x.status === 2 && /--allow|allow rule/.test(x.stderr)) && S.listTasks(rcli).length === 0,
      JSON.stringify(cliCodes.map(x => [x.status, x.stderr.split('\n')[0]])));
    const rcx = checkRepo();
    const acx = await go(rcx, { run: fake([impl('good')]), runtime: 'codex', allow: [DOCKER] });
    R.check('[LP-44] Codex: --allow 는 실패시키지 않고 효과가 없다고 보고한다(샌드박스가 정한다)', acx.status === 'done' && /no effect/.test(acx.report) && /sandbox/.test(acx.report), acx.report);

    // 거부된 명령 기록 → blocked 보고(이어받기 명령) → resume --allow 로 같은 세션이 이어서 done
    const rd = checkRepo();
    const DEN = [{ tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'docker build -t probe:pg -f docker/Dockerfile .' } },
      { tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'cp -r docs/evidence/pg docs/evidence/pg.old' } },
      { tool_name: 'Bash', tool_use_id: 'c', tool_input: { command: 'git push origin main' } },
      { tool_name: 'Bash', tool_use_id: 'd', tool_input: { command: 'docker build -t probe:pg -f docker/Dockerfile .' } }];
    const fd = fake([o => { impl('half')(o); write(path.join(o.cwd, '.harness', path.basename(o.cwd), 'BLOCKED.md'), 'docker build and cp -r were refused (nobody to approve).\n'); return { permission_denials: DEN }; }]);
    const bd = await go(rd, { run: fd });
    const td = S.readTask(rd, bd.id);
    const repoName = path.basename(rd);
    R.check('[LP-45] 거부된 명령을 기록한다(중복 없이 · 최대 20)', bd.status === 'blocked' && Array.isArray(td.denied) && td.denied.length === 3 && td.denied.some(x => /docker build/.test(x.command)), JSON.stringify(td.denied));
    R.check('[LP-45] blocked 보고: 거부된 명령 · resume --allow 제안(docker build · cp) · git push 는 사용자 몫 · 손으로 이어받는 git worktree add',
      /denied commands \(unattended — nobody could approve them\): .*docker build -t probe:pg/.test(bd.report)
      && bd.report.includes(`to continue with them allowed: node harness/cli.js resume ${bd.id} --allow "Bash(docker build:*)" --allow "Bash(cp:*)"`)
      && /must be done by the user.*git push origin main/.test(bd.report)
      && bd.report.includes(`to take it over by hand: git worktree add ../${repoName}-${bd.id} harness/${bd.id}`), bd.report);
    const fd2 = fake([impl('good')]);
    const rs = await L.resume({ ...quiet, root: rd, id: bd.id, run: fd2, allow: [DOCKER, 'Bash(cp:*)'] });
    const td2 = S.readTask(rd, bd.id);
    const tree = git(rd, ['ls-tree', '-r', '--name-only', td2.branch]);
    R.check('[LP-46] resume <blocked> --allow: 같은 세션 · "BLOCKED.md 를 보고 허용했다" 메시지 · 규칙이 러너까지 · done', rs.status === 'done' && fd2.calls.length === 1 && fd2.calls[0].sessionId === fd.calls[0].newSessionId
      && /The user reviewed your BLOCKED\.md and allowed: Bash\(docker build:\*\), Bash\(cp:\*\)/.test(fd2.calls[0].prompt) && /same checks/.test(fd2.calls[0].prompt)
      && fd2.calls[0].allowRules.includes(DOCKER) && JSON.stringify(td2.allow) === JSON.stringify([DOCKER, 'Bash(cp:*)']), `${rs.status} ${rs.reason} ${fd2.calls[0] && fd2.calls[0].prompt}`);
    R.check('[LP-46] resume <blocked>: BLOCKED.md → BLOCKED.1.md (이력은 브랜치에 남는다)', new RegExp(`\\.harness/${bd.id}/BLOCKED\\.1\\.md`).test(tree) && !new RegExp(`\\.harness/${bd.id}/BLOCKED\\.md`).test(tree), tree);
    const rb2 = checkRepo();
    const blk = o => { write(path.join(o.cwd, '.harness', path.basename(o.cwd), 'BLOCKED.md'), 'still blocked\n'); };
    const bb = await go(rb2, { run: fake([blk]) });
    const fb1 = fake([blk]);
    const rb1 = await L.resume({ ...quiet, root: rb2, id: bb.id, run: fb1 });
    R.check('[LP-47] resume <blocked> (규칙 없이): "계속하라고 했다" 메시지 · 다시 막히면 blocked', rb1.status === 'blocked' && /The user reviewed your BLOCKED\.md and asked you to continue/.test(fb1.calls[0].prompt), `${rb1.status} ${fb1.calls[0] && fb1.calls[0].prompt}`);
    const rb3 = await L.resume({ ...quiet, root: rb2, id: bb.id, run: fake([impl('good')]) });
    const tree2 = git(rb2, ['ls-tree', '-r', '--name-only', bb.branch]);
    R.check('[LP-47] 두 번 막혔다 풀리면 BLOCKED.1.md · BLOCKED.2.md 가 남고 BLOCKED.md 는 없다 → done', rb3.status === 'done' && /BLOCKED\.1\.md/.test(tree2) && /BLOCKED\.2\.md/.test(tree2) && !/BLOCKED\.md/.test(tree2.replace(/BLOCKED\.\d+\.md/g, '')), `${rb3.status} ${tree2}`);
    let e47 = null; try { await L.resume({ ...quiet, root: rb2, id: bb.id, run: fake([impl('good')]), allow: ['Bash(git push:*)'] }); } catch (e) { e47 = e; }
    R.check('[LP-47] resume --allow 도 같은 검증(금지 규칙 → USAGE)', e47 && e47.code === 'USAGE', String(e47 && e47.message));

    // ── 세션이 worktree 를 다른 브랜치로 옮기면 하네스는 그 브랜치에 커밋하지 않는다 ──
    //   권한 규칙은 경계가 아니다(`node -e` 의 child_process 로 git checkout 할 수 있다). 옮겨 간 브랜치가 사용자 브랜치면
    //   체크포인트 커밋이 사용자 브랜치에 쌓였다 — 커밋은 작업 브랜치에서만, 옮겨졌으면 error 로 멈춘다.
    const r48 = checkRepo();
    git(r48, ['branch', 'release']);
    const rel0 = git(r48, ['rev-parse', 'release']);
    const f48 = fake([o => { spawnSync('git', ['checkout', '-q', 'release'], { cwd: o.cwd, windowsHide: true }); write(path.join(o.cwd, 'impl.txt'), 'good\n'); }]);
    const g48 = await go(r48, { run: f48 });
    R.check('[LP-48] 세션이 worktree 를 사용자 브랜치로 옮기면: 그 브랜치에 커밋 0 · error · worktree 는 남긴다',
      git(r48, ['rev-parse', 'release']) === rel0 && g48.status === 'error' && /no longer on/.test(g48.reason) && !!g48.worktree_kept,
      `release ${rel0.slice(0, 8)}→${git(r48, ['rev-parse', 'release']).slice(0, 8)} · ${g48.status} · ${g48.reason} · kept=${g48.worktree_kept}`);

    // ── --runtime codex 에 --model 이 없으면 Codex 기본 모델(opus 를 넘기지 않는다) ──
    //   [평가 2026-10-02] codex 팔이 4/4 즉시 실패: "The 'opus' model is not supported when using Codex with a ChatGPT account."
    const r50 = checkRepo(), f50 = fake([impl('good')]);
    const g50 = await go(r50, { run: f50, runtime: 'codex' });
    const f50b = fake([impl('good')]);
    await go(checkRepo(), { run: f50b });
    R.check('[LP-50] codex 런타임 · --model 없음 → 러너에 모델을 넘기지 않는다 · claude 는 여전히 opus',
      g50.status === 'done' && !f50.calls[0].model && f50b.calls[0].model === 'opus', `${g50.status} codex=${f50.calls[0].model} claude=${f50b.calls[0].model}`);

    // ── 빈 저장소(그린필드)의 작업자도 기본 프로그램(node · python …)을 돌릴 수 있다 · 검증 명령 거부는 BLOCKED 이유가 아니다 ──
    //   [평가 2026-10-02] 빈 저장소에서 시작한 목표 3/3 이 BLOCKED: 저장소 종류를 모르니 node 가 허용 목록에 없었고,
    //   10/01 에 더한 "거부되면 BLOCKED.md" 문구 때문에 모델이 테스트를 못 돌린다는 이유로 멈췄다(숨은 검사는 16/16 통과).
    const e51 = path.join(base, 'empty51'); fs.mkdirSync(e51); git(e51, ['init', '-q', '-b', 'main']); git(e51, ['config', 'user.name', 't']); git(e51, ['config', 'user.email', 't@example.invalid']);
    git(e51, ['commit', '-q', '--allow-empty', '-m', 'empty']);
    fs.writeFileSync(path.join(e51, 'CLAUDE.md'), '```yaml\nworker_permissions: strict\n```\n');   // 허용 목록 모드의 안내를 본다
    const f51 = fake([o => { write(path.join(o.cwd, 'package.json'), '{"name":"x"}\n'); write(path.join(o.cwd, 'x.js'), '1\n'); }]);
    const g51 = await L.go({ ...quiet, root: e51, goal: 'make a cli', run: f51 });
    const a51 = f51.calls[0].allowCommands || [];
    R.check('[LP-51] 빈 저장소: 작업자 허용에 node · npm · python 이 있다', ['node', 'npm', 'python'].every(p => a51.includes(p)), JSON.stringify(a51));
    const p51 = f51.calls[0].prompt;
    R.check('[LP-51] 프롬프트: 검증용 명령(테스트 · 실행)이 거부돼도 BLOCKED.md 를 쓰지 말라 — 하네스가 턴 뒤에 검사한다',
      /only to verify/i.test(p51) && /do not write BLOCKED\.md/i.test(p51), p51.slice(-900));
    const pc51 = Pr.taskPrompt({ id: 't-x', goal: 'g', runtime: 'codex', checks: { source: 'detected', commands: [['npm', 'test']] } }, {});
    R.check('[LP-51] codex 프롬프트: 샌드박스의 spawn EPERM 은 멈출 이유가 아니다', /EPERM/.test(pc51) && /outside the sandbox/.test(pc51), pc51.slice(-600));

    // ── 프로젝트 블록(test_command · check_timeout_min)은 부른 체크아웃에서 읽는다 ──
    //   [2026-10-03 · .NET 앱 저장소] 새 AGENTS.md(단위 테스트만 · 커밋 전)를 worktree 가 못 보고 기준 커밋의 판(블록 없음)을 읽어,
    //   솔루션 전체 `dotnet test`(화면에 앱을 띄우는 UI 테스트 포함)로 돌았다. CLAUDE.md 가 git 밖인 저장소도 같다.
    const r53 = checkRepo();
    write(path.join(r53, 'other.js'), 'console.log("# pass 7\\n# fail 0")\n'); git(r53, ['add', 'other.js']); git(r53, ['commit', '-qm', 'other check']);
    write(path.join(r53, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node other.js"\ncheck_timeout_min: 3\n```\n');   // 커밋하지 않는다
    const g53 = await L.go({ ...quiet, root: r53, goal: 'x', run: fake([impl('good')]) });
    const t53 = S.readTask(r53, g53.id);
    R.check('[LP-53] 커밋 안 된 AGENTS.md 의 test_command · check_timeout_min 을 쓴다(worktree 의 옛 판이 아니라)',
      JSON.stringify(t53.checks.commands) === '[["node","other.js"]]' && t53.checks.timeout_ms === 180000 && g53.checks.pass === 7, JSON.stringify([t53.checks.commands, t53.checks.timeout_ms, g53.checks]));

    // ── 불안정한 검사: 실패하면 한 번 더 돌려 본다 — 통과하면 작업자에게 돌려보내지 않고 보고에 "불안정" 으로 적는다 ──
    //   [2026-10-03 실측] 코드 변경 없이 1 · 2 · 16 건이 실패했다가 통과 — 작업자가 없는 버그를 고치느라 이어 가기 3회.
    const r54 = checkRepo({ 'flaky.js': "const fs=require('fs');const f='.flaky-count';const n=fs.existsSync(f)?+fs.readFileSync(f,'utf8'):0;fs.writeFileSync(f,String(n+1));if(n%2===1){console.log('# pass 0\\n# fail 1');process.exit(1);}console.log('# pass 1\\n# fail 0');", '.gitignore': '.flaky-count\n' });
    const f54 = fake([impl('good')]);
    const g54 = await L.go({ ...quiet, root: r54, goal: 'x', run: f54, checks: ['node check.js', 'node flaky.js'] });
    R.check('[LP-54] 실패한 검사를 한 번 더 돌려 통과하면 → 작업자에게 돌려보내지 않고 done · 보고에 불안정 검사',
      g54.status === 'done' && f54.calls.length === 1 && /flaky checks .*node flaky\.js/.test(g54.report), `${g54.status} calls=${f54.calls.length} ${g54.report.split('\n').filter(l => /flaky/.test(l)).join(' | ')}`);
    // 변경 규모 — 리뷰할 근거(판정이 아니라 표시)
    const r55 = checkRepo();
    const g55 = await go(r55, { run: fake([o => { write(path.join(o.cwd, 'impl.txt'), 'good\n'); write(path.join(o.cwd, 'extra.js'), 'a\nb\nc\n'); }]) });
    R.check('[LP-55] 보고에 변경 규모(추가 · 삭제 줄 · 새 파일 수)', /diff: \+4 -0 lines · 2 new files/.test(g55.report), g55.report.split('\n').filter(l => /diff/.test(l)).join(' | '));

    // ── 보고 맨 위의 한국어 요약 · 다음 할 일 (보고는 사용자에게 그대로 전해진다) ──
    const r49 = checkRepo();
    const g49 = await go(r49, { run: fake([impl('good')]) });
    const l49 = g49.report.split('\n');
    R.check('[LP-49] done 보고: 둘째 줄 요약(완료 · 검사 통과 수) · 셋째 줄 다음(accept · cancel)',
      /^요약: 완료 — 검사 통과 \(1 통과 \/ 0 실패\)/.test(l49[1]) && /^다음: .*accept .*cancel/.test(l49[2]), l49.slice(0, 3).join(' | '));
    const r49b = checkRepo();
    const g49b = await L.go({ ...quiet, root: r49b, goal: 'x', run: fake([o => { write(path.join(o.cwd, 'x.txt'), 'x\n'); }]) });
    R.check('[LP-49] 검사 없는 done: 요약이 "모델의 보고뿐 — 직접 확인" 을 말한다', /^요약: 완료 — 신뢰할 검사 없음/.test(g49b.report.split('\n')[1]) && /직접 확인/.test(g49b.report.split('\n')[1]), g49b.report.split('\n')[1]);
    const r49c = checkRepo();
    const g49c = await go(r49c, { run: fake([o => { write(path.join(o.cwd, '.harness', path.basename(o.cwd), 'BLOCKED.md'), 'need docker\n'); return { permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'docker build -t x .' } }] }; }]) });
    const l49c = g49c.report.split('\n');
    R.check('[LP-49] blocked 보고: 요약은 막힘 · 다음은 허용해 이어 가는 resume --allow 줄',
      /^요약: 막힘/.test(l49c[1]) && /^다음: .*resume .*--allow "Bash\(docker build:\*\)"/.test(l49c[2]), l49c.slice(0, 3).join(' | '));
    // ── [2026-10-28 자동 이슈 #54] Windows 에서 worktree 정리가 'Filename too long' 으로 실패했는데 git 은 등록과 .git 파일을 이미 지웠다 —
    //    파일이 든 폴더만 남았고, 보고는 그 폴더에서 직접 이어 받으라고 했다(그 안의 git 은 상위 저장소를 본다). 가짜 git 으로 그 실패를 흉내 낸다(POSIX). ──
    if (process.platform !== 'win32') {
      const shimDir = path.join(base, 'gitshim'), realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      write(path.join(shimDir, 'git'), `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = remove ] && [ -f "$3/.git" ]; then
  wt="$3"; gd=$(sed -n 's/^gitdir: //p' "$wt/.git")
  rm -rf "$gd" "$wt/.git"
  echo "error: failed to delete '$wt': Filename too long" >&2; exit 255
fi
exec "${realGit}" "$@"
`);
      fs.chmodSync(path.join(shimDir, 'git'), 0o755);
      const oldPath = process.env.PATH, rmSync = fs.rmSync;
      const blocked = o => { write(path.join(o.cwd, '.harness', path.basename(o.cwd), 'BLOCKED.md'), 'need a decision\n'); };
      try {
        process.env.PATH = shimDir + path.delimiter + oldPath;
        const r99 = checkRepo();
        const t99 = await go(r99, { run: fake([blocked]) });
        const k99 = S.readTask(r99, t99.id);
        R.check('[LP-99] git 이 등록만 지우고 파일이 든 폴더를 남기면(긴 경로) 하네스가 마저 지운다 — 내용은 이미 브랜치에 있다',
          t99.status === 'blocked' && !k99.worktree_kept && !fs.existsSync(S.taskPaths(r99, t99.id).wt) && !/worktree 가 .* 남아 있다|the worktree is kept at/.test(t99.report),
          `${t99.status} kept=${k99.worktree_kept} exists=${fs.existsSync(S.taskPaths(r99, t99.id).wt)}`);
        // 마저 지우지도 못하면(잠긴 파일) 폴더를 남기되, 그 폴더에서 이어 받으라고 하지 않는다 — 새 worktree 를 안내한다
        const r99b = checkRepo();
        fs.rmSync = function (p, ...a) { if (/\.harness-worktrees/.test(String(p))) { const e = new Error('EPERM: locked'); e.code = 'EPERM'; throw e; } return rmSync.call(this, p, ...a); };
        const t99b = await go(r99b, { run: fake([blocked]) });
        fs.rmSync = rmSync;
        const k99b = S.readTask(r99b, t99b.id);
        R.check('[LP-99] 못 지운 폴더는 남김으로 적고(등록이 사라졌다) · 보고는 그 폴더가 아니라 git worktree add 로 이어 받으라고 한다',
          t99b.status === 'blocked' && /registration is gone/.test(k99b.worktree_kept || '') && k99b.worktree_orphaned === true
          && !/worktree 가 .* 남아 있다|the worktree is kept at/.test(t99b.report) && /git worktree add \.\.\/.*-t-/.test(t99b.report),
          `${t99b.status} kept=${k99b.worktree_kept} | ${t99b.report.split('\n').filter(l => /이어 받|take it over/.test(l)).join(' | ')}`);
      } finally { process.env.PATH = oldPath; fs.rmSync = rmSync; }
    } else console.log('  ℹ [LP-99] Windows — 가짜 git(sh) 으로 긴 경로 실패를 흉내 내지 못한다(POSIX 에서 잰다)');
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

function G_same(a, b) { return require('../../harness/lib/git').samePath(a, b); }

'use strict';
// harness v5 러너(A1) — run() 파사드 · Claude/Codex 인자 · 결과 파싱 · 오류 분류 · 프로세스 트리 종료 · 실행 파일 찾기 · 워커 권한.
//   모델을 부르지 않는다: exe = node, exePrefixArgs = [가짜 CLI 스크립트] 로 띄운다(tests/fixtures/v5-fake-cli).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { makeReporter } = require('../run.js');
const runner = require('../../harness/lib/runner.js');
const rc = require('../../harness/lib/runner-claude.js');
const rx = require('../../harness/lib/runner-codex.js');
const exe = require('../../harness/lib/exe.js');
const policy = require('../../harness/lib/policy.js');
const proc = require('../../harness/lib/proc.js');
const R = makeReporter('v5 러너 — 두 런타임을 같은 모양으로 · 권한 · 종료 · 실행 파일');

const FIX = path.join(__dirname, '..', 'fixtures', 'v5-fake-cli');
const FAKE_CLAUDE = path.join(FIX, 'fake-claude.js'), FAKE_CODEX = path.join(FIX, 'fake-codex.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-runner-'));
const cwd = path.join(base, 'ws'); fs.mkdirSync(cwd);
const WIN = process.platform === 'win32';
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const flagVal = (a, f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
let n = 0;
function fake(runtime, mode, extra) {
  const log = path.join(base, `log-${++n}.json`), pids = path.join(base, `pids-${n}.json`);
  const o = { runtime, cwd, prompt: 'do the thing\nline two "quoted"', exe: process.execPath, exePrefixArgs: [runtime === 'claude' ? FAKE_CLAUDE : FAKE_CODEX],
    env: { FAKE_MODE: mode, FAKE_LOG: log, FAKE_PIDS: pids }, allowCommands: ['node', 'npm'], ...(extra || {}) };
  if (extra && extra.env) o.env = { FAKE_MODE: mode, FAKE_LOG: log, FAKE_PIDS: pids, ...extra.env };
  return { o, log, pids };
}
async function deadWithin(pids, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!alive(pids.self) && !alive(pids.grand)) return true; await new Promise(r => setTimeout(r, 100)); }
  return false;
}
async function waitFile(f, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fs.existsSync(f)) return true; await new Promise(r => setTimeout(r, 50)); } return false; }

(async () => {
  const savedEnv = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
  try {
    // ── RN-01 policy ────────────────────────────────────────────────
    const st = policy.claudeSettings(['node', 'npm', 'bad name', 'x(y)', 'git']);
    const allow = st.permissions.allow, deny = st.permissions.deny;
    R.check('[RN-01] allow: 프로그램마다 Bash·PowerShell 짝', ['Bash(node:*)', 'PowerShell(node:*)', 'Bash(npm:*)', 'PowerShell(npm:*)'].every(r => allow.includes(r)), JSON.stringify(allow));
    R.check('[RN-01] allow: 읽기 전용 git(status·diff·log·show) 두 셸 모두', ['status', 'diff', 'log', 'show'].every(g => allow.includes(`Bash(git ${g}:*)`) && allow.includes(`PowerShell(git ${g}:*)`)), JSON.stringify(allow));
    R.check('[RN-01] allow: 규칙을 깨는 이름·git 통째 허용은 버린다', !allow.some(r => /bad name|x\(y\)|\(git:\*\)/.test(r)), JSON.stringify(allow));
    const MUST_DENY = ['git push', 'git merge', 'git reset', 'git rebase', 'git checkout', 'git switch', 'git branch -D', 'git clean', 'git commit'];
    const missing = [];
    for (const sh of ['Bash', 'PowerShell']) for (const g of MUST_DENY) if (!deny.includes(`${sh}(${g}:*)`)) missing.push(`${sh}(${g})`);
    R.check('[RN-01] deny: push·merge·reset·rebase·checkout·switch·branch -D·clean·commit 을 Bash·PowerShell 모두', missing.length === 0, missing.join(', '));
    // [2026-10-15 현장 감사] 작업자 셸 호출의 17% 가 거부 — 65% 는 출력을 줄이려 붙인 파이프(`dotnet build … | Select-String`) 때문이었다.
    //   읽기 전용 필터는 허용한다(파일을 쓰거나 다른 명령을 실행하는 sed · find · xargs · awk · tee 는 넣지 않는다).
    const FILTERS = ['grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'Select-String', 'Select-Object', 'Measure-Object', 'Sort-Object', 'Format-Table', 'Format-List', 'Out-String'];
    R.check('[RN-01b] allow: 읽기 전용 파이프 필터(grep · head · tail · Select-String · Select-Object …)를 두 셸 모두', FILTERS.every(f => allow.includes(`Bash(${f}:*)`) && allow.includes(`PowerShell(${f}:*)`)), JSON.stringify(allow));
    R.check('[RN-01b] allow: 쓰기 · 실행이 되는 도구(sed · find · xargs · awk · tee · ForEach-Object · Invoke-Expression)는 넣지 않는다', !allow.some(r => /\((sed|find|xargs|awk|tee|ForEach-Object|Invoke-Expression|iex|Set-Content|Out-File):/.test(r)), JSON.stringify(allow));
    // [2026-10-16 자동 이슈 #12] 저장소 구조를 보는 읽기 전용 명령까지 거부돼 작업자가 우회하거나 정체됐다.
    const RO = ['ls', 'cat', 'pwd', 'tree', 'stat', 'realpath', 'which', 'Get-ChildItem', 'Get-Content', 'Get-Item', 'Test-Path', 'Resolve-Path', 'Get-Location', 'git ls-files', 'git rev-parse', 'git grep', 'git blame', 'dotnet --list-sdks', 'dotnet --list-runtimes', 'dotnet --info'];
    R.check('[RN-01c] allow: 저장소를 읽기만 하는 명령(ls · cat · Get-ChildItem · git ls-files · dotnet --list-sdks …)을 두 셸 모두', RO.every(f => allow.includes(`Bash(${f}:*)`) && allow.includes(`PowerShell(${f}:*)`)), JSON.stringify(allow));
    R.check('[RN-01c] allow: find 는 넣지 않는다(-delete · -exec 로 지우거나 실행한다)', !allow.some(r => /\(find:/.test(r)), JSON.stringify(allow));
    // [2026-10-16 사용자 지시] 작업자 명령을 거부하지 말 것 — 허용 목록은 경계가 아니었다(node · python 으로 무엇이든 돈다) · 거부율 19%.
    //   open(기본): 명령은 다 허용 · git 쓰기는 deny 그대로 · 되돌릴 수 없는 명령은 guard 훅(대화형과 같은 것)이 거른다.
    const op = policy.claudeSettings(['node'], [], 'open');
    R.check('[RN-01d] open: Bash · PowerShell 전부 허용 · git 쓰기 deny 는 그대로', op.permissions.allow.includes('Bash(*)') && op.permissions.allow.includes('PowerShell(*)') && op.permissions.deny.includes('Bash(git push:*)') && op.permissions.deny.includes('PowerShell(git commit:*)'), JSON.stringify(op.permissions));
    R.check('[RN-01d] open: worktree 밖 읽기(Read · Grep · Glob) 허용 · git -C · stash · config 는 deny 대신 guard 가 읽기만 통과(쓰기 deny 는 남는다)',
      ['Read', 'Grep', 'Glob', 'Monitor'].every(x => op.permissions.allow.includes(x)) && /Monitor/.test(op.hooks.PreToolUse[0].matcher) && !op.permissions.deny.some(x => /git (-C|stash|config|--git-dir|--work-tree):/.test(x)) && op.permissions.deny.includes('Bash(git reset:*)') && op.permissions.deny.includes('Bash(git checkout:*)'), JSON.stringify(op.permissions));
    const gh = (((op.hooks || {}).PreToolUse || [])[0] || {});
    R.check('[RN-01d] open: guard 훅(hooks/guard.js)을 Bash · PowerShell 앞에 건다', /Bash/.test(gh.matcher || '') && /PowerShell/.test(gh.matcher || '') && (gh.hooks || []).some(h => /--worker/.test(h.command) && fs.existsSync((/"([^"]+guard\.js)"/.exec(h.command) || [])[1] || '')), JSON.stringify(op.hooks));
    R.check('[RN-01d] strict(예전): 기본 인자는 그대로 허용 목록', !allow.includes('Bash(*)') && !st.hooks, JSON.stringify(allow).slice(0, 200));
    R.check('[RN-01] allow 에 git 쓰기가 없다', !allow.some(r => /git (push|merge|reset|rebase|checkout|switch|branch|clean|commit)/.test(r)), JSON.stringify(allow));
    R.check('[RN-01] bypass 모드를 끈다', st.permissions.disableBypassPermissionsMode === 'disable');
    R.check('[RN-01] codexArgs = -s workspace-write, 위험 플래그 없음', JSON.stringify(policy.codexArgs()) === JSON.stringify(['-s', 'workspace-write']));
    R.check('[RN-01] allowFor: 검사 argv[0](경로·.exe 포함) + 저장소 종류',
      JSON.stringify(policy.allowFor([['C:\\Program Files\\nodejs\\node.exe', 'tests/run.js']], null)) === '["node"]'
      && JSON.stringify(policy.allowFor([['node', 'x']], 'node')) === '["node","npm","npx"]'
      && JSON.stringify(policy.allowFor(['pytest -q', '"C:/py/python.exe" -m pytest'], 'python')) === '["python","py","pytest","pip"]',
      JSON.stringify([policy.allowFor([['node', 'x']], 'node'), policy.allowFor(['pytest -q'], 'python')]));
    R.check('[RN-01] allowFor: 후보 밖 실행기(bash·sh·cmd·powershell)는 넣지 않는다',
      policy.allowFor([['bash', 'test.sh'], 'sh -c x', ['cmd', '/c', 'x'], ['powershell', '-c', 'x']], null).length === 0
      && JSON.stringify(policy.allowFor([['dotnet', 'test']], ['go', 'dotnet'])) === '["dotnet","go"]');

    // ── RN-02 proc: 머리+꼬리 · 환경 정리 ──────────────────────────────
    const cap = new proc.Capture(5, 5); cap.push('abcdefghij'); cap.push('KLMNOPQRST');
    R.check('[RN-02] Capture: 머리 5 + 꼬리 5, 가운데는 몇 글자 버렸는지', cap.text() === 'abcde\n…[10 chars omitted]…\nPQRST' && cap.omitted === 10, JSON.stringify(cap.text()));
    const small = new proc.Capture(5, 5); small.push('abc'); small.push('de');
    R.check('[RN-02] Capture: 상한 안이면 그대로', small.text() === 'abcde');
    process.env.CLAUDECODE = '1'; process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const ce = proc.childEnv({ NODE_TEST_CONTEXT: 'child-v8', KEEP: 'y' });
    R.check('[RN-02] childEnv: CLAUDECODE · CLAUDE_CODE_ENTRYPOINT · NODE_TEST_CONTEXT 제거, 나머지 유지', !('CLAUDECODE' in ce) && !('CLAUDE_CODE_ENTRYPOINT' in ce) && !('NODE_TEST_CONTEXT' in ce) && ce.KEEP === 'y');

    // ── RN-03 Claude 새 세션 ─────────────────────────────────────────
    const SID = '11111111-2222-4333-8444-555555555555';
    let f = fake('claude', 'ok', { newSessionId: SID, model: 'sonnet', effort: 'high', budgetUsd: 2.345, systemAppend: 'SYS', timeoutMs: 30000 });
    let r = await runner.run(f.o), L = readJson(f.log);
    const a = L ? L.argv : [], aStr = a.join(' ');
    R.check('[RN-03] 인자: -p · json · acceptEdits · --settings · --setting-sources user · model · effort · budget · append',
      a[0] === '-p' && flagVal(a, '--output-format') === 'json' && flagVal(a, '--permission-mode') === 'acceptEdits' && !!flagVal(a, '--settings')
      && flagVal(a, '--setting-sources') === 'user' && flagVal(a, '--model') === 'sonnet' && flagVal(a, '--effort') === 'high'
      && flagVal(a, '--max-budget-usd') === '2.35' && flagVal(a, '--append-system-prompt') === 'SYS', aStr);
    R.check('[RN-03] 새 세션은 --session-id <newSessionId>, --resume 없음', flagVal(a, '--session-id') === SID && !a.includes('--resume'), aStr);
    R.check('[RN-03] 금지 플래그 없음(bypassPermissions · dangerously · --safe-mode · --bare)', !/bypassPermissions|dangerously|--safe-mode|--bare/.test(aStr), aStr);
    R.check('[RN-03] 프롬프트는 stdin 으로(argv 에 없음)', L && L.stdin === f.o.prompt && !a.includes(f.o.prompt), L && JSON.stringify(L.stdin));
    R.check('[RN-03] --settings 파일 = policy.claudeSettings(allowCommands)', L && JSON.stringify(L.settings) === JSON.stringify(policy.claudeSettings(['node', 'npm'])), L && JSON.stringify(L.settings));
    R.check('[RN-03] --settings 임시 파일은 호출 뒤 지워진다', L && !!L.settingsPath && !fs.existsSync(L.settingsPath), L && L.settingsPath);
    {
      // 강제 종료된 작업자가 남긴 --settings 파일 — 주인이 죽었으면 다음 실행이 치운다 · 살아 있는 주인의 것은 그대로
      const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-sweep-'));
      const dead = '99999996';   // 어느 OS 에서도 배정되지 않는 pid(끝난 프로세스의 pid 는 곧 재사용될 수 있다)
      const fDead = path.join(sd, `harness-claude-settings-${dead}-abc123.json`), fLive = path.join(sd, `harness-claude-settings-${process.pid}-def456.json`), fOther = path.join(sd, 'other.json');
      for (const f of [fDead, fLive, fOther]) fs.writeFileSync(f, '{}');
      const gone = rc.sweepOrphanSettings(sd);
      R.check('[RN-03b] 주인이 죽은 --settings 임시 파일만 치운다(살아 있는 주인 · 다른 파일은 그대로)', !fs.existsSync(fDead) && fs.existsSync(fLive) && fs.existsSync(fOther) && gone.length === 1, JSON.stringify(gone));
      // 테스트 러너: 끊긴 이전 실행의 임시 폴더는 6시간 넘은 것만 치운다(동시에 도는 실행의 폴더는 그대로)
      const old = path.join(sd, 'harness-v5-loop-AbC123'), fresh = path.join(sd, 'harness-v5-integ-XyZ789'), mine = path.join(sd, 'harness-v5-lint-notmine-x');
      for (const d of [old, fresh, mine]) fs.mkdirSync(d);
      const t7 = Date.now() - 7 * 3600 * 1000; fs.utimesSync(old, t7 / 1000, t7 / 1000); fs.utimesSync(mine, t7 / 1000, t7 / 1000);
      const swept = require('../run.js').sweepStaleTmp(sd);
      R.check('[RN-03c] 테스트 러너는 6시간 넘은 테스트 임시 폴더만 치운다', !fs.existsSync(old) && fs.existsSync(fresh) && fs.existsSync(mine) && swept.join() === 'harness-v5-loop-AbC123', JSON.stringify(swept));
      fs.rmSync(sd, { recursive: true, force: true });
    }
    R.check('[RN-03] 자식 환경에 CLAUDECODE · CLAUDE_CODE_ENTRYPOINT 가 없다', L && L.env.CLAUDECODE === null && L.env.CLAUDE_CODE_ENTRYPOINT === null, L && JSON.stringify(L.env));
    R.check('[RN-03] cwd 에서 실행', L && fs.realpathSync.native(L.cwd).toLowerCase() === fs.realpathSync.native(cwd).toLowerCase(), L && L.cwd);
    R.check('[RN-03] 결과: ok · session_id · final_text · 비용 · 토큰(캐시 포함 입력)',
      r.ok && !r.is_error && r.error_kind === null && r.session_id === SID && r.final_text === 'done' && r.cost_usd === 0.5 && r.session_cost_usd === 0.5
      && r.tokens && r.tokens.input === 130 && r.tokens.output === 5 && r.tokens.total === 135 && r.exit_code === 0 && Array.isArray(r.permission_denials) && r.permission_denials.length === 0, JSON.stringify(r));
    const KEYS = ['ok', 'session_id', 'final_text', 'cost_usd', 'tokens', 'exit_code', 'is_error', 'error_kind', 'error_message', 'permission_denials', 'stderr_tail'];
    R.check('[RN-03] r 는 계약의 키를 모두 가진다', KEYS.every(k => k in r), KEYS.filter(k => !(k in r)).join(','));

    f = fake('claude', 'ok', {}); r = await runner.run(f.o); L = readJson(f.log);
    R.check('[RN-03] newSessionId 가 없으면 러너가 uuid 를 정해 넘기고 돌려준다', L && /^[0-9a-f-]{36}$/.test(flagVal(L.argv, '--session-id') || '') && r.session_id === flagVal(L.argv, '--session-id'), JSON.stringify(r.session_id));
    let threw = null; try { await runner.run(fake('claude', 'ok', { newSessionId: 'not-a-uuid' }).o); } catch (e) { threw = e; }
    R.check('[RN-03] uuid 가 아닌 newSessionId 는 입력 오류로 던진다', threw && threw.code === 'BAD_SESSION_ID', String(threw));

    // ── RN-04 Claude 재개 · 비용 차액 ────────────────────────────────
    const RID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    f = fake('claude', 'ok', { sessionId: RID, newSessionId: SID, priorSessionCostUsd: 1.0, env: { FAKE_COST: '1.25' } });
    r = await runner.run(f.o); L = readJson(f.log);
    const b = L ? L.argv : [];
    R.check('[RN-04] 재개는 --resume <id>, --session-id 없음', flagVal(b, '--resume') === RID && !b.includes('--session-id'), b.join(' '));
    R.check('[RN-04] 재개에도 권한 모드 · --settings · --setting-sources 를 다시 넘긴다', flagVal(b, '--permission-mode') === 'acceptEdits' && !!flagVal(b, '--settings') && flagVal(b, '--setting-sources') === 'user', b.join(' '));
    // [실측 2026-09-29] 2.1.283 은 재개 호출의 total_cost_usd 가 세션 누계, 2.1.248 은 호출분이다 — 버전으로 가른다.
    R.check('[RN-04] (2.1.283) cost_usd = 누계 − 직전 누계(0.25), session_cost_usd = 누계(1.25)', r.cost_usd === 0.25 && r.session_cost_usd === 1.25 && r.cost_mode === 'cumulative' && r.session_id === RID, JSON.stringify({ c: r.cost_usd, s: r.session_cost_usd, m: r.cost_mode }));
    r = await runner.run(fake('claude', 'ok', { sessionId: RID, priorSessionCostUsd: 1.0, env: { FAKE_COST: '1.25', FAKE_VERSION: '2.1.248' } }).o);
    R.check('[RN-04] (2.1.248) 호출분 — cost_usd 1.25, session_cost_usd 2.25', r.cost_usd === 1.25 && r.session_cost_usd === 2.25 && r.cost_mode === 'per_call', JSON.stringify({ c: r.cost_usd, s: r.session_cost_usd, m: r.cost_mode }));
    r = await runner.run(fake('claude', 'ok', { sessionId: RID, priorSessionCostUsd: 0.5, env: { FAKE_COST: '0.1' } }).o);
    R.check('[RN-04] 누계 모드인데 누계가 줄면 모순 → 호출분으로(0.1 · 0.6)', r.cost_usd === 0.1 && r.session_cost_usd === 0.6 && /contradiction/.test(r.cost_mode), JSON.stringify({ c: r.cost_usd, s: r.session_cost_usd, m: r.cost_mode }));
    r = await runner.run(fake('claude', 'ok', { sessionId: RID, priorSessionCostUsd: 1.0, costMode: 'per_call', env: { FAKE_COST: '1.25' } }).o);
    R.check('[RN-04] o.costMode 로 강제할 수 있다', r.cost_usd === 1.25 && r.cost_mode === 'per_call', JSON.stringify({ c: r.cost_usd, m: r.cost_mode }));
    R.check('[RN-04] costModeFor: ≤2.1.248 호출분 · 그 밖(모름 포함) 누계',
      rc.costModeFor([2, 1, 248]) === 'per_call' && rc.costModeFor([2, 0, 9]) === 'per_call' && rc.costModeFor([2, 1, 283]) === 'cumulative' && rc.costModeFor(null) === 'cumulative');

    // ── RN-05 Claude 오류 분류 ───────────────────────────────────────
    r = await runner.run(fake('claude', 'quota').o);
    R.check('[RN-05] 한도 문구 → quota, 원문이 실린다', !r.ok && r.error_kind === 'quota' && /hit your limit/.test(r.error_message), JSON.stringify(r));
    r = await runner.run(fake('claude', 'auth').o);
    R.check('[RN-05] 로그인/API 키 문구(결과 JSON 없음) → auth', !r.ok && r.error_kind === 'auth' && /login/.test(r.error_message), JSON.stringify(r));
    r = await runner.run(fake('claude', 'model').o);
    R.check('[RN-05] 그 밖의 is_error 결과 → model', !r.ok && r.is_error && r.error_kind === 'model' && /500/.test(r.error_message), JSON.stringify(r));
    r = await runner.run(fake('claude', 'crash').o);
    R.check('[RN-05] 결과 JSON 없이 죽음 → crash, exit_code · stderr_tail', !r.ok && r.error_kind === 'crash' && r.exit_code === 3 && /boom/.test(r.stderr_tail), JSON.stringify(r));
    r = await runner.run(fake('claude', 'budget').o);
    R.check('[RN-05] 예산 소진 → model + budget_exhausted', !r.ok && r.error_kind === 'model' && r.budget_exhausted === true, JSON.stringify(r));
    r = await runner.run(fake('claude', 'denied').o);
    R.check('[RN-05] permission_denials 를 그대로 돌려준다', r.ok && r.permission_denials.length === 1 && r.permission_denials[0].tool_input.command === 'git push origin main', JSON.stringify(r.permission_denials));
    r = await runner.run({ runtime: 'claude', cwd, prompt: 'x', exe: path.join(base, 'nope.exe') });
    R.check('[RN-05] 실행 파일이 없으면 던지지 않고 crash 로 돌려준다', !r.ok && r.error_kind === 'crash' && /EXE_NOT_FOUND/.test(r.error_message), JSON.stringify(r));
    R.check('[RN-05] 분류기: quota 가 auth 보다 먼저 · 무관한 문구는 null',
      rc.classify('Claude AI usage limit reached') === 'quota' && rc.classify('OAuth token has expired') === 'auth' && rc.classify('Credit balance is too low') === 'quota' && rc.classify('syntax error near foo') === null);

    // ── RN-06 상한 시간 · 취소 — 프로세스 트리를 죽이고 곧 돌아온다 ──────────
    f = fake('claude', 'hang', { timeoutMs: 1500 });
    let t0 = Date.now(); r = await runner.run(f.o); let took = Date.now() - t0;
    let pids = readJson(f.pids);
    R.check('[RN-06] Claude 상한 → error_kind timeout', !r.ok && r.error_kind === 'timeout', JSON.stringify(r));
    R.check('[RN-06] 상한 뒤 곧 돌아온다(< 8초)', took < 8000, took + 'ms');
    R.check('[RN-06] 자식과 손자 모두 죽었다(taskkill /T)', !!pids && await deadWithin(pids, 3000), JSON.stringify(pids));
    R.check('[RN-06] 상한으로 끝나도 settings 임시 파일은 지워진다', !fs.readdirSync(os.tmpdir()).some(x => x.startsWith(`harness-claude-settings-${process.pid}-`)));

    f = fake('claude', 'hang', { timeoutMs: 60000 });
    const ac = new AbortController(); f.o.signal = ac.signal;
    const pending = runner.run(f.o);
    await waitFile(f.pids, 10000);
    t0 = Date.now(); ac.abort(); r = await pending; took = Date.now() - t0; pids = readJson(f.pids);
    R.check('[RN-06] AbortSignal → error_kind aborted, 곧 돌아온다', !r.ok && r.error_kind === 'aborted' && took < 8000, JSON.stringify({ k: r.error_kind, took }));
    R.check('[RN-06] 취소 뒤 자식과 손자 모두 죽었다', !!pids && await deadWithin(pids, 3000), JSON.stringify(pids));
    const ac2 = new AbortController(); ac2.abort();
    f = fake('claude', 'ok', { signal: ac2.signal }); r = await runner.run(f.o);
    R.check('[RN-06] 이미 취소된 신호면 띄우지 않고 aborted', r.error_kind === 'aborted' && !fs.existsSync(f.log), JSON.stringify(r));

    // ── RN-07 Codex 새 스레드 · JSONL 파싱 ───────────────────────────
    f = fake('codex', 'ok', { model: 'gpt-6-sol', effort: 'medium', tokenBudget: 1000 });
    r = await runner.run(f.o); L = readJson(f.log);
    const c = L ? L.argv : [];
    R.check('[RN-07] 인자: exec --json -s workspace-write -C <cwd> -m M -c model_reasoning_effort=E --skip-git-repo-check -',
      JSON.stringify(c) === JSON.stringify(['exec', '--json', '-s', 'workspace-write', '-C', cwd, '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=medium',
        ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []), '--skip-git-repo-check', '-']), c.join(' '));
    R.check('[RN-07] 위험 플래그 없음(danger-full-access · bypass · yolo · --ephemeral)', !/danger|bypass|yolo|--ephemeral/.test(c.join(' ')), c.join(' '));
    R.check('[RN-07] 프롬프트는 stdin(-)', L && L.stdin === f.o.prompt, L && JSON.stringify(L.stdin));
    R.check('[RN-07] thread.started.thread_id → session_id', r.session_id === '0199a213-81c0-7800-8aa1-bbab2a035a53', r.session_id);
    R.check('[RN-07] 마지막 agent_message → final_text', r.final_text === 'final answer', r.final_text);
    R.check('[RN-07] turn.completed.usage 는 누계 — 마지막 값(합산 아님)', r.tokens && r.tokens.input === 24763 && r.tokens.output === 122 && r.tokens.total === 24885, JSON.stringify(r.tokens));
    R.check('[RN-07] 재시도 중 error 이벤트 · 잡음 줄은 실패가 아니다 · cost_usd null', r.ok && !r.is_error && r.error_kind === null && r.cost_usd === null && r.exit_code === 0, JSON.stringify(r));
    R.check('[RN-07] r 는 계약의 키를 모두 가진다', KEYS.every(k => k in r), KEYS.filter(k => !(k in r)).join(','));

    // ── RN-08 Codex 재개 · 실패 ──────────────────────────────────────
    const TID = '0199b000-0000-7000-8000-000000000001';
    f = fake('codex', 'ok', { sessionId: TID, model: 'm1' }); r = await runner.run(f.o); L = readJson(f.log);
    const d = L ? L.argv : [], ri = d.indexOf('resume');
    R.check('[RN-08] 재개: 옵션은 모두 resume 앞, 뒤는 <thread_id> - 뿐',
      ri > 0 && JSON.stringify(d.slice(ri)) === JSON.stringify(['resume', TID, '-']) && d.slice(0, ri).includes('-s') && d.slice(0, ri).includes('-C') && flagVal(d, '-C') === cwd, d.join(' '));
    R.check('[RN-08] 재개 세션 id 가 이어진다', r.ok && r.session_id === TID, r.session_id);
    r = await runner.run(fake('codex', 'quota').o);
    R.check('[RN-08] turn.failed 한도 문구 → quota, 원문', !r.ok && r.error_kind === 'quota' && /usage limit/.test(r.error_message) && r.exit_code === 1 && r.session_id, JSON.stringify(r));
    r = await runner.run(fake('codex', 'fail').o);
    R.check('[RN-08] 그 밖의 turn.failed → model', !r.ok && r.error_kind === 'model' && /sandbox refused/.test(r.error_message), JSON.stringify(r));
    r = await runner.run(fake('codex', 'error-only').o);
    R.check('[RN-08] 턴 없이 error 만 남기고 exit 1 → 문구로 분류(401 → auth)', !r.ok && r.error_kind === 'auth', JSON.stringify(r));
    r = await runner.run(fake('codex', 'declined').o);
    R.check('[RN-08] declined 명령 → permission_denials', r.ok && r.permission_denials.length === 1 && r.permission_denials[0].tool_input.command === 'git commit -m x', JSON.stringify(r.permission_denials));
    f = fake('codex', 'hang', { timeoutMs: 1500 });
    t0 = Date.now(); r = await runner.run(f.o); took = Date.now() - t0; pids = readJson(f.pids);
    R.check('[RN-08] Codex 상한 → timeout, 곧 돌아오고 트리가 죽는다', r.error_kind === 'timeout' && took < 8000 && !!pids && await deadWithin(pids, 3000), JSON.stringify({ k: r.error_kind, took, pids }));
    const p2 = rx.makeParser(); ['{"type":"thread.started","thread_id":"T"}', '{bad json', '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}', '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2}}'].forEach(l => p2.line(l));
    R.check('[RN-08] 파서: 깨진 줄을 세고 누계는 마지막 값', p2.state().bad_lines === 1 && p2.state().usage.input_tokens === 9 && p2.state().thread_id === 'T');

    // ── RN-09 exe.resolve ────────────────────────────────────────────
    const home = path.join(base, 'home'), shimDir = path.join(base, 'npm'), exeDir = path.join(base, 'winget');
    for (const dd of [home, shimDir, exeDir]) fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(shimDir, 'claude'), '#!/bin/sh\n'); fs.writeFileSync(path.join(shimDir, 'claude.cmd'), '@echo off\r\n');
    const winEnv = PATH => ({ PATH, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
    const wopts = PATH => ({ platform: 'win32', env: winEnv(PATH), home });
    if (WIN) {
      fs.writeFileSync(path.join(exeDir, 'claude.exe'), '');
      const got = exe.resolve('claude', null, wopts([shimDir, exeDir].join(';')));
      R.check('[RN-09] shim 폴더가 PATH 앞이어도 .exe 를 고른다', got === path.resolve(exeDir, 'claude.exe'), got);
      let e1 = null; try { exe.resolve('claude', null, wopts(shimDir)); } catch (e) { e1 = e; }
      R.check('[RN-09] shim·.cmd 만 있으면 EXE_NOT_FOUND(확장자 없는 파일을 돌려주지 않는다)', e1 && e1.code === 'EXE_NOT_FOUND', String(e1 && e1.message));
      let e2 = null; try { exe.resolve('claude', path.join(shimDir, 'claude'), wopts('')); } catch (e) { e2 = e; }
      R.check('[RN-09] 강제 경로도 확장자 없는 파일이면 EXE_NOT_RUNNABLE', e2 && e2.code === 'EXE_NOT_RUNNABLE', String(e2 && e2.message));
      const envForced = exe.resolve('claude', null, { platform: 'win32', env: { ...winEnv(shimDir), HARNESS_CLAUDE_EXE: path.join(exeDir, 'claude.exe') }, home });
      R.check('[RN-09] HARNESS_CLAUDE_EXE 를 따른다', envForced === path.resolve(exeDir, 'claude.exe'), envForced);
      let e3 = null; try { exe.resolve('codex', null, { platform: 'win32', env: { ...winEnv(''), HARNESS_CODEX_EXE: path.join(shimDir, 'claude.cmd') }, home }); } catch (e) { e3 = e; }
      R.check('[RN-09] HARNESS_CODEX_EXE 가 .cmd 면 거부', e3 && e3.code === 'EXE_NOT_RUNNABLE', String(e3 && e3.message));
      // Codex 번들: VS Code 확장(버전 숫자 비교) → 데스크톱 앱.
      for (const v of ['9.9.1', '10.0.2']) { const dd = path.join(home, '.vscode', 'extensions', `openai.chatgpt-${v}-win32-x64`, 'bin', 'windows-x86_64'); fs.mkdirSync(dd, { recursive: true }); fs.writeFileSync(path.join(dd, 'codex.exe'), ''); fs.writeFileSync(path.join(dd, 'codex'), ''); }
      const desk = path.join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin', 'abc123'); fs.mkdirSync(desk, { recursive: true }); fs.writeFileSync(path.join(desk, 'codex.exe'), '');
      const cands = exe.candidates('codex', wopts(''));
      R.check('[RN-09] Codex: 가장 새 VS Code 확장(10.0.2 > 9.9.1) → 데스크톱 번들 순, 모두 .exe',
        /openai\.chatgpt-10\.0\.2/.test(cands[0] || '') && /9\.9\.1/.test(cands[1] || '') && /abc123/.test(cands[2] || '') && cands.every(x => /\.exe$/i.test(x)), JSON.stringify(cands));
      const npmExe = path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'); fs.mkdirSync(npmExe, { recursive: true }); fs.writeFileSync(path.join(npmExe, 'claude.exe'), '');
      const viaNpm = exe.resolve('claude', null, wopts(shimDir));
      R.check('[RN-09] Claude: PATH 에 shim 만 있으면 npm 패키지 안의 claude.exe 로', viaNpm === path.resolve(npmExe, 'claude.exe'), viaNpm);
    } else {
      R.check('[RN-09] (POSIX) 확장자 없는 실행 파일을 PATH 순서로', exe.candidates('claude', { env: { PATH: shimDir }, home })[0] === path.resolve(shimDir, 'claude'));
    }
    let e4 = null; try { exe.resolve('gemini'); } catch (e) { e4 = e; }
    R.check('[RN-09] 모르는 runtime → BAD_RUNTIME', e4 && e4.code === 'BAD_RUNTIME');

    // ── RN-10 파사드 ────────────────────────────────────────────────
    let e5 = null; try { await runner.run({ runtime: 'gpt', cwd, prompt: 'x' }); } catch (e) { e5 = e; }
    let e6 = null; try { await runner.run({ runtime: 'claude', cwd, prompt: '' }); } catch (e) { e6 = e; }
    R.check('[RN-10] 모르는 runtime · 빈 prompt 는 던진다', e5 && e5.code === 'BAD_RUNTIME' && e6 && e6.code === 'BAD_INPUT');
    R.check('[RN-10] claude 인자 빌더는 새·재개에서 같은 앞부분(권한·설정)을 쓴다',
      JSON.stringify(rc.buildArgs({}, 'S', SID).slice(0, 9)) === JSON.stringify(rc.buildArgs({ sessionId: RID }, 'S', null).slice(0, 9)));

    // ── RN-11 (H1) 세션 id 는 CLI 가 확인했을 때만 ─────────────────────
    r = await runner.run(fake('claude', 'crash', { newSessionId: SID }).o);
    R.check('[RN-11] (H1) 결과 JSON 없이 죽은 새 세션은 session_id 를 지어내지 않는다', r.error_kind === 'crash' && r.session_id === null && r.session_confirmed === false, JSON.stringify({ sid: r.session_id, c: r.session_confirmed }));
    r = await runner.run(fake('claude', 'model', { newSessionId: SID }).o);
    R.check('[RN-11] (H1) 결과 JSON 에 session_id 가 있으면 확인된 세션', r.error_kind === 'model' && r.session_id === SID && r.session_confirmed === true, JSON.stringify({ sid: r.session_id, c: r.session_confirmed }));
    r = await runner.run(fake('claude', 'crash', { sessionId: RID }).o);
    R.check('[RN-11] (H1) 재개 호출이 죽어도 기존 세션 id 는 그대로', r.session_id === RID, JSON.stringify(r.session_id));
    r = rx.toResult({ code: 1, stderr: 'boom', durationMs: 1 }, rx.makeParser().state(), {});
    const rxs = await runner.run(fake('codex', 'error-only').o);
    R.check('[RN-11] (H1) Codex: thread.started 없이 끝나면 확인되지 않은 세션 · 있으면 확인된 세션', r.session_confirmed === false && r.session_id === null && rxs.session_confirmed === true && !!rxs.session_id,
      JSON.stringify({ sid: r.session_id, c: r.session_confirmed, c2: rxs.session_confirmed }));

    // ── RN-12 (M8) 워커 환경은 git push 를 무력화한다 — 실제 push 로 확인 ──
    const dump = path.join(base, 'envdump.js');
    fs.writeFileSync(dump, `const fs=require('fs');if(process.argv[2]==='--version'){console.log('2.1.283 (Claude Code)');process.exit(0);}
const e={};for(const k of Object.keys(process.env))if(/^GIT_CONFIG_(COUNT|KEY_\\d+|VALUE_\\d+)$/.test(k))e[k]=process.env[k];
fs.writeFileSync(process.env.DUMP,JSON.stringify(e));process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',session_id:null,total_cost_usd:0}));});`);
    const envOf = async (runtime, extraEnv) => {
      const out = path.join(base, `dump-${++n}.json`);
      await runner.run({ runtime, cwd, prompt: 'x', exe: process.execPath, exePrefixArgs: [dump], env: { DUMP: out, ...(extraEnv || {}) }, timeoutMs: 30000 });
      return readJson(out) || {};
    };
    const cfgPairs = e => { const out = []; for (let i = 0; i < Number(e.GIT_CONFIG_COUNT || 0); i++) out.push(`${e['GIT_CONFIG_KEY_' + i]}=${e['GIT_CONFIG_VALUE_' + i]}`); return out; };
    const ce1 = await envOf('claude'), cx1 = await envOf('codex');
    R.check('[RN-12] (M8) Claude·Codex 워커 환경에 push.default=nothing · 모든 URL 의 pushInsteadOf 를 막는 설정',
      [ce1, cx1].every(e => cfgPairs(e).includes('push.default=nothing') && cfgPairs(e).some(p => /^url\..+\.pushinsteadof=https:\/\/$/i.test(p))), JSON.stringify([cfgPairs(ce1), cfgPairs(cx1)]));
    // [자동 이슈 #21] 빈 값 GIT_CONFIG_VALUE_n 은 Windows 에서 환경을 되돌리는 시험 픽스처가 지워 자식 git 을 128 로 만들었다
    R.check('[RN-12b] (#21) 워커 환경의 GIT_CONFIG_VALUE_n 에 빈 값이 없다', [ce1, cx1].every(e => Object.keys(e).filter(k => /^GIT_CONFIG_VALUE_\d+$/.test(k)).every(k => String(e[k]) !== '')), JSON.stringify(cfgPairs(ce1).filter(p => /=$/.test(p))));
    const ce2 = await envOf('claude', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
    R.check('[RN-12] (M8) 이미 있는 GIT_CONFIG_* 는 보존하고 뒤에 덧붙인다', cfgPairs(ce2)[0] === 'core.autocrlf=false' && cfgPairs(ce2).includes('push.default=nothing'), JSON.stringify(cfgPairs(ce2)));
    // 임시 폴더 안의 bare 원격에만 — 외부로 나가는 push 는 없다.
    const { spawnSync } = require('node:child_process');
    const gitIn = (dir, args, env) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(env || {}) } });
    const bare = path.join(base, 'remote.git'), work = path.join(base, 'pushwork');
    gitIn(base, ['init', '-q', '--bare', bare]); gitIn(base, ['init', '-q', '-b', 'main', work]);
    gitIn(work, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'one']);
    gitIn(work, ['remote', 'add', 'origin', bare]);
    const pushes = [['push', 'origin', 'main'], ['push', bare, 'main:other'], ['push', 'file:///' + bare.split(path.sep).join('/'), 'main:third']];
    const blocked = pushes.map(a => gitIn(work, a, ce1).status);
    const refsAfterBlocked = gitIn(bare, ['for-each-ref', '--format=%(refname)']).stdout.trim();
    const control = gitIn(work, ['push', '-q', 'origin', 'main']).status;
    R.check('[RN-12] (M8) 실제 git push(원격 이름 · 경로 · file://)가 워커 환경에서는 모두 실패하고 원격은 그대로', blocked.every(s => s !== 0) && refsAfterBlocked === '', JSON.stringify({ blocked, refsAfterBlocked }));
    R.check('[RN-12] (M8) 대조: 같은 push 가 워커 환경 없이는 성공한다(검사가 무의미하지 않다)', control === 0 && /refs\/heads\/main/.test(gitIn(bare, ['for-each-ref', '--format=%(refname)']).stdout), String(control));
    R.check('[RN-12] (M8) fetch 는 막지 않는다', gitIn(work, ['fetch', '-q', 'origin'], ce1).status === 0);

    // ── [2026-10-17 자동 보고 caed67b9a2f1] 작업자가 worktree 의 compose 로 사용자의 실행 중 컨테이너를 다시 만들었다(프로젝트 이름이 메인과 같았다).
    //    작업자 · 검사 프로세스에는 작업별 COMPOSE_PROJECT_NAME 을 준다(compose 에서 .env · name: 보다 앞선다). 메인 체크아웃에는 주지 않는다. ──
    {
      const wtc = path.join(base, 'iso', '.harness-worktrees', 't-20261017-000000-abcd');
      fs.mkdirSync(wtc, { recursive: true });
      const e1 = proc.noPushEnv({}, wtc), e2 = proc.noPushEnv({}, path.join(base, 'iso'));
      const r3 = await require('../../harness/lib/checks').runCheck(wtc, ['node', '-e', 'console.log("P=" + process.env.COMPOSE_PROJECT_NAME)'], { timeoutMs: 20000 });
      R.check('[RN-19] 작업자 · 검사 환경의 COMPOSE_PROJECT_NAME 은 작업별(harness-<id>) · 메인 체크아웃에는 없다',
        e1.COMPOSE_PROJECT_NAME === 'harness-t-20261017-000000-abcd' && e2.COMPOSE_PROJECT_NAME === undefined && /P=harness-t-20261017-000000-abcd/.test(r3.output), `${e1.COMPOSE_PROJECT_NAME} ${e2.COMPOSE_PROJECT_NAME} ${r3.output}`);
      const pr19 = require('../../harness/lib/prompts').taskPrompt({ id: 't-x', goal: 'g', checks: { commands: [] }, runtime: 'claude' });
      R.check('[RN-19] 작업자 지시: 메인 체크아웃의 실행 중인 서비스 · 컨테이너는 건드리지 않는다', /running services|containers/i.test(pr19) && /main checkout/i.test(pr19), pr19.slice(0, 1500));
    }

    // ── RN-18 워커 환경은 이 저장소의 ref 를 바꾸지 못한다 — 권한 규칙(경계 아님)을 `node -e` 로 우회해도 ──
    //   reference-transaction 훅(core.hooksPath 를 환경으로)이 prepared 단계에서 거부한다. 다른 저장소(테스트가 만드는 임시 저장소)는 그대로.
    const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
    const main18 = path.join(base, 'protect-main'), wt18 = path.join(base, 'protect-wt'), other18 = path.join(base, 'protect-other');
    gitIn(base, ['init', '-q', '-b', 'main', main18]); gitIn(main18, [...ID, 'commit', '-q', '--allow-empty', '-m', 'base']);
    gitIn(main18, ['worktree', 'add', '-q', '-b', 'harness/t-1', wt18]);
    gitIn(base, ['init', '-q', '-b', 'main', other18]);
    const we = proc.noPushEnv({}, wt18);
    const refs18 = () => gitIn(main18, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout;
    const before18 = refs18();
    const tries18 = [[wt18, [...ID, 'commit', '-q', '--allow-empty', '-m', 'w']], [main18, [...ID, 'commit', '-q', '--allow-empty', '-m', 'w']],
      [wt18, ['update-ref', 'refs/heads/main', 'HEAD~0']], [wt18, ['tag', 'x']], [wt18, ['branch', 'sneaky']], [wt18, ['-C', main18, ...ID, 'commit', '-q', '--allow-empty', '-m', 'w']]];
    const st18 = tries18.map(([d, a]) => gitIn(d, a, we));
    R.check('[RN-18] 워커 환경: 작업 worktree · 메인 체크아웃 어디서든 commit · update-ref · tag · branch 가 실패하고 ref 는 그대로',
      st18.every(r => r.status !== 0) && refs18() === before18 && st18.some(r => /harness/.test(r.stderr)), JSON.stringify(st18.map(r => [r.status, r.stderr.trim().slice(0, 120)])));
    R.check('[RN-18] 워커 환경: 읽기 전용 git(status · log)은 된다',
      gitIn(wt18, ['status', '--porcelain'], we).status === 0 && gitIn(wt18, ['log', '-1', '--format=%s'], we).stdout.trim() === 'base');
    R.check('[RN-18] 워커 환경: 다른 저장소(테스트의 임시 저장소)의 커밋은 된다', gitIn(other18, [...ID, 'commit', '-q', '--allow-empty', '-m', 'ok'], we).status === 0);
    R.check('[RN-18] 대조: 하네스(워커 환경 없음)의 커밋은 된다', gitIn(wt18, [...ID, 'commit', '-q', '--allow-empty', '-m', 'harness'], {}).status === 0);

    // ── RN-13 (L4) 모델의 말로 quota/auth 를 가르지 않는다 ─────────────
    const tr = rc.toResult({ code: 1, stderr: '', stdout: '', durationMs: 1 }, { type: 'result', subtype: 'error_max_turns', is_error: false, session_id: SID,
      result: 'I fixed the rate limit handler; the 401 path now retries and the quota check is gone.' }, {}, SID, 'per_call');
    R.check('[RN-13] (L4) 작업 내용(result)의 "rate limit"·"401"·"quota" 는 분류에 쓰지 않는다 → model', tr.error_kind === 'model', tr.error_kind);
    const tq = rc.toResult({ code: 1, stderr: '', stdout: '', durationMs: 1 }, { type: 'result', subtype: 'success', is_error: true, session_id: SID, result: 'Claude AI usage limit reached|1760000000' }, {}, SID, 'per_call');
    R.check('[RN-13] (L4) API 오류가 결과 자리에 온 모양(is_error · success)은 여전히 quota', tq.error_kind === 'quota', tq.error_kind);
    // ── [2026-10-01] go --allow · worker_allow → worker --settings 의 permissions.allow 에 덧붙는다(deny 는 그대로 — deny 가 이긴다) ──
    f = fake('claude', 'ok', { allowRules: ['Bash(docker build:*)', 'Bash(cp:*)'] }); r = await runner.run(f.o); L = readJson(f.log);
    const sa = L && L.settings && L.settings.permissions;
    R.check('[RN-17] allowRules 는 --settings 의 allow 끝에 덧붙고 기본 허용 · deny 는 그대로', !!sa && sa.allow.includes('Bash(docker build:*)') && sa.allow.includes('Bash(cp:*)') && sa.allow.includes('Bash(node:*)')
      && JSON.stringify(sa.deny) === JSON.stringify(policy.claudeSettings([]).permissions.deny) && sa.deny.includes('Bash(git push:*)'), JSON.stringify(sa));
    const guarded = policy.claudeSettings(['node'], ['Bash(git push:*)', 'Bash(*)', 'Bash(bash:*)', 'Bash(docker build:*)']).permissions.allow;
    R.check('[RN-17] claudeSettings 는 금지 규칙을 다시 걸러 낸다(엔진을 거치지 않은 호출도)', guarded.includes('Bash(docker build:*)') && !guarded.some(x => /git push|\(\*\)|bash:/.test(x)), JSON.stringify(guarded));
    // ── --doc 명세 폴더는 worktree 밖(메인 체크아웃의 docs/)이라 Claude 워커에게 --add-dir 로 열어 준다 ──
    const rcArgs = require('../../harness/lib/runner-claude.js').buildArgs({ model: 'opus', addDirs: ['C:/r/docs/prds', 'C:/r/docs/designs'] }, 'S.json', 'u-1');
    const ai = rcArgs.indexOf('--add-dir');
    R.check('[RN-16] addDirs 는 --add-dir 로 넘기고 다음 인자는 옵션이다(가변 인자를 끊는다)', ai > 0 && rcArgs[ai + 1] === 'C:/r/docs/prds' && rcArgs.lastIndexOf('--add-dir') > ai && /^-/.test(rcArgs[rcArgs.lastIndexOf('--add-dir') + 2] || '-'), rcArgs.join(' '));
    // ── [2026-10-25 사용 분석] 작업 worktree 에서 돌면 하네스가 정해 준 임시 폴더(TEMP)를 --add-dir 로 연다 — acceptEdits 가 그 폴더의 Write 를 거부했다 ──
    const tmpBase0 = process.env.HARNESS_TMP_BASE; process.env.HARNESS_TMP_BASE = path.join(base, 'tmpbase');
    const wt27 = path.join(base, 'repo27', '.harness-worktrees', 't-20261025-000000-abcd'), tmp27 = require('../../harness/lib/resources.js').envFor(wt27).TEMP;
    const a27 = rc.buildArgs({ cwd: wt27 }, 'S.json', 'u-1'), o27 = rc.buildArgs({ cwd: path.join(base, 'plain') }, 'S.json', 'u-1');
    if (tmpBase0 === undefined) delete process.env.HARNESS_TMP_BASE; else process.env.HARNESS_TMP_BASE = tmpBase0;
    R.check('[RN-20] 작업 worktree 의 Claude 작업자는 그 작업의 임시 폴더를 --add-dir 로 받는다 · worktree 밖이면 없다', !!tmp27 && a27[a27.indexOf('--add-dir') + 1] === tmp27 && !o27.includes('--add-dir'), JSON.stringify({ tmp27, a27 }));
    // ── [2026-09-30 실측] Codex Windows 샌드박스 — elevated 가 준비 안 된 PC 에서 모든 쓰기·실행이 "apply deny-read ACLs" 로 실패했다 ──
    const cxArgs = o => rx.buildArgs({ cwd: 'W', ...o }).join(' ');
    R.check('[RN-14] Windows 에서는 기본으로 windows.sandbox="unelevated" 를 넘긴다', cxArgs({ platform: 'win32', env: {} }).includes('-c windows.sandbox="unelevated"'), cxArgs({ platform: 'win32', env: {} }));
    R.check('[RN-14] HARNESS_CODEX_WINDOWS_SANDBOX=inherit 이면 사용자 설정을 그대로 둔다', !cxArgs({ platform: 'win32', env: { HARNESS_CODEX_WINDOWS_SANDBOX: 'inherit' } }).includes('windows.sandbox'));
    R.check('[RN-14] Windows 가 아니면 넘기지 않는다', !cxArgs({ platform: 'linux', env: {} }).includes('windows.sandbox'));
    R.check('[RN-14] 재개에서도 옵션은 resume 앞에 온다', /windows\.sandbox="unelevated" --skip-git-repo-check resume T1 -$/.test(cxArgs({ platform: 'win32', env: {}, sessionId: 'T1' })), cxArgs({ platform: 'win32', env: {}, sessionId: 'T1' }));
    const sbp = rx.makeParser();
    for (const l of [
      { type: 'thread.started', thread_id: 'T9' },
      { type: 'item.completed', item: { type: 'file_change', status: 'failed', changes: [{ path: 'x', kind: 'add' }] } },
      { type: 'item.completed', item: { type: 'command_execution', status: 'failed', aggregated_output: 'Failed to create unified exec process: helper_unknown_error: apply deny-read ACLs failed' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'I could not create the file.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    ]) sbp.line(JSON.stringify(l));
    const sbr = rx.toResult({ code: 0, stderr: '', durationMs: 1 }, sbp.state(), { cwd: 'W' });
    R.check('[RN-15] 샌드박스가 도구 실행을 거부하면 턴이 끝났어도 error_kind=sandbox(판정하지 않는다)', sbr.is_error && sbr.error_kind === 'sandbox' && rx.SANDBOX_FAIL.test(sbr.error_message) && sbr.tool_failures.length === 2, JSON.stringify(sbr).slice(0, 300));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ }
  }
  R.done();
})();

'use strict';
// Claude Code 러너 — `claude -p` 한 번 = 한 턴(모델이 도구를 쓰며 끝낼 때까지).
//   claude -p --output-format json --permission-mode acceptEdits --settings <임시 파일> --setting-sources user
//          [--model M] [--effort E] [--max-budget-usd B] [--append-system-prompt S]
//          (--session-id <uuid> | --resume <id>)        프롬프트는 stdin(Windows 명령줄 32K 상한 회피).
//   [2.1.283 --help 대조] 위 플래그는 모두 설치본에 있다. `--append-system-prompt-file` 은 --help 에 없어 쓰지 않는다.
//   [조사 §5] `-p --resume` 은 권한 모드·--settings 를 복원하지 않는다 → 매 호출 다시 넘긴다(여기서는 새/재개 인자가 같다).
//   [조사 §7] --system-prompt-snapshot 기본 on — 재개 때 준 append 문구는 반영되지 않는다(넘겨도 해가 없다).
//   비용 — 재개 호출의 total_cost_usd 의 뜻이 **버전마다 다르다** [실측 2026-09-29 · haiku · 같은 프롬프트 두 번]:
//     2.1.248: 첫 호출 0.1130 → 재개 0.0289 (누계보다 작다 = 호출분, usage 도 호출분).
//     2.1.283: 첫 호출 0.0278 → 재개 0.0425. transcript 의 메시지별 usage 로 값을 매기면 재개분은 ≈0.0136 이고
//       0.0425 ≈ 0.0191+0.0136+부대비용(첫 호출과 같은 크기) → **세션 누계**(v4 주석과 일치).
//     그래서 costMode: 'per_call'(≤2.1.248) | 'cumulative'(그 밖 — 모르는 버전 포함). cumulative 인데 누계가 직전보다 작으면
//     모순이므로 호출분으로 읽는다. o.costMode 로 강제할 수 있고, r.cost_mode 로 무엇을 썼는지 돌려준다.
//     cost_usd = 이번 호출분 · session_cost_usd = 세션 누계.
//   --max-budget-usd 는 재개 호출에서도 **그 호출(프로세스)분**과 비교된다 — 세션 누계가 아니다 [실측 2026-09-30 · 2.1.283 · haiku]:
//     첫 호출 $0.2343(98K 입력) → 같은 세션을 --max-budget-usd 0.05 로 재개: success(1턴 $0.0111, 누계 $0.2454) →
//     다시 0.05 로 재개, Read 2회(3턴): success(호출분 $0.0322, 누계 $0.2776) → 0.015(money() 로 $0.02)로 재개, 같은 3턴:
//     error_max_budget_usd "Reached maximum budget ($0.02)"(호출분 $0.0217). 누계와 비교했다면 셋 다 즉시 멈췄어야 한다.
//     그래서 엔진은 재개에도 "남은 예산" 만 넘긴다(priorSessionCostUsd 를 더하지 않는다).
//   쓰지 않는 것: --safe-mode · --bare(CLAUDE.md/AGENTS.md 는 작업 맥락이다) · bypassPermissions · --dangerously-skip-permissions.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnCapture, noPushEnv } = require('./proc');
const policy = require('./policy');
const exe = require('./exe');

// [2026-10-20 평가 실측] 구독의 세션 · 주간 한도 문구("You've hit your session limit · resets 3:20am (Asia/Seoul)")를 몰라 충돌로 분류했다
const QUOTA = /usage limit|usageLimitExceeded|rate.?limit|quota|purchase more credits|insufficient[_ ]credits|credit balance is too low|hit your (?:\w+ )?limit|(?:session|weekly|daily|opus) limit|limit reached|too many requests|\b429\b/i;
const AUTH = /not logged in|please run \/login|run \/login|invalid api key|invalid x-api-key|authentication[_ ](?:error|failed)|oauth token (?:has )?expired|token (?:has )?expired|unauthori[sz]ed|\b401\b|login required/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(n) { return String(Math.max(0.01, Math.round(Number(n) * 100) / 100)); }

// 인자 — 새 세션이면 --session-id, 재개면 --resume. settingsFile 은 호출자가 만든 임시 파일 경로.
function buildArgs(o, settingsFile, sessionIdForNew) {
  const a = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--settings', settingsFile, '--setting-sources', 'user'];
  if (o.model) a.push('--model', String(o.model));
  if (o.effort) a.push('--effort', String(o.effort));
  if (o.budgetUsd != null && Number(o.budgetUsd) > 0) a.push('--max-budget-usd', money(o.budgetUsd));
  if (o.systemAppend) a.push('--append-system-prompt', String(o.systemAppend));
  // 무인 실행: 묻는 도구는 아무도 답하지 않으므로 즉시 거부되게 한다(2.1.283 에 있음 · 2.1.248 에는 없음 → 호출자가 버전으로 켠다).
  if (o.promptsNone) a.push('--permission-prompts', 'none');
  for (const d of o.addDirs || []) a.push('--add-dir', String(d));   // 읽기용 추가 폴더(--doc 명세) — 다음 인자는 항상 '-' 로 시작해 가변 인자를 끊는다
  // [2026-10-25 사용 분석 · C++ 저장소] 하네스가 작업마다 정해 준 임시 폴더(TEMP)는 worktree 밖이라 acceptEdits 가 Write · Edit 를 거부했다 —
  //   guard 는 허용하고 "임시 파일은 이 폴더에" 라고 안내하면서, 작업자는 거기에 스크립트를 쓰다 막혀 우회했다(작업 58개 중 6번). 작업 폴더로 더한다.
  const tmp = o.cwd ? require('./resources').envFor(o.cwd).TEMP : null;
  if (tmp) a.push('--add-dir', tmp);
  if (o.sessionId) a.push('--resume', String(o.sessionId));
  else a.push('--session-id', sessionIdForNew);
  return a;
}

// stdout 에서 결과 객체 하나를 고른다 — 한 줄 JSON · (--verbose 면) 배열 · 앞에 잡음이 섞인 여러 줄 모두.
function parseResult(stdout) {
  const t = String(stdout || '').trim();
  const pick = x => x && typeof x === 'object' && !Array.isArray(x) && (x.type === 'result' || 'total_cost_usd' in x) ? x : null;
  try { const x = JSON.parse(t); const hit = Array.isArray(x) ? [...x].reverse().find(pick) : pick(x); if (hit) return hit; } catch { /* 여러 줄 */ }
  for (const l of t.split(/\r?\n/).reverse()) {
    const s = l.trim(); if (!s.startsWith('{')) continue;
    try { const x = pick(JSON.parse(s)); if (x) return x; } catch { /* JSON 아님 */ }
  }
  return null;
}

function tokensOf(u) {
  if (!u || typeof u !== 'object') return null;
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const output = u.output_tokens || 0;
  return { input, output, total: input + output };
}

function classify(text) { return QUOTA.test(text) ? 'quota' : AUTH.test(text) ? 'auth' : null; }

// 버전 → 재개 비용의 뜻. 실측 두 점(2.1.248 호출분 · 2.1.283 누계)만 안다 — 그 사이·이후·모름은 누계로 본다.
const LAST_PER_CALL = [2, 1, 248];
function cmpVer(a, b) { for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }
function costModeFor(version) { return version && cmpVer(version, LAST_PER_CALL) <= 0 ? 'per_call' : 'cumulative'; }

// total = 이번 결과의 total_cost_usd · prior = 직전 세션 누계(재개일 때만) → {cost, session, mode}
function costOf(total, prior, mode) {
  const round = x => Math.round(x * 1e9) / 1e9;
  if (total == null) return { cost: null, session: prior || null, mode };
  if (mode === 'cumulative' && total >= prior) return { cost: round(total - prior), session: round(total), mode };
  if (mode === 'cumulative') mode = 'per_call(contradiction)'; // 누계가 줄 수는 없다 — 호출분이다
  return { cost: round(total), session: round(prior + total), mode };
}

// 프로세스 결과 + 파싱된 결과 → r(설계 §3).
function toResult(p, j, o, sid, mode) {
  const stderrTail = String(p.stderr || '').slice(-2000);
  const total = j && typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
  const prior = o.sessionId ? Number(o.priorSessionCostUsd) || 0 : 0;
  const c = costOf(total, prior, o.sessionId ? (mode || 'cumulative') : 'per_call');
  // 세션 id 는 CLI 가 결과 JSON 으로 확인했을 때만 새 세션의 것이다(H1). 결과 없이 죽은 새 세션에 미리 정한 uuid 를 돌려주면
  //   엔진이 없는 세션을 저장하고 --resume 이 영구 실패한다. 재개 호출은 기존 id 를 그대로 돌려준다(확인은 아님).
  const confirmed = !!(j && j.session_id);
  const r = {
    ok: false, session_id: confirmed ? j.session_id : (o.sessionId || null), session_confirmed: confirmed, final_text: j ? String(j.result == null ? '' : j.result) : '',
    cost_usd: c.cost, session_cost_usd: c.session, cost_mode: c.mode,
    tokens: tokensOf(j && j.usage), exit_code: p.code, is_error: true, error_kind: null, error_message: null,
    permission_denials: j && Array.isArray(j.permission_denials) ? j.permission_denials : [],
    stderr_tail: stderrTail, subtype: j ? j.subtype || null : null, num_turns: j && j.num_turns != null ? j.num_turns : null,
    budget_exhausted: false, duration_ms: p.durationMs,
  };
  if (p.spawnError) { r.error_kind = 'crash'; r.error_message = `실행 실패: ${p.spawnError.message}`; return r; }
  if (p.timedOut) { r.error_kind = 'timeout'; r.error_message = `상한 시간(${o.timeoutMs}ms)에 프로세스 트리를 종료했다`; return r; }
  if (p.aborted) { r.error_kind = 'aborted'; r.error_message = '취소 신호로 프로세스 트리를 종료했다'; return r; }
  if (!j) {
    const said = (stderrTail || String(p.stdout || '').slice(-2000)).trim();
    r.error_kind = classify(said) || 'crash';
    r.error_message = (said || `결과 JSON 없이 종료(exit ${p.code})`).slice(0, 900);
    return r;
  }
  const isErr = !!j.is_error || (j.subtype && j.subtype !== 'success') || p.code !== 0;
  if (!isErr) { r.ok = true; r.is_error = false; return r; }
  const said = [typeof j.result === 'string' ? j.result : '', Array.isArray(j.errors) ? j.errors.join(' · ') : '', j.subtype || ''].filter(Boolean).join(' · ');
  r.budget_exhausted = /budget/i.test(String(j.subtype || '')) || j.terminal_reason === 'budget_exhausted';
  // 분류(L4): result 는 보통 모델의 마지막 말이다 — 작업 내용에 "rate limit"·"401" 이 흔하다. API 오류가 결과 자리에 오는 모양
  //   (is_error:true · subtype:'success' — 한도·인증 오류가 이렇게 온다)일 때만 result 를 보고, 그 밖에는 errors · subtype · stderr 만.
  const apiErrorAsResult = j.is_error === true && (!j.subtype || j.subtype === 'success') && typeof j.result === 'string';
  const evidence = [apiErrorAsResult ? j.result : '', Array.isArray(j.errors) ? j.errors.join(' · ') : '', j.subtype || '', stderrTail].filter(Boolean).join('\n');
  r.error_kind = classify(evidence) || 'model';
  r.error_message = (said || `exit ${p.code}`).slice(0, 900);
  return r;
}

// 강제 종료(stop · 세션 종료)된 작업자는 finally 에 닿지 못해 --settings 임시 파일이 남는다 — 주인이 죽은 것은 다음 실행이 치운다.
function sweepOrphanSettings(dir) {
  const d = dir || os.tmpdir();
  let names = []; try { names = fs.readdirSync(d); } catch { return []; }
  const gone = [];
  for (const n of names) {
    const m = /^harness-claude-settings-(\d+)-[0-9a-f]+\.json$/.exec(n);
    if (!m || require('./state').pidAlive(Number(m[1]))) continue;
    try { fs.rmSync(path.join(d, n), { force: true }); gone.push(n); } catch { /* 다음에 */ }
  }
  return gone;
}

async function run(o) {
  const sid = o.sessionId ? null : (o.newSessionId || crypto.randomUUID());
  if (sid && !UUID.test(sid)) throw Object.assign(new TypeError(`newSessionId 는 UUID 여야 한다: ${sid}`), { code: 'BAD_SESSION_ID' });
  sweepOrphanSettings();
  const settingsFile = path.join(os.tmpdir(), `harness-claude-settings-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`);
  let bin;
  try { bin = exe.resolve('claude', o.exe); }
  catch (e) { return toResult({ spawnError: e, code: null, stderr: '', stdout: '', durationMs: 0 }, null, o, sid); }
  // 재개일 때만 비용의 뜻이 필요하다 — 버전은 실행 파일마다 한 번 묻는다.
  const mode = !o.sessionId ? 'per_call' : o.costMode || costModeFor(exe.version(bin, o.exePrefixArgs, o.env));
  try {
    // allowRules: 사용자가 준 추가 허용(go --allow · worker_allow) — allow 끝에 덧붙고 deny 는 그대로다.
    fs.writeFileSync(settingsFile, JSON.stringify(policy.claudeSettings(o.allowCommands || [], o.allowRules || [], o.workerPermissions || 'strict'), null, 2));
    const ver = exe.version(bin, o.exePrefixArgs, o.env);
    const promptsNone = o.promptsNone != null ? o.promptsNone : !!(ver && cmpVer(ver, [2, 1, 283]) >= 0);
    const args = [...(o.exePrefixArgs || []), ...buildArgs({ ...o, promptsNone }, settingsFile, sid)];
    const p = await spawnCapture({ exe: bin, args, cwd: o.cwd, input: o.prompt, env: noPushEnv(o.env, o.cwd), timeoutMs: o.timeoutMs, signal: o.signal, reapTree: true });
    return toResult(p, parseResult(p.stdout), o, sid, mode);
  } finally {
    try { fs.rmSync(settingsFile, { force: true }); } catch { /* 임시 파일 — 남아도 결과와 무관 */ }
  }
}

module.exports = { sweepOrphanSettings, run, buildArgs, parseResult, toResult, classify, costOf, costModeFor, QUOTA, AUTH };

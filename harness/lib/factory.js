'use strict';
// 공장 총괄(PRD R4) — 요구 하나를 과제 카드로 나눠 여러 작업자에게 병렬로 맡기고, 통합 브랜치에 하나씩 합친다.
//   [2026-10-20 사용자 지시] 다중 에이전트를 관리 · 감독하고 코드가 엉키지 않게 한다.
//   총괄은 **프로그램**이다(상태 기계 · 대기열 · 예산 · 동시 실행 · 저장). 판단은 계획 에이전트만 정해진 JSON 으로 내고, 프로그램이 검사한다.
//   카드 하나 = 하네스 작업 하나(go — worktree · guard · 쓰기 소유권 · 검사 · 품질 규칙 · 자원 장부를 그대로 쓴다).
//   합류: 통합 브랜치(harness/factory/<fid>)에 하나씩 병합 → 매번 저장소 검사 → 실패 · 충돌이면 되돌리고(revert) 그 카드를 최신 통합 상태에서 다시.
//   사용자 브랜치는 건드리지 않는다 — 받아들이는 것은 사용자가 말한 뒤(factory accept).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const S = require('./state'), G = require('./git'), K = require('./checks');

const FID_RE = /^f-\d{8}-\d{6}-[0-9a-f]{4}$/;
const DEFAULTS = { jobs: 3, maxCards: 12, budgetUsd: 60, cardBudgetUsd: 15, planBudgetUsd: 3, maxAttempts: 2, planTimeoutMs: 20 * 60 * 1000 };

const newFid = () => S.newId().replace(/^t-/, 'f-');
function dirs(root, fid) {
  const P = S.paths(root), dir = path.join(P.harnessDir, 'factory', fid);
  return { P, dir, file: path.join(dir, 'run.json'), logFile: path.join(dir, 'log.jsonl'), planWt: path.join(P.worktreesDir, `${fid}-plan`), intWt: path.join(P.worktreesDir, `${fid}-int`), branch: `harness/factory/${fid}` };
}
const readRun = (root, fid) => S.readJson(dirs(root, fid).file, null);
function save(root, run) { run.updated_at = S.nowIso(); fs.mkdirSync(dirs(root, run.id).dir, { recursive: true }); S.writeJsonAtomic(dirs(root, run.id).file, run); }
function event(root, fid, e) { try { fs.appendFileSync(dirs(root, fid).logFile, JSON.stringify({ at: S.nowIso(), ...e }) + '\n'); } catch { /* 기록 실패가 실행을 막지 않는다 */ } }
function listRuns(root) {
  const d = path.join(S.paths(root).harnessDir, 'factory');
  let names = []; try { names = fs.readdirSync(d).filter(n => FID_RE.test(n)); } catch { return []; }
  return names.sort().map(n => readRun(root, n)).filter(Boolean);
}

// ── 계획 ────────────────────────────────────────────────────────────────────
function plannerPrompt(request, o) {
  return [
    'You are the PLANNER of a software factory. Many workers will implement your cards IN PARALLEL in separate git worktrees of this repository,',
    'and the harness merges the finished cards one at a time into an integration branch, running the repository\'s checks after each merge.',
    'Read the repository (code, tests, build files, conventions) as much as you need, then split the request into cards. Do not change any files.',
    '', '# Request', request, '',
    '# Rules for cards',
    `- At most ${o.maxCards} cards. Use fewer, larger cards when the work is tightly coupled; never split one change across cards just to have more.`,
    '- Each card has "owns": the ONLY paths it may change (globs relative to the repository root, e.g. "src/billing/**", "tests/billing/test_invoice.py").',
    '  Cards that may run at the same time must not own the same files. Shared files (registrations, routing tables, project files, changelogs) belong to exactly one card.',
    '- "depends_on": cards whose merged result this card needs (it starts from the integration branch after they are merged). No cycles.',
    '- "goal": complete instructions for the worker, in the language of the request — what to build or fix, the acceptance criteria, and the interfaces it must provide or use.',
    '  Workers see only their own card, the overall request and the contracts below, so every interface between cards must be written in "contracts".',
    '- "risk": 1 (trivial) to 5 (hard or risky).',
    '- Include tests in the card that changes the behaviour (the test files must be in that card\'s "owns").',
    '', 'Reply with ONLY one JSON object, no prose, in this shape:',
    '{"contracts":"<interfaces, names, data shapes and conventions every card must follow>","cards":[{"id":"c1","title":"<short>","goal":"<instructions>","owns":["<glob>"],"depends_on":[],"risk":2}]}',
  ].join('\n');
}
function parsePlan(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
// 글자 접두(glob 앞의 고정 부분) — 두 소유 경로가 겹칠 수 있는지 보수적으로 본다
const prefixOf = g => String(g).replace(/\\/g, '/').replace(/^\.\//, '').split(/[*?[{]/)[0].replace(/\/+$/, '');
const overlaps = (a, b) => a.some(x => b.some(y => { const p = prefixOf(x), q = prefixOf(y); return !p || !q || p === q || p.startsWith(q + '/') || q.startsWith(p + '/'); }));
// 계획 검사 — 문제 목록(비면 통과). 겹치는 소유 경로는 의존을 더해 차례로 돌게 고친다(오류가 아니라 직렬화).
function validatePlan(plan, o) {
  const errs = [];
  if (!plan || !Array.isArray(plan.cards)) return { errs: ['the reply is not a JSON object with a "cards" array'] };
  const cards = plan.cards;
  if (!cards.length) errs.push('no cards');
  if (cards.length > o.maxCards) errs.push(`too many cards (${cards.length} > ${o.maxCards})`);
  const ids = new Set();
  for (const c of cards) {
    if (!c || typeof c !== 'object') { errs.push('a card is not an object'); continue; }
    if (!/^[A-Za-z0-9][\w-]{0,31}$/.test(String(c.id || ''))) errs.push(`card id ${JSON.stringify(c.id)} must be short letters/digits/-`);
    if (ids.has(c.id)) errs.push(`duplicate card id ${c.id}`); ids.add(c.id);
    if (typeof c.goal !== 'string' || c.goal.trim().length < 10) errs.push(`card ${c.id}: "goal" must be the worker's full instructions`);
    if (!Array.isArray(c.owns) || !c.owns.length) errs.push(`card ${c.id}: "owns" must list the paths it may change`);
    else for (const g of c.owns) if (typeof g !== 'string' || /^([a-zA-Z]:|\/)|(^|\/)\.\.(\/|$)/.test(g)) errs.push(`card ${c.id}: owns ${JSON.stringify(g)} must be a relative path inside the repository`);
    c.depends_on = Array.isArray(c.depends_on) ? c.depends_on.map(String) : [];
  }
  for (const c of cards) for (const d of c.depends_on) if (!ids.has(d)) errs.push(`card ${c.id} depends on unknown card ${d}`);
  if (errs.length) return { errs };
  // 순환 검사
  const byId = new Map(cards.map(c => [c.id, c])), state = new Map();
  const visit = id => { if (state.get(id) === 1) return true; if (state.get(id) === 2) return false; state.set(id, 1); for (const d of byId.get(id).depends_on) if (visit(d)) return true; state.set(id, 2); return false; };
  for (const c of cards) if (visit(c.id)) { errs.push(`dependency cycle through card ${c.id}`); break; }
  if (errs.length) return { errs };
  // 겹치는 소유 경로 → 앞 카드에 의존을 더해 직렬화(이미 의존 경로가 있으면 그대로)
  const reach = (from, to, seen = new Set()) => from === to || (!seen.has(from) && (seen.add(from), byId.get(from).depends_on.some(d => reach(d, to, seen))));
  const serialized = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    if (overlaps(a.owns, b.owns) && !reach(a.id, b.id) && !reach(b.id, a.id)) { b.depends_on.push(a.id); serialized.push(`${b.id} after ${a.id}`); }
  }
  return { errs: [], serialized };
}

// ── 합류(통합 브랜치에 하나씩) ────────────────────────────────────────────────
// [2026-10-25 사용 분석 · C++ 저장소] 실패한 검사는 go · accept 처럼 한 번 더 돌린다 — 불안정한 시험 하나(1 failing)로 카드를 되돌리고
//   처음부터 다시 돌렸다(재시도 10번 중 8번 · 카드 한 번에 수십 분 · 수 달러). 프로젝트 블록 rerun_failed: off 면 다시 돌리지 않는다.
async function runChecks(c) {
  if (!c.commands.length) return null;
  const rerun = !/^(off|false|no)$/i.test(K.yamlString(c.root, 'rerun_failed') || '');
  const judged = (await K.runJudged(c.intWt, c.commands, { timeoutMs: c.checkTimeoutMs, rerun })).judged;
  restoreTracked(c);
  return judged;
}
// [자동 이슈 #51] 검사가 추적 파일(산출물 · 스냅숏)을 다시 쓰면 통합 worktree 가 더러워져 다음 병합 · 되돌림(revert)이 실패했고,
//   카드를 처음부터 다시 돌렸다. 통합 worktree 는 하네스만 쓰므로 검사 뒤 추적 파일 변경을 HEAD 로 되돌린다(추적 안 된 · 무시된 파일은 그대로).
function restoreTracked(c) {
  const files = G.dirtyFiles(c.intWt).filter(e => e.code !== '??').map(e => e.path);
  if (!files.length) return;
  G.git(c.intWt, ['checkout', '-q', 'HEAD', '--', '.'], { allowFail: true });
  event(c.root, c.run.id, { event: 'restored_after_checks', files: files.slice(0, 20) });
}
async function mergeCard(c, card, task) {
  if (c.baselineP) await c.baselineP;   // 통합 worktree 에서 기준선 검사가 끝난 뒤에만 합친다
  const { root, run } = c, msg = `factory ${run.id}: ${card.id} — ${String(card.title || '').slice(0, 72)}`;
  const m = G.git(c.intWt, [...G.identityArgs(c.intWt), 'merge', '--no-ff', '--no-verify', '-m', msg, task.branch], { allowFail: true });
  if (!m.ok) {
    const conflict = G.mergeInProgress(c.intWt);
    if (conflict) G.git(c.intWt, ['merge', '--abort'], { allowFail: true });
    return { ok: false, why: conflict ? `merge conflict with cards already merged: ${(m.out + ' ' + m.err).trim().split('\n').filter(l => /CONFLICT/.test(l)).join(' ').slice(0, 300)}` : `merge failed: ${m.err.trim().slice(0, 300)}`, conflict };
  }
  const after = await runChecks(c);
  if (after) {
    const j = K.judge(after, c.baseline);
    if (j.verdict === 'fail') {
      G.git(c.intWt, [...G.identityArgs(c.intWt), 'revert', '-m', '1', '--no-edit', 'HEAD'], { allowFail: true });
      return { ok: false, why: `checks fail after merging into the integration branch (${j.why})`, excerpt: K.failureExcerpt(after).slice(0, 1500) };
    }
  }
  return { ok: true, commit: G.headSha(c.intWt) };
}

// ── 카드 하나: 작업 → 합류 ───────────────────────────────────────────────────
function cardGoal(c, card) {
  const run = c.run, merged = run.cards.filter(x => x.status === 'merged');
  return [card.goal, '', '---',
    `Context — factory run ${run.id}, card ${card.id} of ${run.cards.length} ("${card.title || card.id}"). This card is one part of a larger request; other cards are being implemented in parallel by other workers, so stay inside your card.`,
    `Overall request: ${String(run.request).slice(0, 1500)}`,
    ...(run.plan && run.plan.contracts ? [`Contracts every card follows: ${String(run.plan.contracts).slice(0, 3000)}`] : []),
    ...(merged.length ? [`Already merged into the code you start from: ${merged.map(x => `${x.id} (${x.title || ''})`).join(', ')}.`] : []),
    ...(card.retry_note ? [`A previous attempt of this card could not be merged: ${card.retry_note}`] : [])].join('\n');
}
async function runCard(c, card) {
  const { root, run, o } = c;
  card.status = 'running'; card.attempts = (card.attempts || 0) + 1; card.started_at = S.nowIso(); save(root, run);
  event(root, run.id, { event: 'card_start', card: card.id, attempt: card.attempts });
  let res;
  try {
    res = await require('./loop').go({ root, goal: cardGoal(c, card), base: c.branch, owns: card.owns, run: o.run, runtime: o.runtime, mode: o.mode, model: o.model,
      budgetUsd: Math.min(o.cardBudgetUsd, Math.max(1, o.budgetUsd - spent(c))), wallMin: o.cardWallMin, log: o.log || (() => {}), checks: o.checks, factory: { run: run.id, card: card.id } });
  } catch (e) { res = { status: 'error', reason: e.message }; }
  card.task_ids = [...(card.task_ids || []), res.id].filter(Boolean);
  if (res.status !== 'done') { card.status = 'failed'; card.reason = `task ${res.id || ''} ended ${res.status}: ${String(res.reason || '').slice(0, 300)}`; save(root, run); event(root, run.id, { event: 'card_failed', card: card.id, task: res.id, status: res.status }); return; }
  // 합류는 한 번에 하나
  const release = await c.mergeLock();
  try {
    const task = S.readTask(root, res.id);
    card.status = 'merging'; save(root, run);
    const m = await mergeCard(c, card, task);
    if (m.ok) { card.status = 'merged'; card.merge_commit = m.commit; card.reason = null; event(root, run.id, { event: 'card_merged', card: card.id, task: res.id, commit: m.commit }); }
    else if (card.attempts < o.maxAttempts) { card.status = 'pending'; card.retry_note = `${m.why}${m.excerpt ? `\n${m.excerpt}` : ''}`.slice(0, 2000); event(root, run.id, { event: 'card_retry', card: card.id, why: m.why }); }
    else { card.status = 'failed'; card.reason = m.why; event(root, run.id, { event: 'card_failed', card: card.id, why: m.why }); }
    save(root, run);
  } finally { release(); }
}
async function schedule(c) {
  const { root, run, o, log } = c, fid = run.id;
  const running = new Map();
  for (;;) {
    const now = readRun(root, fid) || run;
    if (now.stop_requested && !run.stop_requested) { run.stop_requested = now.stop_requested; log(`[pilot] factory ${fid} — stop requested: no new cards`); }
    const byId = new Map(run.cards.map(x => [x.id, x]));
    for (const card of run.cards) if (card.status === 'pending' && card.depends_on.some(d => ['failed', 'skipped'].includes(byId.get(d).status))) { card.status = 'skipped'; card.reason = 'a card it depends on was not merged'; }
    const over = spent(c) >= o.budgetUsd;
    if (over || run.stop_requested) for (const card of run.cards) if (card.status === 'pending') { card.status = 'skipped'; card.reason = over ? `budget ${o.budgetUsd} reached` : 'stopped'; }
    const ready = run.cards.filter(x => x.status === 'pending' && !running.has(x.id) && x.depends_on.every(d => byId.get(d).status === 'merged'));
    while (running.size < o.jobs && ready.length) {
      const card = ready.shift();
      running.set(card.id, runCard(c, card).finally(() => running.delete(card.id)));
    }
    save(root, run);
    if (!running.size) break;
    await Promise.race(running.values());
  }
}
function spent(c) {
  let sum = c.run.plan_cost_usd || 0;
  for (const card of c.run.cards) for (const id of card.task_ids || []) { const t = S.readTask(c.root, id); if (t && t.spent) sum += t.spent.cost_usd || 0; }
  const v = c.run.verify;
  if (v) { sum += v.cost_usd || 0; for (const id of v.task_ids || []) { const t = S.readTask(c.root, id); if (t && t.spent) sum += t.spent.cost_usd || 0; } }
  return sum;
}
function mutex() {
  let tail = Promise.resolve();
  return () => { let release; const next = new Promise(r => { release = r; }); const wait = tail; tail = tail.then(() => next); return wait.then(() => release); };
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
// o: { root, request, fid?, run(runner), jobs, budgetUsd, cardBudgetUsd, maxCards, maxAttempts, model, runtime, checks, log }
async function start(o0) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(o0).filter(([, v]) => v != null)) };
  const root = S.mainRoot(o.root || process.cwd());
  const log = o.log || (m => process.stderr.write(m + '\n'));
  o.run = require('./loop').getRun(o);
  const fid = o.fid || newFid(), D = dirs(root, fid);
  const base = o.base || G.currentBranch(root) || 'HEAD', baseCommit = G.headSha(root, base);
  if (!baseCommit) throw Object.assign(new Error(`cannot resolve the base ${base}`), { code: 'USAGE' });
  const run = { id: fid, request: String(o.request || '').trim(), status: 'running', stage: 'plan', base_branch: base, base_commit: baseCommit, branch: D.branch,
    jobs: o.jobs, budget_usd: o.budgetUsd, created_at: S.nowIso(), owner: S.ownerRecord(), cards: [], plan: null, plan_cost_usd: 0, language: /[가-힣]/.test(o.request || '') ? 'Korean' : null };
  if (!run.request) throw Object.assign(new Error('factory needs a request'), { code: 'USAGE' });
  save(root, run); event(root, fid, { event: 'created', base: base, base_commit: baseCommit });
  log(`[pilot] factory ${fid} — planning`);
  const c = { root, run, o, log, branch: D.branch, intWt: D.intWt, commands: [], baseline: null, mergeLock: mutex(), checkTimeoutMs: (K.yamlNumber(root, 'check_timeout_min') || 15) * 60000 };
  try {
    // 1) 계획 — 기준 커밋의 분리 worktree 에서(작업자 권한은 읽기 전용 목록)
    G.git(root, ['worktree', 'add', '--detach', '-f', D.planWt, baseCommit], { retryLock: true });
    let plan = null, problems = [];
    try {
      for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
        const prompt = plannerPrompt(run.request, o) + (problems.length ? `\n\nYour previous plan was rejected:\n- ${problems.join('\n- ')}\nFix these and reply with the whole JSON again.` : '');
        const r = await o.run({ runtime: o.runtime || 'claude', cwd: D.planWt, prompt, newSessionId: crypto.randomUUID(), model: o.model || ((o.runtime || 'claude') === 'claude' ? 'opus' : null), budgetUsd: o.planBudgetUsd, timeoutMs: o.planTimeoutMs,
          allowCommands: [], allowRules: [], workerPermissions: 'strict', systemAppend: '' });
        run.plan_cost_usd += Number(r && r.cost_usd) || 0;
        const p = parsePlan(r && r.final_text), v = validatePlan(p, o);
        if (!v.errs.length) { plan = p; run.serialized = v.serialized; } else problems = v.errs;
        // 러너 오류(모델 이름 · 인증 · 한도)는 "JSON 이 아니다" 로 가려지지 않게 기록 · 보고한다
        if (r && r.is_error) problems = [`the planner session failed (${r.error_kind || 'error'}): ${String(r.error_message || r.stderr_tail || '').replace(/\s+/g, ' ').slice(0, 300)}`, ...problems];
        event(root, fid, { event: 'plan', attempt, ok: !v.errs.length, problems, cost_usd: r && r.cost_usd, error: r && r.is_error ? (r.error_kind || 'error') : undefined });
      }
    } finally { G.removeWorktree(root, D.planWt); G.removeEmptyDir(D.planWt); }
    if (!plan) { run.status = 'error'; run.reason = `the planner did not produce a valid plan: ${problems.join('; ').slice(0, 500)}`; return finish(c, log); }
    run.plan = { contracts: plan.contracts || '' };
    run.cards = plan.cards.map(x => ({ id: x.id, title: x.title || x.id, goal: x.goal, owns: x.owns, depends_on: x.depends_on, risk: x.risk || null, status: 'pending', attempts: 0 }));
    run.stage = 'build'; save(root, run);
    log(`[pilot] factory ${fid} — ${run.cards.length} cards${(run.serialized || []).length ? ` (serialized: ${run.serialized.join(', ')})` : ''} · jobs ${o.jobs}`);
    // 2) 통합 브랜치 · worktree · 기준선 검사
    G.git(root, ['branch', '-f', D.branch, baseCommit]);
    G.git(root, ['worktree', 'add', '-f', D.intWt, D.branch], { retryLock: true });
    c.commands = K.discover(D.intWt, o.checks, root).commands || [];
    // 통합 기준선은 카드 작업과 동시에 잰다 — 첫 합류만 그것을 기다린다(예전엔 전체 검사가 끝날 때까지 카드가 시작하지 않았다)
    c.baselineP = runChecks(c).then(b => { c.baseline = b; if (b) event(root, fid, { event: 'baseline', ok: b.ok, pass: b.pass, fail: b.fail }); return b; });
    // 3) 카드 일정 — 의존이 모두 합쳐진 카드를 동시 상한까지
    await schedule(c);
    // 4) 검증 라인(PRD R6) — 합쳐진 결과를 여러 시험 에이전트가 나눠 시험 · 재현된 결함은 수정 카드로 같은 합류 대기열에
    // 시험 웨이브(모델이 찾고 모델이 확인)는 --verify 일 때만 — thin 원칙: 하네스는 판정자로 나서지 않는다(효과를 평가로 보이기 전까지)
    if (o.verify === true && run.cards.some(x => x.status === 'merged') && !run.stop_requested) {
      run.stage = 'verify'; save(root, run);
      await require('./verify').run(c, { schedule: () => schedule(c), save: () => save(root, run), event: e => event(root, fid, e), spent: () => spent(c) });
    }
    const merged = run.cards.filter(x => x.status === 'merged').length;
    const openDefects = (run.verify && run.verify.findings || []).filter(x => x.status === 'confirmed' && !(run.cards.find(k => k.id === x.fix_card) || {}).merge_commit).length;
    run.status = merged === run.cards.length && !openDefects ? 'done' : merged ? 'partial' : 'failed';
    run.reason = `${merged}/${run.cards.length} cards merged into ${D.branch}`;
  } catch (e) { run.status = 'error'; run.reason = `${e.code ? e.code + ': ' : ''}${e.message}`; event(root, fid, { event: 'error', message: e.message }); }
  return finish(c, log);
}
function finish(c, log) {
  const { root, run } = c, D = dirs(root, run.id);
  try { if (fs.existsSync(D.intWt)) { G.removeWorktree(root, D.intWt); G.removeEmptyDir(D.intWt); } } catch { /* 남으면 gc 가 */ }
  run.head = G.branchExists(root, D.branch) ? G.headSha(root, D.branch) : null;
  run.spent_usd = Math.round(spent(c) * 100) / 100;
  run.stage = 'done'; run.finished_at = S.nowIso(); save(root, run);
  event(root, run.id, { event: 'end', status: run.status, reason: run.reason, spent_usd: run.spent_usd });
  log(`[pilot] factory ${run.id} — ${run.status}`);
  return { id: run.id, status: run.status, reason: run.reason, report: report(root, run) };
}

// ── 보고 · 상태 · 멈춤 ───────────────────────────────────────────────────────
function report(root, run) {
  const ko = run.language === 'Korean', cli = 'node harness/cli.js';
  const L = [`pilot factory ${run.id} — ${String(run.status).toUpperCase()}${deadMark(run)}`, `${ko ? '이유' : 'why'}: ${run.reason || ''}`,
    `${ko ? '요구' : 'request'}: ${String(run.request).replace(/\s+/g, ' ').slice(0, 200)}`,
    `${ko ? '통합 브랜치' : 'integration branch'}: ${run.branch}${run.head ? ` @ ${run.head.slice(0, 10)}` : ''} (${ko ? '기준' : 'from'} ${run.base_branch} @ ${String(run.base_commit).slice(0, 10)}) — ${ko ? '사용자 브랜치는 그대로다' : 'your branch is unchanged'}`,
    `${ko ? '비용' : 'cost'}: $${run.spent_usd != null ? run.spent_usd : '?'} / ${ko ? '상한' : 'budget'} $${run.budget_usd} · ${ko ? '동시' : 'jobs'} ${run.jobs}`,
    `${ko ? '카드' : 'cards'} (${run.cards.length}):`];
  for (const x of run.cards) L.push(`  ${x.id} ${x.status.toUpperCase()}${x.task_ids && x.task_ids.length ? ` [${x.task_ids.join(', ')}]` : ''} — ${x.title}${x.depends_on.length ? ` (${ko ? '의존' : 'after'} ${x.depends_on.join(', ')})` : ''}${x.reason ? ` · ${x.reason.split('\n')[0].slice(0, 160)}` : ''}`);
  if (run.verify) L.push(...require('./verify').reportLines(run, ko));
  if ((run.serialized || []).length) L.push(`${ko ? '소유 경로가 겹쳐 차례로 돌린 카드' : 'serialized (overlapping owned paths)'}: ${run.serialized.join(', ')}`);
  // 카드 작업들의 결정 분기점을 한곳에 — 사용자가 다르게 하려면 그 작업을 resume --note 로
  const decisions = [];
  for (const x of run.cards) for (const id of x.task_ids || []) { const t = S.readTask(root, id); for (const d of (t && t.decisions) || []) decisions.push(`  ${x.id}/${id}: ${d.title}`); }
  if (decisions.length) L.push(`${ko ? '결정 분기점' : 'decision points'} (${decisions.length}):`, ...decisions.slice(0, 30));
  if (run.status === 'done' || run.status === 'partial') L.push(`${ko ? '다음' : 'next'}: ${ko ? '통합 브랜치를 확인한 뒤 받아들이기(사용자가 말한 뒤)' : 'review the integration branch, then accept it (only after the user says so)'}: git log ${run.branch} · ${cli} factory accept ${run.id}`);
  return L.join('\n');
}
// [2026-10-25 사용 분석 · C++ 저장소] 프로세스가 죽은 실행이 RUNNING 으로 남아(20개 중 11개) 무엇이 실제로 도는지 알 수 없었다 — go 의 status 처럼 OWNER DEAD 를 붙인다.
const deadMark = r => r.status === 'running' && r.owner && !S.ownerAlive(r.owner) ? ' · OWNER DEAD' : '';
function status(root) {
  return listRuns(root).map(r => `${r.id} ${String(r.status).toUpperCase()}${deadMark(r)} stage ${r.stage} · ${r.cards.filter(x => x.status === 'merged').length}/${r.cards.length} merged · $${r.spent_usd != null ? r.spent_usd : '?'} — ${String(r.request).replace(/\s+/g, ' ').slice(0, 80)}`).join('\n') || 'no factory runs';
}
function requestStop(root, fid) {
  const r = readRun(root, fid);
  if (!r) throw Object.assign(new Error(`unknown factory run: ${fid}`), { code: 'UNKNOWN_TASK' });
  if (r.status !== 'running') return { id: fid, status: r.status, reason: 'not running' };
  r.stop_requested = S.nowIso(); save(root, r);
  return { id: fid, status: 'running', reason: 'stop requested — running cards finish, no new cards start' };
}

// factory accept <fid> — 통합 브랜치를 사용자 브랜치(실행을 시작한 기준 브랜치)에 병합한다. 사용자가 말한 뒤에만 부른다(AGENTS.md).
//   메인 체크아웃이 그 브랜치에 있어야 하고, 병합이 바꿀 파일에 미커밋 변경이 있으면 거부한다(다른 세션 · 사람의 변경을 덮지 않는다).
function accept(o) {
  const root = S.mainRoot(o.root || process.cwd()), run = readRun(root, o.fid);
  if (!run) throw Object.assign(new Error(`unknown factory run: ${o.fid}`), { code: 'UNKNOWN_TASK' });
  const refused = why => ({ id: run.id, status: run.status, refused: true, reason: why, report: `pilot factory ${run.id} — REFUSED: ${why}` });
  if (run.accepted_at) return refused(`already accepted at ${run.accepted_at} (${String(run.merge_commit || '').slice(0, 10)})`);
  if (!['done', 'partial'].includes(run.status)) return refused(`the run is ${run.status} — nothing to accept`);
  if (!G.branchExists(root, run.branch)) return refused(`the integration branch ${run.branch} is gone`);
  const cur = G.currentBranch(root);
  if (cur !== run.base_branch) return refused(`the main checkout is on ${cur || 'a detached HEAD'} — switch it to ${run.base_branch} first`);
  const changing = new Set(G.diffNames(root, run.base_commit, run.branch).map(f => f.replace(/\\/g, '/')));
  const dirty = G.dirtyFiles(root).map(e => String(e.path).replace(/\\/g, '/')).filter(f => changing.has(f));
  if (dirty.length) return refused(`uncommitted changes in files the merge would change: ${dirty.slice(0, 8).join(', ')} — commit or move them first`);
  const msg = `factory ${run.id}: ${String(run.request).replace(/\s+/g, ' ').slice(0, 72)}`;
  const m = G.git(root, [...G.identityArgs(root), 'merge', '--no-ff', '--no-verify', '-m', msg, run.branch], { allowFail: true });
  if (!m.ok) {
    if (G.mergeInProgress(root)) G.git(root, ['merge', '--abort'], { allowFail: true });
    return refused(`merge failed (nothing changed): ${(m.out + ' ' + m.err).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
  }
  run.accepted_at = S.nowIso(); run.merge_commit = G.headSha(root); run.status = 'accepted'; save(root, run);
  event(root, run.id, { event: 'accepted', merge_commit: run.merge_commit, into: cur });
  return { id: run.id, status: 'accepted', reason: `merged ${run.branch} into ${cur}`, report: `pilot factory ${run.id} — ACCEPTED: merged ${run.branch} into ${cur} @ ${run.merge_commit.slice(0, 10)}` };
}

module.exports = { start, accept, plannerPrompt, parsePlan, validatePlan, overlaps, report, status, requestStop, readRun, listRuns, dirs, FID_RE, DEFAULTS };

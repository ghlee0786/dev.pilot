'use strict';
// 묶음(batch) — 끝난 작업 브랜치 여럿을 harness/batch/<bid> 에 하나씩 합치고, 대상 브랜치의 검사를 **한 번** 돌린다. 사용자 브랜치는 건드리지 않는다.
//   [2026-10-25 증거 검토 · C++ 저장소] 카드마다 전체 검사 · 검사 잠금 폴링 · 실패하면 되돌리고 처음부터 → 작업 64개 · $313 에 병합 2건.
//   끝난 브랜치를 묶어 검사를 한 번 돌리자 1,187/0 · 32분. 충돌하는 것은 모델에게 풀게 하지 않고 건너뛴다(기록에 충돌 파일) — 나머지는 계속.
//   실패면 대상 끝에서 같은 검사를 재(기준선 캐시 공유) 원래부터 실패인지 가린다. 시간 초과뿐인 실패는 판정 불가(indeterminate).
//   batch accept 는 사용자가 말한 뒤에만 — 대상이 그새 움직였으면 거부한다(다시 batch). 기록: <git-common-dir>/harness/batches/<bid>.json
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const S = require('./state'), G = require('./git'), K = require('./checks'), I = require('./integrate'), St = require('./status');

const BID_RE = /^b-\d{8}-\d{6}-[0-9a-f]{4}$/;
const OK_VERDICTS = new Set(['pass', 'not-worse']);
const usage = msg => Object.assign(new Error(msg), { code: 'USAGE' });
const strip = b => String(b).replace(/^refs\/heads\//, '');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const newBid = () => S.newId().replace(/^t-/, 'b-');
const dirOf = root => path.join(S.paths(root).harnessDir, 'batches');
const fileOf = (root, bid) => path.join(dirOf(root), `${bid}.json`);
function readBatch(root, bid) { return BID_RE.test(String(bid || '')) ? S.readJson(fileOf(root, bid), null) : null; }
function saveBatch(root, b) { b.updated_at = S.nowIso(); S.writeJsonAtomic(fileOf(root, b.id), b); return b; }
function listBatches(root) {
  let names = []; try { names = fs.readdirSync(dirOf(root)); } catch { return []; }
  return names.filter(n => BID_RE.test(n.replace(/\.json$/, ''))).sort().map(n => S.readJson(path.join(dirOf(root), n), null)).filter(Boolean);
}
const needBid = bid => { if (!BID_RE.test(String(bid || ''))) throw usage(`expected a batch id b-yyyymmdd-HHMMss-xxxx, got ${JSON.stringify(String(bid || '')).slice(0, 80)}`); return bid; };
const VERDICT_KO = { pass: '통과', 'not-worse': '나빠지지 않음 — 대상 브랜치도 원래 같은 실패', fail: '실패 — 대상 브랜치보다 나빠졌다', indeterminate: '판정 불가 — 실패한 검사가 모두 시간 초과' };
// 묶을 수 있는 작업: done, 또는 열린 light 칸(받아들이거나 취소한 것 · 돌고 있는 것은 아니다)
const eligible = t => !!t && (t.status === 'done' || (t.mode === 'light' && t.status === 'open'));
const TASK_BRANCH_RE = /^harness\/(t-\d{8}-\d{6}-[0-9a-f]{4})$/;

// 구성원 고르기 — 명시한 id(맞지 않으면 아무것도 만들기 전에 거부) · --all(대상이 같은 묶을 수 있는 작업 전부) · --branch(작업 기록 없는 브랜치)
//   [2026-10-29 감사] --branch harness/<id> 로 칸을 묶으면 작업 기록 없는 브랜치로 다뤄 받아들인 뒤에도 작업이 open 으로 남았다(그 뒤 cancel 은
//   "병합 전에 버렸다" 고 했지만 변경은 사용자 브랜치에 그대로) — 작업 기록이 있으면 id 로 묶은 것과 같이 다룬다.
function pickMembers(root, target, o) {
  const out = [], seen = new Set();
  const add = m => { const k = m.id || `branch:${m.branch}`; if (!seen.has(k)) { seen.add(k); out.push(m); } };
  const addTask = id => {
    if (!S.validId(id)) throw usage(`invalid task id: ${JSON.stringify(String(id)).slice(0, 80)} (expected t-yyyymmdd-HHMMss-xxxx)`);
    const t = S.readTask(root, id);
    if (!t) throw Object.assign(new Error(`unknown task: ${id}`), { code: 'UNKNOWN_TASK' });
    if (!eligible(t)) throw usage(`task ${id} is ${t.status}${t.mode === 'light' ? ' (light)' : ''} — only done tasks and open light lanes can be bundled`);
    if (!G.branchExists(root, t.branch)) throw usage(`task ${id}: branch ${t.branch} does not exist`);
    add({ id, branch: t.branch, goal: clip(t.goal, 120) });
  };
  for (const id of o.ids || []) addTask(id);
  if (o.all) {
    for (const t of S.listTasks(root)) {
      if (!eligible(t) || !G.branchExists(root, t.branch) || I.acceptTarget(t, {}, root) !== target) continue;
      add({ id: t.id, branch: t.branch, goal: clip(t.goal, 120) });
    }
  }
  for (const b0 of o.branches || []) {
    const b = strip(b0), tm = TASK_BRANCH_RE.exec(b);
    if (tm && S.readTask(root, tm[1])) { addTask(tm[1]); continue; }
    if (!G.branchExists(root, b)) throw usage(`branch ${b} does not exist`);
    if (b === target) throw usage(`--branch ${b} is the target itself`);
    add({ id: null, branch: b, goal: null });
  }
  return out;
}

// 그 칸의 worktree 안에서 지금 일하는 산 대화형 세션 → 이유(문자열) 또는 null. accept · check · cancel 과 같은 규칙(integrate.js):
//   세션 파일의 root · cwd 가 그 worktree(안)이고 산 세션(플랫폼 목록 · 없으면 last_seen 30분)이면. 부른 쪽의 cwd 가 그 안이면 자기 자신이라 뺀다.
//   [2026-10-29 조율] 사람이 아직 고치는 칸을 묶으면 반쯤 된 일이 커밋돼 들어간다 — --all 은 특히. --force 면 보지 않는다.
const within = (p, dir) => { if (!p || !dir) return false; const Ch = require('../hooks/_common'); const rel = path.relative(Ch.real(dir), Ch.real(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
function liveSessionIn(root, wt) {
  const Ch = require('../hooks/_common');
  if (within(process.cwd(), wt)) return null;
  const common = S.paths(root).commonDir;
  const cand = Ch.listSessions(common).filter(s => within(s.root, wt) || within(s.cwd, wt));
  if (!cand.length) return null;   // 후보가 없으면 플랫폼에 묻지 않는다
  let agents = null; try { agents = Ch.platformAgents(common); } catch { agents = null; }
  const now = Date.now(), live = cand.filter(s => Ch.sessionLive(s, agents, now));
  if (!live.length) return null;
  return `live session ${live.map(s => Ch.sid8(s.session_id)).join(', ')} is working in ${wt} — let it finish (or end it), then batch again; --force bundles it anyway`;
}

// 칸의 작업 폴더를 묶어도 되는가 → 안 되면 이유(문자열). accept(integrate.js)와 같은 보호 —
//   [2026-10-29 감사] 앞선 accept 가 남긴 충돌 병합을 batch 가 git add -A 로 커밋해 충돌 표식이 판정 pass 로 묶음에 들어갔다 ·
//   [자동 이슈 #61 과 같은 자리] 커밋하지 않은 추적 파일 대량 삭제(중단된 git 작업)를 그대로 커밋했다.
const MASS_DELETE = 20;   // integrate.js 와 같은 값
function laneUnsafe(t, wt) {
  if (G.mergeInProgress(wt)) {
    const still = [...new Set([...G.unmergedFiles(wt), ...G.dirtyFiles(wt).map(e => e.path)])].filter(f => G.hasConflictMarkers(path.join(wt, f)));
    if (still.length) return `a merge left in ${wt} still has conflict markers in ${still.slice(0, 10).join(', ')} — resolve them there, commit, then batch again`;
    if (t.mode !== 'light') return `a merge is in progress in ${wt} — finish it there, then batch again`;
  }
  const del = G.statusEntries(wt).filter(e => e.code !== '??' && e.code !== '!!' && (e.x === 'D' || e.y === 'D')).map(e => e.path);
  if (!del.length) return null;
  const stage = G.git(wt, ['ls-files', '-s', '--', ...del.slice(0, 500).map(p => `:(literal)${p}`)], { allowFail: true }).out;
  const gitlinks = stage.split(/\r?\n/).filter(l => /^160000 /.test(l)).map(l => l.split('\t')[1]).filter(Boolean);
  if (!gitlinks.length && del.length < MASS_DELETE) return null;
  return `the worktree ${wt} is missing ${del.length} tracked file(s)${gitlinks.length ? ` including submodule(s) ${gitlinks.slice(0, 5).join(', ')}` : ''} that are not committed as deleted (e.g. ${del.slice(0, 5).join(', ')}) — this looks like an interrupted git operation, not work; nothing was committed. Restore them (git -C "${wt}" checkout HEAD -- .) or commit the deletions yourself, then batch again`;
}

// 구성원이 가져온 .harness/ 계획 폴더를 묶음 브랜치에서 걷어 낸다(accept 의 archivePlan 과 같이 보관한 뒤) — 사용자 브랜치에 들어가지 않게.
//   대상에 원래 있던 .harness/ 경로는 대상의 내용으로 되돌리고, 구성원이 더한 것만 지운다.
function dropPlanFolders(root, b, wt) {
  const changed = G.diffNames(wt, b.target_commit, 'HEAD').filter(f => f.startsWith('.harness/'));
  if (!changed.length) return null;
  for (const n of [...new Set(changed.map(f => f.split('/')[1]).filter(Boolean))]) {
    const src = path.join(wt, '.harness', n);
    if (!fs.existsSync(src)) continue;
    const dst = S.validId(n) && S.readTask(root, n) ? S.taskPaths(root, n).archiveDir : path.join(dirOf(root), b.id, 'archive', n);
    try { I.copyDir(src, dst); } catch { /* 보관 실패는 걷어 내기를 막지 않는다 — 내용은 구성원 브랜치에 남아 있다 */ }
  }
  const inTarget = f => G.git(wt, ['cat-file', '-e', `${b.target_commit}:${f}`], { allowFail: true }).ok;
  const restore = changed.filter(inTarget), drop = changed.filter(f => !restore.includes(f));
  const lit = f => `:(literal)${f}`;
  for (let i = 0; i < drop.length; i += 100) G.git(wt, ['rm', '-q', '-f', '--ignore-unmatch', '--', ...drop.slice(i, i + 100).map(lit)], { retryLock: true });
  for (let i = 0; i < restore.length; i += 100) G.git(wt, ['checkout', b.target_commit, '--', ...restore.slice(i, i + 100).map(lit)], { retryLock: true });
  try { if (fs.readdirSync(path.join(wt, '.harness')).length === 0) fs.rmdirSync(path.join(wt, '.harness')); } catch { /* 없거나 남은 것이 있다 */ }
  if (G.git(wt, ['diff', '--cached', '--quiet'], { allowFail: true }).ok) return null;
  G.git(wt, [...G.identityArgs(wt), 'commit', '-q', '--no-verify', '-m', `harness batch ${b.id}: drop .harness/ plan folders (archived in the task records)`], { retryLock: true });
  return G.headSha(wt);
}

// 대상 끝(target_commit)의 같은 검사 — 실패를 원래부터 있던 것과 가르려고. 열쇠(기준 커밋 · 검사 · .worktreeinclude 내용 · 검사 상한)가 같으면
//   같은 커밋에서 잰 앞선 묶음의 결과를 다시 쓴다. 임시 분리 worktree 에서 재고 지운다.
//   [2026-10-29 감사 · baseline.js 와 같이] 시간 초과가 든 기준선은 쓰지도 읽지도 않는다 — 부하 때 잰 "원래부터 실패" 가 다음 판정을 not-worse 로 틀었다.
const timedOut = j => (j.results || []).some(r => r && r.timed_out);
async function targetBaseline(root, b, commands, include, runOn, log, timeoutMs) {
  const key = crypto.createHash('sha1').update(JSON.stringify([b.target_commit, commands, (include || []).map(x => `${x.path}:${x.sha1}`), timeoutMs || null])).digest('hex');
  const cacheFile = path.join(S.paths(root).harnessDir, 'baseline-cache', `${key}.json`);
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c && Array.isArray(c.results) && !timedOut(c)) { log(`[pilot] batch ${b.id} — 대상 끝의 검사 결과를 캐시에서 다시 쓴다(${String(b.target_commit).slice(0, 10)})`); return { ...c, cached: true }; } } catch { /* 없음 */ }
  const dir = path.join(S.paths(root).worktreesDir, `${b.id}-base`);
  log(`[pilot] batch ${b.id} — 검사가 실패해 대상 끝(${String(b.target_commit).slice(0, 10)})에서 같은 검사를 잰다(원래부터 실패인지)`);
  try {
    G.addWorktree(root, dir, { detach: true, base: b.target_commit });
    try { G.copyWorktreeInclude(root, dir); } catch { /* 복사 실패는 검사가 보여 준다 */ }
    const j = (await runOn(dir, commands)).judged;
    const slim = { ...j, results: j.results.map(r => ({ ...r, output: undefined })) };
    if (!timedOut(slim)) { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(slim)); } catch { /* 캐시 실패는 판정을 막지 않는다 */ } }
    return slim;
  } catch (e) { b.baseline_error = String(e.message).slice(0, 300); return null; }
  finally {
    try { G.dropSubmoduleClones(root, dir, { force: true }); } catch { /* 없음 */ }
    G.git(root, ['worktree', 'remove', '--force', dir], { allowFail: true, retryLock: true });
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 다음 gc */ }
    G.git(root, ['worktree', 'prune'], { allowFail: true });
  }
}

// batch — o = { root, ids, all, branches, into, checks, checkTimeoutMs, force(산 세션이 일하는 칸도 묶는다), log } → 결과(id · status · verdict · members · report)
async function create(o) {
  const log = o.log || (() => {});
  const root = S.mainRoot(o.root || process.cwd());
  const target = o.into ? strip(o.into) : G.currentBranch(root);
  if (!target) throw usage(`the main checkout ${root} is on a detached HEAD — pass --into <branch>`);
  if (!G.branchExists(root, target)) throw usage(`target branch ${target} does not exist`);
  if (!(o.ids || []).length && !o.all && !(o.branches || []).length) throw usage('batch needs task ids, --all or --branch <name>');
  const members = pickMembers(root, target, o);
  if (!members.length) throw usage(`nothing to bundle — no done tasks or open light lanes for ${target}`);
  const bid = newBid(), wt = path.join(S.paths(root).worktreesDir, bid);
  const b = { id: bid, status: 'building', target, target_commit: G.headSha(root, target), branch: `harness/batch/${bid}`, worktree: wt,
    members: members.map(m => ({ ...m, status: 'pending' })), checks: null, commands: [], verdict: null, failed_tests: [], created_at: S.nowIso() };
  // [2026-10-29 감사] 만드는 동안 batch-<bid> 잠금을 쥔다 — gc 가 검사 중인 묶음 작업 폴더의 등록을 지웠다(gc 는 이 잠금이 살아 있으면 건너뛴다).
  const h = S.acquire(root, `batch-${bid}`);
  try {
    saveBatch(root, b);
    try { return await build(root, b, o, log); }
    catch (e) { b.status = 'error'; b.error = clip(e.message, 300); saveBatch(root, b); throw e; }
  } finally { h.release(); }
}
async function build(root, b, o, log) {
  const bid = b.id, wt = b.worktree, target = b.target;
  G.addWorktree(root, wt, { branch: b.branch, base: b.target_commit });
  const include = G.copyWorktreeInclude(root, wt);
  // 1. 하나씩 합친다 — 충돌하면 그 구성원만 되돌리고(merge --abort) 건너뛴다. 모델에게 풀게 하지 않는다.
  for (const m of b.members) {
    const t = m.id ? S.readTask(root, m.id) : null;
    if (t) {
      const P = S.taskPathsFor(root, t);
      if (fs.existsSync(P.wt) && G.isWorktreeRoot(P.wt, t.branch)) {
        const why = (!o.force && liveSessionIn(root, P.wt)) || laneUnsafe(t, P.wt);
        if (why) { m.status = 'skipped'; m.why = why; continue; }
        // light 칸의 미커밋분은 그 칸에 먼저 커밋한다(accept 와 같이) — 묶음에는 커밋된 것만 들어간다
        if (t.mode === 'light') {
          try { const files = I.commitLeftovers(t, P.wt, `uncommitted work before batch ${bid}`); if (files.length) { m.committed = files.slice(0, 50); S.writeTask(root, t); S.log(root, t.id, { event: 'leftovers_committed', phase: 'batch', batch: bid, files: files.slice(0, 200) }); } }
          catch (e) { m.leftover_error = String(e.message).slice(0, 200); }
        }
      }
    }
    const ref = t ? t.branch : m.branch, before = G.headSha(wt);
    // 묶은 때의 구성원 끝 — batch accept 가 그 뒤에 더한 커밋(들어가지 않는다)을 알아본다
    m.tip = G.headSha(root, ref);
    if (G.isAncestor(wt, ref, 'HEAD')) { m.status = 'skipped'; m.why = `already in ${target}`; continue; }
    const msg = `harness batch ${bid}: merge ${m.id || ref}${m.goal ? ` — ${clip(m.goal, 72)}` : ''}`;
    const r = G.git(wt, [...G.identityArgs(wt), 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', msg, ref], { allowFail: true, retryLock: true });
    if (r.ok && G.headSha(wt) !== before) { m.status = 'merged'; m.commit = G.headSha(wt); continue; }
    if (G.mergeInProgress(wt)) {
      m.conflicts = G.unmergedFiles(wt);
      G.git(wt, ['merge', '--abort'], { allowFail: true, retryLock: true });
      m.status = 'skipped'; m.why = 'conflict';
    } else { m.status = 'skipped'; m.why = r.ok ? 'git made no merge commit' : clip(r.err, 300); }
  }
  saveBatch(root, b);
  const merged = b.members.filter(m => m.status === 'merged');
  if (merged.length) b.plan_drop_commit = dropPlanFolders(root, b, wt) || undefined;
  // 2. 대상의 검사를 한 번 — 실패한 검사는 한 번 더(불안정) · 검사 줄은 일반 순서(priority 1)
  //   [2026-10-29 감사] 빈 묶음이 작업 폴더와 브랜치를 남기고 다음 할 일을 알리지 않았다 — 바로 치운다.
  if (!merged.length) {
    b.status = 'empty'; b.verdict = null;
    const rm = removeBatchWorktree(root, b, true);
    const d = rm.ok ? G.git(root, ['branch', '-D', b.branch], { allowFail: true, retryLock: true }) : { ok: false };
    b.cleaned = rm.ok && d.ok;
    if (!b.cleaned) b.worktree_kept = rm.ok ? clip(d.err, 200) : rm.why;
    saveBatch(root, b); return result(root, b);
  }
  // 검사한 묶음 브랜치 끝 — batch accept 는 그 뒤에 더한 커밋을 이 판정으로 들이지 않는다(다시 batch)
  b.checked_tip = G.headSha(wt);
  const co = G.checkoutOf(root, target), proj = co ? co.path : root;
  const found = K.discover(wt, o.checks, proj);
  const m0 = K.yamlNumber(proj, 'check_timeout_min') || K.yamlNumber(wt, 'check_timeout_min');
  const timeoutMs = o.checkTimeoutMs || (m0 ? m0 * 60000 : K.CHECK_TIMEOUT_MS);
  const rerun = !/^(off|false|no)$/i.test(K.yamlString(proj, 'rerun_failed') || K.yamlString(wt, 'rerun_failed') || '');
  // 검사 줄은 저장소 하나에 하나(직렬이 기본 · 프로젝트 블록 serial_checks: off 면 끔)
  const serialRoot = typeof K.serialChecksOn === 'function' && !K.serialChecksOn(root) ? null : root;
  const runOn = (dir, cmds) => K.runJudged(dir, cmds, { timeoutMs, rerun, serialRoot, priority: 1 });
  b.commands = found.commands.map(K.display);
  b.checks_source = found.source;
  if (!found.commands.length) { b.verdict = 'pass'; b.no_checks = true; }
  else {
    log(`[pilot] batch ${bid} — ${merged.length}개를 합쳤다 · 검사: ${b.commands.join(' ; ')}`);
    const rj = await runOn(wt, found.commands);
    let j = rj.judged;
    if (rj.flaky && rj.flaky.length) b.flaky = rj.flaky;
    if (j.ok) b.verdict = 'pass';
    else if (I.isIndeterminate(j)) b.verdict = 'indeterminate';   // 대상 끝을 재도 가릴 수 없다(부하 · 상한) — 시간을 더 쓰지 않는다
    // [2026-10-29 감사] 사용자가 준 검사는 그 기능을 묘사한다 — 원래부터 실패여도 not-worse 로 넘기지 않는다(accept 와 같다 · 대상 끝은 재지 않는다)
    else if (found.source === 'user') b.verdict = 'fail';
    else {
      const base = await targetBaseline(root, b, found.commands, include, runOn, log, timeoutMs);
      // 캐시된 기준선이 멈춘 테스트를 떼어 낸 명령이면 같은 명령으로 다시 잰다(판정은 명령마다 짝지어 비교한다)
      if (base && Array.isArray(base.commands) && JSON.stringify(base.commands) !== JSON.stringify(found.commands)) j = (await runOn(wt, base.commands)).judged;
      if (base) b.baseline = { ok: base.ok, pass: base.pass, fail: base.fail, cached: !!base.cached };
      const v = K.judge(j, base);
      b.verdict = v.verdict === 'pass' ? 'pass' : v.verdict === 'not_worse' ? 'not-worse' : 'fail';
    }
    b.checks = K.brief(j);
    b.failed_tests = ((j.failed_tests) || []).slice(0, 50);
    if (b.verdict !== 'pass') b.failing = j.results.filter(r => !r.ok).map(r => r.command);
  }
  // 3. 린트 — accept 와 같이 묶음이 바꾼 파일에서({files}) 또는 저장소 전체에서 한 번. 실패면 판정은 fail.
  //   [2026-10-29 감사] batch 는 lint_command 를 돌리지 않아 accept 가 린트로 거절한 변경이 묶음으로는 사용자 브랜치에 들어갔다.
  const lintCmd = K.yamlString(proj, 'lint_command') || K.yamlString(wt, 'lint_command');
  if (lintCmd) {
    const changed = G.diffNames(wt, b.target_commit, 'HEAD').filter(f => !f.startsWith('.harness/') && fs.existsSync(path.join(wt, f)));
    const argv = K.lintArgv(lintCmd, /{files}/.test(lintCmd) ? changed : []);
    if (argv) {
      const lr = await K.runCheck(wt, argv, { timeoutMs });
      b.lint = { command: lr.command || argv.join(' '), ok: !!lr.ok, exit_code: lr.exit_code, first: lr.ok ? null : clip(K.firstAssertion(lr), 200) };
      if (!lr.ok && b.verdict !== 'fail') { b.verdict = 'fail'; b.failing = [...(b.failing || []), b.lint.command]; }
    } else b.lint = { command: lintCmd, ok: true, skipped: 'no changed files' };
  }
  b.status = 'ready';
  saveBatch(root, b);
  return result(root, b);
}

function result(root, b) {
  return { id: b.id, status: b.status, verdict: b.verdict, target: b.target, branch: b.branch, worktree: b.worktree, merge_commit: b.merge_commit || null,
    members: b.members.map(m => ({ id: m.id, branch: m.branch, status: m.status, ...(m.conflicts ? { conflicts: m.conflicts } : {}) })), failed_tests: b.failed_tests || [], report: format(b) };
}

// 사람이 읽는 보고(한국어)
function format(b) {
  const cli = 'node harness/cli.js';
  const merged = b.members.filter(m => m.status === 'merged'), skipped = b.members.filter(m => m.status === 'skipped');
  const head = b.status === 'empty' ? '합친 것이 없다' : b.status === 'accepted' ? `받아들임 — ${b.target} 에 ${String(b.merge_commit).slice(0, 10)} 로 병합했다`
    : b.status === 'dropped' ? '버림' : b.status === 'error' ? `오류: ${b.error}` : b.status === 'building' ? '만드는 중(또는 중간에 끝남)' : `판정: ${VERDICT_KO[b.verdict] || b.verdict}`;
  const L = [`pilot batch ${b.id} — ${head}`,
    `대상: ${b.target} @ ${String(b.target_commit).slice(0, 10)} · 묶음 브랜치: ${b.branch}${b.status !== 'accepted' && b.status !== 'dropped' ? ` · 작업 폴더: ${b.worktree}` : ''}`];
  L.push(`합침 ${merged.length}개${merged.length ? ':' : ''}`);
  for (const m of merged) L.push(`  - ${m.id || m.branch}${m.goal ? ` — ${m.goal}` : ''}${m.committed ? ` (커밋되지 않았던 ${m.committed.length}개 파일을 먼저 커밋: ${m.committed.slice(0, 5).join(', ')}${m.committed.length > 5 ? ' …' : ''})` : ''}`);
  if (skipped.length) {
    L.push(`건너뜀 ${skipped.length}개(나머지는 계속 합쳤다 — 충돌은 모델에게 풀게 하지 않는다):`);
    for (const m of skipped) L.push(`  - ${m.id || m.branch} — ${m.why === 'conflict' ? `충돌: ${(m.conflicts || []).slice(0, 8).join(', ')}` : m.why}`);
  }
  if (b.no_checks) L.push('검사: 찾지 못했다 — 검사 없이 판정했다(직접 확인하세요)');
  else if (b.checks) {
    L.push(`검사(한 번): ${b.commands.join(' ; ')} — ${b.checks.pass} 통과 / ${b.checks.fail} 실패${b.baseline ? ` · 대상 끝: ${b.baseline.pass} 통과 / ${b.baseline.fail} 실패${b.baseline.cached ? '(캐시)' : ''}` : ''}`);
    if ((b.flaky || []).length) L.push(`  불안정(실패했다가 다시 돌리니 통과): ${b.flaky.join(' ; ')}`);
    if ((b.failing || []).length) L.push(`  실패한 검사: ${b.failing.join(' ; ')}`);
    if ((b.failed_tests || []).length) L.push(`  실패한 시험: ${b.failed_tests.slice(0, 10).join(', ')}${b.failed_tests.length > 10 ? ` … (+${b.failed_tests.length - 10})` : ''}`);
    if (b.baseline_error) L.push(`  대상 끝을 재지 못했다: ${b.baseline_error}`);
    if (b.checks_source === 'user' && b.verdict === 'fail') L.push('  사용자가 준 검사(--check)다 — 원래부터 실패여도 "나빠지지 않음" 으로 넘기지 않는다(accept 와 같다)');
  }
  if (b.lint) L.push(`린트: ${b.lint.command} — ${b.lint.skipped ? '바뀐 파일 없음(건너뜀)' : b.lint.ok ? '통과' : `실패(exit ${b.lint.exit_code})${b.lint.first ? `: ${b.lint.first}` : ''}`}`);
  if (b.status === 'empty') {
    L.push(b.cleaned ? '묶음 작업 폴더와 브랜치는 지웠다.' : `묶음 작업 폴더 · 브랜치를 지우지 못했다(${b.worktree_kept || '?'}) — ${cli} batch drop ${b.id}`);
    L.push(`다음: 건너뛴 이유(위)를 고친 뒤 다시 묶는다(${cli} batch <id>…) — 사용자 브랜치는 그대로다.`);
  }
  if (b.status === 'ready') {
    L.push(OK_VERDICTS.has(b.verdict) ? `다음: 받아들이려면(사용자가 말한 뒤) ${cli} batch accept ${b.id} · 버리려면 ${cli} batch drop ${b.id}`
      : b.verdict === 'indeterminate' ? `다음: 부하가 줄었을 때 다시 묶거나(${cli} batch …) 결과를 알고 합치려면 ${cli} batch accept ${b.id} --force · 버리려면 ${cli} batch drop ${b.id}`
        : `다음: 실패를 고친 뒤 다시 묶는다 · 그래도 합치려면 ${cli} batch accept ${b.id} --force · 버리려면 ${cli} batch drop ${b.id}`);
    L.push('사용자 브랜치는 그대로다.');
  }
  if (b.status === 'accepted') L.push(`구성원은 accepted 로 기록했다(되돌리기: ${cli} cancel <id> — 그 구성원의 병합만 되돌린다)${b.worktree_kept ? ` · 작업 폴더 남김: ${b.worktree} (${b.worktree_kept})` : ''}`);
  return L.join('\n');
}

// 묶음 작업 폴더를 치운다 — 하네스의 것이라 검사 산출물(추적 안 된 · 무시된 파일)은 버린다. 추적 파일이 고쳐져 있으면(사람이 손댐) force 일 때만.
function removeBatchWorktree(root, b, force) {
  if (!fs.existsSync(b.worktree)) { G.git(root, ['worktree', 'prune'], { allowFail: true }); return { ok: true }; }
  // 등록이 사라진 폴더 — 그 안에서 git 을 부르면 위의 메인 저장소를 본다(메인의 미커밋 파일을 묶음의 변경으로 잘못 보고 drop 이 영영 거부됐다).
  //   하네스의 검사 폴더이고 커밋은 묶음 브랜치에 있다 — 폴더를 치운다.
  if (!G.worktreeRegistered(root, b.worktree)) {
    G.git(root, ['worktree', 'prune'], { allowFail: true });
    try { fs.rmSync(b.worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { return { ok: false, why: clip(e.message, 200) }; }
    return fs.existsSync(b.worktree) ? { ok: false, why: `could not remove the leftover folder ${b.worktree}` } : { ok: true };
  }
  const edited = G.dirtyFiles(b.worktree).filter(e => e.code !== '??').map(e => e.path);
  if (edited.length && !force) return { ok: false, why: `tracked files were changed in the batch worktree: ${edited.slice(0, 5).join(', ')}` };
  try { G.dropSubmoduleClones(root, b.worktree, { force: true }); } catch { /* 없음 */ }
  const r = G.git(root, ['worktree', 'remove', '--force', b.worktree], { allowFail: true, retryLock: true });
  if (!r.ok) return { ok: false, why: clip(r.err, 200) };
  try { const parent = path.dirname(b.worktree); if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* 다른 worktree 가 남아 있다 */ }
  return { ok: true };
}

// batch accept <bid> — 묶음 브랜치를 대상에 --no-ff 로 병합(사용자가 말한 뒤에만). 구성원은 accepted(merge_commit = 묶음 안의 그 구성원 병합 — cancel 이 그것만 되돌린다).
async function accept(o) {
  const root = S.mainRoot(o.root || process.cwd()), bid = needBid(o.bid);
  if (!readBatch(root, bid)) throw Object.assign(new Error(`unknown batch: ${bid}`), { code: 'UNKNOWN_TASK' });
  return S.withLock(root, 'merge', async () => {
    let h;
    try { h = S.acquire(root, `batch-${bid}`); }
    catch (e) { if (e.code === 'LOCK_HELD') return { id: bid, status: 'ready', refused: true, reason: `batch ${bid} is being changed by another process (pid ${e.owner && e.owner.pid})`, report: `pilot batch ${bid} — 바뀐 것 없음: 다른 프로세스가 이 묶음을 쓰는 중이다` }; throw e; }
    try { return acceptLocked(root, readBatch(root, bid), o); } finally { h.release(); }
  }, { waitMs: I.MERGE_WAIT_MS });
}
function acceptLocked(root, b, o) {
  const refuse = (why, ko) => ({ id: b.id, status: b.status, verdict: b.verdict, refused: true, reason: why, report: `pilot batch ${b.id} — 바뀐 것 없음: ${ko || why}` });
  if (b.status === 'accepted') return refuse(`already accepted into ${b.target} (${String(b.merge_commit).slice(0, 10)})`, `이미 ${b.target} 에 받아들였다(${String(b.merge_commit).slice(0, 10)})`);
  if (b.status === 'dropped') return refuse('the batch was dropped', '버린 묶음이다');
  const merged = b.members.filter(m => m.status === 'merged');
  if (b.status !== 'ready' || !merged.length) return refuse(`nothing to accept (status ${b.status}, ${merged.length} merged)`, `받아들일 것이 없다(상태 ${b.status} · 합친 것 ${merged.length}개)`);
  if (!OK_VERDICTS.has(b.verdict) && !o.force) return refuse(`verdict is ${b.verdict} — only pass / not-worse batches are accepted; pass --force to merge anyway`, `판정이 ${VERDICT_KO[b.verdict] || b.verdict} — 통과 · 나빠지지 않음만 받아들인다. 그래도 합치려면 --force`);
  if (!G.branchExists(root, b.branch)) return refuse(`the batch branch ${b.branch} is gone`, `묶음 브랜치 ${b.branch} 가 없다`);
  // [2026-10-29 감사] 판정은 검사한 그 끝에만 해당한다 — 그 뒤 묶음 브랜치에 더한 커밋이 같은 pass 로 사용자 브랜치에 들어갔다.
  const bt = G.headSha(root, b.branch);
  if (b.checked_tip && bt !== b.checked_tip) return refuse(`the batch branch ${b.branch} moved after it was checked (${String(b.checked_tip).slice(0, 10)} → ${String(bt).slice(0, 10)}) — run batch again so the checks see it`,
    `묶음 브랜치 ${b.branch} 가 검사 뒤에 움직였다(${String(b.checked_tip).slice(0, 10)} → ${String(bt).slice(0, 10)}) — batch 를 다시 하세요`);
  // [2026-10-29 감사] 구성원 작업의 지금 상태를 다시 본다 — 묶은 뒤 cancel 한 구성원이 병합되고 accepted 로 되살아났다 ·
  //   묶은 뒤 칸에 더한 커밋은 병합되지 않는데 작업은 accepted 가 되고 worktree 가 지워져 다시 들일 길이 막혔다.
  for (const mm of merged) {
    if (!mm.id) continue;
    const t = S.readTask(root, mm.id);
    if (!eligible(t)) return refuse(`member ${mm.id} is now ${t ? t.status : 'gone'} — run batch again without it`, `구성원 ${mm.id} 가 지금 ${t ? t.status : '없음'} 이다 — 그것을 빼고 batch 를 다시 하세요`);
    const now = G.headSha(root, t.branch);
    if (mm.tip && now !== mm.tip) return refuse(`lane ${mm.id} has new commits since it was batched (${String(mm.tip).slice(0, 10)} → ${String(now).slice(0, 10)}) — run batch again so they are checked and merged`,
      `칸 ${mm.id} 에 묶은 뒤의 커밋이 있다(${String(mm.tip).slice(0, 10)} → ${String(now).slice(0, 10)}) — 검사 · 병합되도록 batch 를 다시 하세요`);
    const P = S.taskPathsFor(root, t);
    const live = !o.force && fs.existsSync(P.wt) && liveSessionIn(root, P.wt);
    if (live) return refuse(`member ${mm.id}: ${live}`, `구성원 ${mm.id} 의 worktree 에서 산 세션이 일하고 있다 — 끝난 뒤 다시 하거나(그 세션을 끝내고) --force`);
    if (t.mode === 'light' && fs.existsSync(P.wt) && G.worktreeRegistered(root, P.wt)) {
      const dirty = G.dirtyFiles(P.wt).map(e => e.path).filter(f => !f.startsWith('.harness/'));
      if (dirty.length) return refuse(`lane ${mm.id} has uncommitted changes since it was batched: ${dirty.slice(0, 5).join(', ')} — commit them and run batch again`, `칸 ${mm.id} 에 묶은 뒤의 미커밋 변경이 있다: ${dirty.slice(0, 5).join(', ')} — 커밋하고 batch 를 다시 하세요`);
    }
  }
  const tip = G.headSha(root, b.target);
  if (tip !== b.target_commit) return refuse(`${b.target} moved since the batch was built (${String(b.target_commit).slice(0, 10)} → ${String(tip).slice(0, 10)}) — run batch again so the checks see the new ${b.target}`,
    `묶은 뒤 ${b.target} 가 움직였다(${String(b.target_commit).slice(0, 10)} → ${String(tip).slice(0, 10)}) — 검사가 새 ${b.target} 를 보도록 batch 를 다시 하세요`);
  const co = G.checkoutOf(root, b.target);
  if (!co) return refuse(`target branch ${b.target} is not checked out in any checkout; check it out in your main checkout and run batch accept again`, `대상 브랜치 ${b.target} 가 어느 체크아웃에도 열려 있지 않다 — 메인 체크아웃에서 열고 다시 하세요`);
  if (G.mergeInProgress(co.path)) return refuse(`a merge is in progress in ${co.path}`, `${co.path} 에서 병합이 진행 중이다`);
  if (G.currentBranch(co.path) !== b.target) return refuse(`${co.path} is no longer on ${b.target}`);
  const clash = I.dirtyOverlap(co.path, G.diffNames(root, b.target, b.branch));
  if (clash.length) return refuse(`uncommitted changes in ${co.path} touch files this batch changes: ${clash.join(', ')} — commit them first`, `${co.path} 의 미커밋 변경이 이 묶음의 파일과 겹친다: ${clash.join(', ')} — 먼저 커밋하세요`);
  const before = G.headSha(co.path), branchTip = G.headSha(root, b.branch);
  const msg = [`harness: batch ${b.id} — ${merged.length} member(s) into ${b.target}`, '', ...merged.map(m => `- ${m.id || m.branch}${m.goal ? `: ${m.goal}` : ''}`)].join('\n');
  const m = G.git(co.path, [...G.identityArgs(co.path), 'merge', '--no-ff', '--no-edit', '-m', msg, b.branch], { allowFail: true, retryLock: true });
  if (!m.ok) {
    if (G.mergeInProgress(co.path)) G.git(co.path, ['merge', '--abort'], { allowFail: true });
    return refuse(`git merge into ${b.target} failed: ${clip(m.err, 300)}`);
  }
  const merge = G.headSha(co.path);
  if (merge === before || G.headSha(co.path, `${merge}^1`) !== before || G.headSha(co.path, `${merge}^2`) !== branchTip) return refuse(`git merge produced ${String(merge).slice(0, 10)}, which is not this batch's merge (parents differ) — inspect ${b.target}`);
  // 병합은 끝났다 — 무엇보다 먼저 기록한다
  Object.assign(b, { status: 'accepted', merge_commit: merge, accepted_at: S.nowIso(), forced: !OK_VERDICTS.has(b.verdict) || undefined });
  saveBatch(root, b);
  for (const mm of merged) if (mm.id) markAccepted(root, b, mm, merge);
  const rm = removeBatchWorktree(root, b, false);
  if (!rm.ok) b.worktree_kept = rm.why;
  saveBatch(root, b);
  return { ...result(root, b), status: 'accepted' };
}
// 구성원 하나를 accepted 로 — accept 와 같이 태그 · worktree 정리 · 자원 회수. 실패해도 병합은 그대로(기록에 남긴다).
function markAccepted(root, b, mm, merge) {
  let h = null;
  try { h = S.acquire(root, `task-${mm.id}`); } catch (e) { if (e.code !== 'LOCK_HELD') throw e; }   // 잡지 못해도 기록은 한다 — 병합은 이미 사용자 브랜치에 있다
  try {
    const t = S.readTask(root, mm.id);
    if (!t || t.status === 'accepted') return;
    const was = t.status;
    Object.assign(t, { status: 'accepted', reason: `merged into ${b.target} by batch ${b.id} as ${merge.slice(0, 10)}`, merge_commit: mm.commit, batch_merge_commit: merge,
      accepted_into: b.target, accepted_at: S.nowIso(), accepted_via: b.id, revert_commit: null });
    if (!eligible({ ...t, status: was })) t.forced_from = { status: was, reason: '' };
    S.writeTask(root, t);
    S.log(root, t.id, { event: 'accepted', via: b.id, merge_commit: mm.commit, batch_merge_commit: merge, into: b.target });
    const tag = `harness/merged/${t.id}`;
    if (!G.tagExists(root, tag)) { const tr = G.git(root, ['tag', tag, mm.commit], { allowFail: true }); if (!tr.ok) t.tag_error = clip(tr.err, 300); }
    const P = S.taskPathsFor(root, t);
    if (fs.existsSync(P.wt)) {
      const rm = St.removeIfSafe(root, P.wt, t.worktree_include);
      if (rm.ok) delete t.worktree_kept; else t.worktree_kept = rm.why;
    }
    I.releaseResources(root, t);
    S.writeTask(root, t);
  } finally { if (h) h.release(); }
}

// batch status [<bid>]
function status(o) {
  const root = S.mainRoot(o.root || process.cwd());
  if (o.bid) { const b = readBatch(root, needBid(o.bid)); if (!b) throw Object.assign(new Error(`unknown batch: ${o.bid}`), { code: 'UNKNOWN_TASK' }); return { batches: [b], report: format(b) }; }
  const all = listBatches(root);
  return { batches: all, report: all.length ? all.map(b => `${b.id}  ${b.status}${b.verdict ? ` · ${b.verdict}` : ''}  → ${b.target}  합침 ${b.members.filter(m => m.status === 'merged').length}/${b.members.length}  ${b.created_at}`).join('\n') : '묶음이 없다' };
}

// batch drop <bid> — 묶음 작업 폴더와 브랜치를 지운다(구성원은 그대로)
function drop(o) {
  const root = S.mainRoot(o.root || process.cwd()), bid = needBid(o.bid);
  const b0 = readBatch(root, bid);
  if (!b0) throw Object.assign(new Error(`unknown batch: ${bid}`), { code: 'UNKNOWN_TASK' });
  return S.withLockSync(root, `batch-${bid}`, () => {
    const b = readBatch(root, bid);
    const rm = removeBatchWorktree(root, b, !!o.force);
    if (!rm.ok) return { id: bid, status: b.status, refused: true, reason: `${rm.why} — pass --force to discard them`, report: `pilot batch ${bid} — 바뀐 것 없음: ${rm.why} — 버리려면 --force` };
    if (G.branchExists(root, b.branch)) {
      const d = G.git(root, ['branch', '-D', b.branch], { allowFail: true, retryLock: true });
      if (!d.ok) return { id: bid, status: b.status, refused: true, reason: `could not delete ${b.branch}: ${clip(d.err, 200)}`, report: `pilot batch ${bid} — 브랜치 ${b.branch} 를 지우지 못했다: ${clip(d.err, 200)}` };
    }
    if (b.status !== 'accepted') b.status = 'dropped';
    b.dropped_at = S.nowIso();
    saveBatch(root, b);
    return { id: bid, status: b.status, report: `pilot batch ${bid} — 버렸다: 작업 폴더와 브랜치 ${b.branch} 를 지웠다(구성원 작업은 그대로다)` };
  });
}

module.exports = { create, accept, status, drop, format, readBatch, listBatches, pickMembers, removeBatchWorktree, BID_RE };

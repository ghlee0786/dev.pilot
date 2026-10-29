'use strict';
// 늦은 기준선 — 합칠 때 검사가 실패하면 "원래부터 실패하던 것인가" 를 가리려고 작업 시작 커밋에서 같은 검사를 잰다(무인 루프에서 옮겨 옴).
//   캐시 · 멈춘 테스트 떼어 내기 · 시간 초과된 자동 검사 빼기 · 의존성 경고. accept · cancel · restore · check 가 쓴다.
//   measureAt: 다른 커밋(대상 브랜치 끝)에서 같은 검사 · 린트를 잰다 — "대상이 스스로 빨갛다" 를 레인 탓으로 돌리지 않게(G2 #11 · #20).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const S = require('./state'), G = require('./git'), K = require('./checks');

// 검사 줄(checks) — 직렬이 기본(K.serialChecksOn · serial_checks: off 면 끔). 그 함수가 없는 판이면 작업에 기록된 값.
//   [2026-10-29 감사 G2 #9 · #13] 늦은 기준선과 멈춘 테스트 떼어 내기는 task.checks.serial(명시적으로 on 일 때만 기록)만 봐서 기본(켬)에서
//   다른 작업의 검사와 동시에 돌았다(자동 이슈 #4 — 같은 시험 DB). accept 의 기준선은 merge 잠금을 쥐고 있으니 priority 0 으로 줄 맨 앞에.
const serialRoot = (root, task) => ((typeof K.serialChecksOn === 'function' ? K.serialChecksOn(root) : !!(task.checks && task.checks.serial)) ? root : null);
const queued = (root, task, o, label, fn) => {
  const sr = serialRoot(root, task);
  return sr ? K.inQueue({ serialRoot: sr, priority: o.priority, label: `${label} ${task.id}` }, () => fn()) : fn();
};

// 캐시 열쇠: 기준 커밋 · 검사 · .worktreeinclude 내용 · 검사 상한.
//   [2026-10-29 감사 G2 #2 · #15] 상한이 열쇠에 없어 부하로 시간 초과된 기준선이 상한을 넉넉히 준 다음 작업에도 그대로 쓰였다(검사가 영구히 빠짐).
//   시간 초과가 남은 기준선은 캐시에 쓰지 않고, 그런 캐시는 읽지도 않는다 — 다음 작업이 다시 잰다.
function baselineCacheFile(root, task, commands, baseCommit, timeoutMs) {
  const key = crypto.createHash('sha1').update(JSON.stringify([baseCommit, commands, (task.worktree_include || []).map(x => `${x.path}:${x.sha1}`), timeoutMs || null])).digest('hex');
  return path.join(S.paths(root).harnessDir, 'baseline-cache', `${key}.json`);
}
function readCache(file) {
  let b = null; try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  return b && Array.isArray(b.results) && !b.results.some(r => r.timed_out) ? b : null;
}
function writeCache(file, b) {
  if ((b.results || []).some(r => r.timed_out)) return;
  const slim = { ...b, results: (b.results || []).map(r => ({ ...r, output: undefined })) };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(slim)); } catch { /* 캐시 실패는 작업을 멈추지 않는다 */ }
}
function readBaselineCache(root, task, commands, baseCommit, timeoutMs) { return !!readCache(baselineCacheFile(root, task, commands, baseCommit, timeoutMs)); }

// 기준선 — 작업 전 상태에서 검사를 잰다(캐시 · 멈춘 테스트 떼어 내기 · 시간 초과된 자동 검사 빼기 · 의존성 경고). dir: 작업 시작 시점의 코드가 있는 폴더.
//   [2026-10-21 평가 2단계 · D2] 기본은 늦게(lazy): 검사가 실패해 "원래부터 실패하던 것인가" 를 가려야 할 때만 별도 worktree 에서 잰다 —
//   빠른 모델(GPT-6.1 Sol)은 맨 실행 2~8분인데 하네스가 작업 전 전체 테스트에 17~44분을 써서 상한에 걸리고 정확도까지 잃었다.
async function measureBaseline(root, task, found, dir, o, log, baseCommit) {
      // 기준선 캐시: 같은 기준 커밋 · 같은 검사 · 같은 .worktreeinclude 내용 · 같은 상한이면 앞선 작업의 기준선을 다시 쓴다(느린 저장소에서 작업마다 수십 분).
      const cacheFile = baselineCacheFile(root, task, found.commands, baseCommit, o.checkTimeoutMs);
      let b = o.freshBaseline ? null : readCache(cacheFile);
      if (b) {
        log(`[pilot] ${task.id} — baseline reused from an earlier task on the same base commit (cache: ${cacheFile} — delete it to measure again)`); task.checks.baseline_cached = true;
        if (b.commands) { found.commands = b.commands; task.checks.commands = b.commands; task.checks.hung = b.hung; }
      } else {
        b = await queued(root, task, o, 'baseline', async () => {
          let m = (await K.runJudged(dir, found.commands, { timeoutMs: o.checkTimeoutMs, rerun: task.checks.rerun })).judged;
          // 멈춘 테스트 떼어 내기(K.isolateHangs) — 시간 초과된 검사 가운데 언어 팩이 멈춘 테스트를 짚을 수 있는 것은 그 테스트를 빼고 다시 잰다. 사용자가 준 검사도.
          const hung = [];
          for (let i = 0; i < m.results.length; i++) {
            if (!m.results[i].timed_out) continue;
            const iso = await K.isolateHangs(dir, found.commands[i], { timeoutMs: o.checkTimeoutMs });
            if (!iso) continue;
            hung.push(...iso.excluded.map(t => ({ command: K.display(found.commands[i]), test: t })));
            found.commands = found.commands.map((c, k) => (k === i ? iso.argv : c));
            m.results[i] = iso.result;
          }
          if (hung.length) {
            m = { ...K.summarize(m.results), commands: found.commands, hung };
            task.checks.commands = found.commands; task.checks.hung = hung;
            log(`[pilot] ${task.id} — excluded tests that hung before the task (no output for ${Math.round(K.STALL_MS / 60000)} min): ${hung.map(h => h.test).join(' ; ')}`);
          }
          return m;
        });
        writeCache(cacheFile, b);
      }
      // [2026-10-16 자동 이슈 #13] 저장소에서 찾은 검사가 새 worktree 에서 작업 전부터 시간 초과 — 작업과 무관하게 정체됐다.
      //   자동으로 찾은 검사(사용자가 준 것이 아닌)는 기준선에서 시간 초과면 판정에서 빼고 알린다. argv 는 남긴다 — accept 가 다시 재려고 되살린다(G2 #1).
      if (found.source !== 'user' && b.results.some(x => x.timed_out)) {
        const keep = b.results.map(x => !x.timed_out);
        task.checks.dropped = found.commands.filter((_, i) => !keep[i]).map(cmd => ({ command: K.display(cmd), why: 'timed out before the task (baseline)', argv: cmd }));
        task.checks.commands = found.commands.filter((_, i) => keep[i]);
        b = K.summarize(b.results.filter((_, i) => keep[i]));
        log(`[pilot] ${task.id} — dropped auto-detected checks that timed out before the task: ${task.checks.dropped.map(d => d.command).join(' ; ')}`);
      }
      task.checks.baseline = K.brief(b);
      // 요약 없이 종료 코드만 빨간 기준선(M7) — 새 worktree 에 의존성(node_modules 등 무시된 파일)이 없어서일 수 있다.
      const blind = b.results.filter(x => !x.ok && !x.found);
      if (blind.length) {
        task.checks.baseline_warning = `the checks failed before the task without a readable test summary (${blind.map(x => `${x.command}: ${x.timed_out ? 'timed out' : `exit ${x.exit_code}`}`).join('; ')}) — this may be an environment problem in the new worktree (e.g. dependencies are not installed there; list them in .worktreeinclude), and such checks cannot show "not worse"`;
        log(`[pilot] ${task.id} — warning: ${task.checks.baseline_warning}`);
      }
      S.log(root, task.id, { event: 'baseline', ok: b.ok, pass: b.pass, fail: b.fail, warning: task.checks.baseline_warning || null });
      S.writeTask(root, task);
}

// commit 의 코드를 임시 worktree(.harness-worktrees/<id>-<suffix>)에 꺼내(무시된 의존성 복사 포함) fn(dir) 을 부르고 지운다.
async function withTree(root, task, commit, suffix, fn) {
  const P = S.taskPathsFor(root, task);
  const dir = path.join(path.dirname(P.wt), `${task.id}-${suffix}`);
  try {
    G.git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    G.git(root, ['worktree', 'add', '--detach', dir, commit], { retryLock: true });
    try { G.copyWorktreeInclude(root, dir); } catch { /* 복사 실패는 기준선 경고로 드러난다 */ }
    return await fn(dir);
  } finally {
    G.git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 다음 gc */ }
    G.git(root, ['worktree', 'prune'], { allowFail: true });
  }
}

// 늦은 기준선: 작업 시작 커밋에서 잰다. 이미 있거나 검사가 없으면 아무것도 안 한다. opts.o: { checkTimeoutMs, priority, freshBaseline }.
//   accept · cancel · restore · check(판정에 기준선이 필요할 때)가 쓴다.
async function ensureBaseline(root, task, opts) {
  if (task.checks.baseline || !(task.checks.commands || []).length) return false;
  const o = (opts && opts.o) || {}, log = (opts && opts.log) || (() => {});
  log(`[pilot] ${task.id} — checks failed; measuring the baseline at ${String(task.base_commit).slice(0, 10)} to tell old failures from new ones`);
  try {
    await withTree(root, task, task.base_commit, 'base', dir => measureBaseline(root, task, { source: task.checks.source, commands: task.checks.commands.slice() }, dir, o, log, task.base_commit));
  } catch (e) { task.checks.baseline_error = String(e.message).slice(0, 300); S.log(root, task.id, { event: 'baseline_error', error: task.checks.baseline_error }); }
}

// 다른 커밋(대상 브랜치 끝)에서 작업의 검사를 잰다 → 판정 객체(brief) · 실패하면 null. 캐시는 기준선과 같다(시간 초과는 쓰지 않는다).
async function measureAt(root, task, commit, opts) {
  const o = (opts && opts.o) || {}, log = (opts && opts.log) || (() => {});
  const cmds = task.checks.commands || [];
  if (!cmds.length || !commit) return null;
  const file = baselineCacheFile(root, task, cmds, commit, o.checkTimeoutMs);
  const hit = readCache(file);
  if (hit) return K.brief(hit);
  log(`[pilot] ${task.id} — measuring the checks at ${String(commit).slice(0, 10)} (the target as it is now) to tell whether it already fails without this work`);
  try {
    const b = await withTree(root, task, commit, 'target', dir => queued(root, task, o, 'target', async () => (await K.runJudged(dir, cmds, { timeoutMs: o.checkTimeoutMs, rerun: task.checks.rerun })).judged));
    writeCache(file, b);
    return K.brief(b);
  } catch (e) { S.log(root, task.id, { event: 'target_measure_error', error: String(e.message).slice(0, 300) }); return null; }
}

// 다른 커밋에서 린트 한 번 → runCheck 결과 · 실패하면 null. [G2 #20] v7 은 린트 기준선을 재지 않는다 — 저장소 전체 린트가 막을 때만 대상 끝에서 잰다.
async function lintAt(root, task, commit, argv, opts) {
  const o = (opts && opts.o) || {};
  try { return await withTree(root, task, commit, 'lint', dir => K.runCheck(dir, argv, { timeoutMs: o.checkTimeoutMs })); }
  catch (e) { S.log(root, task.id, { event: 'lint_measure_error', error: String(e.message).slice(0, 300) }); return null; }
}

module.exports = { ensureBaseline, measureBaseline, measureAt, lintAt, readBaselineCache, baselineCacheFile };

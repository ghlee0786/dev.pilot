'use strict';
// 늦은 기준선 — 합칠 때 검사가 실패하면 "원래부터 실패하던 것인가" 를 가리려고 작업 시작 커밋에서 같은 검사를 잰다(무인 루프에서 옮겨 옴).
//   캐시 · 멈춘 테스트 떼어 내기 · 시간 초과된 자동 검사 빼기 · 의존성 경고. accept · cancel · restore · check 가 쓴다.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const S = require('./state'), G = require('./git'), K = require('./checks');

// 기준선 — 작업 전 상태에서 검사를 잰다(캐시 · 멈춘 테스트 떼어 내기 · 시간 초과된 자동 검사 빼기 · 의존성 경고). dir: 작업 시작 시점의 코드가 있는 폴더.
//   [2026-10-21 평가 2단계 · D2] 기본은 늦게(lazy): 검사가 실패해 "원래부터 실패하던 것인가" 를 가려야 할 때만 별도 worktree 에서 잰다 —
//   빠른 모델(GPT-6.1 Sol)은 맨 실행 2~8분인데 하네스가 작업 전 전체 테스트에 17~44분을 써서 상한에 걸리고 정확도까지 잃었다.
async function measureBaseline(root, task, found, dir, o, log, baseCommit) {
      // 기준선 캐시: 같은 기준 커밋 · 같은 검사 · 같은 .worktreeinclude 내용이면 앞선 작업의 기준선을 다시 쓴다(느린 저장소에서 작업마다 수십 분).
      const cacheKey = crypto.createHash('sha1').update(JSON.stringify([baseCommit, found.commands, (task.worktree_include || []).map(x => `${x.path}:${x.sha1}`)])).digest('hex');
      const cacheFile = path.join(S.paths(root).harnessDir, 'baseline-cache', `${cacheKey}.json`);
      let b = null;
      if (!o.freshBaseline) { try { b = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { b = null; } }
      if (b) {
        log(`[pilot] ${task.id} — baseline reused from an earlier task on the same base commit (--fresh-baseline to rerun)`); task.checks.baseline_cached = true;
        if (b.commands) { found.commands = b.commands; task.checks.commands = b.commands; task.checks.hung = b.hung; }
      } else {
        b = (await K.runJudged(dir, found.commands, { timeoutMs: o.checkTimeoutMs, rerun: task.checks.rerun, serialRoot: task.checks.serial ? root : null })).judged;
        // 멈춘 테스트 떼어 내기(K.isolateHangs) — 시간 초과된 검사 가운데 언어 팩이 멈춘 테스트를 짚을 수 있는 것은 그 테스트를 빼고 다시 잰다. 사용자가 준 검사도.
        const hung = [];
        for (let i = 0; i < b.results.length; i++) {
          if (!b.results[i].timed_out) continue;
          const iso = await K.isolateHangs(dir, found.commands[i], { timeoutMs: o.checkTimeoutMs });
          if (!iso) continue;
          hung.push(...iso.excluded.map(t => ({ command: K.display(found.commands[i]), test: t })));
          found.commands = found.commands.map((c, k) => (k === i ? iso.argv : c));
          b.results[i] = iso.result;
        }
        if (hung.length) {
          b = { ...K.summarize(b.results), commands: found.commands, hung };
          task.checks.commands = found.commands; task.checks.hung = hung;
          log(`[pilot] ${task.id} — excluded tests that hung before the task (no output for ${Math.round(K.STALL_MS / 60000)} min): ${hung.map(h => h.test).join(' ; ')}`);
        }
        const slim = { ...b, results: (b.results || []).map(r => ({ ...r, output: undefined })) };
        try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(slim)); } catch { /* 캐시 실패는 작업을 멈추지 않는다 */ }
      }
      // [2026-10-16 자동 이슈 #13] 저장소에서 찾은 검사가 새 worktree 에서 작업 전부터 시간 초과 — 작업과 무관하게 정체됐다.
      //   자동으로 찾은 검사(사용자가 준 것이 아닌)는 기준선에서 시간 초과면 판정에서 빼고 알린다(남은 검사가 없으면 모델의 보고로 끝난다).
      if (found.source !== 'user' && b.results.some(x => x.timed_out)) {
        const keep = b.results.map(x => !x.timed_out);
        task.checks.dropped = found.commands.filter((_, i) => !keep[i]).map(cmd => ({ command: K.display(cmd), why: 'timed out before the task (baseline)' }));
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

function baselineCacheFile(root, task, commands, baseCommit) {
  const key = crypto.createHash('sha1').update(JSON.stringify([baseCommit, commands, (task.worktree_include || []).map(x => `${x.path}:${x.sha1}`)])).digest('hex');
  return path.join(S.paths(root).harnessDir, 'baseline-cache', `${key}.json`);
}
function readBaselineCache(root, task, commands, baseCommit) { try { return !!JSON.parse(fs.readFileSync(baselineCacheFile(root, task, commands, baseCommit), 'utf8')); } catch { return false; } }

// 늦은 기준선: 작업 시작 커밋의 코드를 별도 worktree 에 꺼내(무시된 의존성 복사 포함) 잰 뒤 지운다. 이미 있거나 검사가 없으면 아무것도 안 한다.
//   루프(검사 실패 때) · accept · cancel · restore(판정에 기준선이 필요할 때)가 쓴다.
async function ensureBaseline(root, task, opts) {
  if (task.checks.baseline || !(task.checks.commands || []).length) return false;
  const o = (opts && opts.o) || {}, log = (opts && opts.log) || (() => {});
  const P = S.taskPathsFor(root, task);
  const dir = path.join(path.dirname(P.wt), `${task.id}-base`);
  log(`[pilot] ${task.id} — checks failed; measuring the baseline at ${String(task.base_commit).slice(0, 10)} to tell old failures from new ones`);
  try {
    G.git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    G.git(root, ['worktree', 'add', '--detach', dir, task.base_commit], { retryLock: true });
    try { G.copyWorktreeInclude(root, dir); } catch { /* 복사 실패는 기준선 경고로 드러난다 */ }
    await measureBaseline(root, task, { source: task.checks.source, commands: task.checks.commands.slice() }, dir, o, log, task.base_commit);
  } catch (e) { task.checks.baseline_error = String(e.message).slice(0, 300); S.log(root, task.id, { event: 'baseline_error', error: task.checks.baseline_error }); }
  finally {
    G.git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 다음 gc */ }
    G.git(root, ['worktree', 'prune'], { allowFail: true });
  }
}

module.exports = { ensureBaseline, measureBaseline, readBaselineCache, baselineCacheFile };

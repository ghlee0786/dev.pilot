'use strict';
// 공장 총괄(PRD R4) — 계획(JSON) 검사 · 소유 경로 겹침 직렬화 · 병렬 카드 · 통합 브랜치에 하나씩 합류 · 검사 실패 시 되돌리고 다시 · 예산 · 사용자 브랜치 불변.
//   계획자와 작업자는 가짜 실행기(모델 호출 없음).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const F = require('../../harness/lib/factory');
const S = require('../../harness/lib/state');
const R = makeReporter('공장 총괄 — 계획 · 병렬 카드 · 합류 대기열');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-factory-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
let seq = 0;
// 검사: bad.txt 가 있으면 실패
const CHECK = "const fs=require('fs');if(fs.existsSync('bad.txt')){console.log('# pass 0\\n# fail 1');process.exit(1)}console.log('# pass 1\\n# fail 0')\n";
function repo() {
  const d = path.join(base, `r${++seq}`); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  write(path.join(d, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\n```\n'); write(path.join(d, 'check.js'), CHECK); write(path.join(d, 'README.md'), 'x\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
// 가짜 실행기: 계획자에게는 plans[n], 작업자에게는 카드별 동작
function fake(plans, workers, cost) {
  const calls = { plan: [], work: [] };
  const run = async o => {
    const ok = (extra) => ({ ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: cost == null ? 0.01 : cost, permission_denials: [], ...(extra || {}) });
    if (/You are the PLANNER/.test(o.prompt)) { calls.plan.push(o); return ok({ final_text: plans[Math.min(calls.plan.length - 1, plans.length - 1)], cost_usd: 0.01 }); }
    const card = (/card (\S+) of \d+/.exec(o.prompt) || [])[1];
    calls.work.push({ card, prompt: o.prompt, cwd: o.cwd, at: Date.now() });
    await new Promise(r => setTimeout(r, 30));
    await (workers[card] || (() => {}))(o, calls.work.filter(w => w.card === card).length);
    return ok();
  };
  return { run, calls };
}
const plan = cards => JSON.stringify({ contracts: 'module.exports names are the card ids', cards });

(async () => {
  try {
    // FA-01 — 계획 검사: 형식 · 순환 · 모르는 의존 · 겹치는 소유 경로는 직렬화
    const v1 = F.validatePlan({ cards: [{ id: 'a', goal: 'do the a thing well', owns: ['src/**'], depends_on: [] }, { id: 'b', goal: 'do the b thing well', owns: ['src/x/**'], depends_on: [] }] }, F.DEFAULTS);
    const v2 = F.validatePlan({ cards: [{ id: 'a', goal: 'do the a thing well', owns: ['x/**'], depends_on: ['b'] }, { id: 'b', goal: 'do the b thing well', owns: ['y/**'], depends_on: ['a'] }] }, F.DEFAULTS);
    const v3 = F.validatePlan({ cards: [{ id: 'a', goal: 'short', owns: [], depends_on: ['zz'] }] }, F.DEFAULTS);
    const v4 = F.validatePlan({ cards: [{ id: 'a', goal: 'do the a thing well', owns: ['../up/**'] }] }, F.DEFAULTS);
    R.check('[FA-01] 겹치는 소유 경로(src/** · src/x/**)는 오류가 아니라 뒤 카드를 앞 카드 뒤로 직렬화', !v1.errs.length && v1.serialized.join() === 'b after a', JSON.stringify(v1));
    R.check('[FA-01] 의존 순환 · 빈 소유 · 짧은 목표 · 모르는 의존 · 저장소 밖 경로는 거부', /cycle/.test(v2.errs.join()) && v3.errs.length >= 2 && /relative path/.test(v4.errs.join()), JSON.stringify({ v2, v3, v4 }));
    R.check('[FA-01] 겹침 판단: 접두가 겹치면 겹침 · 형제 폴더는 아님', F.overlaps(['src/**'], ['src/a/b.py']) && !F.overlaps(['src/a/**'], ['src/b/**']) && !F.overlaps(['docs'], ['docsx/a.md']));

    // FA-02 — 끝까지: 독립 카드 둘(병렬) + 의존 카드 하나(앞 카드가 합쳐진 뒤 그 결과에서 시작) → 통합 브랜치에 셋 · 사용자 브랜치 그대로
    const r2 = repo(), main0 = git(r2, 'rev-parse', 'main');
    const f2 = fake([plan([
      { id: 'c1', title: 'a', goal: 'create src/a/a.js exporting 1', owns: ['src/a/**'], depends_on: [], risk: 1 },
      { id: 'c2', title: 'b', goal: 'create src/b/b.js exporting 2', owns: ['src/b/**'], depends_on: [], risk: 1 },
      { id: 'c3', title: 'c', goal: 'create src/c/c.js using src/a', owns: ['src/c/**'], depends_on: ['c1'], risk: 2 }])], {
      c1: o => write(path.join(o.cwd, 'src/a/a.js'), 'module.exports = 1;\n'),
      c2: o => write(path.join(o.cwd, 'src/b/b.js'), 'module.exports = 2;\n'),
      c3: o => write(path.join(o.cwd, 'src/c/c.js'), fs.existsSync(path.join(o.cwd, 'src/a/a.js')) ? 'saw-a\n' : 'no-a\n'),
    });
    const g2 = await F.start({ ...quiet, root: r2, request: '세 모듈을 만들어라', run: f2.run, jobs: 3 });
    const run2 = F.readRun(r2, g2.id);
    const show = f => git(r2, 'show', `${run2.branch}:${f}`);
    R.check('[FA-02] 세 카드 모두 통합 브랜치에 합쳐지고(done) 파일이 다 있다', g2.status === 'done' && run2.cards.every(c => c.status === 'merged') && show('src/a/a.js') && show('src/b/b.js') && show('src/c/c.js'), JSON.stringify({ status: g2.status, reason: g2.reason, cards: run2.cards.map(c => [c.id, c.status, c.reason]) }));
    R.check('[FA-02] 의존 카드는 앞 카드가 합쳐진 통합 브랜치에서 시작한다(src/a 를 본다)', show('src/c/c.js').trim() === 'saw-a', show('src/c/c.js'));
    const w = f2.calls.work, s1 = w.find(x => x.card === 'c1'), s2 = w.find(x => x.card === 'c2');
    // 시각이 아니라 공장 기록의 순서로(부하에 흔들리지 않게): c2 는 c1 이 합쳐지기 전에 시작 · c3 는 c1 이 합쳐진 뒤 시작
    const ev2 = fs.readFileSync(F.dirs(r2, g2.id).logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const at = (e, card) => ev2.findIndex(x => x.event === e && x.card === card);
    R.check('[FA-02] 독립 카드는 동시에 돈다(c2 가 c1 합류 전에 시작) · 의존 카드는 앞 카드가 합쳐진 뒤 시작', s1 && s2 && at('card_start', 'c2') < at('card_merged', 'c1') && at('card_start', 'c3') > at('card_merged', 'c1'), JSON.stringify(ev2.map(x => [x.event, x.card])));
    // FA-02b — [2026-10-21 사용자 지시 · thin] 기본 공장: 카드는 thin 작업자 · 시험 웨이브(모델이 찾고 모델이 확인)는 --verify 일 때만
    R.check('[FA-02b] 기본 공장 — 카드 작업은 thin 모드 · 시험 웨이브 없음(verify 기록 없음 · 시험 에이전트 호출 없음)',
      run2.cards.every(k => (k.task_ids || []).every(id => require('../../harness/lib/state').readTask(r2, id).mode === 'thin')) && !run2.verify && f2.calls.work.every(w => w.card),
      JSON.stringify({ verify: !!run2.verify, modes: run2.cards.map(k => (k.task_ids || []).map(id => require('../../harness/lib/state').readTask(r2, id).mode)) }));
    R.check('[FA-02] 사용자 브랜치(main)는 그대로 · 계획 · 통합 worktree 는 치웠다', git(r2, 'rev-parse', 'main') === main0 && !/-plan|-int/.test(git(r2, 'worktree', 'list')), git(r2, 'worktree', 'list'));
    R.check('[FA-02] 카드 작업은 소유 경로를 받는다(작업 기록 · 지시문) · 지시문에 전체 요구 · 계약 · 이미 합쳐진 카드', run2.cards.every(c => c.task_ids.length && JSON.stringify(S.readTask(r2, c.task_ids[0]).owns) === JSON.stringify(c.owns))
      && /Overall request: 세 모듈을 만들어라/.test(w.find(x => x.card === 'c3').prompt) && /Contracts every card follows/.test(w.find(x => x.card === 'c3').prompt) && /Already merged into the code you start from: c1/.test(w.find(x => x.card === 'c3').prompt), w.find(x => x.card === 'c3').prompt.slice(-600));
    R.check('[FA-02] 보고: 통합 브랜치 · 카드별 상태 · 사용자 브랜치 불변 · 받아들이기는 사용자가 말한 뒤', /통합 브랜치: harness\/factory\/f-/.test(g2.report) && /c3 MERGED/.test(g2.report) && /사용자 브랜치는 그대로다/.test(g2.report) && /factory accept/.test(g2.report), g2.report);

    // FA-03 — 잘못된 계획은 이유와 함께 한 번 돌려보낸다 · 두 번 틀리면 error
    const r3 = repo();
    const f3 = fake(['not json at all', plan([{ id: 'x', title: 'x', goal: 'create src/x/x.js exporting 9', owns: ['src/x/**'], depends_on: [] }])], { x: o => write(path.join(o.cwd, 'src/x/x.js'), '9\n') });
    const g3 = await F.start({ ...quiet, root: r3, request: 'make x', run: f3.run });
    R.check('[FA-03] 첫 계획이 형식 밖이면 이유를 붙여 다시 묻고, 두 번째로 진행', g3.status === 'done' && f3.calls.plan.length === 2 && /Your previous plan was rejected/.test(f3.calls.plan[1].prompt) && f3.calls.plan[0].workerPermissions === 'strict', JSON.stringify({ s: g3.status, n: f3.calls.plan.length }));
    const f3b = fake(['{}', '{"cards":[]}'], {});
    const g3b = await F.start({ ...quiet, root: repo(), request: 'make y', run: f3b.run });
    R.check('[FA-03] 두 번 모두 틀리면 error(작업을 시작하지 않는다)', g3b.status === 'error' && !f3b.calls.work.length && /did not produce a valid plan/.test(g3b.reason), JSON.stringify(g3b));
    // FA-03c — [2026-10-21 평가에서 발견] Codex 공장의 계획 에이전트에 모델 'opus' 를 넘겨 5초 만에 실패했고, 그 오류가 "JSON 이 아니다" 로 가려졌다
    const callsC = [];
    const runC = async o => { callsC.push(o); return { ok: false, is_error: true, error_kind: 'model', error_message: 'unknown model', session_id: null, final_text: '', cost_usd: null, permission_denials: [] }; };
    const g3c = await F.start({ ...quiet, root: repo(), request: 'make z', run: runC, runtime: 'codex' });
    R.check('[FA-03c] Codex 공장: 계획 에이전트에 Claude 모델 이름을 넘기지 않는다 · 러너 오류는 이유에 그대로', callsC.length >= 1 && callsC.every(o => o.model == null && o.runtime === 'codex') && /planner session failed \(model\): unknown model/.test(g3c.reason),
      JSON.stringify({ models: callsC.map(o => o.model), reason: g3c.reason }));

    // FA-04 — 각자는 통과하지만 합치면 깨지는 조합(의미 충돌): 뒤에 합친 카드를 되돌리고(revert) 이유와 함께 최신 통합 상태에서 다시 → 고치면 merged
    const r4 = repo();
    write(path.join(r4, 'check.js'), "const fs=require('fs');if(fs.existsSync('src/a/flag')&&fs.existsSync('src/b/flag')){console.log('# pass 0\\n# fail 1');process.exit(1)}console.log('# pass 1\\n# fail 0')\n");
    git(r4, 'add', '-A'); git(r4, 'commit', '-qm', 'combo check');
    const f4 = fake([plan([{ id: 'ka', title: 'ka', goal: 'create src/a/flag and src/a/a.js', owns: ['src/a/**'], depends_on: [] }, { id: 'kb', title: 'kb', goal: 'create src/b/b.js (and maybe a flag)', owns: ['src/b/**'], depends_on: [] }])], {
      ka: o => { write(path.join(o.cwd, 'src/a/a.js'), '1\n'); write(path.join(o.cwd, 'src/a/flag'), 'x\n'); },
      // 병렬 — kb 의 첫 시도는 ka 가 합쳐질 때까지 기다린다(합류 순서 고정 · 시각에 기대지 않음): 각자는 초록 · 합치면 빨강 → kb 를 되돌리고 다시
      kb: async (o, n) => {
        if (n === 1) { const fid = /factory run (f-[\w-]+)/.exec(o.prompt)[1]; for (let i = 0; i < 600; i++) { const rr = F.readRun(r4, fid); if (rr && rr.cards.find(c => c.id === 'ka').status === 'merged') break; await new Promise(r => setTimeout(r, 100)); } }
        write(path.join(o.cwd, 'src/b/b.js'), '2\n'); if (n === 1) write(path.join(o.cwd, 'src/b/flag'), 'x\n'); },
    });
    const g4 = await F.start({ ...quiet, root: r4, request: 'make ka kb', run: f4.run });
    const run4 = F.readRun(r4, g4.id), kb = run4.cards.find(c => c.id === 'kb');
    const wk = f4.calls.work.filter(x => x.card === 'kb');
    R.check('[FA-04] 합친 뒤 검사 실패 → 그 카드를 되돌리고 이유를 지시문에 넣어 다시 → 두 번째에 merged · 통합 브랜치는 초록', g4.status === 'done' && kb.attempts === 2 && wk.length === 2 && /could not be merged: checks fail after merging/.test(wk[1].prompt) && !git(r4, 'ls-tree', '-r', '--name-only', run4.branch).split('\n').includes('src/b/flag'), JSON.stringify({ s: g4.status, reason: g4.reason, kb }));
    R.check('[FA-04] 되돌림은 기록으로 남는다(revert 커밋 — reset 하지 않는다)', /Revert/.test(git(r4, 'log', '--format=%s', run4.branch)), git(r4, 'log', '--format=%s', run4.branch));

    // FA-05 — 예산: 쓴 돈이 상한에 닿으면 새 카드를 시작하지 않는다(나머지는 skipped) · 앞 카드가 실패하면 의존 카드는 skipped
    const r5 = repo();
    const f5 = fake([plan([{ id: 'p', title: 'p', goal: 'create src/p/p.js exporting 1', owns: ['src/p/**'] }, { id: 'q', title: 'q', goal: 'create src/q/q.js exporting 2', owns: ['src/q/**'] }, { id: 'r', title: 'r', goal: 'create src/r/r.js exporting 3', owns: ['src/r/**'] }])],
      { p: o => write(path.join(o.cwd, 'src/p/p.js'), '1\n'), q: o => write(path.join(o.cwd, 'src/q/q.js'), '2\n'), r: o => write(path.join(o.cwd, 'src/r/r.js'), '3\n') }, 5);
    const g5 = await F.start({ ...quiet, root: r5, request: 'make p q r', run: f5.run, jobs: 1, budgetUsd: 6 });
    const run5 = F.readRun(r5, g5.id);
    R.check('[FA-05] 예산 상한에 닿으면 남은 카드는 skipped(budget) · 상태 partial', g5.status === 'partial' && run5.cards.some(c => c.status === 'skipped' && /budget/.test(c.reason)) && run5.cards.filter(c => c.status === 'merged').length >= 1, JSON.stringify(run5.cards.map(c => [c.id, c.status, c.reason])));
    const r6 = repo();
    const f6 = fake([plan([{ id: 'a', title: 'a', goal: 'this card cannot be done at all', owns: ['src/a/**'] }, { id: 'b', title: 'b', goal: 'create src/b/b.js after a', owns: ['src/b/**'], depends_on: ['a'] }])],
      { a: o => { const id = /\.harness\/(t-[\w-]+)\//.exec(o.prompt)[1]; write(path.join(o.cwd, '.harness', id, 'BLOCKED.md'), 'cannot\n'); } });
    const g6 = await F.start({ ...quiet, root: r6, request: 'a then b', run: f6.run });
    const run6 = F.readRun(r6, g6.id);
    R.check('[FA-05] 카드 작업이 끝내지 못하면 failed · 그 카드에 의존하는 카드는 skipped · 상태 failed', run6.cards[0].status === 'failed' && run6.cards[1].status === 'skipped' && g6.status === 'failed', JSON.stringify(run6.cards.map(c => [c.id, c.status, c.reason])));

    // FA-07 — 받아들이기(factory accept): 기준 브랜치에서만 · 병합이 바꿀 파일에 미커밋 변경이 있으면 거부 · 아니면 --no-ff 병합
    const run2b = F.readRun(r2, g2.id);
    git(r2, 'checkout', '-q', '-b', 'other');
    const a1 = F.accept({ root: r2, fid: g2.id });
    git(r2, 'checkout', '-q', 'main');
    fs.mkdirSync(path.join(r2, 'src', 'a'), { recursive: true }); write(path.join(r2, 'src/a/a.js'), 'local edit\n');
    const a2 = F.accept({ root: r2, fid: g2.id });
    fs.rmSync(path.join(r2, 'src'), { recursive: true, force: true });
    const a3 = F.accept({ root: r2, fid: g2.id });
    R.check('[FA-07] 다른 브랜치에 있으면 · 겹치는 미커밋 변경이 있으면 거부(아무것도 바꾸지 않는다)', a1.refused && /switch it to main/.test(a1.reason) && a2.refused && /uncommitted changes .*src\/a\/a\.js/.test(a2.reason), JSON.stringify([a1.reason, a2.reason]));
    R.check('[FA-07] 받아들이면 통합 브랜치가 main 에 병합된다(파일 · 병합 커밋) · 두 번은 거부', a3.status === 'accepted' && fs.existsSync(path.join(r2, 'src/c/c.js')) && git(r2, 'rev-parse', 'HEAD^2') === run2b.head && F.accept({ root: r2, fid: g2.id }).refused, JSON.stringify(a3));

    // FA-08 — CLI: 분리된 프로세스에서 돌고 부른 쪽은 끝날 때까지 기다려 보고를 낸다(가짜 실행기 모듈 주입)
    const r8 = repo();
    const runner = path.join(base, 'fake-runner.js');
    write(runner, `const fs=require('fs'),p=require('path');exports.run=async o=>{const ok=x=>Object.assign({ok:true,is_error:false,session_id:o.newSessionId||o.sessionId,final_text:'ok',cost_usd:0.01,permission_denials:[]},x||{});
if(/You are the PLANNER/.test(o.prompt))return ok({final_text:JSON.stringify({contracts:'',cards:[{id:'z',title:'z',goal:'create src/z/z.js exporting 7',owns:['src/z/**'],depends_on:[]}]})});
fs.mkdirSync(p.join(o.cwd,'src','z'),{recursive:true});fs.writeFileSync(p.join(o.cwd,'src','z','z.js'),'7\\n');return ok();};\n`);
    const cli = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'harness', 'cli.js'), 'factory', '모듈 z 를 만들어라', '--root', r8], { encoding: 'utf8', windowsHide: true, timeout: 240000, env: { ...process.env, HARNESS_RUNNER_MODULE: runner, HARNESS_DOCKER_CLEANUP: 'off' } });
    const runs8 = F.listRuns(r8);
    R.check('[FA-08] CLI factory: 분리된 프로세스에서 끝까지(done) · 부른 쪽이 보고를 낸다 · 진행 줄 · 결과 줄', cli.status === 0 && runs8.length === 1 && runs8[0].status === 'done' && runs8[0].owner.pid !== process.pid && /pilot factory f-.* — DONE/.test(cli.stdout) && /분리된 프로세스/.test(cli.stderr), `${cli.status}\n${cli.stdout.slice(-800)}\n${cli.stderr.slice(-800)}`);
    const st8 = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'harness', 'cli.js'), 'factory', 'status', '--root', r8], { encoding: 'utf8', windowsHide: true });
    R.check('[FA-08] CLI factory status · 잘못된 id 는 사용법 오류(2)', st8.status === 0 && /DONE/.test(st8.stdout) && spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'harness', 'cli.js'), 'factory', 'wait', 'nope', '--root', r8], { encoding: 'utf8', windowsHide: true }).status === 2, st8.stdout);

    // FA-09 — 검증 라인(PRD R6): 시험 설계 → 시험 에이전트(제품 코드는 못 씀) → 중복 묶기 → 독립 재현 → 재현된 결함만 수정 카드 → 같은 합류 대기열 → 발견율이 낮으면 멈춤
    const r9 = repo();
    const calls9 = { strat: 0, testers: [], repro: [], fix: [] };
    const tid = o => /\.harness\/(t-[\w-]+)\//.exec(o.prompt)[1];
    const run9 = async o => {
      const ok = x => ({ ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.01, permission_denials: [], ...(x || {}) });
      if (/You are the PLANNER/.test(o.prompt)) return ok({ final_text: plan([{ id: 'c1', title: 'a', goal: 'create src/a/a.js with add()', owns: ['src/a/**'], depends_on: [] }]) });
      if (/You are the TEST STRATEGIST/.test(o.prompt)) {
        calls9.strat++;
        return ok({ final_text: JSON.stringify({ charters: calls9.strat === 1 ? [{ id: 'q1', kind: 'boundary', mission: 'call add with negative numbers', area: ['src/a/a.js'], oracle: 'add returns the sum' }, { id: 'q2', kind: 'scenario', mission: 'use add in a flow', area: ['src/a/a.js'], oracle: 'add returns the sum' }]
          : [{ id: 'q9', kind: 'regression', mission: 'check add again near the fixed bug', area: ['src/a/a.js'], oracle: 'add returns the sum' }] }) });
      }
      if (/You are a TESTER/.test(o.prompt)) {
        const ch = /charter (\S+),/.exec(o.prompt)[1]; calls9.testers.push({ ch, prompt: o.prompt });
        const bugA = { title: 'add returns wrong sum for negative numbers', severity: 'high', area: 'src/a/a.js', repro: 'node -e add(-1,-2)', expected: '-3', actual: '3' };
        const bugB = { title: 'add is slow on large inputs maybe', severity: 'low', area: 'src/a/a.js', repro: 'loop', expected: 'fast', actual: 'slow?' };
        const list = ch === 'w1-q1' ? [bugA] : ch === 'w1-q2' ? [{ ...bugA, title: 'add returns the wrong sum for negative numbers' }, bugB] : [];
        write(path.join(o.cwd, '.harness', tid(o), 'FINDINGS.json'), JSON.stringify(list));
        return ok();
      }
      if (/You are a REPRODUCER/.test(o.prompt)) {
        calls9.repro.push(o.prompt);
        write(path.join(o.cwd, '.harness', tid(o), 'REPRO.json'), JSON.stringify({ reproduced: /negative numbers/.test(o.prompt), how: 'ran it', observed: 'x' }));
        return ok();
      }
      if (/Fix this confirmed defect/.test(o.prompt)) { calls9.fix.push(o.prompt); write(path.join(o.cwd, 'src/a/a.js'), 'module.exports = (a, b) => a + b; // fixed\n'); return ok(); }
      write(path.join(o.cwd, 'src/a/a.js'), 'module.exports = (a, b) => Math.abs(a) + Math.abs(b);\n');
      return ok();
    };
    const g9 = await F.start({ ...quiet, root: r9, request: 'add 함수를 만들어라', run: run9, jobs: 2, verify: true, testAgents: 3, waves: 3 });   // 시험 웨이브는 이제 --verify 일 때만
    const run9r = F.readRun(r9, g9.id), V9 = run9r.verify;
    const fA = V9.findings.find(x => /negative/.test(x.title)), fB = V9.findings.find(x => /slow/.test(x.title));
    R.check('[FA-09] 시험 설계가 낸 차터마다 시험 에이전트 · 같은 결함 둘은 하나로 묶인다(보고 2) · 고유 결함 2', calls9.testers.length >= 2 && V9.findings.length === 2 && fA && fA.reports === 2, JSON.stringify(V9.findings.map(x => [x.id, x.status, x.reports, x.title])));
    R.check('[FA-09] 다른 에이전트가 독립 재현 — 재현된 것만 결함(A) · 재현 안 된 것(B)은 고치지 않는다', fA.status === 'fixed' && fB.status === 'not_reproduced' && calls9.repro.length === 2 && calls9.fix.length === 1, JSON.stringify({ A: fA.status, B: fB.status, repro: calls9.repro.length, fix: calls9.fix.length }));
    R.check('[FA-09] 수정 카드: 그 영역을 소유한 카드의 소유 경로 · 회귀 시험 요구 · 같은 합류 대기열로 merged · 통합 브랜치에 수정', run9r.cards.some(k => k.fix_of === fA.id && k.status === 'merged' && k.owns.includes('src/a/**')) && /regression test that fails before your fix/.test(calls9.fix[0]) && /fixed/.test(git(r9, 'show', `${run9r.branch}:src/a/a.js`)), JSON.stringify(run9r.cards.map(k => [k.id, k.status, k.owns])));
    R.check('[FA-09] 시험 · 재현 작업은 제품 코드를 소유하지 못한다(.harness-qa/** 만)', V9.task_ids.every(id => JSON.stringify(S.readTask(r9, id).owns) === JSON.stringify(['.harness-qa/**'])) && V9.task_ids.length >= 4, JSON.stringify(V9.task_ids.map(id => S.readTask(r9, id).owns)));
    R.check('[FA-09] 파도: 1차 발견율(1/2)이 기준 이상이라 2차는 결함 주변으로(초점) · 2차에서 새 결함 0 → 멈춤', V9.waves.length === 2 && calls9.strat === 2 && /yield 0 </.test(V9.stop_reason) && calls9.testers.some(t => t.ch === 'w2-q9') && g9.status === 'done', JSON.stringify({ waves: V9.waves.map(w => [w.wave, w.testers, w.confirmed, w.yield]), stop: V9.stop_reason, status: g9.status }));
    R.check('[FA-09] 계획 · 통합 · 시험 설계 worktree 는 빈 폴더까지 치운다', !(fs.existsSync(path.join(r9, '.harness-worktrees')) ? fs.readdirSync(path.join(r9, '.harness-worktrees')) : []).some(n => /^f-.*-(plan|int|int-qad+)$/.test(n)), JSON.stringify(fs.existsSync(path.join(r9, '.harness-worktrees')) ? fs.readdirSync(path.join(r9, '.harness-worktrees')) : []));
    R.check('[FA-09] 보고에 검증 라인(파도 · 시험 에이전트 · 고유 · 재현 · 고침)과 결함별 상태', /검증 라인: 파도 2 · 시험 에이전트 3 · 보고 3 · 고유 2 · 재현됨 1 \(고침 1\)/.test(g9.report) && /f\d FIXED \[high\]/.test(g9.report) && /NOT_REPRODUCED/.test(g9.report), g9.report);

    // FA-10 — [자동 이슈 #44 #45] factory 도 go 처럼 "-"(stdin) · --goal-file 로 요청을 받는다 — "-" 를 요청 본문으로 쓰거나 --goal-file 을 버리지 않는다 · 두 곳에서 주면 사용법 오류
    const CLI = require('../../harness/cli.js');
    const planOf = async argv => { const fk = fake(['not json'], {}); const errs = []; const code = await CLI.main(argv, { run: fk.run, stdin: '표준 입력 요청 STDIN-BODY', out: () => {}, err: s => errs.push(s) }); return { code, prompt: (fk.calls.plan[0] || {}).prompt || '', errs: errs.join('\n') }; };
    const r10 = repo(); const gf10 = path.join(base, 'goal10.txt'); write(gf10, '﻿파일 요청 FILE-BODY\n');
    const s10 = await planOf(['factory', '-', '--root', r10]), f10 = await planOf(['factory', '--goal-file', gf10, '--root', r10]), b10 = await planOf(['factory', '-', '--goal-file', gf10, '--root', r10]);
    R.check('[FA-10] (#44 #45) factory - · --goal-file — 계획자가 받는 요청이 stdin · 파일 본문 · 둘 다 주면 2(회차 없음)', /STDIN-BODY/.test(s10.prompt) && /FILE-BODY/.test(f10.prompt) && b10.code === 2 && !b10.prompt,
      JSON.stringify({ s: s10.prompt.slice(0, 80), f: f10.prompt.slice(0, 80), b: b10.code, e: b10.errs.slice(0, 120) }));

    // FA-11 — [2026-10-25 사용 분석] 통합 브랜치 검사가 한 번만 흔들려 실패(다시 돌리면 통과)하면 카드를 되돌리지 않는다 — go · accept 처럼 실패한 검사를 한 번 더 돌린다
    const r11 = repo(), flag11 = JSON.stringify(path.join(base, 'flaky11.flag'));
    write(path.join(r11, 'check.js'), `const fs=require('fs');if(fs.existsSync('src/a/a.js')&&/-int/.test(process.cwd())&&!fs.existsSync(${flag11})){fs.writeFileSync(${flag11},'x');console.log('# pass 0\\n# fail 1');process.exit(1)}console.log('# pass 1\\n# fail 0')\n`);
    git(r11, 'add', '-A'); git(r11, 'commit', '-qm', 'flaky check');
    const f11 = fake([plan([{ id: 'ka', title: 'ka', goal: 'create src/a/a.js', owns: ['src/a/**'], depends_on: [] }])], { ka: o => write(path.join(o.cwd, 'src/a/a.js'), '1\n') });
    const g11 = await F.start({ ...quiet, root: r11, request: 'make ka', run: f11.run });
    const ka11 = F.readRun(r11, g11.id).cards.find(c => c.id === 'ka');
    R.check('[FA-11] 통합 검사가 한 번 흔들려도(다시 돌리면 통과) 카드를 되돌려 다시 돌리지 않는다 — 한 번에 merged · 작업자 1회', g11.status === 'done' && ka11.status === 'merged' && ka11.attempts === 1 && f11.calls.work.length === 1 && fs.existsSync(JSON.parse(flag11)),
      JSON.stringify({ s: g11.status, why: g11.reason, st: ka11.status, at: ka11.attempts, w: f11.calls.work.length }));

    // FA-13 — [자동 이슈 #51] 검사가 추적 파일을 다시 쓰면(통합 worktree 가 더러워짐) 카드 병합이 실패해 같은 카드를 처음부터 다시 돌렸다 —
    //   통합 worktree 의 검사가 바꾼 추적 파일은 검사 뒤 되돌린다(그 worktree 는 하네스만 쓴다)
    const r13 = repo();
    write(path.join(r13, 'check.js'), "const fs=require('fs');fs.mkdirSync('gen',{recursive:true});fs.writeFileSync('gen/stamp.txt',process.cwd()+'\\n');console.log('# pass 1\\n# fail 0')\n");
    write(path.join(r13, 'gen/stamp.txt'), 'init\n');
    git(r13, 'add', '-A'); git(r13, 'commit', '-qm', 'check rewrites a tracked file');
    const f13 = fake([plan([{ id: 'ka', title: 'ka', goal: 'create src/a/a.js and refresh gen/stamp.txt', owns: ['src/a/**', 'gen/**'], depends_on: [] }])],
      { ka: o => { write(path.join(o.cwd, 'src/a/a.js'), '1\n'); write(path.join(o.cwd, 'gen/stamp.txt'), 'card\n'); } });
    const g13 = await F.start({ ...quiet, root: r13, request: 'make ka', run: f13.run });
    const ka13 = F.readRun(r13, g13.id).cards.find(c => c.id === 'ka');
    R.check('[FA-13] (#51) 검사가 추적 파일을 다시 써도 카드 병합이 실패하지 않는다 — 한 번에 merged · 작업자 1회 · 통합 브랜치에 카드의 내용', g13.status === 'done' && ka13.status === 'merged' && ka13.attempts === 1 && f13.calls.work.length === 1 && git(r13, 'show', `${F.readRun(r13, g13.id).branch}:gen/stamp.txt`) === 'card',
      JSON.stringify({ s: g13.status, why: g13.reason, st: ka13.status, at: ka13.attempts, r: ka13.reason, note: ka13.retry_note }));

    // FA-12 — [2026-10-25 사용 분석] 프로세스가 죽은 실행은 status · 보고에 OWNER DEAD 가 붙는다(살아 있는 실행 · 끝난 실행은 붙지 않는다)
    const run12 = F.readRun(r11, g11.id), dead12 = { ...run12, status: 'running', owner: { pid: 2147483646, host: os.hostname() } };
    fs.writeFileSync(F.dirs(r11, g11.id).file, JSON.stringify(dead12));
    const st12 = F.status(r11), rp12 = F.report(r11, F.readRun(r11, g11.id));
    fs.writeFileSync(F.dirs(r11, g11.id).file, JSON.stringify({ ...dead12, owner: { pid: process.pid, host: os.hostname() } }));
    const live12 = F.status(r11);
    R.check('[FA-12] 죽은 실행은 RUNNING · OWNER DEAD(status · 보고) · 살아 있으면 붙지 않는다', /RUNNING · OWNER DEAD/.test(st12) && /RUNNING · OWNER DEAD/.test(rp12.split('\n')[0]) && !/OWNER DEAD/.test(live12) && !/OWNER DEAD/.test(F.status(r2)), JSON.stringify({ st12, live12 }));

    // FA-06 — 상태 · 멈춤
    R.check('[FA-06] factory status 는 실행마다 한 줄', F.status(r2).split('\n').length === 1 && /ACCEPTED/.test(F.status(r2)), F.status(r2));   // FA-07 이 받아들인 뒤
    R.check('[FA-06] 끝난 실행의 멈춤 요청은 "not running"', F.requestStop(r2, g2.id).reason === 'not running');
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 1200)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

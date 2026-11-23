'use strict';
// 다음 batch 후보 표시 — `ready <id> [--note] | --clear` · status 의 ready{…, fresh} · batch --ready(신선한 표시만 · 표시 뒤 커밋은 건너뜀) · --all 의미 불변.
//   [dev.pilot #87] 표적 시험까지 끝났지만 이번 클로징 밖이라 기다리는 레인을 status 가 일반 열린 레인과 구분하지 못해 batch 대기열에서 빠졌다.
//   모델은 부르지 않는다 · 저장소는 모두 임시 디렉터리 · 플랫폼 세션 목록은 없는 파일(진짜 claude agents 를 부르지 않는다).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-ready-'));
process.env.HARNESS_AGENTS_JSON = path.join(base, 'agents.json');
delete process.env.HARNESS_AGENTS_CMD; delete process.env.HARNESS_AGENTS;
const S = require('../../harness/lib/state');
const Lane = require('../../harness/lib/lane');
const B = require('../../harness/lib/batch');
const I = require('../../harness/lib/integrate');
const St = require('../../harness/lib/status');
const R = makeReporter('v5 ready — 다음 batch 후보 표시 · status · batch --ready');

const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (cwd, args) => (spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
let seq = 0;
function mkRepo() {
  const dir = path.join(base, `r${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']); git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  write(path.join(dir, 'check.js'), "console.log('# pass 1\\n# fail 0')");
  write(path.join(dir, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\n```\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return dir;
}
const commitIn = (wt, f, t) => { write(path.join(wt, f), t); git(wt, ['add', '--', f]); git(wt, ['commit', '-qm', `edit ${f}`, '--', f]); };
const lane = (repo, goal, edits) => { const l = Lane.start({ ...quiet, root: repo, goal }); const wt = S.taskPaths(repo, l.id).wt; for (const [f, t] of Object.entries(edits)) commitIn(wt, f, t); return { ...l, wt }; };
const taskFile = (repo, id) => read(S.taskPaths(repo, id).taskFile);
const tip = (repo, id) => git(repo, ['rev-parse', `harness/${id}`]);
const OLD_KEYS = ['id', 'status', 'mode', 'reason', 'goal', 'runtime', 'owner', 'stale', 'branch', 'branch_exists', 'base_branch', 'files_changed', 'cost_usd', 'worktree', 'merge_commit', 'updated_at'];

(async () => {
  try {
    const A = mkRepo();
    const la = lane(A, 'lane a', { 'a.txt': 'a\n' });
    const ld = lane(A, 'lane d (not marked)', { 'd.txt': 'd\n' });

    // RD-01 표시 — 상태는 그대로 open · ready { at, tip = 레인 끝, note(한 줄) } · 기록 ready_marked · CLI 는 HARNESS_RESULT
    const r1 = B.markReady({ root: A, id: la.id, note: 'targeted 211/0\r\nsecond line' });
    const t1 = S.readTask(A, la.id);
    R.check('[RD-01] ready <id> --note — 상태 open 그대로 · ready.tip = 레인 끝 · 메모는 한 줄 · 기록 ready_marked',
      !r1.refused && t1.status === 'open' && t1.ready && t1.ready.tip === tip(A, la.id) && t1.ready.note === 'targeted 211/0 second line' && !!Date.parse(t1.ready.at) &&
      S.readLog(A, la.id).some(e => e.event === 'ready_marked' && e.tip === t1.ready.tip), JSON.stringify({ r1, ready: t1.ready }));
    const c1 = spawnSync(process.execPath, [CLI, 'ready', la.id, '--note', 'cli mark', '--root', A], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const res1 = JSON.parse((/HARNESS_RESULT (.*)$/m.exec(c1.stdout) || [])[1] || '{}');
    R.check('[RD-01] CLI ready — exit 0 · HARNESS_RESULT 에 ready · 다시 부르면 덮어쓴다(메모 바뀜)', c1.status === 0 && res1.ready && res1.ready.note === 'cli mark' && S.readTask(A, la.id).ready.note === 'cli mark', `${c1.status} ${c1.stdout.slice(-300)} ${c1.stderr.slice(0, 200)}`);
    const c0 = spawnSync(process.execPath, [CLI, 'ready', '--root', A], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    R.check('[RD-01] CLI ready 에 id 가 없으면 사용법 오류 2', c0.status === 2, `${c0.status} ${c0.stderr.slice(0, 200)}`);

    // RD-02 주인 모를 미커밋이 있으면 거부 · task.json 불변 / 검사 캐시만 있으면 표시한다(반증 짝)
    const lb = lane(A, 'lane b', { 'b.txt': 'b\n' });
    write(path.join(lb.wt, 'notes.txt'), 'someone else\n');
    const before2 = taskFile(A, lb.id);
    const r2 = B.markReady({ root: A, id: lb.id });
    R.check('[RD-02] 레인에 주인 모를 미커밋(일반 미추적 파일)이 있으면 거부 — 이유에 그 파일 · task.json 바이트 그대로 · 파일도 그대로',
      r2.refused === true && /notes\.txt/.test(r2.reason) && taskFile(A, lb.id) === before2 && read(path.join(lb.wt, 'notes.txt')) === 'someone else\n', JSON.stringify(r2));
    fs.rmSync(path.join(lb.wt, 'notes.txt'));
    write(path.join(lb.wt, '__pycache__', 'x.cpython-312.pyc'), 'cache');
    const r2b = B.markReady({ root: A, id: lb.id });
    R.check('[RD-02] 검사 캐시만 남았으면 표시한다(캐시는 주인 모를 변경이 아니다 — batch 규칙과 같다)', !r2b.refused && S.readTask(A, lb.id).ready && S.readTask(A, lb.id).ready.tip === tip(A, lb.id), JSON.stringify(r2b));
    B.markReady({ root: A, id: lb.id, clear: true });

    // RD-03 accepted · cancelled · running 은 거부 — 상태 · 파일 그대로
    const got3 = [];
    for (const st of ['accepted', 'cancelled', 'running']) {
      const lx = lane(A, `lane ${st}`, { [`${st}.txt`]: 'x\n' });
      const tx = S.readTask(A, lx.id); tx.status = st; S.writeTask(A, tx);
      const bx = taskFile(A, lx.id), rx = B.markReady({ root: A, id: lx.id });
      got3.push([st, rx.refused === true && new RegExp(st).test(rx.reason) && taskFile(A, lx.id) === bx]);
      tx.status = 'cancelled'; S.writeTask(A, tx);   // 뒤 사례의 --all 에 끼지 않게
    }
    R.check('[RD-03] accepted · cancelled · running 작업은 표시하지 않는다(refused · task.json 그대로)', got3.every(x => x[1]), JSON.stringify(got3));

    // RD-04 status --json · 텍스트
    const s4 = St.status({ root: A });
    const ta = s4.tasks.find(t => t.id === la.id), td = s4.tasks.find(t => t.id === ld.id);
    R.check('[RD-04] status --json — 표시한 레인은 ready{at,tip,note,fresh:true} · 표시 없는 레인은 ready null · 기존 키는 모두 그대로(더하기만)',
      ta && ta.ready && ta.ready.fresh === true && ta.ready.tip === tip(A, la.id) && ta.ready.note === 'cli mark' && td && td.ready === null && OLD_KEYS.every(k => k in td) && OLD_KEYS.every(k => k in ta), JSON.stringify({ ta: ta && ta.ready, keys: td && Object.keys(td) }));
    const txt4 = St.formatStatus(s4), ko4 = St.formatStatus({ ...s4, language: 'Korean' });
    const line = txt4.split('\n').find(l => l.includes(la.id)) || '';
    R.check('[RD-04] 텍스트 — 표시한 레인 줄 끝에 후보 꼬리(시각 · 메모) · 표시 없는 레인 줄에는 없음 · 목록 아래 batch --ready 안내 한 줄(영어 · 한국어)',
      /next batch candidate \(\d\d:\d\d · cli mark\)$/.test(line) && !/candidate/.test(txt4.split('\n').find(l => l.includes(ld.id)) || 'x candidate') && /next batch candidates 1: node harness\/cli\.js batch --ready/.test(txt4) &&
      /다음 batch 후보\(\d\d:\d\d · cli mark\)/.test(ko4) && /다음 batch 후보 1: node harness\/cli\.js batch --ready/.test(ko4), `${line} || ${txt4.split('\n').filter(l => /candidate/.test(l)).join(' / ')}`);

    // RD-05 표시 뒤 커밋 → status fresh false · batch --ready 는 그 레인을 건너뛰고 신선한 후보만 합친다 · RD-06 표시 없는 레인은 빠진다
    const le = lane(A, 'lane e', { 'e.txt': 'e\n' });
    B.markReady({ root: A, id: le.id, note: 'before more work' });
    commitIn(le.wt, 'e2.txt', 'more\n');
    const s5 = St.status({ root: A }), te = s5.tasks.find(t => t.id === le.id);
    R.check('[RD-05] 표시 뒤 레인에 커밋 — status 는 fresh false · 텍스트에 다시 표시하라는 꼬리', te && te.ready && te.ready.fresh === false && new RegExp(`mark it again with ready ${le.id}`).test(St.formatStatus(s5)), JSON.stringify(te && te.ready));
    const b5 = await B.create({ ...quiet, root: A, ready: true });
    const m5 = Object.fromEntries((b5.members || []).map(m => [m.id, m.status]));
    const rec5 = B.readBatch(A, b5.id), me = (rec5.members || []).find(m => m.id === le.id) || {};
    R.check('[RD-05] batch --ready — 신선한 후보(a)는 합치고 표시 뒤 커밋이 있는 후보(e)는 skipped(new commits since it was marked ready)',
      m5[la.id] === 'merged' && m5[le.id] === 'skipped' && /new commits since it was marked ready/.test(me.why || '') && /mark it again/.test(me.why || ''), JSON.stringify({ m5, why: me.why }));
    R.check('[RD-06] batch --ready 는 표시한 레인만 — 표시 없는 열린 레인(d)은 구성원이 아니다', !(ld.id in m5) && !(lb.id in m5), JSON.stringify(m5));
    B.drop({ root: A, bid: b5.id, force: true });
    const b6 = await B.create({ ...quiet, root: A, all: true });
    const m6 = Object.fromEntries((b6.members || []).map(m => [m.id, m.status]));
    R.check('[RD-06] 같은 저장소에서 batch --all 은 예전처럼 묶을 수 있는 레인을 모두 넣는다(표시와 무관 · --all 의미 불변 반증 짝)', ld.id in m6 && la.id in m6 && lb.id in m6 && le.id in m6 && m6[le.id] === 'merged', JSON.stringify(m6));
    B.drop({ root: A, bid: b6.id, force: true });

    // RD-07 --clear → 필드 없음 · status null · 후보가 없으면 batch --ready 는 사용법 오류
    const C = mkRepo();
    const lc = lane(C, 'lane c', { 'c.txt': 'c\n' });
    B.markReady({ root: C, id: lc.id, note: 'x' });
    const r7 = B.markReady({ root: C, id: lc.id, clear: true });
    let e7 = null; try { await B.create({ ...quiet, root: C, ready: true }); } catch (e) { e7 = e; }
    R.check('[RD-07] ready --clear — task.json 에 ready 없음 · 기록 ready_cleared · status ready null · batch --ready 후보 0 이면 USAGE(no lanes marked ready)',
      !r7.refused && !('ready' in S.readTask(C, lc.id)) && S.readLog(C, lc.id).some(e => e.event === 'ready_cleared') && St.status({ root: C }).tasks.find(t => t.id === lc.id).ready === null &&
      e7 && e7.code === 'USAGE' && /no lanes marked ready/.test(e7.message), JSON.stringify({ r7, e7: e7 && e7.message }));
    const b7 = await B.create({ ...quiet, root: C, ready: true, ids: [lc.id] });
    R.check('[RD-07] (#87 리뷰 N2) --ready 를 ids 와 함께 주면 표시가 없어도 오류가 아니다 — ids 로 묶는다', (b7.members || []).some(m => m.id === lc.id && m.status === 'merged'), JSON.stringify(b7.members));
    B.drop({ root: C, bid: b7.id, force: true });

    // RD-09 (#87 리뷰 S1) 표시하는 사이 다른 경로가 상태를 바꾸면 덮어쓰지 않고 거부한다 — 미커밋 확인 중에 accepted 로 바뀌는 경우를 흉내 낸다
    const orig = I.unownedLeftovers;
    I.unownedLeftovers = wt => { const tc = S.readTask(C, lc.id); tc.status = 'accepted'; S.writeTask(C, tc); return orig(wt); };
    let r9; try { r9 = B.markReady({ root: C, id: lc.id, note: 'race' }); } finally { I.unownedLeftovers = orig; }
    const t9 = S.readTask(C, lc.id);
    R.check('[RD-09] 표시 도중 accepted 로 바뀌면 refused(changed to accepted) · task.json 은 accepted 그대로 · ready 를 쓰지 않는다',
      r9 && r9.refused === true && /changed to accepted/.test(r9.reason) && t9.status === 'accepted' && !('ready' in t9), JSON.stringify({ r9, status: t9.status, ready: t9.ready }));
    t9.status = 'open'; S.writeTask(C, t9);

    // RD-10 (#87 리뷰 N3) 작업 잠금을 산 프로세스가 쥐고 있으면 예외가 아니라 거부 — integrate 와 같은 말
    const held = S.acquire(C, `task-${lc.id}`);
    let r10, e10 = null; try { r10 = B.markReady({ root: C, id: lc.id }); } catch (e) { e10 = e; } finally { held.release(); }
    R.check('[RD-10] 잠금이 쥐어져 있으면 refused("task is owned by a live process (pid …)") · 던지지 않는다 · 쓰지 않는다',
      !e10 && r10 && r10.refused === true && new RegExp(`task is owned by a live process \\(pid ${process.pid}\\)`).test(r10.reason) && !('ready' in S.readTask(C, lc.id)), JSON.stringify({ r10, e10: e10 && e10.message }));

    const s7 = St.status({ root: C });
    R.check('[RD-07] 표시가 하나도 없으면 텍스트는 표시 기능이 없던 때와 같다(ready 키를 빼고 만든 출력과 바이트가 같다)',
      St.formatStatus(s7) === St.formatStatus({ ...s7, tasks: s7.tasks.map(({ ready, ...t }) => t) }) && !/candidate/.test(St.formatStatus(s7)));

    // RD-08 옛 task.json(ready 없음) — status · batch · accept 가 예전과 같다
    const t8 = S.readTask(A, ld.id);
    const a8 = await I.accept({ ...quiet, root: A, id: ld.id });
    R.check('[RD-08] 표시한 적 없는 옛 작업 — task.json 에 ready 키가 없고 status 는 null · accept 는 예전처럼 받아들인다',
      !('ready' in t8) && a8.status === 'accepted' && git(A, ['show', 'main:d.txt']) === 'd', JSON.stringify({ a8: [a8.status, a8.reason] }));
    R.check('[RD-08] 받아들인 작업은 표시가 남아 있어도 status 에 후보로 보이지 않는다', (() => { const ta8 = S.readTask(A, la.id); ta8.status = 'accepted'; S.writeTask(A, ta8); const r = St.status({ root: A }).tasks.find(t => t.id === la.id); return !r || r.ready === null; })());
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

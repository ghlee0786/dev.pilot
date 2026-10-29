'use strict';
// accept 2 — [2026-10-29 감사 G2] 받아들이기 · 취소 · 미리 보기의 구멍들: 남긴 충돌(표식 · 수정/삭제 · 이진 · ours) · cancel 이 표식을 커밋 ·
//   unverified 재시도 · 시간 초과된 기준선 캐시 · 시험 이름으로 비교 · 대상 끝이 스스로 빨갛다 · 대상의 대량 삭제 · check 의 산출물 ·
//   문서만 판별 · 늦은 기준선의 검사 줄 · 오해를 부르는 문구 · 한국어 거부 · YAML 따옴표 · 레인에서 일하는 산 세션. 모델 호출 없음 · 임시 저장소만.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const Ln = require('../../harness/lib/lane');
const I = require('../../harness/lib/integrate');
const B = require('../../harness/lib/baseline');
const K = require('../../harness/lib/checks');
const Ch = require('../../harness/hooks/_common');
const R = makeReporter('accept 2 — 남긴 충돌 · unverified · 기준선 · 산 세션');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-acc2-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const gitR = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
const git = (cwd, args) => (gitR(cwd, args).stdout || '').trim();
const quiet = { log: () => {} };
const MARK = /^(<<<<<<<|>>>>>>>)/m;
let seq = 0;
function mkRepo(files) {
  const dir = path.join(base, `r${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']); git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [f, t] of Object.entries(files)) write(path.join(dir, f), t);
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return dir;
}
const commitAllIn = (cwd, msg) => { git(cwd, ['add', '-A']); git(cwd, ['commit', '-qm', msg]); };
const lane = (root, goal, o) => Ln.start({ ...quiet, root, goal, ...(o || {}) });
const PASS_CHECK = "console.log('# pass 1\\n# fail 0')";
const AGENTS = cmd => `# p\n\n\`\`\`yaml\ntest_command: "${cmd}"\n\`\`\`\n`;
// X · Y · Z 세 시험 — <이름>.txt 가 broken 이면 그 시험이 실패한다(tap)
const RUN_JS = `const fs=require('fs');let p=0,f=0,i=0;const out=[];
for(const n of ['X','Y','Z']){i++;const bad=fs.existsSync(n+'.txt')&&fs.readFileSync(n+'.txt','utf8').trim()==='broken';if(bad){f++;out.push('not ok '+i+' - '+n)}else{p++;out.push('ok '+i+' - '+n)}}
console.log(out.join('\\n'));console.log('# pass '+p+'\\n# fail '+f);process.exit(f?1:0);`;

(async () => {
  try {
    // ── AC2-01 (#0) 충돌을 남긴 레인을 cancel → 표식을 커밋하지 않는다 · restore 뒤 accept 도 표식을 병합하지 않는다 ──
    {
      const r = mkRepo({ 'a.txt': 'one\ntwo\nthree\n', 'check.js': PASS_CHECK });
      const t = lane(r, 'edit a', { checks: [] });
      write(path.join(t.worktree, 'a.txt'), 'LANE\ntwo\nthree\n'); commitAllIn(t.worktree, 'lane');
      write(path.join(r, 'a.txt'), 'MAIN\ntwo\nthree\n'); commitAllIn(r, 'main');
      const a1 = await I.accept({ ...quiet, root: r, id: t.id });
      const c = await I.cancel({ ...quiet, root: r, id: t.id });
      const tagA = git(r, ['show', `harness/cancelled/${t.id}:a.txt`]);
      R.check('[AC2-01] (#0) 충돌을 남긴 레인의 cancel 은 표식을 커밋하지 않는다(병합을 거둔다) · 태그는 병합 커밋이 아니다',
        a1.refused && /left in progress/.test(a1.reason) && c.status === 'cancelled' && !MARK.test(tagA) && /^LANE/.test(tagA) && git(r, ['rev-list', '--parents', '-n', '1', `harness/cancelled/${t.id}`]).split(/\s+/).length === 2,
        JSON.stringify({ a1: a1.reason, c: [c.status, c.reason], tagA }));
      const rs = await I.restore({ ...quiet, root: r, id: t.id });
      const a2 = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-01] (#0) restore 뒤 accept 는 다시 충돌로 거부한다 · main 에 표식이 없다', rs.status === 'restored' && a2.refused && /conflicts with main/.test(a2.reason) && !MARK.test(read(path.join(r, 'a.txt'))),
        JSON.stringify({ rs: rs.status, a2: a2.reason, main: read(path.join(r, 'a.txt')) }));
      // 레인 세션이 표식째 커밋해 버려도(병합은 끝났다) accept 는 그 표식을 병합하지 않는다
      commitAllIn(t.worktree, 'commit with markers');
      const mainBefore = git(r, ['rev-parse', 'main']);
      const a3 = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-01] (#0) 표식을 커밋해 병합을 끝낸 레인도 accept 거부 · main 그대로', a3.refused === true && /conflict markers/.test(a3.reason) && /a\.txt/.test(a3.reason) && git(r, ['rev-parse', 'main']) === mainBefore,
        JSON.stringify({ a3: [a3.status, a3.reason] }));
    }

    // ── AC2-02 (#1 · #2 · #15) unverified 는 --force 없이 병합하지 않는다 · 시간 초과된 기준선은 캐시하지 않는다 · 상한이 다르면 다시 잰다 ──
    {
      const SLOW_OR_BAD = `const fs=require('fs');if(fs.existsSync('bad.txt')){console.log('AssertionError: bad');console.log('# pass 0\\n# fail 1');process.exit(1);}
{const t=Date.now();while(Date.now()-t<4000){}}console.log('# pass 1\\n# fail 0');`;
      const r = mkRepo({ 'check.js': SLOW_OR_BAD, 'AGENTS.md': AGENTS('node check.js') });
      const logs = [], log = m => logs.push(String(m));
      const ta = lane(r, 'lane a', { checkTimeoutMs: 1500 });
      write(path.join(ta.worktree, 'bad.txt'), 'x\n'); commitAllIn(ta.worktree, 'bad');
      const main0 = git(r, ['rev-parse', 'main']);
      const a1 = await I.accept({ log, root: r, id: ta.id });
      const a2 = await I.accept({ log, root: r, id: ta.id });
      R.check('[AC2-02] (#1) unverified 로 거부된 칸을 --force 없이 다시 accept 해도 병합하지 않는다 · 문구는 레인의 실패를 말한다',
        a1.refused && /^unverified/.test(a1.reason) && /1 failing/.test(a1.reason) && !/nothing judged/.test(a1.reason) && a2.refused === true && /unverified/.test(a2.reason) && git(r, ['rev-parse', 'main']) === main0 && !fs.existsSync(path.join(r, 'bad.txt')),
        JSON.stringify({ a1: a1.reason, a2: [a2.status, a2.reason] }));
      const cache = path.join(S.paths(r).harnessDir, 'baseline-cache');
      const cached = fs.existsSync(cache) ? fs.readdirSync(cache) : [];
      R.check('[AC2-02] (#2 · #15) 시간 초과된 기준선은 캐시에 남기지 않는다', cached.length === 0, JSON.stringify(cached));
      const tb = lane(r, 'lane b', { checkTimeoutMs: 20000 });
      write(path.join(tb.worktree, 'bad.txt'), 'x\n'); commitAllIn(tb.worktree, 'bad');
      const b1 = await I.accept({ log, root: r, id: tb.id });
      R.check('[AC2-02] (#2 · #15) 같은 기준 커밋이라도 상한이 넉넉한 칸은 기준선을 다시 재 "나빠짐" 으로 거부 · --fresh-baseline 안내가 없다',
        b1.refused && /worse than before/.test(b1.reason) && !(S.readTask(r, tb.id).checks.dropped || []).length && !logs.some(l => /fresh-baseline/.test(l)),
        JSON.stringify({ b1: b1.reason, logs: logs.filter(l => /baseline/.test(l)) }));
      const a3 = await I.accept({ log, root: r, id: ta.id, checkTimeoutMs: 20000 });
      R.check('[AC2-02] (#1) 상한을 넉넉히 주고 다시 accept 하면 빠졌던 검사를 되살려 재고 "나빠짐" 으로 거부', a3.refused && /worse than before/.test(a3.reason) && git(r, ['rev-parse', 'main']) === main0,
        JSON.stringify({ a3: a3.reason }));
    }

    // ── AC2-03 (#3) 실패 수가 같아도 다른 시험이 새로 실패하면 나빠짐 ──
    {
      const r = mkRepo({ 'run.js': RUN_JS, 'Y.txt': 'broken\n', 'AGENTS.md': AGENTS('node run.js') });
      const t = lane(r, 'break x');
      write(path.join(t.worktree, 'X.txt'), 'broken\n'); commitAllIn(t.worktree, 'break X');
      write(path.join(r, 'Y.txt'), 'ok\n'); commitAllIn(r, 'fix Y');
      const main0 = git(r, ['rev-parse', 'main']);
      const a = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-03] (#3) 기준선에서 통과하던 X 가 새로 실패하면(실패 수는 같아도) 거부 · main 그대로', a.refused === true && /X/.test((a.failed_tests || []).join(',')) && git(r, ['rev-parse', 'main']) === main0,
        JSON.stringify({ st: a.status, reason: a.reason, ft: a.failed_tests }));
    }

    // ── AC2-04 (#11) 대상 브랜치가 스스로 깨졌으면 레인 탓으로 거부하지 않는다 ──
    {
      const r = mkRepo({ 'run.js': RUN_JS, 'AGENTS.md': AGENTS('node run.js') });
      const t = lane(r, 'harmless');
      write(path.join(t.worktree, 'note.txt'), 'n\n'); commitAllIn(t.worktree, 'harmless');
      write(path.join(r, 'Z.txt'), 'broken\n'); commitAllIn(r, 'someone breaks Z on main');
      const a = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-04] (#11) 대상 끝(main)이 이미 같은 시험(Z)으로 빨가면 나빠지지 않은 것 — 받아들인다 · 기록에 남긴다',
        a.status === 'accepted' && S.readLog(r, t.id).some(e => e.event === 'checks' && e.verdict === 'not_worse_than_target'),
        JSON.stringify({ st: a.status, reason: a.reason, log: S.readLog(r, t.id).filter(e => e.event === 'checks') }));
    }

    // ── AC2-05 (#4a) 수정/삭제 충돌은 사람이 풀기 전까지 거부 ──
    {
      const r = mkRepo({ 'm.txt': 'm\n', 'check.js': PASS_CHECK });
      const t = lane(r, 'delete m', { checks: [] });
      git(t.worktree, ['rm', '-q', 'm.txt']); git(t.worktree, ['commit', '-qm', 'rm m']);
      write(path.join(r, 'm.txt'), 'main edit\n'); commitAllIn(r, 'main edits m');
      const main0 = git(r, ['rev-parse', 'main']);
      const a1 = await I.accept({ ...quiet, root: r, id: t.id });
      const a2 = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-05] (#4) 수정/삭제 충돌을 남긴 채 다시 accept → 거부(미해결 · m.txt) · main 그대로',
        a1.refused && /m\.txt/.test(a1.reason) && a2.refused === true && /m\.txt/.test(a2.reason) && /unresolved|resolve/.test(a2.reason) && git(r, ['rev-parse', 'main']) === main0,
        JSON.stringify({ a1: a1.reason, a2: [a2.status, a2.reason] }));
      git(S.taskPaths(r, t.id).wt, ['rm', '-q', 'm.txt']);
      const a3 = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-05] (#4) git rm 으로 풀면 받아들인다 · 레인의 삭제가 main 에', a3.status === 'accepted' && !fs.existsSync(path.join(r, 'm.txt')), JSON.stringify({ a3: [a3.status, a3.reason] }));
    }

    // ── AC2-06 (#4b) 이진 파일 충돌 · 대상에서 온 파일을 레인의 미커밋 작업으로 보고하지 않는다 ──
    {
      const r = mkRepo({ 'check.js': PASS_CHECK });
      fs.writeFileSync(path.join(r, 'img.bin'), Buffer.from([0, 1, 2, 3])); commitAllIn(r, 'bin');
      const t = lane(r, 'bin lane', { checks: [] });
      fs.writeFileSync(path.join(t.worktree, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 0xaa, 0xaa])); commitAllIn(t.worktree, 'lane bin');
      fs.writeFileSync(path.join(r, 'img.bin'), Buffer.from([0, 0xbb, 0xbb, 0xbb])); write(path.join(r, 'other.txt'), 'o\n'); commitAllIn(r, 'main bin');
      const main0 = git(r, ['rev-parse', 'main']);
      const a1 = await I.accept({ ...quiet, root: r, id: t.id });
      const a2 = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-06] (#4) 이진 충돌을 남긴 채 다시 accept → 거부(img.bin) · main 그대로', a1.refused && a2.refused === true && /img\.bin/.test(a2.reason) && git(r, ['rev-parse', 'main']) === main0,
        JSON.stringify({ a1: a1.reason, a2: [a2.status, a2.reason] }));
      const wt = S.taskPaths(r, t.id).wt;
      git(wt, ['checkout', '--theirs', '--', 'img.bin']); git(wt, ['add', 'img.bin']);
      const a3 = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-06] (#4) 한쪽을 골라 add 하면 받아들인다 · 대상에서 온 other.txt 를 "커밋되지 않았던 변경" 으로 보고하지 않는다',
        a3.status === 'accepted' && fs.readFileSync(path.join(r, 'img.bin')).equals(Buffer.from([0, 0xbb, 0xbb, 0xbb])) && !/uncommitted changes and merged them too:.*other\.txt/.test(a3.report || ''),
        JSON.stringify({ a3: [a3.status, a3.reason], rep: a3.report }));
    }

    // ── AC2-07 (#5) ours 로 풀고 add 만 해도(색인 = HEAD) 병합을 마친다 ──
    {
      const r = mkRepo({ 'a.txt': 'one\n', 'check.js': PASS_CHECK });
      const t = lane(r, 'ours', { checks: [] });
      write(path.join(t.worktree, 'a.txt'), 'LANE\n'); commitAllIn(t.worktree, 'lane');
      write(path.join(r, 'a.txt'), 'MAIN\n'); commitAllIn(r, 'main');
      const a1 = await I.accept({ ...quiet, root: r, id: t.id });
      const wt = S.taskPaths(r, t.id).wt;
      git(wt, ['checkout', '--ours', '--', 'a.txt']); git(wt, ['add', 'a.txt']);
      const a2 = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-07] (#5) ours 로 풀고 add 만 한 칸 → accept 가 병합을 마치고 받아들인다(끝없는 거부 아님)', a1.refused && a2.status === 'accepted' && read(path.join(r, 'a.txt')) === 'LANE\n',
        JSON.stringify({ a2: [a2.status, a2.reason] }));
    }

    // ── AC2-08 (#6) 대상이 파일 25개를 지운 병합 — 대량 삭제로 거부하지 않는다 · 안내는 guard 가 막지 않는다 ──
    {
      const files = { 'a.txt': 'one\n', 'check.js': PASS_CHECK };
      for (let i = 0; i < 25; i++) files[`old/d${i}.txt`] = `${i}\n`;
      const r = mkRepo(files);
      const t = lane(r, 'edit a', { checks: [] });
      write(path.join(t.worktree, 'a.txt'), 'LANE\n'); commitAllIn(t.worktree, 'lane');
      fs.rmSync(path.join(r, 'old'), { recursive: true }); write(path.join(r, 'a.txt'), 'MAIN\n'); commitAllIn(r, 'main deletes old/');
      const a1 = await I.accept({ ...quiet, root: r, id: t.id });
      const wt = S.taskPaths(r, t.id).wt;
      write(path.join(wt, 'a.txt'), 'BOTH\n'); git(wt, ['add', 'a.txt']);
      const a2 = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-08] (#6) 대상에서 온 삭제는 수상한 대량 삭제가 아니다 — 풀고 add 한 뒤 accept 가 받아들인다',
        a1.refused && a2.status === 'accepted' && !fs.existsSync(path.join(r, 'old')) && read(path.join(r, 'a.txt')) === 'BOTH\n', JSON.stringify({ a2: [a2.status, a2.reason] }));
    }

    // ── AC2-09 (#7) check <id> 도 검사가 고쳐 쓴 추적 파일을 되돌린다 ──
    {
      const GEN = "const fs=require('fs');fs.writeFileSync('gen.txt','generated '+Date.now()+'\\n');console.log('# pass 1\\n# fail 0');";
      const r = mkRepo({ 'gen.txt': 'generated v0\n', 'check.js': GEN, 'AGENTS.md': AGENTS('node check.js') });
      const t = lane(r, 'f');
      write(path.join(t.worktree, 'f.txt'), 'f\n'); commitAllIn(t.worktree, 'f');
      const ck = await I.check({ ...quiet, root: r, id: t.id });
      const st = git(S.taskPaths(r, t.id).wt, ['status', '--porcelain']);
      const a = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-09] (#7) check 뒤 칸에 검사 산출물(gen.txt) 변경이 남지 않는다 · accept 가 그것을 병합하지 않는다',
        ck.status === 'checked' && !/gen\.txt/.test(st) && a.status === 'accepted' && read(path.join(r, 'gen.txt')) === 'generated v0\n' && !/gen\.txt/.test(a.report || ''),
        JSON.stringify({ ck: ck.status, st, a: a.status, gen: read(path.join(r, 'gen.txt')), rep: a.report }));
    }

    // ── AC2-10 (#8) 문서만 — docs/ 폴더의 코드 파일은 문서가 아니다 ──
    {
      const d = I.docsOnly;
      const got = [d(['docs/a.md']), d(['README.md', 'docs/img.png']), d(['.harness/t/PLAN.md']), d(['lib/doc/util.js']), d(['docs/conf.py']), d(['src/docs/x.ts']), d(['docs/a.md', 'x.js']), d([])];
      R.check('[AC2-10] (#8) docsOnly — .md · docs/ 의 그림은 문서 · docs/ 아래 코드(.js · .py · .ts)는 아니다', JSON.stringify(got) === '[true,true,true,false,false,false,false,false]', JSON.stringify(got));
    }

    // ── AC2-11 (#10) 대상을 들이지 않았으면 "bringing main" 이라고 하지 않는다 ──
    {
      const BAD = "const fs=require('fs');if(fs.existsSync('bad.txt')){console.log('# pass 0\\n# fail 1');process.exit(1)}console.log('# pass 1\\n# fail 0')";
      const r = mkRepo({ 'check.js': BAD });
      const t = lane(r, 'bad', { checks: ['node check.js'] });
      write(path.join(t.worktree, 'bad.txt'), 'x\n'); commitAllIn(t.worktree, 'bad');
      await I.check({ ...quiet, root: r, id: t.id });
      const a = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-11] (#10) main 이 그대로인데 검사가 실패하면 "bringing main" 이 아니라 그 칸의 검사 실패로 알린다', a.refused && !/after bringing/.test(a.reason) && /checks fail on harness\//.test(a.reason) && S.readLog(r, t.id).every(e => e.event !== 'target_merged'),
        a.reason);
    }

    // ── AC2-12 (#12) 한국어 작업의 거부 보고: 충돌 · 표식 문구도 한국어 ──
    {
      const r = mkRepo({ 'a.txt': 'one\n', 'check.js': PASS_CHECK });
      const t = lane(r, '기능 추가', { checks: [] });
      write(path.join(t.worktree, 'a.txt'), 'LANE\n'); commitAllIn(t.worktree, 'lane');
      write(path.join(r, 'a.txt'), 'MAIN\n'); commitAllIn(r, 'main');
      const a1 = await I.accept({ ...quiet, root: r, id: t.id });
      const a2 = await I.accept({ ...quiet, root: r, id: t.id });
      const rep = `${a1.report}\n${a2.report}`;
      R.check('[AC2-12] (#12) 한국어 작업: 충돌을 남긴 거부 · 표식이 남은 거부 보고가 한국어(파일 이름 · 경로는 원문)', /충돌/.test(a1.report) && /표식/.test(a2.report) && !/conflicts with|left in progress|still has conflict markers/.test(rep) && /a\.txt/.test(rep), rep);
      const gone = I.refuseKo('the worktree X is missing 25 tracked file(s) that are not committed as deleted (e.g. a) — this looks like an interrupted git operation, not work; nothing was committed. Restore them (git -C "X" restore --source=HEAD --staged --worktree -- old/) or, if the deletions are intended, commit them yourself, then accept again');
      const unv = I.refuseKo('unverified — the checks fail on harness/t (1 failing) but they timed out at the base commit (node a.js), so it is unknown whether this work made them worse; fix the failures, or run the tests yourself and accept again with --force');
      const worse = I.refuseKo('checks fail on harness/t and are worse than before the task (2 failing) — fix it in the lane, then accept again (or --force if you accept the failures)');
      R.check('[AC2-12] (#12) 대량 삭제 · unverified · 나빠짐 거부도 한국어로 옮긴다', [gone, unv, worse].every(s => /[가-힣]/.test(s) && !/^(the worktree|unverified —|checks fail on)/.test(s)), JSON.stringify([gone, unv, worse]));
    }

    // ── AC2-13 (#22) test_command 의 YAML 이스케이프(\") ──
    {
      const r = mkRepo({ 'AGENTS.md': '# p\r\n\r\n```yaml\r\ntest_command: "node -e \\"process.exit(0)\\""\r\n```\r\n' });
      const t = lane(r, 'yaml');
      write(path.join(t.worktree, 'x.txt'), 'x\n'); commitAllIn(t.worktree, 'x');
      const cmds = S.readTask(r, t.id).checks.commands;
      const a = await I.accept({ ...quiet, root: r, id: t.id });
      R.check('[AC2-13] (#22) test_command: "node -e \\"process.exit(0)\\"" → node -e "process.exit(0)" 로 돌아 받아들인다', JSON.stringify(cmds) === JSON.stringify([['node', '-e', 'process.exit(0)']]) && a.status === 'accepted',
        JSON.stringify({ cmds, a: [a.status, a.reason] }));
    }

    // ── AC2-14 (새 요구) 레인 worktree 안에서 산 대화형 세션이 일하는 중이면 accept · check · cancel 은 거부(--force 면 진행) ──
    {
      const r = mkRepo({ 'check.js': PASS_CHECK });
      const t = lane(r, 'live', { checks: [] });
      const wt = S.taskPaths(r, t.id).wt;
      write(path.join(wt, 'done.txt'), 'done\n'); commitAllIn(wt, 'done');
      write(path.join(wt, 'half.txt'), 'HALF WRITTEN\n');
      const common = S.paths(r).commonDir;
      const sid = 'lane-sess-1';
      write(Ch.sessionPath(common, sid), JSON.stringify({ session_id: sid, runtime: 'claude', files: ['half.txt'], cwd: path.join(wt, 'sub'), root: process.platform === 'win32' ? wt.toUpperCase() : wt, branch: t.branch, last_seen: new Date().toISOString() }));
      const agentsFile = path.join(base, 'agents.json');
      write(agentsFile, JSON.stringify([{ sessionId: sid, pid: process.pid, cwd: wt, kind: 'interactive', name: 'lane-1', status: 'busy' }]));
      const had = process.env.HARNESS_AGENTS_JSON;
      process.env.HARNESS_AGENTS_JSON = agentsFile;
      let a1, c1, k1, a2, a3;
      const main0 = git(r, ['rev-parse', 'main']);
      try {
        a1 = await I.accept({ ...quiet, root: r, id: t.id });
        k1 = await I.check({ ...quiet, root: r, id: t.id });
        c1 = await I.cancel({ ...quiet, root: r, id: t.id });
        R.check('[AC2-14] 산 세션이 레인 worktree 에서 일하면 accept · check · cancel 거부(그 세션에서 끝내고 커밋하라) · main · worktree 그대로',
          a1.refused && /live session/.test(a1.reason) && /lane-1|lane-sess/.test(a1.reason) && /--force/.test(a1.reason) && k1.refused && c1.refused && /live session/.test(c1.reason)
            && git(r, ['rev-parse', 'main']) === main0 && fs.existsSync(path.join(wt, 'half.txt')) && S.readTask(r, t.id).status === 'open',
          JSON.stringify({ a1: a1.reason, k1: k1.reason, c1: c1.reason }));
        write(agentsFile, JSON.stringify([]));   // 그 세션이 끝났다(플랫폼 목록에 없다)
        a2 = await I.accept({ ...quiet, root: r, id: t.id, into: 'nope-branch' });
        R.check('[AC2-14] 세션이 끝나면(플랫폼 목록에 없음) 세션 때문에 거부하지 않는다', !/live session/.test(a2.reason || ''), a2.reason);
        write(agentsFile, JSON.stringify([{ sessionId: sid, pid: process.pid, cwd: wt, kind: 'interactive', name: 'lane-1', status: 'busy' }]));
        a3 = await I.accept({ ...quiet, root: r, id: t.id, force: true });
        R.check('[AC2-14] --force 면 산 세션이 있어도 받아들인다', a3.status === 'accepted', JSON.stringify([a3.status, a3.reason]));
      } finally { if (had == null) delete process.env.HARNESS_AGENTS_JSON; else process.env.HARNESS_AGENTS_JSON = had; }
    }

    // ── AC2-15 (#9 · #13) 늦은 기준선도 검사 줄(checks)에 선다 — 직렬 기본(serial_checks 설정 없음) · accept 의 기준선은 priority 0 ──
    {
      const r = mkRepo({ 'check.js': PASS_CHECK, 'AGENTS.md': AGENTS('node check.js') });
      const t = lane(r, 'queue');
      const task = S.readTask(r, t.id);
      const hold = S.acquire(r, 'checks');
      let done = false;
      const p = B.ensureBaseline(r, task, { o: { checkTimeoutMs: 20000, priority: 0 } }).then(() => { done = true; });
      let q = [];
      for (let i = 0; i < 200 && !q.length && !done; i++) { await new Promise(res => setTimeout(res, 25)); q = S.queueOf(r, 'checks'); }
      const waited = !done;
      hold.release();
      await p;
      R.check('[AC2-15] (#9 · #13) 늦은 기준선은 검사 줄 뒤에서 기다린다(줄이 잡혀 있으면 돌지 않는다) · 우선순위 0',
        waited && q.length === 1 && q[0].priority === 0 && done && S.readTask(r, t.id).checks.baseline && S.readTask(r, t.id).checks.baseline.ok === true,
        JSON.stringify({ waited, q, bl: S.readTask(r, t.id).checks.baseline }));
    }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

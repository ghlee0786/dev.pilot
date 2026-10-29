'use strict';
// 작업 장부(PRD R2) — 이미 한 일을 다시 하지 않고, 이전 작업을 이어 가게 알린다(막지 않는다). 언어 무관(글자 3-gram). 모델 호출 없음.
//   v7 Light: 작업은 light 칸(lane.start)으로 연다 — 장부는 칸을 열 때 같은 · 비슷한 작업을 task.related 와 안내(report)에 싣는다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const W = require('../../harness/lib/worklog');
const Ln = require('../../harness/lib/lane');
const S = require('../../harness/lib/state');
const R = makeReporter('작업 장부 — 중복 감지 · 맥락 이어 주기');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-worklog-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
function repo() {
  const d = path.join(base, 'r'); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  write(path.join(d, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\n```\n'); write(path.join(d, 'check.js'), "console.log('# pass 1\\n# fail 0')\n");
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}

(async () => {
  try {
    // WL-01 — 유사도: 표현만 다른 같은 요청 · 다른 요청 · 한국어 · 영어 · 코드 이름 섞임
    const same1 = W.similarity('이벤트 매핑을 다른 부대로 옮기면 옛 부대에도 알림을 보내라', '이벤트 매핑을 다른 부대로 옮길 때 옛 부대에도 알림을 보내라');
    const same2 = W.similarity('add retry to the HTTP client in shared/mcp_client.py', 'add retries to the http client (shared/mcp_client.py)');
    const diff1 = W.similarity('이벤트 매핑을 다른 부대로 옮기면 옛 부대에도 알림을 보내라', 'ROI 에 is_exclusion 칸을 추가해라');
    const diff2 = W.similarity('add retry to the HTTP client', 'refactor the logging module');
    R.check('[WL-01] 같은 요청(표현만 다름)은 "같은 목표" 기준 이상 · 다른 요청은 "관련" 기준 미만 — 한국어 · 영어 모두', same1 >= W.SAME && same2 >= W.SAME && diff1 < W.RELATED && diff2 < W.RELATED, JSON.stringify({ same1, same2, diff1, diff2 }));

    // WL-02 — 첫 작업: 관련 이전 작업이 없다
    const r = repo();
    const goalA = '설정 저장 방식을 파일에서 데이터베이스로 바꾸고 기존 설정을 옮겨라';
    const t1 = Ln.start({ ...quiet, root: r, goal: goalA });
    write(path.join(t1.worktree, 'store.js'), 'module.exports = "db";\n');
    git(t1.worktree, 'add', '-A'); git(t1.worktree, 'commit', '-qm', 'store in db');
    R.check('[WL-02] 첫 작업은 관련 이전 작업이 없다(기록 · 결과 · 안내 모두)', t1.status === 'open' && !(S.readTask(r, t1.id).related || []).length && !t1.related.length && !/같은 · 비슷한 작업/.test(t1.report),
      JSON.stringify(S.readTask(r, t1.id).related));

    // WL-03 — 같은 목표를 다시 보냄: 이전 작업을 알아보고 안내에 "처음부터 다시 만들지 말고 이어 가라" + --from 으로 이어 가는 명령
    const t2 = Ln.start({ ...quiet, root: r, goal: '설정 저장 방식을 파일에서 데이터베이스로 바꾸고, 기존 설정도 옮겨라' });
    const task2 = S.readTask(r, t2.id);
    R.check('[WL-03] 같은 목표의 이전 작업을 장부에서 찾는다(kind same · 상태 open) · 결과에 그 브랜치', (task2.related || []).some(x => x.id === t1.id && x.kind === 'same' && x.status === 'open')
      && t2.related.some(x => x.id === t1.id && x.branch === t1.branch), JSON.stringify({ rec: task2.related, res: t2.related }));
    R.check('[WL-03] 안내: 같은 · 비슷한 작업 목록(같은 요청 표시 · 브랜치) · "처음부터 다시 만들지 말고 이어 가세요" · start --from <이전 id>',
      /같은 · 비슷한 작업.*처음부터 다시 만들지 말고 이어 가세요/.test(t2.report) && new RegExp(`- ${t1.id} \\(open · 같은 요청\\) ${t1.branch.replace(/[/]/g, '\\/')}`).test(t2.report)
      && t2.report.includes(`node harness/cli.js start --from ${t1.id} "<목표>"`), t2.report);

    // WL-04 — 무관한 작업에는 아무것도 붙지 않는다
    const t3 = Ln.start({ ...quiet, root: r, goal: '로그 화면의 글꼴 크기를 키워라' });
    R.check('[WL-04] 무관한 목표에는 이전 작업이 없다(기록 · 안내)', !(S.readTask(r, t3.id).related || []).length && !/같은 · 비슷한 작업/.test(t3.report), JSON.stringify(S.readTask(r, t3.id).related));

    // WL-05 — 장부 조회(W.related): 비슷한 작업만 · 점수 순 · 상한 안
    const rel5 = W.related(r, { id: 't-20990101-000000-ffff', goal: '로그 화면의 글꼴 크기와 색을 키워라' });
    R.check('[WL-05] 장부는 점수 순 · 최대 4개 · 무관한 작업(t1 · t2)은 빠진다', rel5.some(x => x.id === t3.id) && !rel5.some(x => x.id === t1.id || x.id === t2.id) && rel5.length <= 4
      && rel5.every((x, i) => i === 0 || rel5[i - 1].score >= x.score), JSON.stringify(rel5));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

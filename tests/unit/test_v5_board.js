'use strict';
// v5 세션 게시판(hooks/board.js) — 같은 체크아웃의 다른 세션 알림(쌍마다 한 번) · 같은 목표 알림(첫 요청 · 세션 · 열린 작업) ·
//   남의 미커밋 파일 편집 전 묻기(ask) · 가벼운 길의 SessionStart 환경(CLAUDE_ENV_FILE) · 끝난/오래된 세션은 산 세션이 아니다 ·
//   무인 작업자 worktree 에서는 아무것도 하지 않는다 · 실패는 열어 둔다.
//   훅은 실제 프로세스로 띄운다. 저장소는 임시 git 저장소, HOME · USERPROFILE · CODEX_HOME · TEMP · 전역 git 설정은 임시로 돌린다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const R = makeReporter('v5 게시판 — 같은 체크아웃 · 같은 목표 · 남의 파일 · 가벼운 길 환경');

const HOOKS = path.join(__dirname, '..', '..', 'harness', 'hooks');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-board-'));
const home = path.join(base, 'home'); fs.mkdirSync(home, { recursive: true });
const gitGlobal = path.join(base, 'gitconfig-global'); fs.writeFileSync(gitGlobal, '');
const hookTmp = path.join(base, 'tmp'); fs.mkdirSync(hookTmp, { recursive: true });
const ENV = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), GIT_CONFIG_GLOBAL: gitGlobal, GIT_CONFIG_NOSYSTEM: '1', TEMP: hookTmp, TMP: hookTmp, TMPDIR: hookTmp, HARNESS_AUTOUPDATE: 'off' };
for (const k of ['CLAUDE_PROJECT_DIR', 'HARNESS_HOOK_RUNTIME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'CLAUDE_ENV_FILE', 'HARNESS_TMP_BASE', 'HARNESS_TASK_ID', 'HARNESS_AGENTS_CMD', 'HARNESS_AGENTS']) delete ENV[k];
// 진짜 `claude agents --json` 은 부르지 않는다 — 기본은 없는 파일(= 플랫폼 목록을 못 얻음 → last_seen 어림). 목록 시험은 따로 준다.
ENV.HARNESS_AGENTS_JSON = path.join(base, 'no-agents.json');
ENV.HARNESS_TOOLKIT_HINT = 'off';   // 세션 시작의 도구 점검 한 줄은 test_v5_toolkit 이 본다(사용자 HOME 의 MCP 설정을 읽지 않게)

function hook(name, payload, extraEnv, args) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [path.join(HOOKS, name + '.js'), ...(args || [])], { input, encoding: 'utf8', env: { ...ENV, ...(extraEnv || {}) }, cwd: base, windowsHide: true, timeout: 30000 });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { json = 'UNPARSEABLE:' + r.stdout; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function git(cwd, ...args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV, windowsHide: true }); return (r.stdout || '').trim(); }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function mkRepo(name, files) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) write(path.join(dir, f), t);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=setup', '-c', 'user.email=setup@x', 'commit', '-q', '-m', 'init');
  return dir;
}
const sessionFile = (repo, sid) => path.join(repo, '.git', 'harness', 'sessions', sid + '.json');
const readSession = (repo, sid) => { try { return JSON.parse(fs.readFileSync(sessionFile(repo, sid), 'utf8')); } catch { return null; } };
const isAllow = r => r.status === 0 && r.stdout.trim() === '';
const ctx = r => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.hookEventName === 'UserPromptSubmit' && r.json.hookSpecificOutput.additionalContext) || '';
const ups = (repo, sid, prompt, cwd) => hook('board', { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: cwd || repo, prompt_id: 'p', prompt });
const preWrite = (repo, sid, file) => hook('board', { hook_event_name: 'PreToolUse', session_id: sid, cwd: repo, prompt_id: 'p', tool_name: 'Write', tool_input: { file_path: file, content: 'x' } });
const track = (repo, sid, file) => hook('track', { hook_event_name: 'PostToolUse', session_id: sid, cwd: repo, prompt_id: 'p', tool_name: 'Write', tool_input: { file_path: file, content: 'x' } });
const ago = min => new Date(Date.now() - min * 60000).toISOString();

try {
  const repo = mkRepo('repo', { 'src/x.js': 'x\n', 'src/y.js': 'y\n', 'README.md': '# r\n' });
  const GOAL_A = 'auth 모듈의 로그인 토큰 만료 처리 버그를 고친다';

  // ── 세션 파일 갱신 ──
  const s0 = hook('board', { hook_event_name: 'SessionStart', session_id: 'aaaa1111-A', cwd: repo, source: 'startup' });
  const a0 = readSession(repo, 'aaaa1111-A');
  R.check('[board] SessionStart: 출력 없음 · 세션 파일에 cwd · root · branch · last_seen (goal 없음)', isAllow(s0) && a0 && a0.root && fs.realpathSync.native(a0.root).toLowerCase() === fs.realpathSync.native(repo).toLowerCase()
    && a0.cwd === repo && a0.branch === 'main' && !isNaN(Date.parse(a0.last_seen)) && !a0.goal, JSON.stringify(a0) + s0.stdout);
  const a1 = ups(repo, 'aaaa1111-A', GOAL_A);
  R.check('[board] 첫 요청: 다른 세션이 없으면 출력 없음 · goal = 첫 요청', isAllow(a1) && readSession(repo, 'aaaa1111-A').goal === GOAL_A, a1.stdout);
  ups(repo, 'aaaa1111-A', '그리고 테스트도 돌려 줘');
  R.check('[board] 두 번째 요청은 goal 을 바꾸지 않는다', readSession(repo, 'aaaa1111-A').goal === GOAL_A);
  const long = 'x'.repeat(500);
  ups(repo, 'longgoal', long);
  R.check('[board] goal 은 200자 이하로 자른다', (readSession(repo, 'longgoal').goal || '').length <= 200);
  fs.unlinkSync(sessionFile(repo, 'longgoal'));

  // ── 같은 체크아웃 ──
  const b1 = ups(repo, 'bbbb2222-B', 'README 에 설치 방법을 적는다');
  const t1 = ctx(b1);
  R.check('[board] 같은 폴더의 다른 산 세션 → 문맥(한국어): 그 세션 sid8 · 목표 · 분 전 · 섞임 · cli.js start', b1.status === 0 && /aaaa1111/.test(t1) && t1.includes(GOAL_A) && /분 전/.test(t1) && /섞/.test(t1) && /node harness\/cli\.js start "<목표>"/.test(t1), b1.stdout);
  R.check('[board] 알린 쌍을 세션 파일에 기억한다', (readSession(repo, 'bbbb2222-B').warned_sessions || []).includes('aaaa1111-A'));
  const b2 = ups(repo, 'bbbb2222-B', '계속');
  R.check('[board] 같은 쌍은 한 번만 알린다(B 의 두 번째 요청은 조용)', isAllow(b2), b2.stdout);
  const a2 = ups(repo, 'aaaa1111-A', '다음');
  R.check('[board] 반대쪽(A)도 B 에 대해 한 번 알림을 받는다', /bbbb2222/.test(ctx(a2)) && isAllow(ups(repo, 'aaaa1111-A', '또')), a2.stdout);
  // 끝난 세션 · 30분 넘게 소식 없는 세션은 산 세션이 아니다
  write(sessionFile(repo, 'eeee-ended'), JSON.stringify({ session_id: 'eeee-ended', runtime: 'claude', files: [], root: repo, last_seen: ago(1), ended_at: ago(1), goal: 'ended one' }));
  write(sessionFile(repo, 'ssss-stale'), JSON.stringify({ session_id: 'ssss-stale', runtime: 'claude', files: [], root: repo, last_seen: ago(45), goal: 'stale one' }));
  const c1 = ups(repo, 'cccc3333-C', 'CSS 색을 바꾼다');
  R.check('[board] 끝난 세션 · 30분 넘게 소식 없는 세션은 알리지 않는다(산 세션 A · B 만)', /aaaa1111/.test(ctx(c1)) && /bbbb2222/.test(ctx(c1)) && !/eeee/.test(ctx(c1)) && !/ssss/.test(ctx(c1)), ctx(c1));

  // ── session-end 가 ended_at 을 적으면 더는 산 세션이 아니다 ──
  hook('session-end', { hook_event_name: 'SessionEnd', session_id: 'cccc3333-C', cwd: repo, reason: 'other' });
  const cEnd = readSession(repo, 'cccc3333-C');
  const d1 = ups(repo, 'dddd4444-D', '문서 오타를 고친다');
  R.check('[board] session-end 가 ended_at 을 적고 · 그 세션은 다음 세션에 알리지 않는다', cEnd && cEnd.ended_at && !/cccc3333/.test(ctx(d1)) && /aaaa1111/.test(ctx(d1)), JSON.stringify(cEnd) + ' | ' + ctx(d1));
  const c2 = ups(repo, 'cccc3333-C', '다시 왔다');
  R.check('[board] 끝난 세션이 다시 말을 걸면 ended_at 을 지운다(이어 간 세션)', !readSession(repo, 'cccc3333-C').ended_at && c2.status === 0);

  // ── 같은 목표 ──
  const h1 = ups(repo, 'hhhh5555-H', GOAL_A);
  const th = ctx(h1);
  R.check('[board] 첫 요청이 다른 산 세션의 목표와 같다 → 그 세션(sid8 · 브랜치)을 알린다', /같은 일이 이미 있다/.test(th) && /세션 aaaa1111\(/.test(th) && /main/.test(th), th);
  const tasksDir = path.join(repo, '.git', 'harness', 'tasks');
  const GOAL_T = 'CSV 보고서 내보내기 기능을 추가한다(날짜 범위 · 열 선택)';
  write(path.join(tasksDir, 't-20261025-120000-aaaa', 'task.json'), JSON.stringify({ id: 't-20261025-120000-aaaa', status: 'open', mode: 'light', owner: null, goal: GOAL_T, branch: 'harness/t-20261025-120000-aaaa' }));
  write(path.join(tasksDir, 't-20261025-120001-bbbb', 'task.json'), JSON.stringify({ id: 't-20261025-120001-bbbb', status: 'accepted', goal: GOAL_T, branch: 'harness/t-20261025-120001-bbbb' }));
  write(path.join(tasksDir, 't-20261025-120002-cccc', 'task.json'), JSON.stringify({ id: 't-20261025-120002-cccc', status: 'blocked', goal: GOAL_T + ' 해 줘', branch: 'harness/t-20261025-120002-cccc' }));
  const i1 = ups(repo, 'iiii6666-I', GOAL_T);
  const ti = ctx(i1);
  R.check('[board] 첫 요청이 열린 작업의 목표와 같다 → id · 상태 · 브랜치 · start --from <id> · 끝난(accepted) 작업은 빼고', /t-20261025-120000-aaaa\(open · light · harness\/t-20261025-120000-aaaa\)/.test(ti) && /t-20261025-120002-cccc/.test(ti)
    && /node harness\/cli\.js start --from t-20261025-120000-aaaa "<목표>"/.test(ti) && !/120001-bbbb/.test(ti), ti);
  const i2 = ups(repo, 'iiii6666-I', GOAL_T);
  R.check('[board] 같은 목표 알림은 첫 요청에서만', !/같은 일이 이미 있다/.test(ctx(i2)), ctx(i2));
  const j1 = ups(repo, 'jjjj7777-J', '완전히 다른 일: 빌드 스크립트의 경고 메시지를 정리');
  R.check('[board] 비슷하지 않은 요청에는 같은 목표 알림이 없다', !/같은 일이 이미 있다/.test(ctx(j1)), ctx(j1));
  // 셋까지만
  for (let k = 0; k < 4; k++) write(path.join(tasksDir, `t-20261025-13000${k}-dd0${k}`, 'task.json'), JSON.stringify({ id: `t-20261025-13000${k}-dd0${k}`, status: 'open', goal: '결제 모듈 환불 API 를 추가한다', branch: `harness/t-20261025-13000${k}-dd0${k}` }));
  const k1 = ups(repo, 'kkkk8888-K', '결제 모듈 환불 API 를 추가한다');
  R.check('[board] 같은 목표는 가장 비슷한 셋까지만', (ctx(k1).match(/작업 t-20261025-13000/g) || []).length === 3, ctx(k1));

  // ── 남의 미커밋 파일 편집 전 묻기 ──
  const ask = r => r.status === 0 && r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.hookEventName === 'PreToolUse' && r.json.hookSpecificOutput.permissionDecision === 'ask';
  write(path.join(repo, 'src', 'x.js'), 'edited by A\n');
  track(repo, 'aaaa1111-A', path.join(repo, 'src', 'x.js'));
  const p1 = preWrite(repo, 'bbbb2222-B', path.join(repo, 'src', 'x.js'));
  R.check('[board] 다른 산 세션이 기록했고 지금 미커밋인 파일 → ask(한국어 이유 · 파일 · 그 세션)', ask(p1) && /src\/x\.js/.test(p1.json.hookSpecificOutput.permissionDecisionReason) && /aaaa1111/.test(p1.json.hookSpecificOutput.permissionDecisionReason) && /미커밋/.test(p1.json.hookSpecificOutput.permissionDecisionReason), p1.stdout);
  R.check('[board] 상대 경로(cwd 기준)도 같다', ask(preWrite(repo, 'bbbb2222-B', 'src/x.js')));
  R.check('[board] 아무도 기록하지 않은 파일은 출력 없음', isAllow(preWrite(repo, 'bbbb2222-B', path.join(repo, 'src', 'y.js'))));
  R.check('[board] 자기 세션이 기록한 파일은 묻지 않는다', isAllow(preWrite(repo, 'aaaa1111-A', path.join(repo, 'src', 'x.js'))));
  track(repo, 'bbbb2222-B', path.join(repo, 'src', 'x.js'));
  R.check('[board] 이미 이 세션도 고친 파일이면 다시 묻지 않는다', isAllow(preWrite(repo, 'bbbb2222-B', path.join(repo, 'src', 'x.js'))));
  git(repo, '-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-q', '-m', 'x', '--', 'src/x.js');
  R.check('[board] 커밋돼 깨끗한 파일이면 출력 없음', isAllow(preWrite(repo, 'dddd4444-D', path.join(repo, 'src', 'x.js'))));
  write(path.join(repo, 'src', 'x.js'), 'edited again by A\n');
  const aSess = readSession(repo, 'aaaa1111-A'); write(sessionFile(repo, 'aaaa1111-A'), JSON.stringify({ ...aSess, ended_at: ago(0) }));
  const bSess = readSession(repo, 'bbbb2222-B'); write(sessionFile(repo, 'bbbb2222-B'), JSON.stringify({ ...bSess, ended_at: ago(0) }));
  R.check('[board] 기록한 세션이 끝났으면 묻지 않는다', isAllow(preWrite(repo, 'dddd4444-D', path.join(repo, 'src', 'x.js'))));
  R.check('[board] 저장소 밖 파일은 출력 없음', isAllow(preWrite(repo, 'dddd4444-D', path.join(base, 'elsewhere.txt'))));

  // ── 가벼운 길 · 무인 작업자 worktree ──
  const lid = 't-20261025-140000-1a2b', wid = 't-20261025-140001-3c4d';
  const lwt = path.join(repo, '.harness-worktrees', lid), wwt = path.join(repo, '.harness-worktrees', wid);
  git(repo, 'worktree', 'add', '-q', '-b', `harness/${lid}`, lwt);
  git(repo, 'worktree', 'add', '-q', '-b', `harness/${wid}`, wwt);
  write(path.join(tasksDir, lid, 'task.json'), JSON.stringify({ id: lid, status: 'open', mode: 'light', owner: null, goal: 'lane goal', branch: `harness/${lid}` }));
  write(path.join(tasksDir, wid, 'task.json'), JSON.stringify({ id: wid, status: 'running', goal: 'worker goal', branch: `harness/${wid}` }));
  const envFile = path.join(base, 'claude-env.sh');
  write(envFile, '# existing\n');
  const ls = hook('board', { hook_event_name: 'SessionStart', session_id: 'llll9999-L', cwd: lwt, source: 'startup' }, { CLAUDE_ENV_FILE: envFile });
  const envText = fs.readFileSync(envFile, 'utf8');
  const RES = require('../../harness/lib/resources');
  R.check('[board/lane] SessionStart(가벼운 길): CLAUDE_ENV_FILE 에 그 길의 환경을 export 로 덧붙인다(작업 id · compose 이름 · 데이터 이름 · TEMP · 빌드 서버 끔)', isAllow(ls) && envText.startsWith('# existing\n')
    && envText.includes(`export HARNESS_TASK_ID='${lid}'`) && envText.includes(`export COMPOSE_PROJECT_NAME='${RES.composeProject(lid)}'`) && envText.includes(`export HARNESS_DATA_NS='${RES.dataNs(lid)}'`)
    && /^export TEMP='.+'$/m.test(envText) && /^export TMPDIR='.+'$/m.test(envText) && envText.includes(`export MSBUILDDISABLENODEREUSE='1'`), envText);
  const ll = readSession(repo, 'llll9999-L');
  R.check('[board/lane] 가벼운 길의 세션도 게시판에 오른다(root = 그 worktree · branch = harness/<id>)', ll && ll.branch === `harness/${lid}` && fs.realpathSync.native(ll.root).toLowerCase() === fs.realpathSync.native(lwt).toLowerCase(), JSON.stringify(ll));
  const envFile2 = path.join(base, 'claude-env-main.sh'); write(envFile2, '');
  hook('board', { hook_event_name: 'SessionStart', session_id: 'mmmm0000-M', cwd: repo, source: 'startup' }, { CLAUDE_ENV_FILE: envFile2 });
  R.check('[board/lane] 메인 체크아웃의 SessionStart 는 CLAUDE_ENV_FILE 을 건드리지 않는다', fs.readFileSync(envFile2, 'utf8') === '');
  const l2 = ups(repo, 'llll9999-L', '레인에서 하는 일', lwt);
  R.check('[board/lane] 다른 폴더(가벼운 길)의 세션에는 같은 체크아웃 알림이 없다', !/같은 폴더/.test(ctx(l2)), ctx(l2));
  const w1 = hook('board', { hook_event_name: 'SessionStart', session_id: 'wwww-worker', cwd: wwt, source: 'startup' }, { CLAUDE_ENV_FILE: envFile2 });
  ups(repo, 'wwww-worker', 'worker prompt', wwt);
  R.check('[board/worker] 무인 작업자 worktree 에서는 아무것도 하지 않는다(세션 파일 · 환경 파일 · 출력 없음)', isAllow(w1) && readSession(repo, 'wwww-worker') === null && fs.readFileSync(envFile2, 'utf8') === '', w1.stdout);
  const BD = require(path.join(HOOKS, 'board.js'));
  R.check('[board] 환경 값은 작은따옴표로 안전하게', BD.shQuote("C:\\a b\\it's") === "'C:\\a b\\it'\\''s'" && BD.shQuote('$HOME `x`') === "'$HOME `x`'");

  // ── 플랫폼 목록(claude agents --json): 산 세션의 첫 근거 · 이름 · busy/idle ──
  {
    const pr = mkRepo('plat', { 'p.js': 'p\n', 'q.js': 'q\n' });
    const agentsFile = path.join(base, 'agents-plat.json');
    write(agentsFile, JSON.stringify([{ pid: 1, cwd: pr, kind: 'interactive', startedAt: 1, sessionId: 'pppp1111-P', name: 'plat-proj-34', status: 'busy' },
      { pid: 2, cwd: 'C:\\elsewhere', kind: 'interactive', startedAt: 2, sessionId: 'not-ours', name: 'other-1', status: 'idle' }]));
    const AE = { HARNESS_AGENTS_JSON: agentsFile };
    write(sessionFile(pr, 'pppp1111-P'), JSON.stringify({ session_id: 'pppp1111-P', runtime: 'claude', files: ['p.js'], root: pr, last_seen: ago(120), goal: '플랫폼 목록에 있는 세션' }));
    write(sessionFile(pr, 'qqqq2222-Q'), JSON.stringify({ session_id: 'qqqq2222-Q', runtime: 'claude', files: ['q.js'], root: pr, last_seen: ago(1), goal: '목록에 없는 세션' }));
    write(sessionFile(pr, 'xxxx-codex'), JSON.stringify({ session_id: 'xxxx-codex', runtime: 'codex', files: [], root: pr, last_seen: ago(2), goal: '코덱스 세션' }));
    const r1 = hook('board', { hook_event_name: 'UserPromptSubmit', session_id: 'rrrr3333-R', cwd: pr, prompt_id: 'p', prompt: '전혀 다른 작업' }, AE);
    const tr1 = ctx(r1);
    R.check('[board/agents] 목록에 있는 Claude 세션은 last_seen 이 2시간 전이어도 산 세션 · 플랫폼 이름 · busy 를 싣는다', /세션 pppp1111\(plat-proj-34 · busy · 120분 전/.test(tr1), tr1);
    R.check('[board/agents] 목록에 없는 Claude 세션은 1분 전에 보였어도 산 세션이 아니다 · Codex 세션은 last_seen 어림', !/qqqq2222/.test(tr1) && /xxxxcode/.test(tr1), tr1);
    write(path.join(pr, 'p.js'), 'P dirty\n'); write(path.join(pr, 'q.js'), 'Q dirty\n');
    const pw = (f, env) => hook('board', { hook_event_name: 'PreToolUse', session_id: 'rrrr3333-R', cwd: pr, prompt_id: 'p', tool_name: 'Edit', tool_input: { file_path: path.join(pr, f) } }, env || AE);
    const pp = pw('p.js');
    R.check('[board/agents] 쓰기 전: 목록에 있는 세션의 미커밋 파일 → ask(이름 · busy)', pp.json && pp.json.hookSpecificOutput && pp.json.hookSpecificOutput.permissionDecision === 'ask' && /plat-proj-34 · busy/.test(pp.json.hookSpecificOutput.permissionDecisionReason), pp.stdout);
    R.check('[board/agents] 쓰기 전: 목록에 없는 세션의 미커밋 파일은 묻지 않는다', isAllow(pw('q.js')));
    R.check('[board/agents] 목록을 못 얻으면(파일 없음) last_seen 어림으로 — q.js(1분 전)는 묻고 p.js(2시간 전)는 묻지 않는다', !isAllow(pw('q.js', {})) && isAllow(pw('p.js', {})));

    // 캐시 · 대신 돌릴 명령 · 실패 · 시간 초과 — 프로세스 안에서 _common 을 직접 부른다
    const C1 = require(path.join(HOOKS, '_common.js'));
    const counter = path.join(base, 'agents-calls.txt'), fakeAgents = path.join(base, 'fake-agents.js');
    write(fakeAgents, `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');\nif (process.argv[2] === 'fail') process.exit(3);\nprocess.stdout.write(JSON.stringify([{ sessionId: 'sss-1', name: 'n1', status: 'idle' }]));\n`);
    const calls = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0);
    const saved = {}; for (const k of ['HARNESS_AGENTS_JSON', 'HARNESS_AGENTS_CMD', 'HARNESS_AGENTS']) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      const common = path.join(pr, '.git');
      const cache = path.join(common, 'harness', 'agents-cache.json');
      process.env.HARNESS_AGENTS_CMD = JSON.stringify([process.execPath, fakeAgents]);
      const g1 = C1.platformAgents(common), g2 = C1.platformAgents(common);
      R.check('[board/agents] 대신 돌릴 명령의 결과를 읽고 30초 캐시 — 두 번 불러도 한 번만 띄운다', g1 && g1[0].sessionId === 'sss-1' && g1[0].name === 'n1' && JSON.stringify(g2) === JSON.stringify(g1) && calls() === 1 && fs.existsSync(cache), `${calls()} ${JSON.stringify(g1)}`);
      const cj = JSON.parse(fs.readFileSync(cache, 'utf8')); cj.at = new Date(Date.now() - 31000).toISOString(); fs.writeFileSync(cache, JSON.stringify(cj));
      C1.platformAgents(common);
      R.check('[board/agents] 30초가 지난 캐시는 다시 묻는다', calls() === 2, String(calls()));
      process.env.HARNESS_AGENTS_CMD = JSON.stringify([process.execPath, fakeAgents, 'fail']);
      const f1 = C1.platformAgents(common), f2 = C1.platformAgents(common);
      R.check('[board/agents] 명령이 실패하면 null(→ last_seen 어림) · 실패도 캐시한다(명령이 바뀌면 캐시를 쓰지 않는다)', f1 === null && f2 === null && calls() === 3, String(calls()));
      process.env.HARNESS_AGENTS_CMD = JSON.stringify([process.execPath, '-e', 'setTimeout(() => {}, 20000)']);
      const t0 = Date.now(), to = C1.platformAgents(common), took = Date.now() - t0;
      R.check('[board/agents] 3초 넘게 걸리면 끊고 null', to === null && took < 10000, `${took}ms`);
      process.env.HARNESS_AGENTS_CMD = JSON.stringify([path.join(base, 'no-such-claude.exe'), 'agents', '--json']);
      R.check('[board/agents] 명령이 없으면 null', C1.platformAgents(path.join(base, 'no-common')) === null);
      delete process.env.HARNESS_AGENTS_CMD; process.env.HARNESS_AGENTS = 'off';
      R.check('[board/agents] HARNESS_AGENTS=off 면 묻지 않는다(null)', C1.platformAgents(common) === null);
      const ag = [{ sessionId: 'a1', name: 'x', status: 'idle' }];
      R.check('[board/agents] sessionLive: 목록 있음 → Claude 는 목록만 · Codex 는 어림 / 목록 없음 → ended_at · 30분',
        C1.sessionLive({ session_id: 'a1', runtime: 'claude', ended_at: ago(1) }, ag) === true && C1.sessionLive({ session_id: 'b1', runtime: 'claude', last_seen: ago(0) }, ag) === false
        && C1.sessionLive({ session_id: 'c1', runtime: 'codex', last_seen: ago(0) }, ag) === true && C1.sessionLive({ session_id: 'b1', runtime: 'claude', last_seen: ago(0) }, null) === true
        && C1.sessionLive({ session_id: 'b1', runtime: 'claude', last_seen: ago(31) }, null) === false && C1.sessionLive({ session_id: 'b1', last_seen: ago(0), ended_at: ago(0) }, null) === false);
      R.check('[board/agents] parseAgents: 배열이 아니거나 깨졌으면 null · sessionId 없는 항목은 뺀다', C1.parseAgents('{}') === null && C1.parseAgents('nope') === null && C1.parseAgents('[{"name":"x"},{"sessionId":"s"}]').length === 1);
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }

    // 후보가 없으면 플랫폼에 묻지 않는다 — 혼자인 저장소의 요청 · 아무도 기록하지 않은 파일의 쓰기 전
    const solo = mkRepo('solo', { 's.js': 's\n' });
    const before = calls();
    const SE = { HARNESS_AGENTS_JSON: '', HARNESS_AGENTS_CMD: JSON.stringify([process.execPath, fakeAgents]) };
    hook('board', { hook_event_name: 'UserPromptSubmit', session_id: 'solo-1', cwd: solo, prompt_id: 'p', prompt: '혼자 하는 일' }, SE);
    hook('board', { hook_event_name: 'PreToolUse', session_id: 'solo-1', cwd: solo, prompt_id: 'p', tool_name: 'Write', tool_input: { file_path: path.join(solo, 's.js'), content: 'x' } }, SE);
    R.check('[board/agents] 다른 세션이 없으면 요청 · 쓰기 전 어느 쪽도 claude agents 를 띄우지 않는다', calls() === before, `${before} → ${calls()}`);
    hook('board', { hook_event_name: 'UserPromptSubmit', session_id: 'solo-2', cwd: solo, prompt_id: 'p', prompt: '둘째 세션' }, SE);
    R.check('[board/agents] 다른 세션이 생기면 묻는다(그 세션 파일이 후보)', calls() === before + 1, `${before} → ${calls()}`);
  }

  // ── Codex · 실패는 열어 둔다 ──
  const cx = hook('board', { hook_event_name: 'UserPromptSubmit', session_id: 'codex-1234', turn_id: 't', model: 'gpt', cwd: repo, prompt: '코덱스 세션' }, null, ['--codex']);
  R.check('[board/codex] Codex 요청도 같은 출력 계약 · runtime codex', cx.status === 0 && (readSession(repo, 'codex-1234') || {}).runtime === 'codex' && (cx.stdout.trim() === '' || ctx(cx)), cx.stdout);
  const bad = hook('board', '{oops');
  R.check('[board] 깨진 입력 → exit 0 · 출력 없음 · hook-errors.log(저장소 밖이면 임시 폴더)', isAllow(bad) && fs.existsSync(path.join(hookTmp, 'harness', 'hook-errors.log')) && /"hook":"board"/.test(fs.readFileSync(path.join(hookTmp, 'harness', 'hook-errors.log'), 'utf8')), JSON.stringify(bad));
  R.check('[board] 저장소 밖 · session_id 없음 → 조용히 통과', isAllow(ups(path.join(base, 'tmp'), 'nowhere', 'x')) && isAllow(hook('board', { hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: 'x' })));
} catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 1200)); }
finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
R.done();

'use strict';
// v5 status · gc — 주인 생존 · 겹침(두 작업이 같은 파일) · 메인 체크아웃 미커밋 변경의 주인 분류(세션 · 주인 없음)
//   · gc 는 깨끗한 worktree 만 지우고 더러운 것은 남긴다 · 죽은 잠금 해제 · --json.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const Ln = require('../../harness/lib/lane');
const St = require('../../harness/lib/status');
const R = makeReporter('v5 status · gc — 겹침 · 주인 · 정리');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-status-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
// 끝난 프로세스의 pid 는 부하가 크면 곧 재사용된다(Windows) — 어느 OS 에서도 배정되지 않는 큰 값(4의 배수).
const deadPid = () => 99999996;
const quiet = { log: () => {} };
// v7 Light: 작업은 작업 칸(lane.start)으로 연다 — 그 worktree 에서 자기 파일만 커밋한다(사람 · 대화형 세션이 하는 일).
//   비용은 기록된 값(task.spent — v7 이전 작업 기록에 남은 것)을 status 가 그대로 더해 보인다 — 칸에는 작업자 비용이 없어 기록에 적어 둔다.
const goEdit = (root, files, goal) => {
  const r = Ln.start({ ...quiet, root, goal: goal || 'edit' });
  for (const [f, t] of Object.entries(files)) write(path.join(r.worktree, f), t);
  git(r.worktree, ['add', '--', ...Object.keys(files)]); git(r.worktree, ['commit', '-qm', 'work', '--', ...Object.keys(files)]);
  const t = S.readTask(root, r.id); t.spent = { ...(t.spent || {}), cost_usd: 0.2 }; S.writeTask(root, t);
  return r;
};
// 끝난 작업(v7 이전의 무인 작업이 남긴 done 기록과 같은 모양) — gc 가 worktree 를 치우는 대상
const finish = (root, ...ids) => { for (const id of ids) { const t = S.readTask(root, id); t.status = 'done'; S.writeTask(root, t); } };
// 진짜 `claude agents --json` 은 부르지 않는다 — 플랫폼 목록은 이 파일(없으면 last_seen 어림). CLI 자식도 물려받는다.
const AGENTS_FILE = path.join(base, 'agents.json');
process.env.HARNESS_AGENTS_JSON = AGENTS_FILE;
delete process.env.HARNESS_AGENTS_CMD; delete process.env.HARNESS_AGENTS;

(async () => {
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    git(repo, ['config', 'user.name', 't']); git(repo, ['config', 'user.email', 't@example.invalid']); git(repo, ['config', 'commit.gpgsign', 'false']);
    for (const f of ['shared.txt', 'x.txt', 'y.txt', 'z.txt']) write(path.join(repo, f), f + '\n');
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'init']);

    // ── 겹침 ─────────────────────────────────────────────────────────
    const a = await goEdit(repo, { 'shared.txt': 'A\n', 'only-a.txt': 'a\n' }, 'task a');
    const b = await goEdit(repo, { 'shared.txt': 'B\n' }, 'task b');
    const c = await goEdit(repo, { 'z.txt': 'C\n' }, 'task c');
    R.check('[SS-00] 준비: 작업 칸 3개 open', [a, b, c].every(t => t.status === 'open'), [a, b, c].map(t => t.status).join());
    const s1 = St.status({ root: repo });
    const ov = s1.overlaps.find(o => o.file === 'shared.txt');
    R.check('[SS-01] 겹침: 두 작업이 shared.txt 를 바꿈 → 경고(두 id)', !!ov && ov.tasks.slice().sort().join() === [a.id, b.id].sort().join(), JSON.stringify(s1.overlaps));
    R.check('[SS-01] 한 작업만 바꾼 파일은 겹침이 아니다(z.txt · only-a.txt)', s1.overlaps.length === 1, JSON.stringify(s1.overlaps));
    const ta = s1.tasks.find(t => t.id === a.id);
    R.check('[SS-01] 작업 목록: 상태 · 브랜치 · 바뀐 파일 수(.harness 제외) · 비용', ta && ta.status === 'open' && ta.mode === 'light' && ta.branch === `harness/${a.id}` && ta.files_changed === 2 && ta.cost_usd === 0.2 && ta.branch_exists, JSON.stringify(ta));
    const txt = St.formatStatus(s1);
    R.check('[SS-01] 사람용 출력에 겹침 경고', /overlaps/.test(txt) && txt.includes(`! shared.txt — `), txt);
    // [2026-10-29 감사] 레인에는 모델 비용을 쓰는 하네스 프로세스가 없다 — 작업마다의 $0.00 · 누적 비용 줄은 레인에 보이지 않는다
    R.check('[SS-09] 레인(light)에는 비용 칸 · 누적 비용 줄이 없다', !/\$\d/.test(txt) && !/spent/.test(txt), txt.split('\n').filter(l => /\$|spent/.test(l)).join(' | '));
    write(path.join(repo, 'AGENTS.md'), '```yaml\nreply_language: "Korean"\n```\n');
    const txtKo = St.formatStatus(St.status({ root: repo }));
    R.check('[SS-10] 저장소의 작업 언어가 Korean 이면 status 도 한국어(레인에는 비용 줄 없음)', /^저장소: /m.test(txtKo) && /작업 \(3\)/.test(txtKo) && !/누적 비용/.test(txtKo) && !/\$\d/.test(txtKo) && /겹침/.test(txtKo), txtKo);
    fs.rmSync(path.join(repo, 'AGENTS.md'));

    // ── 주인 생존 ─────────────────────────────────────────────────────
    const tc = S.readTask(repo, c.id);
    tc.status = 'running'; tc.owner = { pid: deadPid(), host: os.hostname(), heartbeat_at: new Date(Date.now() - 90000).toISOString() };
    S.writeTask(repo, tc);
    const s2 = St.status({ root: repo });
    const tcs = s2.tasks.find(t => t.id === c.id);
    R.check('[SS-02] running 인데 주인 pid 가 죽음 → alive=false · stale · heartbeat 나이', tcs.owner.alive === false && tcs.stale === true && tcs.owner.heartbeat_age_s >= 89, JSON.stringify(tcs.owner));
    tc.owner = { pid: process.pid, host: os.hostname(), heartbeat_at: new Date().toISOString() };
    S.writeTask(repo, tc);
    const tcs2 = St.status({ root: repo }).tasks.find(t => t.id === c.id);
    R.check('[SS-02] 주인이 살아 있으면 alive=true · stale 아님', tcs2.owner.alive === true && tcs2.stale === false);
    R.check('[SS-02] 사람용 출력: 죽은 주인은 resume 안내', /OWNER DEAD/.test(St.formatStatus(s2)));
    tc.status = 'done'; S.writeTask(repo, tc);

    // ── 미커밋 변경의 주인 ───────────────────────────────────────────
    write(path.join(repo, 'x.txt'), 'edited by nobody we know\n');
    write(path.join(repo, 'y.txt'), 'edited by session s1\n');
    write(path.join(repo, 'new', 'fresh.txt'), 'new file by session s2\n');
    write(path.join(S.paths(repo).sessionsDir, 's1.json'), JSON.stringify({ session_id: 'session-one-1234', runtime: 'claude', files: ['y.txt', 'untouched.txt'], updated_at: new Date().toISOString() }));
    write(path.join(S.paths(repo).sessionsDir, 's2.json'), JSON.stringify({ session_id: 'session-two-5678', runtime: 'codex', files: ['new\\fresh.txt'], updated_at: new Date().toISOString() }));
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const s3 = St.status({ root: repo });
    const u = s3.uncommitted;
    const bySid = Object.fromEntries(u.by_session.map(x => [x.session_id, x.files.join()]));
    R.check('[SS-03] 세션이 기록한 파일은 그 세션으로 분류(경로 구분자 무관)', bySid['session-one-1234'] === 'y.txt' && bySid['session-two-5678'] === 'new/fresh.txt', JSON.stringify(u));
    R.check('[SS-03] 주인 없는 변경은 unowned 로 목록만', JSON.stringify(u.unowned) === '["x.txt"]', JSON.stringify(u.unowned));
    R.check('[SS-03] status 는 아무것도 커밋하거나 되돌리지 않는다', git(repo, ['rev-parse', 'HEAD']) === headBefore && read(path.join(repo, 'x.txt')) === 'edited by nobody we know\n' && git(repo, ['status', '--porcelain', '-uall']).split(/\r?\n/).length === 3);
    R.check('[SS-03] 사람용 출력: 세션별 · 주인 없음', /session session-/.test(St.formatStatus(s3)) && /no known owner .*: x\.txt/.test(St.formatStatus(s3)));

    // ── --json (CLI) ─────────────────────────────────────────────────
    const cli = spawnSync(process.execPath, [CLI, 'status', '--json', '--root', repo], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    let js = null; try { js = JSON.parse(cli.stdout); } catch { /* 없음 */ }
    R.check('[SS-04] CLI status --json: exit 0 · 파싱 가능 · 같은 내용', cli.status === 0 && js && js.tasks.length === 3 && js.overlaps.length === 1 && js.uncommitted.unowned[0] === 'x.txt', `${cli.status} ${cli.stderr.slice(-300)}`);

    // ── gc ───────────────────────────────────────────────────────────
    const Pa = S.taskPaths(repo, a.id), Pb = S.taskPaths(repo, b.id);
    finish(repo, a.id, b.id);   // 칸의 worktree 는 이미 있다(start) — 끝난 작업으로 만든다
    write(path.join(Pa.wt, 'dirty.txt'), 'uncommitted work\n');
    write(path.join(S.lockDir(repo, 'task-dead'), 'owner.json'), JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date().toISOString(), token: 'x' }));
    const liveLock = S.acquire(repo, 'merge');
    const g = St.gc({ root: repo });
    R.check('[SS-05] gc: 더러운 worktree 는 남긴다(파일도 그대로)', fs.existsSync(Pa.wt) && read(path.join(Pa.wt, 'dirty.txt')) === 'uncommitted work\n' && g.kept.some(k => k.id === a.id), JSON.stringify(g.kept));
    R.check('[SS-05] gc: 깨끗한 끝난 worktree 는 지운다', !fs.existsSync(Pb.wt) && g.removed.some(x => x.id === b.id) && !git(repo, ['worktree', 'list']).includes(b.id), JSON.stringify(g.removed));
    R.check('[SS-05] gc: 죽은 잠금은 해제 · 산 잠금은 그대로', g.locks_removed.includes('task-dead') && fs.existsSync(S.lockDir(repo, 'merge')), JSON.stringify(g.locks_removed));
    liveLock.release();
    const cliGc = spawnSync(process.execPath, [CLI, 'gc', '--json', '--root', repo], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    let gj = null; try { gj = JSON.parse(cliGc.stdout); } catch { /* 없음 */ }
    R.check('[SS-05] CLI gc --json: exit 0 · 더러운 worktree 는 여전히 남는다', cliGc.status === 0 && gj && gj.kept.some(k => k.id === a.id) && fs.existsSync(Pa.wt), `${cliGc.status} ${cliGc.stderr.slice(-300)}`);
    const sAfter = St.status({ root: repo });
    R.check('[SS-06] worktree 의 미커밋 변경도 그 작업의 바뀐 파일로 센다', sAfter.tasks.find(t => t.id === a.id).files_changed === 3);

    // ── [M4] gc 는 git 밖(무시된) 파일이 바뀐 worktree 를 지우지 않는다(.worktreeinclude 복사분은 제외) ─
    const g2 = path.join(base, 'gcrepo');
    fs.mkdirSync(g2);
    git(g2, ['init', '-q', '-b', 'main']);
    git(g2, ['config', 'core.autocrlf', 'false']);
    git(g2, ['config', 'user.name', 't']); git(g2, ['config', 'user.email', 't@example.invalid']); git(g2, ['config', 'commit.gpgsign', 'false']);
    write(path.join(g2, '.gitignore'), '.env\n*.log\n'); write(path.join(g2, '.worktreeinclude'), '.env\n'); write(path.join(g2, 'x.txt'), 'x\n');
    git(g2, ['add', '-A']); git(g2, ['commit', '-qm', 'init']);
    write(path.join(g2, '.env'), 'TOKEN=1\n');
    const d = await goEdit(g2, { 'd.txt': 'd\n' }, 'task d');
    const e = await goEdit(g2, { 'e.txt': 'e\n' }, 'task e');
    const f = await goEdit(g2, { 'f.txt': 'f\n' }, 'task f');
    const wtOf = t => S.taskPaths(g2, t.id).wt;
    R.check('[SS-07] 준비: 작업 칸 3개 open · .env 가 칸마다 복사됐다(.worktreeinclude)', [d, e, f].every(t => t.status === 'open' && read(path.join(wtOf(t), '.env')) === 'TOKEN=1\n'), [d, e, f].map(t => `${t.status} ${t.reason}`).join(' | '));
    finish(g2, d.id, e.id, f.id);
    write(path.join(wtOf(e), 'build.log'), 'artifact outside git\n');
    // [L3] f 는 accept/cancel 이 진행 중(task-<id> 잠금이 산 주인) · f 의 임시 revert worktree 는 merge 잠금 아래
    const tmpF = path.join(S.paths(g2).worktreesDir, `${f.id}-cancel-abcd`);
    git(g2, ['worktree', 'add', '-q', '--detach', tmpF, 'main']);
    const taskLockF = S.acquire(g2, `task-${f.id}`);
    const mergeLock = S.acquire(g2, 'merge');
    const gg = St.gc({ root: g2 });
    R.check('[SS-07][M4] .worktreeinclude 복사분(.env)만 있는 worktree 는 지운다', !fs.existsSync(wtOf(d)) && gg.removed.some(x => x.id === d.id), JSON.stringify(gg));
    R.check('[SS-07][M4] 무시된 파일(build.log)이 바뀐 worktree 는 남긴다 · 파일 그대로 · 이유에 파일 이름', fs.existsSync(wtOf(e)) && read(path.join(wtOf(e), 'build.log')) === 'artifact outside git\n' && gg.kept.some(k => k.id === e.id && /build\.log/.test(k.why)), JSON.stringify(gg.kept));
    R.check('[SS-08][L3] task-<id> 잠금이 산 주인에게 있으면 그 worktree 는 건너뛴다', fs.existsSync(wtOf(f)) && gg.kept.some(k => k.id === f.id && /lock/.test(k.why)), JSON.stringify(gg.kept));
    R.check('[SS-08][L3] 진행 중 통합의 임시 worktree(<id>-cancel-*)도 건너뛴다', fs.existsSync(tmpF) && gg.kept.some(k => k.worktree === tmpF && /lock/.test(k.why)), JSON.stringify(gg.kept));
    R.check('[SS-08][L3] gc 는 산 잠금을 풀지 않는다', fs.existsSync(S.lockDir(g2, 'merge')) && fs.existsSync(S.lockDir(g2, `task-${f.id}`)) && !gg.locks_removed.length, JSON.stringify(gg.locks_removed));
    mergeLock.release(); taskLockF.release();
    const gg2 = St.gc({ root: g2 });
    R.check('[SS-08][L3] 잠금이 풀리면 다음 gc 가 지운다(f · 임시 worktree) · e 는 여전히 남는다', !fs.existsSync(wtOf(f)) && !fs.existsSync(tmpF) && fs.existsSync(wtOf(e)), JSON.stringify(gg2));
    write(path.join(wtOf(e), 'dist.log', 'inner', 'a.bin'), 'x');   // 무시된 폴더(dist.log/) — 폴더째가 아니라 안의 파일로 보고
    const ignE = St.ignoredChanged(g2, wtOf(e), S.readTask(g2, e.id).worktree_include);
    R.check('[SS-07][M4] ignoredChanged: 무시된 폴더는 펼쳐 파일로 · .env 복사분은 빠진다', ignE.includes('build.log') && ignE.includes('dist.log/inner/a.bin') && !ignE.some(p => p.startsWith('.env')), JSON.stringify(ignE));
    const txtG = St.formatGc(gg);
    R.check('[SS-07][M4] 사람용 gc 출력에 남긴 이유', /build\.log/.test(txtG), txtG);

    // ── [2026-10-16 자동 이슈 #16] 잠겨서 남은 폴더(등록 없음)는 gc 가 다시 치운다 — 원래 자리와 옆 경로(<id>-2) 모두 ──
    {
      const tpb = S.taskPaths(repo, b.id);
      write(path.join(tpb.wt, 'left.txt'), 'left\n');
      write(path.join(`${tpb.wt}-2`, 'left.txt'), 'left\n');
      const g12 = St.gc({ root: repo });
      R.check('[SS-12] gc: 등록이 사라진 남은 폴더(원래 자리 · 옆 경로)를 치우고, 브랜치와 다른 파일은 작업 기록에 보관한다',
        !fs.existsSync(tpb.wt) && !fs.existsSync(`${tpb.wt}-2`) && fs.readdirSync(tpb.dir).some(n => n.startsWith('leftover-')), JSON.stringify({ removed: g12.removed, kept: g12.kept }));
    }

    // ── [2026-10-29 설치 전 점검] 끝나지 않은 v6 작업(주인이 죽은 running · failed …)은 이어 갈 작업이다 — gc 가 worktree · 자원을 건드리지 않는다 ──
    {
      const v = await goEdit(repo, { 'v6.txt': 'v6\n' }, 'v6 task');
      const tv = S.readTask(repo, v.id); delete tv.mode; tv.status = 'failed'; tv.owner = { pid: deadPid(), host: os.hostname() }; S.writeTask(repo, tv);
      const wv = S.taskPaths(repo, v.id).wt;
      const g13 = St.gc({ root: repo });
      const tv2 = S.readTask(repo, v.id);
      R.check('[SS-17] gc: 끝나지 않은 v6 작업의 깨끗한 worktree 는 남긴다(이유에 start --from) · 자원 회수도 하지 않는다',
        fs.existsSync(wv) && g13.kept.some(k => k.id === v.id && /start --from/.test(k.why)) && !(tv2.resources && tv2.resources.release_at), JSON.stringify({ kept: g13.kept.filter(k => k.id === v.id), res: tv2.resources }));
    }

    // ── [2026-10-15 자동 이슈 #6] 세션이 끊긴 뒤 task.json 이 공백만 남아 status 에서 작업이 조용히 사라졌다 ──
    const tf = S.taskPaths(repo, c.id).taskFile;
    const tc6 = S.readTask(repo, c.id); tc6.reason = 'second write'; S.writeTask(repo, tc6);   // 앞선 판이 .bak 에 남는다
    fs.writeFileSync(tf, '   \n\n  ');
    const back = S.readTask(repo, c.id);
    R.check('[SS-11] task.json 이 깨지면 직전 판(.bak)으로 읽는다 — 작업이 사라지지 않는다', back && back.id === c.id && S.listTasks(repo).some(t => t.id === c.id), JSON.stringify(back && { id: back.id, status: back.status }));
    fs.writeFileSync(`${tf}.bak`, '');
    const s9 = St.status({ root: repo });
    const txt9 = St.formatStatus(s9);
    R.check('[SS-11] 둘 다 깨지면 status 가 "손상" 줄로 보이고 기록(log.jsonl)의 위치와 목표를 알려 준다', (s9.broken || []).some(x => x.id === c.id && /task c/.test(x.goal)) && new RegExp(`${c.id}.*(BROKEN|손상)`).test(txt9) && /log\.jsonl/.test(txt9), txt9);

    // ── [2026-10-25 Light] 게시판: 대화형 세션(플랫폼 목록 우선) · 가벼운 길 · 주인이 죽은 running 은 DEAD ─────
    {
      const br = path.join(base, 'brd');
      fs.mkdirSync(br);
      git(br, ['init', '-q', '-b', 'main']); git(br, ['config', 'user.name', 't']); git(br, ['config', 'user.email', 't@example.invalid']); git(br, ['config', 'commit.gpgsign', 'false']);
      write(path.join(br, 'a.txt'), 'a\n'); git(br, ['add', '-A']); git(br, ['commit', '-qm', 'init']);
      const ago = m => new Date(Date.now() - m * 60000).toISOString();
      const sd = S.paths(br).sessionsDir;
      const sess = (sid, o) => write(path.join(sd, sid + '.json'), JSON.stringify({ session_id: sid, runtime: 'claude', files: [], root: br, branch: 'main', ...o }));
      sess('aaaa-live', { last_seen: ago(5), goal: '목록에 있는 세션의 목표' });
      sess('bbbb-gone', { last_seen: ago(2) });
      sess('cccc-gone-old', { last_seen: ago(120) });
      sess('dddd-ended', { last_seen: ago(20), ended_at: ago(10) });
      sess('eeee-ended-old', { last_seen: ago(200), ended_at: ago(120) });
      sess('ffff-codex', { runtime: 'codex', last_seen: ago(3) });
      sess('gggg-codex-quiet', { runtime: 'codex', last_seen: ago(180) });
      sess('hhhh-old-format', {});
      write(AGENTS_FILE, JSON.stringify([{ pid: 4242, cwd: br, kind: 'interactive', startedAt: 1, sessionId: 'aaaa-live', name: 'brd-proj-1', status: 'busy' }]));
      const lid = 't-20261025-150000-1a2b', did = 't-20261025-150001-3c4d';
      S.writeTask(br, { id: lid, status: 'open', mode: 'light', owner: null, goal: 'lane goal', branch: `harness/${lid}`, worktree: S.taskPaths(br, lid).wt, created_at: new Date().toISOString() });
      S.writeTask(br, { id: did, status: 'running', owner: { pid: deadPid(), host: os.hostname(), heartbeat_at: ago(3) }, goal: 'dead worker', branch: `harness/${did}`, created_at: new Date().toISOString() });
      const sb = St.status({ root: br });
      const by = Object.fromEntries(sb.board.sessions.map(x => [x.session_id, x]));
      R.check('[SS-13] 게시판: 플랫폼 목록이 있으면 liveness=platform · 목록의 세션은 이름 · busy · pid', sb.board.liveness === 'platform' && by['aaaa-live'] && by['aaaa-live'].state === 'busy' && by['aaaa-live'].name === 'brd-proj-1' && by['aaaa-live'].pid === 4242 && by['aaaa-live'].live === true, JSON.stringify(sb.board));
      R.check('[SS-13] 목록에 없는 Claude 세션은 2분 전에 보였어도 gone(산 세션 아님) · 1시간 넘은 gone · ended 는 숨긴다',
        by['bbbb-gone'] && by['bbbb-gone'].state === 'gone' && by['bbbb-gone'].live === false && !by['cccc-gone-old'] && by['dddd-ended'] && by['dddd-ended'].state === 'ended' && !by['eeee-ended-old'], JSON.stringify(Object.keys(by)));
      R.check('[SS-13] Codex 세션은 last_seen 어림(30분 안 live · 밖 quiet) · 게시판 이전 기록(last_seen 없음)은 빠진다',
        by['ffff-codex'] && by['ffff-codex'].state === 'live' && by['gggg-codex-quiet'] && by['gggg-codex-quiet'].state === 'quiet' && !by['hhhh-old-format'], JSON.stringify(sb.board.sessions.map(x => [x.session_id, x.state])));
      R.check('[SS-13] 가벼운 길: id · open · worktree · 브랜치', sb.board.lanes.length === 1 && sb.board.lanes[0].id === lid && sb.board.lanes[0].status === 'open' && sb.board.lanes[0].worktree === S.taskPaths(br, lid).wt && sb.board.lanes[0].branch === `harness/${lid}`, JSON.stringify(sb.board.lanes));
      const tb = St.formatStatus(sb), tbk = St.formatStatus({ ...sb, language: 'Korean' });
      R.check('[SS-13] 사람용 출력: 세션 줄(sid8 · 플랫폼 이름 · busy · gone) · 가벼운 길 줄 · 주인이 죽은 running 은 DEAD',
        /sessions \(\d+\):/.test(tb) && /aaaalive brd-proj-1 \(claude\) busy/.test(tb) && /bbbbgone \(claude\) gone/.test(tb) && new RegExp(`light lanes \\(1\\):\\n  ${lid}  open · `).test(tb) && new RegExp(`${did}  DEAD \\(running · OWNER DEAD`).test(tb)
        && /세션 \(\d+\):/.test(tbk) && /가벼운 길 \(1\):/.test(tbk) && new RegExp(`${did}  DEAD`).test(tbk) && /사라짐/.test(tbk), tb + '\n---\n' + tbk);
      fs.rmSync(AGENTS_FILE);
      const sh = St.status({ root: br });
      const by2 = Object.fromEntries(sh.board.sessions.map(x => [x.session_id, x.state]));
      R.check('[SS-13] 목록을 못 얻으면 last_seen 어림: 30분 안 live · 밖 quiet(하루까지 보인다) · liveness=last_seen', sh.board.liveness === 'last_seen' && by2['aaaa-live'] === 'live' && by2['bbbb-gone'] === 'live' && by2['cccc-gone-old'] === 'quiet' && by2['dddd-ended'] === 'ended', JSON.stringify(by2));
      const cliB = spawnSync(process.execPath, [CLI, 'status', '--json', '--root', br], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      let jb = null; try { jb = JSON.parse(cliB.stdout); } catch { /* 없음 */ }
      R.check('[SS-13] CLI status --json 에 board(더한 필드) · 기존 필드 그대로', cliB.status === 0 && jb && jb.board && Array.isArray(jb.board.sessions) && Array.isArray(jb.board.lanes) && Array.isArray(jb.tasks) && jb.uncommitted && jb.tasks.some(t => t.id === did && t.stale === true && t.mode === null) && jb.tasks.some(t => t.id === lid && t.mode === 'light'), `${cliB.status} ${cliB.stderr.slice(-300)}`);
    }

    // ── [2026-10-29 감사] 끝난 작업마다 git 을 띄우지 않는다 · 끝난 작업은 최근 것만 · v7 이전 작업의 비용만 보인다 ─
    {
      const mr = path.join(base, 'many');
      fs.mkdirSync(mr);
      git(mr, ['init', '-q', '-b', 'main']); git(mr, ['config', 'user.name', 't']); git(mr, ['config', 'user.email', 't@example.invalid']); git(mr, ['config', 'commit.gpgsign', 'false']);
      write(path.join(mr, 'a.txt'), 'a\n'); git(mr, ['add', '-A']); git(mr, ['commit', '-qm', 'init']);
      Ln.start({ ...quiet, root: mr, goal: 'one lane' });
      for (let i = 0; i < 40; i++) { const id = `t-20261001-1000${String(i).padStart(2, '0')}-a${String(i).padStart(3, '0')}`; S.writeTask(mr, { ...S.newTask({ id, goal: `old ${i}`, status: 'accepted' }), branch: `harness/${id}`, updated_at: new Date(Date.now() - i * 60000).toISOString() }); }
      const v6id = 't-20261001-090000-beef';
      S.writeTask(mr, { ...S.newTask({ id: v6id, goal: 'v6 worker', status: 'done', mode: 'thin' }), branch: `harness/${v6id}`, spent: { cost_usd: 1.5 } });
      const G = require('../../harness/lib/git'), orig = G.branchExists;
      let calls = 0; G.branchExists = (...a) => { calls++; return orig(...a); };
      let sm; try { sm = St.status({ root: mr }); } finally { G.branchExists = orig; }
      const finishedShown = sm.tasks.filter(t => t.status === 'accepted').length, tm = St.formatStatus(sm);
      R.check('[SS-14] status 는 작업마다 브랜치 확인 프로세스를 띄우지 않는다(작업 42개에 branchExists ≤ 2회)', calls <= 2, `branchExists ${calls}회`);
      R.check('[SS-14] 끝난(accepted) 작업은 최근 10개만 · 나머지는 수로 알린다', finishedShown === 10 && sm.finished_hidden === 30 && /30 more finished/.test(tm), `${finishedShown} ${sm.finished_hidden}`);
      R.check('[SS-16] v7 이전 작업이 기록한 비용(>0)만 보인다 — 레인 줄에는 $ 가 없다', /beef  done.*\$1\.50/.test(tm) && /spent by pre-v7 unattended tasks: \$1\.50/.test(tm) && !tm.split('\n').some(l => /one lane/.test(l) && /\$/.test(l)), tm.split('\n').filter(l => /\$/.test(l)).join(' | '));
    }

    // ── [감사] 옆 경로(<id>-2 · task.worktree_alt)에서 일하는 열린 레인은 gc 가 지우지 않는다 ─
    {
      const ar = path.join(base, 'altrepo');
      fs.mkdirSync(ar);
      git(ar, ['init', '-q', '-b', 'main']); git(ar, ['config', 'user.name', 't']); git(ar, ['config', 'user.email', 't@example.invalid']); git(ar, ['config', 'commit.gpgsign', 'false']);
      write(path.join(ar, 'a.txt'), 'a\n'); git(ar, ['add', '-A']); git(ar, ['commit', '-qm', 'init']);
      const la = Ln.start({ ...quiet, root: ar, goal: 'alt lane' });
      const alt = `${la.worktree}-2`;
      git(ar, ['worktree', 'move', la.worktree, alt]);
      const ta = S.readTask(ar, la.id); ta.worktree_alt = alt; S.writeTask(ar, ta);
      write(path.join(alt, 'w.txt'), 'w\n'); git(alt, ['add', '--', 'w.txt']); git(alt, ['commit', '-qm', 'w', '--', 'w.txt']);
      const ga = St.gc({ root: ar });
      const sa = St.status({ root: ar });
      R.check('[SS-15] gc: 옆 경로에서 일하는 열린 레인의 worktree 는 남긴다(열린 레인) · status 는 옆 경로를 보인다', fs.existsSync(alt) && !ga.removed.some(x => x.worktree === alt) && ga.kept.some(k => k.id === la.id && k.worktree === alt)
        && sa.board.lanes.some(l => l.id === la.id && l.worktree === alt), JSON.stringify({ removed: ga.removed, kept: ga.kept, lanes: sa.board.lanes }));
    }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

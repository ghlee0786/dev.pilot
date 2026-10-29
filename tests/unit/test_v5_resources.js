'use strict';
// 자원 장부(PRD R1) — 작업마다의 임시 폴더 · 데이터 구역 · compose 이름 · 포트 구역, accept · cancel · gc 때의 회수, 남은 것 보고.
//   docker 는 가짜 실행기로 명령 모양만 잰다(실제 컨테이너를 만들지 않는다). 모델 호출 없음.
//   v7 Light: 작업은 작업 칸(lane.start)으로 연다 — 무인 작업자의 작업 끝 정리(onTaskEnd · killStrays · 이미지 기록)는 지워졌다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const Res = require('../../harness/lib/resources');
const P = require('../../harness/lib/proc');
const S = require('../../harness/lib/state');
const Ln = require('../../harness/lib/lane');
const I = require('../../harness/lib/integrate');
const St = require('../../harness/lib/status');
const R = makeReporter('자원 장부 — 임시 폴더 · 데이터 구역 · 회수 · 남은 것');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-res-'));
// 포트 장부는 PC 에 하나다 — 이 시험의 장부는 임시 디렉터리에(사용자의 장부를 건드리지 않게)
const PORTS = path.join(base, 'machine-ports.json');
process.env.HARNESS_PORTS_FILE = PORTS;
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
const ID = 't-20261020-101010-abcd';
let seq = 0;
function repo(files) {
  const d = path.join(base, `r${++seq}`); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  for (const [f, t] of Object.entries(files)) write(path.join(d, f), t);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
// 가짜 docker — 명령을 기록하고, 목록 응답은 표로 준다(rm 뒤에는 남은 것만)
function fakeDocker(state) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'version') return { code: state.up ? 0 : 1, out: state.up ? '27.0' : '', err: state.up ? '' : 'Cannot connect' };
    const kind = args[0] === 'ps' ? 'containers' : args[0] === 'images' ? 'images' : `${args[0]}s`;
    if (args[0] === 'ps' && args.some(a => /^name=/.test(a))) return { code: 0, out: (state.named || []).join('\n'), err: '' };   // 이름으로 고른 단독 컨테이너
    if (/^(ps|images)$/.test(args[0]) || args[1] === 'ls') return { code: 0, out: (state[kind] || []).join('\n'), err: '' };
    if (args[0] === 'rm' || args[0] === 'rmi' || args[1] === 'rm') { const k = args[0] === 'rm' ? 'containers' : args[0] === 'rmi' ? 'images' : `${args[0]}s`; state[k] = (state[k] || []).filter(x => !args.includes(x) || (state.stuck || []).includes(x)); if (k === 'containers') state.named = (state.named || []).filter(x => !args.includes(x) || (state.stuck || []).includes(x)); return { code: 0, out: '', err: '' }; }
    return { code: 0, out: '', err: '' };
  };
  return { run, calls };
}

(async () => {
  try {
    // RS-01 — 작업 worktree 의 환경: 작업마다의 임시 폴더 · 데이터 구역 · compose 이름. worktree 밖이면 아무것도 없다.
    const root = path.join(base, 'main');
    const wtSub = path.join(root, '.harness-worktrees', ID, 'src');
    const env = Res.envFor(wtSub), env2 = P.isolationEnv(wtSub);
    const dir = Res.tmpDirFor(root, ID);
    R.check('[RS-01] worktree 안: TEMP · TMP · TMPDIR = 작업의 임시 폴더(만들어 둔다) · COMPOSE_PROJECT_NAME · HARNESS_TASK_ID · HARNESS_DATA_NS',
      env.TEMP === dir && env.TMP === dir && env.TMPDIR === dir && fs.existsSync(dir) && env.COMPOSE_PROJECT_NAME === `harness-${ID}` && env.HARNESS_TASK_ID === ID && env.HARNESS_DATA_NS === 'harness_20261020_101010_abcd', JSON.stringify(env));
    R.check('[RS-01] proc.isolationEnv 는 자원 장부의 환경을 그대로 쓴다(작업자 · 하네스 검사 모두) · worktree 밖이면 빈 환경', JSON.stringify(env2) === JSON.stringify(env) && JSON.stringify(P.isolationEnv(root)) === '{}', JSON.stringify(env2));
    R.check('[RS-01] 임시 폴더는 저장소 밖(OS 임시 폴더 아래) — 저장소 · .git 안이 아니다', !path.resolve(dir).toLowerCase().startsWith(path.resolve(root).toLowerCase()) && dir.includes(`${path.sep}harness${path.sep}`), dir);
    // [자동 이슈 #25 · #26] dotnet 빌드 서버 · MSBuild 노드 재사용을 끈다 — 고아 노드가 1,000개씩 쌓였다
    R.check('[RS-01b] (#25) 작업자 · 검사 환경: MSBUILDDISABLENODEREUSE=1 · DOTNET_CLI_USE_MSBUILD_SERVER=0 · UseSharedCompilation=false', env.MSBUILDDISABLENODEREUSE === '1' && env.DOTNET_CLI_USE_MSBUILD_SERVER === '0' && env.UseSharedCompilation === 'false' && env2.MSBUILDDISABLENODEREUSE === '1', JSON.stringify({ a: env.MSBUILDDISABLENODEREUSE, b: env2.MSBUILDDISABLENODEREUSE }));
    R.check('[RS-01] 데이터 구역 이름은 DB · 큐 이름에 그대로 쓸 수 있다(소문자 · 숫자 · 밑줄)', /^[a-z0-9_]+$/.test(Res.dataNs(ID)) && Res.dataNs('t-20261020-101010-ABCD') === 'harness_20261020_101010_abcd');
    // 작업 환경 안에서 하네스를 다시 불러도(TEMP 가 이미 작업 폴더) 겹겹이 들어가지 않는다
    const keep = process.env.HARNESS_TMP_BASE; process.env.HARNESS_TMP_BASE = keep || os.tmpdir();   // 작업 환경이 물려주는 바탕(러너가 준 것이 있으면 그것)
    const keepT = process.env.TEMP; process.env.TEMP = dir;
    const nested = Res.tmpDirFor(root, ID);
    if (keep === undefined) delete process.env.HARNESS_TMP_BASE; else process.env.HARNESS_TMP_BASE = keep;
    if (keepT === undefined) delete process.env.TEMP; else process.env.TEMP = keepT;
    R.check('[RS-01] 작업 환경 안에서 다시 계산해도 같은 폴더(HARNESS_TMP_BASE 로 바탕을 물려준다)', nested === dir, nested);

    // RS-02 — docker: 작업 끝에는 컨테이너 · 네트워크, 치울 때는 + 볼륨 · 이미지. 이름표로만 고른다. 없으면 건너뛴다.
    const st = { up: true, containers: ['c1', 'c2'], networks: ['n1'], volumes: ['v1'], images: ['i1'] };
    const d1 = fakeDocker(st);
    const rt = Res.teardownCompose(ID, 'runtime', d1.run);
    const label = `label=com.docker.compose.project=harness-${ID}`;
    R.check('[RS-02] 작업 끝(runtime): 이 작업의 이름표가 붙은 컨테이너 · 네트워크만 지운다 — 볼륨 · 이미지는 그대로',
      d1.calls.includes(`docker ps -aq --filter ${label}`) && d1.calls.includes('docker rm -f -v c1 c2') && d1.calls.includes('docker network rm n1') && !d1.calls.some(c => /volume|rmi/.test(c)) && rt.removed.containers === 2 && st.volumes.length === 1, JSON.stringify({ calls: d1.calls, rt }));
    const d2 = fakeDocker(st);
    const all = Res.teardownCompose(ID, 'all', d2.run);
    R.check('[RS-02] 치울 때(all): 볼륨 · 이미지(harness-<id>*)까지', d2.calls.includes(`docker volume ls -q --filter ${label}`) && d2.calls.includes('docker volume rm -f v1') && d2.calls.includes(`docker images -q --filter reference=harness-${ID}*`) && d2.calls.includes('docker rmi -f i1') && all.residue.length === 0, JSON.stringify(d2.calls));
    const st5 = { up: true, containers: ['c1'], named: ['p1'] };
    const d5 = fakeDocker(st5), rn = Res.teardownCompose(ID, 'runtime', d5.run);
    R.check('[RS-02] 이름표 없이 docker run 으로 띄운 harness-<id>… 컨테이너도(이름 앞머리로 고른다) 익명 볼륨까지 지운다',
      d5.calls.includes(`docker ps -aq --filter name=^/?harness-${ID}`) && d5.calls.includes('docker rm -f -v p1') && rn.removed.containers === 2 && !st5.named.length, JSON.stringify({ calls: d5.calls, rn }));
    const st3 = { up: true, containers: ['c9'], stuck: ['c9'] };
    const r3 = Res.teardownCompose(ID, 'runtime', fakeDocker(st3).run);
    R.check('[RS-02] 지워지지 않은 것은 남은 것(residue)으로 보고한다', r3.residue.length === 1 && /docker container c9/.test(r3.residue[0]), JSON.stringify(r3));
    const d4 = fakeDocker({ up: false, containers: ['c1'] });
    const r4 = Res.teardownCompose(ID, 'all', d4.run);
    R.check('[RS-02] docker 가 없거나 꺼져 있으면 건너뛴다(오류가 아니다)', r4.skipped && d4.calls.length === 1 && r4.residue.length === 0, JSON.stringify({ r4, calls: d4.calls }));

    // RS-03 — 프로젝트 정리 명령(cleanup_command): 데이터 구역 이름을 받아 돈다 · 실패는 남은 것으로
    const out = path.join(base, 'cleanup-out.txt');
    const rc = repo({ 'AGENTS.md': '# p\n\n```yaml\ncleanup_command: "node cleanup.js"\n```\n', 'cleanup.js': `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.HARNESS_DATA_NS + ' ' + process.env.HARNESS_TASK_ID);\n` });
    const c1 = Res.runCleanupCommand(rc, ID);
    R.check('[RS-03] cleanup_command 는 HARNESS_DATA_NS · HARNESS_TASK_ID 를 받아 저장소 루트에서 돈다', c1 && c1.ok && fs.readFileSync(out, 'utf8') === `harness_20261020_101010_abcd ${ID}`, JSON.stringify(c1));
    R.check('[RS-03] cleanup_command 가 없으면 아무것도 하지 않는다', Res.runCleanupCommand(base, ID, {}) === null);
    const task = { id: ID }, dirC = Res.tmpDirFor(rc, ID);
    fs.mkdirSync(dirC, { recursive: true }); write(path.join(dirC, 'junk', 'a.bin'), 'x');
    const rel = Res.release(rc, task, { run: fakeDocker({ up: false }).run, cleanup: { command: 'node -e "process.exit(3)"' } });
    R.check('[RS-03] 치우기(release): 임시 폴더를 지우고 · 실패한 정리 명령은 남은 것으로 · 작업 기록에 회수 시각 · 이름들',
      !fs.existsSync(dirC) && rel.tmp.removed && rel.residue.some(x => /cleanup_command failed \(exit 3\)/.test(x)) && task.resources.release_at && task.resources.data_ns === 'harness_20261020_101010_abcd' && task.resources.compose_project === `harness-${ID}`, JSON.stringify({ rel, res: task.resources }));

    // RS-04 — 실제 작업 칸으로: 하네스 검사(check <id>)가 작업의 임시 폴더에서 돌고, 끝난 작업을 gc 가 한 번 회수한다(임시 폴더 · 정리 명령)
    //   v7 Light: 작업 끝 회수(onTaskEnd — 무인 루프)는 없다. 회수는 accept · cancel · gc(release) 때.
    const seen = path.join(base, 'seen.json'), cleaned = path.join(base, 'cleaned.txt');
    const CHECK = `const fs=require('fs'),p=require('path');fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({TEMP:process.env.TEMP,NS:process.env.HARNESS_DATA_NS}));fs.writeFileSync(p.join(process.env.TEMP,'garbage.log'),'x');console.log('# pass 1\\n# fail 0');\n`;
    const r5 = repo({ 'AGENTS.md': '# p\n\n```yaml\ntest_command: "node check.js"\ncleanup_command: "node cleanup.js"\n```\n', 'check.js': CHECK,
      'cleanup.js': `require('fs').writeFileSync(${JSON.stringify(cleaned)}, process.env.HARNESS_DATA_NS);\n` });
    // 칸 worktree 에서 자기 파일만 커밋한다(사람 · 대화형 세션이 하는 일)
    const commitIn = (wt, files) => { for (const [f, t] of Object.entries(files)) write(path.join(wt, f), t); git(wt, 'add', '--', ...Object.keys(files)); git(wt, 'commit', '-qm', 'work', '--', ...Object.keys(files)); };
    const t5 = Ln.start({ ...quiet, root: r5, goal: 'add feat' });
    commitIn(t5.worktree, { 'feat.js': 'module.exports = 1;\n' });
    const ck5 = await I.check({ ...quiet, root: r5, id: t5.id });
    let s5 = {}; try { s5 = JSON.parse(fs.readFileSync(seen, 'utf8')); } catch { /* 검사가 돌지 않았다 */ }
    const tmp5 = Res.tmpDirFor(r5, t5.id);
    R.check('[RS-04] 하네스 검사는 작업의 임시 폴더를 TEMP 로 · 데이터 구역 이름을 받는다', ck5.status === 'checked' && path.resolve(s5.TEMP || '') === path.resolve(tmp5) && s5.NS === Res.dataNs(t5.id), JSON.stringify({ status: ck5.status, s5, tmp5 }));
    // 끝난 작업(v7 이전의 무인 작업이 남긴 done 기록과 같은 모양)으로 만든 뒤 gc
    const done5 = S.readTask(r5, t5.id); done5.status = 'done'; S.writeTask(r5, done5);
    const g5 = St.gc({ root: r5 });
    const task5b = S.readTask(r5, t5.id);
    R.check('[RS-04] gc: 끝난 작업의 임시 폴더(검사가 남긴 쓰레기 포함)를 지운다 · 비면 저장소 키 폴더도 · 남은 것 없음으로 기록',
      !fs.existsSync(tmp5) && !fs.existsSync(path.dirname(tmp5)) && task5b.resources && task5b.resources.release_at && (task5b.resources.residue || []).length === 0, JSON.stringify(task5b.resources));
    R.check('[RS-04] gc: 끝난 작업을 한 번 회수한다 — 프로젝트 정리 명령이 그 작업의 데이터 구역으로 돈다', fs.existsSync(cleaned) && fs.readFileSync(cleaned, 'utf8') === Res.dataNs(t5.id) && task5b.resources.release_at && (g5.released || []).some(x => x.id === t5.id && x.cleanup === true), JSON.stringify({ released: g5.released, res: task5b.resources }));
    fs.rmSync(cleaned, { force: true });
    St.gc({ root: r5 });
    R.check('[RS-04] gc 를 다시 해도 같은 작업을 또 회수하지 않는다', !fs.existsSync(cleaned));

    // RS-05 — accept · cancel 도 회수한다
    const t6 = Ln.start({ ...quiet, root: r5, goal: 'add feat 2' });
    commitIn(t6.worktree, { 'feat2.js': 'module.exports = 2;\n' });
    const acc = await I.accept({ ...quiet, root: r5, id: t6.id });
    R.check('[RS-05] accept 는 그 작업의 자원을 회수한다(정리 명령 포함)', acc.status === 'accepted' && S.readTask(r5, t6.id).resources.release_at && fs.readFileSync(cleaned, 'utf8') === Res.dataNs(t6.id), JSON.stringify({ status: acc.status, report: acc.report, res: S.readTask(r5, t6.id).resources }));
    const t7 = Ln.start({ ...quiet, root: r5, goal: 'add feat 3' });
    commitIn(t7.worktree, { 'feat3.js': 'module.exports = 3;\n' });
    const can = await I.cancel({ ...quiet, root: r5, id: t7.id });
    R.check('[RS-05] cancel 도 회수한다', can.status === 'cancelled' && S.readTask(r5, t7.id).resources.release_at && fs.readFileSync(cleaned, 'utf8') === Res.dataNs(t7.id), JSON.stringify({ status: can.status, res: S.readTask(r5, t7.id).resources }));
    // RS-07 — [2026-10-29 감사] start --owns 는 기록만 되고 어디서도 읽지 않았다(guard --worker 가 빠진 뒤 죽은 옵션) — 레인은 owns 를 받지 않는다
    const t8 = Ln.start({ ...quiet, root: r5, goal: 'billing only', owns: ['src/billing/**'] });
    R.check('[RS-07] start 는 owns 를 기록하지 않는다(효과 없는 옵션을 믿게 하지 않는다)', t8.status === 'open' && S.readTask(r5, t8.id).owns === undefined, JSON.stringify({ status: t8.status, owns: S.readTask(r5, t8.id).owns }));

    // RS-09 — CLI 는 할 일을 마치면 남은 핸들이 있어도 끝난다(분리된 go 가 done 뒤 24분 살아 있던 실측) — 새는 타이머를 미리 심어 재현
    const leak = path.join(base, 'leak.js'); write(leak, 'setInterval(() => {}, 1000);\n');
    const r9 = repo({ 'a.txt': 'x\n' }), t9 = Date.now();
    const cli9 = spawnSync(process.execPath, ['-r', leak, path.join(__dirname, '..', '..', 'harness', 'cli.js'), 'status', '--root', r9], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    R.check('[RS-09] 남은 핸들(타이머)이 있어도 CLI 는 일을 마치고 몇 초 안에 끝난다(종료 코드 유지)', !cli9.error && cli9.status === 0 && Date.now() - t9 < 25000, JSON.stringify({ err: cli9.error && cli9.error.code, status: cli9.status, ms: Date.now() - t9, out: (cli9.stdout || '').slice(0, 120) }));

    // RS-12 — 작업마다의 포트 구역: 장부(PC 에 하나) · 같은 작업은 같은 구역 · 다른 작업은 겹치지 않음 · 끝난/없는 작업은 회수
    { const r12 = repo({ 'a.txt': 'x\n' });
      const ledgerFile = path.join(base, 'ports-12.json');   // 앞 시험의 레인(t8)이 잡은 구역과 섞이지 않게 새 장부
      process.env.HARNESS_PORTS_FILE = ledgerFile;
      const A = 't-20261025-090000-aaaa', B = 't-20261025-090000-bbbb', C = 't-20261025-090000-cccc', D = 't-20261025-090000-dddd';
      const mk = (id, status) => S.writeTask(r12, S.newTask({ id, status }));
      mk(A, 'open'); mk(B, 'done');
      const a1 = Res.portBlock(r12, A), b1 = Res.portBlock(r12, B), a2 = Res.portBlock(r12, A);
      const disjoint = (x, y) => x.base + x.count <= y.base || y.base + y.count <= x.base;
      R.check('[RS-12] 기본 구역: 20000 부터 20개씩 · 같은 작업은 다시 물어도 같은 구역 · 다른 작업은 겹치지 않는 다음 구역',
        a1.base === 20000 && a1.count === 20 && JSON.stringify(a2) === JSON.stringify(a1) && b1.base === 20020 && b1.count === 20 && disjoint(a1, b1), JSON.stringify({ a1, a2, b1 }));
      const led = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      R.check('[RS-12] 장부는 PC 에 하나(HARNESS_PORTS_FILE)의 { id: { base, count, at, root } } · portsOf 는 그 저장소의 것만 보인다',
        led[A] && led[A].base === 20000 && led[A].count === 20 && typeof led[A].at === 'string' && typeof led[A].root === 'string' && led[B].base === 20020 && JSON.stringify(Object.keys(Res.portsOf(r12)).sort()) === JSON.stringify([A, B]), JSON.stringify(led));
      // A 가 받아들여지면(accepted) · 기록이 없는 작업(D)의 구역은 다음 잡기 때 풀린다 — 가장 낮은 빈 구역(20000)을 C 가 받는다
      const raw = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); raw[D] = { base: 20040, count: 20, at: 'x' }; fs.writeFileSync(ledgerFile, JSON.stringify(raw));
      mk(A, 'accepted'); mk(C, 'open');
      const c1 = Res.portBlock(r12, C), led2 = Res.portsOf(r12);
      R.check('[RS-12] 끝난(accepted) 작업 · 기록이 없는 작업의 구역은 회수되고 가장 낮은 빈 구역을 준다 · 살아 있는(done) 작업은 그대로',
        c1.base === 20000 && !led2[A] && !led2[D] && led2[B] && led2[B].base === 20020 && led2[C].base === 20000, JSON.stringify({ c1, led2 }));
      // envFor: 작업 worktree 경로면 포트 변수 · 아니면 없음
      const e12 = Res.envFor(path.join(r12, '.harness-worktrees', C, 'src')), en = Res.envFor(r12);
      R.check('[RS-12] envFor: worktree 안이면 HARNESS_PORT_BASE · HARNESS_PORT_COUNT(그 작업의 구역) · 밖이면 아무것도 없다',
        e12.HARNESS_PORT_BASE === '20000' && e12.HARNESS_PORT_COUNT === '20' && e12.HARNESS_TASK_ID === C && !('HARNESS_PORT_BASE' in en) && JSON.stringify(en) === '{}', JSON.stringify({ e12, en }));
      const eNoRepo = Res.envFor(path.join(base, 'not-a-repo', '.harness-worktrees', C));
      R.check('[RS-12] 장부를 쓸 수 없는 곳(git 저장소 아님)이면 포트 변수만 빠진다 — 던지지 않는다', eNoRepo.HARNESS_TASK_ID === C && !('HARNESS_PORT_BASE' in eNoRepo), JSON.stringify(eNoRepo));
      // 열린 작업의 구역은 장부에 남고(accept 때 검사가 쓴다) · 치울 때(release)는 풀린다
      const tC = S.readTask(r12, C);
      const held = Res.portsOf(r12)[C];
      const relC = Res.release(r12, tC, { run: fakeDocker({ up: false }).run, cleanup: { command: '' } });
      R.check('[RS-12] 열린 작업의 구역은 장부에 남고 · release 가 푼다 · 다시 풀어도 null',
        held && held.base === 20000 && !Res.portsOf(r12)[C] && relC.ports && relC.ports.base === 20000 && Res.freePorts(r12, C) === null, JSON.stringify({ held, ports: relC.ports, led: Res.portsOf(r12) }));
      // 프로젝트 설정: port_range · port_block — 구역이 다 차면 PORTS_EXHAUSTED · envFor 는 포트 변수만 뺀다
      const r13 = repo({ 'AGENTS.md': '# p\n\n```yaml\nport_range: "30000-30059"\nport_block: 30\n```\n' });
      const X = 't-20261025-091000-0001', Y = 't-20261025-091000-0002', Z = 't-20261025-091000-0003';
      for (const id of [X, Y, Z]) S.writeTask(r13, S.newTask({ id, status: 'open' }));
      const x1 = Res.portBlock(r13, X), y1 = Res.portBlock(r13, Y);
      let ex = null; try { Res.portBlock(r13, Z); } catch (e) { ex = e; }
      const eZ = Res.envFor(path.join(r13, '.harness-worktrees', Z));
      R.check('[RS-12] yaml port_range · port_block 을 따른다 · 다 차면 PORTS_EXHAUSTED · envFor 는 그때 포트 변수만 뺀다',
        x1.base === 30000 && x1.count === 30 && y1.base === 30030 && ex && ex.code === 'PORTS_EXHAUSTED' && eZ.HARNESS_TASK_ID === Z && !('HARNESS_PORT_BASE' in eZ), JSON.stringify({ x1, y1, ex: ex && ex.code, eZ: eZ.HARNESS_PORT_BASE }));
      // 두 프로세스가 동시에 잡아도 겹치지 않는다(잠금 아래 장부 쓰기)
      const r14 = repo({ 'a.txt': 'x\n' });
      const idsP = n => Array.from({ length: 6 }, (_, i) => `t-20261025-092000-${n}${String(i).padStart(3, '0')}`);
      const ids1 = idsP('a'), ids2 = idsP('b');
      for (const id of [...ids1, ...ids2]) S.writeTask(r14, S.newTask({ id, status: 'open' }));
      const script = path.join(base, 'ports-child.js');
      write(script, `const Res = require(${JSON.stringify(path.join(__dirname, '..', '..', 'harness', 'lib', 'resources.js'))});\nconst out = {}; for (const id of process.argv.slice(3)) out[id] = Res.portBlock(process.argv[2], id);\nconsole.log(JSON.stringify(out));\n`);
      const runChild = list => new Promise(res => { const c = spawn(process.execPath, [script, r14, ...list], { windowsHide: true }); let o = ''; c.stdout.on('data', d => { o += d; }); c.on('close', code => res({ code, o })); });
      const [p1, p2] = await Promise.all([runChild(ids1), runChild(ids2)]);
      let got = {}; try { got = { ...JSON.parse(p1.o), ...JSON.parse(p2.o) }; } catch { /* 아래에서 실패로 */ }
      const blocks = Object.values(got), ledP = Res.portsOf(r14);
      const allDisjoint = blocks.every((x, i) => blocks.every((y, j) => i === j || disjoint(x, y)));
      R.check('[RS-12] 두 프로세스가 동시에 12개 작업의 구역을 잡아도 서로 겹치지 않고 장부에 모두 남는다',
        p1.code === 0 && p2.code === 0 && blocks.length === 12 && allDisjoint && Object.keys(ledP).length === 12 && Object.entries(got).every(([id, b]) => ledP[id] && ledP[id].base === b.base),
        JSON.stringify({ c1: p1.code, c2: p2.code, got, led: Object.keys(ledP).length })); }

    // RS-13 — [2026-10-29 감사] 장부가 저장소마다라 다른 저장소의 레인이 같은 구역을 받았다 — PC 에 하나인 장부에서 겹치지 않게
    { process.env.HARNESS_PORTS_FILE = path.join(base, 'ports-13.json');
      const one = repo({ 'a.txt': 'x\n' }), two = repo({ 'b.txt': 'y\n' });
      const a = Ln.start({ ...quiet, root: one, goal: 'proj one lane a' }), b = Ln.start({ ...quiet, root: one, goal: 'proj one lane b' }), c = Ln.start({ ...quiet, root: two, goal: 'proj two lane c' });
      const blocks = [a.ports, b.ports, c.ports];
      const disj = (x, y) => x.base + x.count <= y.base || y.base + y.count <= x.base;
      const eC = Res.envFor(path.join(two, '.harness-worktrees', c.id)), eA = Res.envFor(path.join(one, '.harness-worktrees', a.id));
      R.check('[RS-13] 서로 다른 저장소의 레인도 겹치지 않는 포트 구역을 받는다 · envFor 도 같은 구역', blocks.every(Boolean) && disj(a.ports, b.ports) && disj(a.ports, c.ports) && disj(b.ports, c.ports)
        && eC.HARNESS_PORT_BASE === String(c.ports.base) && eA.HARNESS_PORT_BASE === String(a.ports.base) && eC.HARNESS_PORT_BASE !== eA.HARNESS_PORT_BASE, JSON.stringify({ blocks, eA: eA.HARNESS_PORT_BASE, eC: eC.HARNESS_PORT_BASE }));
      // 다른 저장소의 끝난 작업은 다음 잡기 때 풀린다(장부 항목마다 저장소를 적는다)
      const ta = S.readTask(one, a.id); ta.status = 'accepted'; S.writeTask(one, ta);
      const d = Ln.start({ ...quiet, root: two, goal: 'proj two lane d' });
      R.check('[RS-13] 다른 저장소에서 끝난(accepted) 작업의 구역은 다음 잡기 때 풀려 다시 쓰인다', d.ports && d.ports.base === a.ports.base && !Res.portsOf(one)[a.id], JSON.stringify({ d: d.ports, a: a.ports }));

      // RS-14 — 끝난(accepted) 레인의 남은 worktree 에서 세션을 열어도(envFor · board) 구역을 새로 잡지 않는다 · gc 는 남은 구역을 푼다
      const tb = S.readTask(one, b.id); tb.status = 'accepted'; S.writeTask(one, tb);
      Res.freePorts(one, b.id);
      const eB = Res.envFor(path.join(one, '.harness-worktrees', b.id));
      R.check('[RS-14] accepted 작업의 worktree 에서 envFor 는 포트 변수를 주지 않고 장부에 잡지 않는다(다른 변수는 그대로)', eB.HARNESS_TASK_ID === b.id && !('HARNESS_PORT_BASE' in eB) && !Res.portsOf(one)[b.id], JSON.stringify(eB));
      const raw = JSON.parse(fs.readFileSync(process.env.HARNESS_PORTS_FILE, 'utf8')); raw[b.id] = { base: 39000, count: 20, at: 'x', root: S.paths(one).root }; fs.writeFileSync(process.env.HARNESS_PORTS_FILE, JSON.stringify(raw));
      St.gc({ root: one });
      R.check('[RS-14] gc 는 끝난 작업에 남은 구역을 푼다(회수 시각이 이미 있어도)', !Res.portsOf(one)[b.id], JSON.stringify(Res.portsOf(one)));
      // RS-15 — 프로세스 정리 구역은 평가(eval/run.js)가 쓰는 두 함수만 남는다
      R.check('[RS-15] listProcesses · killProcess · teardownCompose 는 그대로 내보낸다', typeof Res.listProcesses === 'function' && typeof Res.killProcess === 'function' && typeof Res.teardownCompose === 'function'); }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

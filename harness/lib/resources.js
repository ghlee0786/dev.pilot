'use strict';
// 자원 장부 — 작업 하나가 git 밖에 만드는 것(임시 폴더 · compose 컨테이너/네트워크/볼륨/이미지 · 시험 데이터 구역)을 정하고, 끝나면 회수한다.
//   [2026-10-20 PRD R1 · 사용자 원칙 "시험 뒤 쓰레기 데이터를 정리한다"] 다중 에이전트에서는 쓰레기가 에이전트 수만큼 는다 — 정리는 전제다.
//   이름이 작업마다 고유하므로(harness-<id> · harness_<id>) 사용자의 것을 건드릴 일이 없다. docker 가 없거나 꺼져 있으면 그 부분은 건너뛴다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const WT_RE = /^(.*?)[\\/]\.harness-worktrees[\\/](t-\d{8}-\d{6}-[0-9a-f]{4})(?:-\d+)?(?=[\\/]|$)/;
// OS 임시 폴더 — 작업 환경의 TEMP 를 바꾸므로, 그 환경 안에서 하네스를 다시 불러도 겹겹이 들어가지 않게 바탕을 물려준다.
const baseTmp = () => process.env.HARNESS_TMP_BASE || os.tmpdir();

function repoKey(root) {
  const real = (() => { try { return fs.realpathSync.native(root); } catch { return path.resolve(root); } })();
  const name = path.basename(real).replace(/[^\w.-]+/g, '_').slice(0, 24) || 'repo';
  return `${name}-${crypto.createHash('sha1').update(real.toLowerCase()).digest('hex').slice(0, 8)}`;
}
const tmpDirFor = (root, id) => path.join(baseTmp(), 'harness', repoKey(root), id);
// DB · 큐 · 버킷 이름에 그대로 쓸 수 있게 — 소문자 · 숫자 · 밑줄
const dataNs = id => `harness_${String(id).replace(/^t-/, '').replace(/[^0-9a-z]+/gi, '_').toLowerCase()}`;
const composeProject = id => `harness-${id}`;

// 작업 worktree 안에서 도는 프로세스(작업자 · 하네스 검사)의 환경 — worktree 밖이면 빈 객체
//   + 작업마다의 포트 구역(HARNESS_PORT_BASE · HARNESS_PORT_COUNT) — 처음 쓸 때 잡는다. 못 잡으면 포트 변수만 뺀다(던지지 않는다).
function envFor(cwd) {
  const m = WT_RE.exec(String(cwd || ''));
  if (!m) return {};
  const id = m[2], dir = tmpDirFor(m[1], id), ports = portEnv(m[1], id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 못 만들면 TEMP 를 바꾸지 않는다 */ return { COMPOSE_PROJECT_NAME: composeProject(id), HARNESS_TASK_ID: id, HARNESS_DATA_NS: dataNs(id), ...ports }; }
  return { COMPOSE_PROJECT_NAME: composeProject(id), TEMP: dir, TMP: dir, TMPDIR: dir, HARNESS_TMP_BASE: baseTmp(), HARNESS_TASK_ID: id, HARNESS_DATA_NS: dataNs(id), ...ports, ...BUILD_NO_SERVERS };
}
function portEnv(root, id) {
  try { const b = portBlock(root, id); return { HARNESS_PORT_BASE: String(b.base), HARNESS_PORT_COUNT: String(b.count) }; }
  catch { return {}; }
}

// ── 포트 구역 ────────────────────────────────────────────────────────────────
//   [2026-10-25 사용자 "구조적으로 막을 수 있다"] 병렬 작업이 같은 포트(개발 서버 · 시험 DB)를 잡아 서로 깨뜨렸다 — 작업마다 겹치지 않는
//   구역(기본 20000-39999 에서 20개씩)을 장부에 잡아 준다. 장부 쓰기는 잠금 아래 · 원자적으로.
//   잡기 전에 기록이 없거나 끝난(accepted · cancelled) 작업의 구역을 푼다. 끝난 작업에는 새로 잡지 않는다.
//   [2026-10-29 감사] 장부가 저장소마다(<git-common-dir>/harness/ports.json) 따로라 다른 저장소의 레인끼리 같은 구역(20000)을 받았다 —
//   장부는 PC 에 하나: <HARNESS_TMP_BASE 또는 OS 임시 폴더>/harness/ports.json(작업 환경에도 HARNESS_TMP_BASE 를 물려주므로 같은 파일) ·
//   HARNESS_PORTS_FILE 로 바꿀 수 있다. 항목마다 그 저장소(root)를 적어 끝난 작업을 알아본다.
//   프로젝트 yaml: port_range: "20000-39999" · port_block: 20 (없거나 이상하면 기본).
const PORT_FINAL = new Set(['accepted', 'cancelled']);
const machinePortsFile = () => process.env.HARNESS_PORTS_FILE || path.join(baseTmp(), 'harness', 'ports.json');
const okEntry = e => !!e && typeof e === 'object' && Number.isInteger(e.base) && Number.isInteger(e.count) && e.count > 0;
function readLedger(file) {
  const raw = require('./state').readJson(file, null), led = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (okEntry(v)) led[k] = v;
  return led;
}
const realRoot = root => { try { return require('./state').paths(root).root; } catch { return path.resolve(root); } };
const sameRoot = (a, b) => !!a && !!b && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
// PC 장부의 잠금 — 저장소 잠금(state.acquire)은 저장소마다라 쓸 수 없다. 같은 mkdir 원자 잠금 · 죽은 주인은 빼앗는다(state.staleInfo · takeOver).
function withMachineLock(file, fn, waitMs) {
  const S = require('./state'), dir = `${file}.lock`, deadline = Date.now() + (waitMs || 15000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    let made = false;
    try { fs.mkdirSync(dir); made = true; } catch (e) { if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e; }
    if (made) {
      const owner = { pid: process.pid, host: S.HOST, at: S.nowIso(), token: crypto.randomBytes(6).toString('hex') };
      try {
        S.writeJsonAtomic(path.join(dir, 'owner.json'), owner, { noMkdir: true });
        return fn();
      } finally {
        const cur = S.readJson(path.join(dir, 'owner.json'), null);
        if (!cur || cur.token === owner.token) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 남으면 다음에 빼앗긴다 */ } }
      }
    }
    const st = S.staleInfo(dir);
    if (st.stale && S.takeOver(dir, st.owner)) continue;
    if (Date.now() >= deadline) throw Object.assign(new Error(`the port ledger ${file} is locked by another process`), { code: 'LOCK_HELD', owner: st.owner });
    S.sleepSync(30 + Math.floor(Math.random() * 30));
  }
}
function portConf(root) {
  let lo = 20000, hi = 39999, count = 20;
  try {
    const K = require('./checks');
    const r = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(K.yamlString(root, 'port_range') || '');
    if (r && +r[1] >= 1024 && +r[2] <= 65535 && +r[1] < +r[2]) { lo = +r[1]; hi = +r[2]; }
    const b = parseInt(K.yamlString(root, 'port_block') || '', 10);
    if (b >= 1 && b <= hi - lo + 1) count = b;
  } catch { /* 설정을 못 읽으면 기본 */ }
  return { lo, hi, count };
}
// → { base, count } — 이 작업의 구역(있으면 그대로 · 없으면 가장 낮은 빈 구역). 빈 구역이 없으면 PORTS_EXHAUSTED.
function portBlock(root, id) {
  const S = require('./state');
  if (!S.validId(id)) throw Object.assign(new Error(`invalid task id: ${id}`), { code: 'USAGE' });
  const rr = realRoot(root), file = machinePortsFile(), have = readLedger(file)[id];
  if (have && sameRoot(have.root, rr)) return { base: have.base, count: have.count };   // 이미 잡았으면 잠그지 않는다(작업자 · 검사가 띄울 때마다 불린다)
  // [2026-10-29 감사] 끝난(accepted) 레인의 남은 worktree 에서 세션을 열면 board 가 그 작업에 구역을 새로 잡고 gc 는 풀지 않았다 — 끝난 · 없는 작업에는 잡지 않는다.
  const task = S.readTask(root, id);
  if (!task) throw Object.assign(new Error(`unknown task: ${id}`), { code: 'UNKNOWN_TASK' });
  if (PORT_FINAL.has(task.status)) throw Object.assign(new Error(`task ${id} is ${task.status} — no port block`), { code: 'TASK_FINISHED' });
  return withMachineLock(file, () => {
    const led = readLedger(file);
    if (led[id] && sameRoot(led[id].root, rr)) return { base: led[id].base, count: led[id].count };
    for (const k of Object.keys(led)) {
      if (k === id) { delete led[k]; continue; }   // 같은 id 의 다른 저장소 항목(있을 수 없지만) — 이 작업으로 다시 잡는다
      let t = null;
      try { t = S.validId(k) && led[k].root && fs.existsSync(led[k].root) ? S.readTask(led[k].root, k) : null; } catch { t = null; }
      if (!t || PORT_FINAL.has(t.status)) delete led[k];
    }
    const { lo, hi, count } = portConf(root);
    const taken = Object.values(led).map(e => [e.base, e.base + e.count]);
    for (let b = lo; b + count - 1 <= hi;) {
      const hit = taken.find(([s, e]) => b < e && s < b + count);
      if (!hit) { led[id] = { base: b, count, at: S.nowIso(), root: rr }; S.writeJsonAtomic(file, led); return { base: b, count }; }
      b = Math.max(hit[1], b + 1);
    }
    S.writeJsonAtomic(file, led);
    throw Object.assign(new Error(`no free port block of ${count} in ${lo}-${hi} (${Object.keys(led).length} tasks hold blocks)`), { code: 'PORTS_EXHAUSTED' });
  });
}
// 이 작업의 구역을 푼다 — 풀었으면 그 구역, 없었으면 null
function freePorts(root, id) {
  const file = machinePortsFile(), rr = realRoot(root);
  const mine = e => !!e && (!e.root || sameRoot(e.root, rr));
  if (!mine(readLedger(file)[id])) return null;
  return withMachineLock(file, () => {
    const led = readLedger(file), had = led[id];
    if (!mine(had)) return null;
    delete led[id]; require('./state').writeJsonAtomic(file, led);
    return { base: had.base, count: had.count };
  });
}
// 이 저장소의 장부 항목(상태 표시용) — { "<id>": { base, count, at, root } }
const portsOf = root => {
  try { const rr = realRoot(root), led = readLedger(machinePortsFile()); return Object.fromEntries(Object.entries(led).filter(([, e]) => sameRoot(e.root, rr))); }
  catch { return {}; }
};
// [2026-10-21 자동 이슈 #25 · #26] 작업자 · 검사의 dotnet test/build 가 MSBuild 작업 노드(/nodemode:1)를 수백 개씩 띄우고, 부모가 끝나면
//   고아로 남아 1,000개 · 수십 GB 까지 쌓였다(작업 끝 점검은 부모를 잃은 노드를 작업 소속으로 알아보지 못한다). 처음부터 띄우지 않게 한다:
//   노드 재사용 끔 · MSBuild 서버 끔 · Roslyn 컴파일러 서버(VBCSCompiler) 끔. 빌드는 조금 느려지지만 남는 프로세스가 없다.
const BUILD_NO_SERVERS = { MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0', UseSharedCompilation: 'false' };

// ── docker(compose) ─────────────────────────────────────────────────────────
const defaultRun = (cmd, args, timeoutMs) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs || 60000 });
  return { code: r.error ? null : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') + (r.error ? r.error.message : '') };
};
const ids = s => [...new Set(String(s || '').split(/\s+/).filter(Boolean))];
// docker 가 있는지는 프로세스마다 한 번만 본다(작업이 끝날 때마다 띄우지 않게). HARNESS_DOCKER_CLEANUP=off 면 보지 않는다.
let dockerSeen = null;
function dockerAvailable(run) {
  if (run !== defaultRun) return run('docker', ['version', '--format', '{{.Server.Version}}'], 15000).code === 0;
  if (process.env.HARNESS_DOCKER_CLEANUP === 'off') return false;
  if (dockerSeen === null) dockerSeen = run('docker', ['version', '--format', '{{.Server.Version}}'], 15000).code === 0;
  return dockerSeen;
}
// level 'runtime' — 컨테이너 · 네트워크(작업이 끝날 때). 'all' — + 볼륨 · 이미지(accept · cancel · gc 때).
function teardownCompose(id, level, run) {
  run = run || defaultRun;
  const res = { skipped: null, removed: {}, residue: [] };
  if (!dockerAvailable(run)) { res.skipped = 'docker not available'; return res; }
  const label = `label=com.docker.compose.project=${composeProject(id)}`;
  // compose 이름표가 붙은 것 + 이름이 harness-<id> 로 시작하는 단독 컨테이너(docker run --name $COMPOSE_PROJECT_NAME-pg) — 익명 볼륨(-v)까지.
  //   [2026-10-20 실측] 작업자가 시험용 postgres 를 docker run 으로 띄우고 두고 갔다(이름표 없음 → 이름표로만 고르던 정리가 놓쳤다).
  const kinds = [
    ['containers', ['ps', '-aq', '--filter', label], list => ['rm', '-f', '-v', ...list]],
    ['containers', ['ps', '-aq', '--filter', `name=^/?${composeProject(id)}`], list => ['rm', '-f', '-v', ...list]],
    ['networks', ['network', 'ls', '-q', '--filter', label], list => ['network', 'rm', ...list]],
    ...(level === 'all' ? [
      ['volumes', ['volume', 'ls', '-q', '--filter', label], list => ['volume', 'rm', '-f', ...list]],
      ['images', ['images', '-q', '--filter', `reference=${composeProject(id)}*`], list => ['rmi', '-f', ...list]],
    ] : []),
  ];
  for (const [kind, listArgs, rmArgs] of kinds) {
    const found = ids(run('docker', listArgs, 30000).out);
    if (!found.length) continue;
    run('docker', rmArgs(found), 120000);
    const left = ids(run('docker', listArgs, 30000).out);
    res.removed[kind] = (res.removed[kind] || 0) + found.length - left.length;
    for (const x of left) res.residue.push(`docker ${kind.replace(/s$/, '')} ${x}`);
  }
  return res;
}

// ── 프로젝트 정리 명령(cleanup_command) ──────────────────────────────────────
//   git 밖 공유 저장소(DB · 큐 · 버킷)에 남긴 시험 데이터는 하네스가 알 수 없다 — 프로젝트가 정한 명령에 데이터 구역 이름을 주고 돌린다.
function runCleanupCommand(root, id, o) {
  const K = require('./checks');
  const cmd = (o && o.command) != null ? o.command : K.yamlString(root, 'cleanup_command');
  if (!cmd) return null;
  const spec = K.spawnSpec(K.splitCommand(cmd));
  const env = { ...K.childEnv(), HARNESS_TASK_ID: id, HARNESS_DATA_NS: dataNs(id), COMPOSE_PROJECT_NAME: composeProject(id) };
  const r = spawnSync(spec.cmd, spec.args, { cwd: root, env, shell: spec.shell, encoding: 'utf8', windowsHide: true, timeout: (o && o.timeoutMs) || 5 * 60 * 1000 });
  return { command: cmd, ok: !r.error && r.status === 0, exit_code: r.error ? null : r.status, output: (String(r.stdout || '') + String(r.stderr || '')).slice(-1500) };
}

// ── 임시 폴더 ────────────────────────────────────────────────────────────────
function removeTmp(root, id) {
  const dir = tmpDirFor(root, id);
  if (!fs.existsSync(dir)) return { dir, removed: false, residue: [] };
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 아래에서 남은 것으로 본다 */ }
  if (fs.existsSync(dir)) return { dir, removed: false, residue: [`temp folder ${dir}`] };
  // 비었으면 위 폴더(저장소 키 · harness)도 — [2026-10-20 실측] 작업 폴더만 지워 빈 폴더가 저장소 · 테스트마다 쌓였다
  for (const up of [path.dirname(dir), path.dirname(path.dirname(dir))]) { try { fs.rmdirSync(up); } catch { break; } }
  return { dir, removed: true, residue: [] };
}

// ── 프로세스 목록 · 끝내기 ──────────────────────────────────────────────────
//   v7 은 작업 끝에 프로세스를 회수하지 않는다(무인 작업자가 없다 · release 에 프로세스 단계 없음) — 등록이 사라진 남은 worktree 폴더를 붙잡은
//   프로세스만 git.js 의 killProcsIn 이 끝낸다. 여기 둘은 평가(eval/run.js)가 작업공간의 남은 프로세스를 치울 때 쓴다.
const IS_WIN = process.platform === 'win32';
// ps 의 etime([[dd-]hh:]mm:ss) → 초
const etimeSec = s => { const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim()); return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + +m[3] * 60 + +m[4]) : null; };
function defaultProcs() {
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 };
  if (IS_WIN) {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString(\'o\') })`t$($_.CommandLine)" }'], opts);
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '').split(/\r?\n/).map(l => /^(\d+)\t(\d*)\t([^\t]*)\t(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: Number(m[1]), ppid: Number(m[2]) || 0, started: Date.parse(m[3]) || null, cmd: m[4] }));
  }
  // 좀비(Z — 끝났지만 부모가 아직 거두지 않음)는 뺀다: 끝낸 직후 다시 볼 때 남은 것으로 잘못 보이지 않게(CI Linux · macOS 실측)
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,etime=,args='], opts), now = Date.now();
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').split(/\r?\n/).map(l => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(l)).filter(m => m && !/^Z/.test(m[4])).map(m => { const e = etimeSec(m[5]); return { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: e == null ? null : now - e * 1000, cmd: m[6] }; });
}
function defaultKill(pid) {
  if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } }
}

// 작업을 치울 때(accept · cancel · gc): 전부 회수한다(포트 구역 포함).
function release(root, task, o) {
  const d = teardownCompose(task.id, 'all', o && o.run);
  const c = runCleanupCommand(root, task.id, o && o.cleanup);
  const t = removeTmp(root, task.id);
  let ports = null; try { ports = freePorts(root, task.id); } catch { /* 장부를 못 쓰면 다음 잡기가 끝난 작업으로 보고 푼다 */ }
  const residue = [...d.residue, ...t.residue, ...(c && !c.ok ? [`cleanup_command failed (exit ${c.exit_code}): ${c.command}`] : [])];
  return record(task, { at: 'release', docker: d, cleanup: c, tmp: t, ports, residue });
}
function record(task, r) {
  task.resources = { tmp: null, ...(task.resources || {}), compose_project: composeProject(task.id), data_ns: dataNs(task.id), [`${r.at}_at`]: new Date().toISOString(), residue: r.residue };
  if (r.tmp) task.resources.tmp = r.tmp.dir;
  return r;
}

module.exports = { envFor, tmpDirFor, dataNs, composeProject, repoKey, teardownCompose, listProcesses: defaultProcs, killProcess: defaultKill, runCleanupCommand, removeTmp, release, WT_RE,
  portBlock, freePorts, portsOf };

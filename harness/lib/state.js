'use strict';
// v5 상태 — 경로 · 작업 기록 · 잠금 · 로그. 저장 위치는 <git-common-dir>/harness/ (모든 worktree 가 공유, 커밋되지 않음).
//   쓰기는 하네스만 한다. 작업 기록은 임시 파일 + rename 으로 원자적으로 쓴다.
//   잠금은 mkdir 원자 잠금 + owner.json {pid, host, at, token}. 같은 호스트의 죽은 pid 잠금은 빼앗는다.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOST = os.hostname();
const IS_WIN = process.platform === 'win32';
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { if (ms > 0) Atomics.wait(SLEEP_CELL, 0, 0, ms); }
const nowIso = () => new Date().toISOString();

// ── 경로 ───────────────────────────────────────────────────────────────
function gitOut(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}
// 저장소 최상위(현재 worktree 의). 없으면 NOT_A_REPO.
function repoRoot(start) {
  const dir = path.resolve(start || process.cwd());
  const top = gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (!top) throw Object.assign(new Error(`not a git repository: ${dir}`), { code: 'NOT_A_REPO' });
  return path.resolve(top);
}
// 주 worktree(메인 체크아웃). 하네스의 모든 경로는 여기에 묶는다 — 연결된 worktree 안에서 불려도 같은 작업을 가리키게.
function mainRoot(start) {
  const top = repoRoot(start);
  const list = gitOut(top, ['worktree', 'list', '--porcelain']);
  const first = list && /^worktree (.+)$/m.exec(list);
  return first ? path.resolve(first[1].trim()) : top;
}
// 한 root 의 common dir 은 프로세스 동안 바뀌지 않는다 — 기록 한 줄마다 git 을 띄우지 않게 기억한다(Windows 에서 spawn 1회 ≈ 30ms).
const COMMON = new Map();
function commonDir(root) {
  const key = path.resolve(root);
  if (COMMON.has(key)) return COMMON.get(key);
  const c = gitOut(key, ['rev-parse', '--git-common-dir']);
  if (!c) throw Object.assign(new Error(`not a git repository: ${root}`), { code: 'NOT_A_REPO' });
  const v = path.resolve(key, c);
  COMMON.set(key, v);
  return v;
}
function paths(root0) {
  // 실경로로 — git 이 알려 주는 경로와 같은 표기여야 비교 · 상대 경로가 맞는다(심볼릭 링크 · Windows 짧은 이름).
  const root = require('../hooks/_common').real(root0);
  const common = commonDir(root), h = path.join(common, 'harness');
  return { root, commonDir: common, harnessDir: h, tasksDir: path.join(h, 'tasks'), sessionsDir: path.join(h, 'sessions'),
    locksDir: path.join(h, 'locks'), worktreesDir: path.join(root, '.harness-worktrees'), excludeFile: path.join(common, 'info', 'exclude') };
}
function taskPaths(root, id) {
  const P = paths(root), dir = path.join(P.tasksDir, id), wt = path.join(P.worktreesDir, id), relWork = `.harness/${id}`;
  return { ...P, id, dir, taskFile: path.join(dir, 'task.json'), logFile: path.join(dir, 'log.jsonl'), archiveDir: path.join(dir, 'archive'),
    branch: `harness/${id}`, wt, relWork, workDir: path.join(wt, '.harness', id), planFile: path.join(wt, '.harness', id, 'PLAN.md'),
    blockedFile: path.join(wt, '.harness', id, 'BLOCKED.md') };
}

// t-<yyyymmdd-HHMMss>-<4hex>
function newId(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return `t-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}
const ID_RE = /^t-\d{8}-\d{6}-[0-9a-f]{4}$/;
const validId = id => typeof id === 'string' && ID_RE.test(id);

// ── 파일 ───────────────────────────────────────────────────────────────
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
// 임시 파일 + rename. Windows 에서 읽는 쪽이 파일을 잡고 있으면 rename 이 EPERM/EBUSY 로 실패한다 → 짧게 재시도.
//   noMkdir: 폴더를 다시 만들지 않는다(잠금의 owner.json — 빼앗겨 사라진 잠금 폴더를 되살리면 주인이 둘이 된다).
function writeJsonAtomic(file, obj, opts) {
  if (!(opts && opts.noMkdir)) fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  // 디스크에 확실히 쓴 뒤 바꿔 끼운다(fsync). opts.backup: 바꾸기 전의 읽을 수 있는 판을 <file>.bak 으로 남긴다.
  //   [2026-10-15 자동 이슈 #6] 세션이 끊긴 뒤 task.json 이 공백만 남아 작업이 목록에서 사라졌다.
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (opts && opts.backup) { try { const cur = fs.readFileSync(file, 'utf8'); JSON.parse(cur); fs.writeFileSync(`${file}.bak`, cur); } catch { /* 처음이거나 이미 깨졌다 — 좋은 .bak 을 덮지 않는다 */ } }
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (i >= 8 || !/^(EPERM|EBUSY|EACCES)$/.test(e.code)) { try { fs.unlinkSync(tmp); } catch { /* 없음 */ } throw e; }
      sleepSync(25 * (i + 1));
    }
  }
}
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: nowIso(), ...obj }) + '\n');
}

// ── 작업 기록 ─────────────────────────────────────────────────────────
function readTask(root, id) { const f = taskPaths(root, id).taskFile; return readJson(f, null) || readJson(`${f}.bak`, null); }   // 깨졌으면 직전 판
function writeTask(root, task) {
  task.updated_at = nowIso();
  writeJsonAtomic(taskPaths(root, task.id).taskFile, task, { backup: true });
  return task;
}
function log(root, id, event) { appendJsonl(taskPaths(root, id).logFile, event); }
function readLog(root, id) {
  let text = ''; try { text = fs.readFileSync(taskPaths(root, id).logFile, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function listTasks(root) {
  const { tasksDir } = paths(root);
  let names = []; try { names = fs.readdirSync(tasksDir); } catch { return []; }
  return names.filter(validId).sort().map(id => readTask(root, id)).filter(Boolean);
}
// 작업의 worktree 를 다른 경로로 옮겨 쓴다(옆 경로 — 원래 자리가 잠겨 비울 수 없을 때). P 를 고쳐 돌려준다.
function retargetWorktree(P, wt) {
  P.wt = wt; P.workDir = path.join(wt, P.relWork); P.planFile = path.join(P.workDir, 'PLAN.md'); P.blockedFile = path.join(P.workDir, 'BLOCKED.md');
  return P;
}
// 작업이 옆 경로(task.worktree_alt)를 쓰는 중이면 그 경로로 — stop · accept · resume 이 같은 곳을 본다.
function taskPathsFor(root, task) {
  const P = taskPaths(root, task.id);
  return task && task.worktree_alt ? retargetWorktree(P, task.worktree_alt) : P;
}
// task.json 과 .bak 이 둘 다 읽히지 않는 작업 — 목록에서 조용히 빠지지 않게 따로 보인다(목표는 log.jsonl 의 created 에서).
function listBrokenTasks(root) {
  const { tasksDir } = paths(root);
  let names = []; try { names = fs.readdirSync(tasksDir); } catch { return []; }
  return names.filter(validId).sort().filter(id => !readTask(root, id)).map(id => {
    const P = taskPaths(root, id), created = readLog(root, id).find(e => e.event === 'created');
    return { id, goal: created ? String(created.goal || '').split(/\r?\n/)[0].slice(0, 100) : '', log: P.logFile, task_file: P.taskFile };
  });
}
function newTask(fields) {
  const at = nowIso();
  return { id: null, goal: '', runtime: 'claude', model: 'opus', effort: null, status: 'running', reason: '', base_branch: null, base_commit: null,
    branch: null, worktree: null, session_id: null, owner: null,
    checks: { source: 'none', commands: [], baseline: null, last: null },
    caps: { budget_usd: 20, token_budget: null, wall_min: 120, max_continuations: 8 },
    spent: { cost_usd: 0, tokens: 0, continuations: 0, wall_ms: 0 },
    commits: [], merge_commit: null, revert_commit: null,
    outside_git: { ignored_changed: [], untracked_left: [] }, tests_modified: [],
    created_at: at, updated_at: at, ...fields };
}

// ── 프로세스 ──────────────────────────────────────────────────────────
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  // [2026-10-29 감사] Windows 는 끝났지만 누가 핸들을 쥔 프로세스에도 EPERM 을 낸다 — 3일 묵은 작업이 '실행 중' 으로 보였다. 목록에 없으면 끝난 것이다.
  try { process.kill(n, 0); } catch (e) { return e.code === 'EPERM' && !(IS_WIN && procStartMs(n) === 'none'); }
  // Linux: 끝났지만 부모가 거두지 않은 프로세스(좀비)도 kill(0) 에는 살아 있다 — /proc 의 상태가 Z 면 끝난 것이다.
  if (process.platform === 'linux') { try { if (/^\d+ \(.*\) Z /s.test(fs.readFileSync(`/proc/${n}/stat`, 'utf8'))) return false; } catch { /* /proc 없음 — kill(0) 을 믿는다 */ } }
  // macOS 등(/proc 없음) — ps 의 상태가 Z(좀비)면 끝난 것이다. [2026-10-13 CI 실측] stop 이 "could not stop" 으로 실패했다.
  else if (process.platform !== 'win32') {
    try { const r = require('node:child_process').spawnSync('ps', ['-o', 'stat=', '-p', String(n)], { encoding: 'utf8', timeout: 5000 }); if (r.status === 0 && /^\s*Z/.test(r.stdout)) return false; } catch { /* ps 없음 — kill(0) 을 믿는다 */ }
  }
  return true;
}
// 프로세스 시작 시각(ms) · 'none'(그 pid 의 프로세스가 없다) · null(알 수 없다). 같은 pid 는 잠깐 기억한다(폴링 루프가 매번 셸을 띄우지 않게).
//   Windows 는 PowerShell(약 0.5초) · Linux 는 /proc · macOS 등은 ps 의 경과 시간.
const START_CACHE = new Map(), START_TTL_MS = 60000;
function procStartMs(pid) {
  const hit = START_CACHE.get(pid);
  if (hit && Date.now() - hit.at < START_TTL_MS) return hit.v;
  let v = null;
  try {
    if (IS_WIN) {
      const ps = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if(-not $p){'none'} else { try { [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() } catch { '?' } }`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const out = String(r.stdout || '').trim();
      v = r.status !== 0 ? null : out === 'none' ? 'none' : /^\d+$/.test(out) ? Number(out) : null;
    } else if (process.platform === 'linux') {
      let stat; try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { stat = null; }
      if (stat === null) v = 'none';
      else {
        const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);   // 22번째 칸(starttime) — 이름의 공백 · 괄호를 건너뛴다
        const btime = Number((/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8')) || [])[1]);
        if (ticks >= 0 && btime) v = btime * 1000 + ticks * 10;   // CLK_TCK 100
      }
    } else {
      const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(String(r.stdout || ''));
      if (r.status === 1 && !String(r.stdout || '').trim()) v = 'none';
      else if (m) v = Date.now() - ((Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3]) * 60) + Number(m[4])) * 1000;
    }
  } catch { v = null; }
  START_CACHE.set(pid, { v, at: Date.now() });
  return v;
}
// 이 프로세스의 시작 시각 — 주인 기록(잠금 · 번호표)에 함께 적어 pid 재사용을 알아본다.
const PROC_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
// 주인이 살아 있는가 — 같은 호스트면 pid 로, 다른 호스트면 판단할 수 없으니 살아 있다고 본다(오래된 at 은 예외).
//   [2026-10-29 감사] 같은 호스트에서도 pid 만 보면, 강제 종료된 accept 의 pid 를 다른 프로세스가 다시 받았을 때 checks 줄이 영영 막혔다.
//   기록에 시작 시각(started_at)이 있으면 그 pid 의 지금 프로세스 시작 시각과 맞춰 본다(다르면 다른 프로세스 — 죽은 주인).
//   시작 시각이 없는 옛 기록은 신호(heartbeat_at · at)가 24시간 넘게 멈췄으면 죽은 것으로 본다.
const FOREIGN_STALE_MS = 24 * 3600 * 1000, START_SLACK_MS = 10000;
const isSelf = owner => !!owner && owner.pid === process.pid && (!owner.host || owner.host === HOST);
function ownerAlive(owner) {
  if (!owner || owner.pid == null) return false;
  const at = Date.parse(owner.heartbeat_at || owner.at || '');
  if (owner.host && owner.host !== HOST) return !(at && Date.now() - at > FOREIGN_STALE_MS);
  if (isSelf(owner)) return true;
  if (!pidAlive(owner.pid)) return false;
  const started = Date.parse(owner.started_at || '');
  if (started) {
    const now = procStartMs(Number(owner.pid));
    if (now === 'none') return false;
    if (typeof now === 'number') return Math.abs(now - started) <= START_SLACK_MS;
    return !(at && Date.now() - at > FOREIGN_STALE_MS);   // 시작 시각을 알 수 없다 — 신호 나이로
  }
  return !(at && Date.now() - at > FOREIGN_STALE_MS);
}

// ── 잠금 ───────────────────────────────────────────────────────────────
// mkdir 은 원자적이다. owner.json 을 쓰기 전에 죽은 잠금(owner 없음)은 10초가 지나면 버려진 것으로 본다.
const ORPHAN_MS = 10000;
function lockDir(root, name) { return path.join(paths(root).locksDir, `${name}.lock`); }
function lockOwner(root, name) { return readJson(path.join(lockDir(root, name), 'owner.json'), null); }
// {stale, owner} — owner 는 판정 때 본 owner.json(없으면 null). 빼앗기는 이 owner 를 들고 가 그사이 바뀌지 않았는지 확인한다.
function staleInfo(dir) {
  const owner = readJson(path.join(dir, 'owner.json'), null);
  if (!owner) {
    let st = null; try { st = fs.statSync(dir); } catch { return { stale: false, owner: null }; }
    return { stale: Date.now() - st.mtimeMs > ORPHAN_MS, owner: null };
  }
  return { stale: !ownerAlive(owner), owner };
}
const lockStale = dir => staleInfo(dir).stale;
// 잠금이 있고 주인이 살아 있으면(또는 막 만들어지는 중이면) true.
function lockLive(root, name) {
  const dir = lockDir(root, name);
  if (!fs.existsSync(dir)) return false;
  return !staleInfo(dir).stale;
}
// 빼앗기(TOCTOU 방지): stale 판정과 옮기기 사이에 다른 이가 먼저 빼앗아 새로 잡을 수 있다 — 그 산 잠금을 지우면 주인이 둘이 된다.
//   1) 빼앗기 전용 뮤텍스(`<lock>.steal`, mkdir 원자)를 잡은 이만 빼앗는다 — 빼앗는 이들끼리 직렬.
//   2) 뮤텍스 아래에서 다시 판정하고, 지금 owner.json 의 토큰이 판정 때 본 것(seen)과 같을 때만 옮긴다.
//   3) 옮긴 뒤(grave) 토큰을 한 번 더 보고, 그사이 바뀌었으면 되돌린다.
//   seen 을 주지 않으면(undefined) 뮤텍스 아래 재판정만 한다. 뮤텍스가 오래 남아 있으면(주인이 그 짧은 구간에서 죽음) 치운다.
const STEAL_ORPHAN_MS = 5000;
function takeOver(dir, seen) {
  const mutex = `${dir}.steal`;
  try { fs.mkdirSync(mutex); }
  catch (e) {
    try { if (Date.now() - fs.statSync(mutex).mtimeMs > STEAL_ORPHAN_MS) fs.rmSync(mutex, { recursive: true, force: true }); } catch { /* 없음 */ }
    return false;   // 다른 이가 빼앗는 중 — 이번 차례는 양보
  }
  try {
    const now = staleInfo(dir);
    if (!now.stale) return false;
    const tok = x => (x ? String(x.token || `${x.pid}@${x.host}@${x.at}`) : null);
    if (seen !== undefined && tok(seen) !== tok(now.owner)) return false;
    const grave = `${dir}.stale-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    try { fs.renameSync(dir, grave); } catch { return false; }
    if (tok(readJson(path.join(grave, 'owner.json'), null)) !== tok(now.owner)) {
      try { fs.renameSync(grave, dir); } catch { /* 그사이 새 잠금이 생겼다 — 그것을 건드리지 않는다 */ }
      return false;
    }
    try { fs.rmSync(grave, { recursive: true, force: true }); } catch { /* 남아도 무해 */ }
    return true;
  } finally {
    try { fs.rmdirSync(mutex); } catch { /* 없음 */ }
  }
}
function acquire(root, name, opts) {
  const o = opts || {}, waitMs = o.waitMs == null ? 0 : o.waitMs, pollMs = o.pollMs || 50;
  const dir = lockDir(root, name), deadline = Date.now() + waitMs;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  let staleMiss = 0;
  for (;;) {
    let made = false;
    try { fs.mkdirSync(dir); made = true; }
    catch (e) { if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e; }
    if (made) {
      const owner = { pid: process.pid, host: HOST, at: nowIso(), started_at: PROC_STARTED_AT, token: crypto.randomBytes(6).toString('hex'), name, ...(o.meta || {}) };
      try { writeJsonAtomic(path.join(dir, 'owner.json'), owner, { noMkdir: true }); }
      catch (e) {
        if (e.code === 'ENOENT') continue;   // owner.json 을 쓰기 전에 폴더가 사라졌다(빼앗김) — 처음부터 다시
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 고아로 남으면 나중에 빼앗긴다 */ }
        throw e;
      }
      return makeHandle(root, name, dir, owner);
    }
    const st = staleInfo(dir);
    if (st.stale) {
      if (o.beforeTakeover) o.beforeTakeover(name);
      if (takeOver(dir, st.owner)) { if (o.onTakeover) o.onTakeover(name); continue; }
      // 빼앗기지 못했다(다른 이가 빼앗는 중이거나 이미 새 주인) — 잠깐 뒤 다시 본다. 판정이 계속 stale 이면 상한까지.
      if (++staleMiss <= 40) { sleepSync(pollMs); continue; }
    }
    if (Date.now() >= deadline) {
      const owner = readJson(path.join(dir, 'owner.json'), null);
      throw Object.assign(new Error(`lock "${name}" is held by pid ${owner ? owner.pid : '?'}@${owner ? owner.host : '?'} since ${owner ? owner.at : '?'}`), { code: 'LOCK_HELD', owner });
    }
    sleepSync(pollMs + Math.floor(Math.random() * pollMs));
  }
}
// owner.json 읽기: 없음(ENOENT)과 잠깐 못 읽음(Windows 에서 touch 의 rename 과 겹침)을 구별한다.
function readOwnerFile(dir) {
  const file = path.join(dir, 'owner.json');
  for (let i = 0; ; i++) {
    try { return { exists: true, owner: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch (e) {
      if (e.code === 'ENOENT') return { exists: false, owner: null };
      if (i >= 4) return { exists: true, owner: null };
      sleepSync(20);
    }
  }
}
function makeHandle(root, name, dir, owner) {
  let released = false;
  return {
    name, dir, owner,
    touch() { if (released) return; try { const cur = readJson(path.join(dir, 'owner.json'), null); if (cur && cur.token === owner.token) writeJsonAtomic(path.join(dir, 'owner.json'), { ...cur, at: nowIso() }, { noMkdir: true }); } catch { /* 무시 */ } },
    release() {
      if (released) return; released = true;
      // 자기 토큰이 확인될 때만 지운다. owner.json 이 없거나(빼앗긴 뒤 새 주인이 mkdir 만 한 상태) 못 읽으면 남의 것일 수 있다 —
      // 지우지 않는다(우리 것이라면 이 프로세스가 끝난 뒤 죽은 잠금으로 빼앗긴다).
      const cur = readOwnerFile(dir);
      if (!cur.owner || cur.owner.token !== owner.token) return;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 남으면 다음에 빼앗긴다 */ }
    },
  };
}
function withLockSync(root, name, fn, opts) {
  const h = acquire(root, name, opts);
  try { return fn(h); } finally { h.release(); }
}
async function withLock(root, name, fn, opts) {
  const h = acquire(root, name, opts);
  try { return await fn(h); } finally { h.release(); }
}
// ── 줄 선 잠금 ────────────────────────────────────────────────────────
// 같은 mkdir 잠금(acquire)을 쓰되 차례를 정한다 — 번호표 <locks>/<name>.queue/<우선순위>-<시각>-<pid>-<순번>.json {pid, host, at, priority, label}.
//   가장 앞(우선순위 → 시각 → pid → 순번)의 산 번호표 주인만 잠금을 잡으러 간다. 0 = 사용자의 accept · 1 = 나머지.
//   [2026-10-25 C++ 저장소 실측] 사용자의 accept 가 1초 폴링 잠금 뒤에서 무인 검사들을 2.5시간 기다렸다(그동안 merge 잠금을 쥔 채).
//   옛 프로세스의 acquire 와도 서로 배제된다(같은 잠금). 죽은 pid 의 번호표는 지운다. 기다리는 동안 이벤트 루프를 막지 않는다.
const TICKET_BEAT_MS = 10 * 60 * 1000;
let TICKET_SEQ = 0;
const TICKETS = new Map();   // 이 프로세스의 번호표 → 잡은 잠금(없으면 null) — 끝날 때 치운다
let exitHooked = false;
function hookExit() {
  if (exitHooked) return; exitHooked = true;
  process.on('exit', () => { for (const [file, h] of TICKETS) { try { if (h) h.release(); } catch { /* 무시 */ } try { fs.unlinkSync(file); } catch { /* 없음 */ } } TICKETS.clear(); });
}
function dropTicket(file) {
  const h = TICKETS.get(file);
  TICKETS.delete(file);
  if (h) h.release();
  try { fs.unlinkSync(file); } catch { /* 없음 */ }
}
const queueDir = (root, name) => path.join(paths(root).locksDir, `${name}.queue`);
const pad = (n, w) => String(n).padStart(w, '0');
// 차례대로의 산 번호표 [{file, pid, host, at, priority, label}]. prune: 죽은 주인 · 오래 못 읽는 번호표를 지운다.
function liveTickets(dir, prune) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter(x => x.endsWith('.json')).sort()) {
    const file = path.join(dir, n), t = readJson(file, null);
    if (!t) {   // 쓰는 중 · 잠깐 못 읽음 — 오래 그러면 버려진 것
      let st = null; try { st = fs.statSync(file); } catch { continue; }
      if (Date.now() - st.mtimeMs > ORPHAN_MS) { if (prune) try { fs.unlinkSync(file); } catch { /* 없음 */ } continue; }
      out.push({ file, pid: null, host: null, at: null, priority: null, label: null });
      continue;
    }
    if (!TICKETS.has(file) && !ownerAlive(t)) { if (prune) try { fs.unlinkSync(file); } catch { /* 없음 */ } continue; }
    out.push({ file, ...t });
  }
  return out;
}
async function acquireQueued(root, name, opts) {
  const o = opts || {}, pollMs = o.pollMs || 500;
  const p = Number(o.priority == null ? 1 : o.priority), priority = Number.isFinite(p) ? Math.max(0, Math.min(9, Math.floor(p))) : 1;
  const dir = queueDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${priority}-${pad(Date.now(), 15)}-${pad(process.pid, 10)}-${pad(++TICKET_SEQ, 6)}.json`);
  const ticket = { pid: process.pid, host: HOST, at: nowIso(), started_at: PROC_STARTED_AT, priority, label: o.label == null ? null : String(o.label) };
  hookExit();
  TICKETS.set(file, null);
  writeJsonAtomic(file, ticket);
  let beat = Date.now();
  try {
    for (;;) {
      if (!fs.existsSync(file)) writeJsonAtomic(file, ticket);   // 남이 지웠다(폴더 정리) — 같은 자리로 다시
      const head = liveTickets(dir, true)[0];
      if (head && head.file === file) {
        let h = null;
        try { h = acquire(root, name, { pollMs: 25, meta: { priority, ...(ticket.label ? { label: ticket.label } : {}) } }); }
        catch (e) { if (e.code !== 'LOCK_HELD') throw e; }   // 줄 밖의 옛 acquire 주인이 쥐고 있다 — 다음 차례에
        if (h) {
          TICKETS.set(file, h);
          let released = false;
          return { ...h, ticket: file, touch: () => h.touch(), release() { if (released) return; released = true; dropTicket(file); } };
        }
      }
      if (Date.now() - beat > TICKET_BEAT_MS) { beat = Date.now(); try { writeJsonAtomic(file, { ...ticket, heartbeat_at: nowIso() }); } catch { /* 다음에 */ } }
      await new Promise(r => setTimeout(r, pollMs));
    }
  } catch (e) { dropTicket(file); throw e; }
}
// 기다리는 줄(차례대로 · 맨 앞은 잡은 이일 수 있다) — 현황 표시용. 읽기만 한다.
function queueOf(root, name) {
  return liveTickets(queueDir(root, name), false).map(t => ({ pid: t.pid, priority: t.priority, label: t.label, at: t.at }));
}

function listLocks(root) {
  const { locksDir } = paths(root);
  let names = []; try { names = fs.readdirSync(locksDir); } catch { return []; }
  return names.filter(n => n.endsWith('.lock')).map(n => {
    const dir = path.join(locksDir, n), owner = readJson(path.join(dir, 'owner.json'), null);
    return { name: n.slice(0, -5), dir, owner, stale: lockStale(dir) };
  });
}
function removeDeadLocks(root) {
  const removed = [];
  const { locksDir } = paths(root);
  let names = []; try { names = fs.readdirSync(locksDir); } catch { return removed; }
  for (const n of names) {
    const dir = path.join(locksDir, n);
    if (/\.stale-/.test(n)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무시 */ } continue; }
    if (n.endsWith('.lock.steal')) {   // 빼앗기 뮤텍스 — 주인이 그 짧은 구간에서 죽어 남은 것만
      try { if (Date.now() - fs.statSync(dir).mtimeMs > STEAL_ORPHAN_MS) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무시 */ }
      continue;
    }
    if (!n.endsWith('.lock')) continue;
    const st = staleInfo(dir);
    if (st.stale && takeOver(dir, st.owner)) removed.push(n.slice(0, -5));
  }
  return removed;
}


// ── 세션 기록 (A3 의 track 훅이 쓴다; 여기서는 읽기만) ────────────────────
function readSessions(root) {
  const { sessionsDir } = paths(root);
  let names = []; try { names = fs.readdirSync(sessionsDir); } catch { return []; }
  return names.filter(n => n.endsWith('.json')).map(n => {
    const s = readJson(path.join(sessionsDir, n), null);
    if (!s || typeof s !== 'object') return null;
    return { session_id: s.session_id || n.slice(0, -5), runtime: s.runtime || null, files: Array.isArray(s.files) ? s.files.filter(f => typeof f === 'string') : [], updated_at: s.updated_at || null };
  }).filter(Boolean);
}

module.exports = { retargetWorktree, taskPathsFor, listBrokenTasks,
  HOST, IS_WIN, sleepSync, nowIso, repoRoot, mainRoot, commonDir, paths, taskPaths, newId, validId, ID_RE,
  readJson, writeJsonAtomic, appendJsonl, readTask, writeTask, log, readLog, listTasks, newTask,
  pidAlive, procStartMs, ownerAlive, isSelf, PROC_STARTED_AT, lockDir, lockOwner, takeOver, acquire, acquireQueued, queueOf, withLock, withLockSync, listLocks, removeDeadLocks, lockStale, staleInfo, lockLive,
  readSessions,
};

'use strict';
// hooks/_common.js — 대화형 세션 훅(guard · track · stop · session-end)이 함께 쓰는 작은 도구들.
//   의존성 0. 어떤 함수도 세션을 깨뜨리지 않는다 — 호출하는 쪽이 try/catch 로 감싸고 실패는 열어 둔다(fail open).
//
// 세션 파일(설계 §2 · §6): <git-common-dir>/harness/sessions/<session_id>.json
//   { session_id, runtime: 'claude'|'codex', files: [저장소 상대 · 슬래시], updated_at, ...훅 전용 필드 }
//   engine 의 status 는 앞의 네 필드만 읽는다. 나머지(stop_blocks 등)는 훅끼리의 기록이다.
//   게시판(board.js): cwd · root(작업 트리 루트) · branch · goal(첫 요청 ≤ 200자) · last_seen · warned_sessions — 끝나면 ended_at(session-end).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';

function readStdinJson() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { raw = ''; }
  if (!raw || !raw.trim()) return { input: null, raw, error: 'empty stdin' };
  try {
    const v = JSON.parse(raw.replace(/^﻿/, ''));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { input: null, raw, error: 'stdin is not a JSON object' };
    return { input: v, raw, error: null };
  } catch (e) { return { input: null, raw, error: 'invalid JSON: ' + e.message }; }
}

// [2026-10-29 감사] 훅도 lib/git.run 처럼(자동 이슈 #54) Windows 에서 긴 경로를 켠다 — 꺼져 있으면 MAX_PATH 를 넘는 새 파일을
//   미커밋으로 보지 못해(stop · session-end 가 조용히 버림) · 추적 중인 그 파일을 ' D' 로 읽어 삭제 커밋을 만들었다.
const LONGPATHS = IS_WIN ? ['-c', 'core.longpaths=true'] : [];
function git(cwd, args, opts) {
  const r = spawnSync('git', [...LONGPATHS, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    timeout: (opts && opts.timeout) || 20000, env: (opts && opts.env) || process.env,
  });
  return { status: r.status == null ? -1 : r.status, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? String(r.error.message) : '') };
}

// cwd 가 속한 저장소의 작업 트리 루트와 공통 git 디렉터리(모든 worktree 가 공유). 저장소가 아니면 null.
//   `--path-format=absolute` 는 git ≥ 2.31 이다. 옛 git 은 이 옵션을 거부하거나(비 0) 그대로 되울린다(첫 줄이 `--…`)
//   — 그때는 옵션 없이 다시 묻고 상대 경로는 cwd 기준으로 푼다. 대체 경로를 쓴 것은 한 번 hook-errors.log 에 남긴다.
let oldGitLogged = false;
function repoInfo(cwd) {
  if (!cwd) return null;
  try { if (!fs.statSync(cwd).isDirectory()) return null; } catch { return null; }
  const G = module.exports.git;                  // 테스트가 옛 git 을 흉내 낼 수 있게 내보낸 것을 부른다
  const r = G(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  let lines = r.status === 0 ? r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
  if (r.status === 0 && lines.length === 2 && !lines[0].startsWith('-')) return { root: path.resolve(lines[0]), common: path.resolve(lines[1]) };
  if (r.status !== 0 && /not a git repository/i.test(r.stderr)) return null;
  if (r.status === 0 && lines[0] !== '--path-format=absolute') return null;
  const f = G(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (f.status !== 0) return null;
  lines = f.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const info = { root: path.resolve(cwd, lines[0]), common: path.resolve(cwd, lines[1]) };
  // [2026-10-15 자동 이슈 #7] 시간 초과 · 실행 실패(status -1)는 옛 git 이 아니라 일시적 부하다 — 대체 경로로 찾되 기록하지 않는다.
  if (!oldGitLogged && r.status !== -1 && !/ETIMEDOUT|ENOENT|EAGAIN/.test(r.stderr)) {
    oldGitLogged = true;                         // logError 가 repoInfo 를 다시 부른다 — 먼저 표시해 재귀를 끊는다
    logError('common', `git rev-parse --path-format=absolute 미지원(git < 2.31?) — 대체 경로 사용: ${(r.stderr || lines[0] || '').trim().slice(0, 200)}`, cwd);
  }
  return info;
}

function harnessDir(common) { return path.join(common, 'harness'); }
function safeId(sid) { return String(sid || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || '_'; }
function sessionPath(common, sid) { return path.join(harnessDir(common), 'sessions', safeId(sid) + '.json'); }
function sid8(sid) { return safeId(sid).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'unknown'; }

function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 잠들지 못하면 바로 재시도 */ } }

function loadSession(common, sid) {
  try { return JSON.parse(fs.readFileSync(sessionPath(common, sid), 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // Windows: 다른 프로세스가 대상 파일을 읽는 중이면 rename 이 EPERM/EACCES 로 실패한다 — 잠깐 뒤 다시.
      if (i >= 20) { try { fs.unlinkSync(tmp); } catch { /* 남은 임시 파일은 무해 */ } throw e; }
      sleepMs(25);
    }
  }
}

// 세션 파일 읽기-수정-쓰기를 mkdir 잠금 아래에서 한다. Claude 는 도구 호출을 병렬로 돌리므로
//   PostToolUse 훅이 동시에 뜬다 — 잠금이 없으면 서로의 기록을 덮어 경로를 잃는다.
//   잠금 = <세션 파일>.lock 폴더 + 그 안의 owner(토큰). 오래된 잠금(staleMs)은 빼앗되 토큰을 확인한다:
//   오래됐다고 본 잠금을 옆으로 옮긴(rename) 뒤 그 안의 토큰 · 폴더 신원이 본 것과 같을 때만 지운다.
//   다르면(그 사이 다른 프로세스가 빼앗고 새로 잡았다) 제자리로 되돌린다. 해제는 토큰이 내 것일 때만 한다.
const LOCK = { waitMs: 5000, staleMs: 10000, beforeTakeover: null };

function lockToken(lock) { try { return fs.readFileSync(path.join(lock, 'owner'), 'utf8'); } catch { return null; } }
function lockIdentity(dir) { try { const st = fs.statSync(dir); return `${st.ino}:${st.birthtimeMs}`; } catch { return null; } }

function acquireLock(lock) {
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK.waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), token);
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let st = null;
    try { st = fs.statSync(lock); } catch { continue; }                      // 방금 풀렸다 — 다시 잡는다
    if (Date.now() - st.mtimeMs > LOCK.staleMs && takeOver(lock)) continue;
    if (Date.now() > deadline) throw new Error('session lock timeout: ' + lock);
    sleepMs(15);
  }
}

function takeOver(lock) {
  const seenToken = lockToken(lock), seenId = lockIdentity(lock);
  if (typeof LOCK.beforeTakeover === 'function') LOCK.beforeTakeover(lock);
  const grave = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try { fs.renameSync(lock, grave); } catch { return false; }             // 다른 프로세스가 먼저 치웠다
  if (lockToken(grave) === seenToken && lockIdentity(grave) === seenId) {
    try { fs.rmSync(grave, { recursive: true, force: true }); } catch { /* 남은 무덤은 무해 */ }
    return true;
  }
  // 옮긴 것은 그 사이 새로 잡힌 남의 잠금이다 — 되돌린다.
  try { fs.renameSync(grave, lock); } catch (e) { logError('common', new Error(`session lock: 남의 새 잠금을 되돌리지 못함 ${lock}: ${e.message}`)); }
  return false;
}

function releaseLock(lock, token) {
  if (lockToken(lock) !== token) return;                                   // 주인 기록이 없거나 남의 것 — 두고 간다
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* 해제 실패는 staleMs 뒤 빼앗긴다 */ }
}

function updateSession(common, sid, runtime, fn) {
  const file = sessionPath(common, sid);
  const lock = file + '.lock';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = acquireLock(lock);
  try {
    const cur = loadSession(common, sid) || { session_id: String(sid), runtime, files: [], updated_at: null };
    if (!Array.isArray(cur.files)) cur.files = [];
    if (!cur.runtime) cur.runtime = runtime;
    const next = fn(cur);
    if (next === null) { try { fs.unlinkSync(file); } catch { /* 이미 없음 */ } return null; }
    const out = next || cur;
    out.updated_at = new Date().toISOString();
    writeJsonAtomic(file, out);
    return out;
  } finally { releaseLock(lock, token); }
}

// 오류는 세션을 막지 않는다. 다만 조용히 사라지면 게이트가 꺼진 줄 모른다 — 공통 디렉터리에 남긴다.
function logError(hook, err, cwdHint) {
  try {
    let dir = null;
    const info = repoInfo(cwdHint || process.cwd());
    if (info) dir = harnessDir(info.common);
    if (!dir) dir = path.join(require('node:os').tmpdir(), 'harness');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), hook, pid: process.pid, error: String(err && err.stack || err).slice(0, 2000) });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'), line + '\n');
  } catch { /* 기록조차 못 하면 포기한다 — 세션이 먼저다 */ }
}

// 이 훅을 부른 것이 Codex 인가. 설치기가 Codex 쪽 명령에 `--codex` 를 붙인다(가장 확실).
//   그 밖에는 환경 변수 · 페이로드 모양으로 추정한다: Codex 는 turn_id · model 을 싣고, Claude 는 prompt_id 를 싣는다.
function detectRuntime(input, argv) {
  const a = argv || process.argv.slice(2);
  if (a.includes('--codex')) return 'codex';
  if (a.includes('--claude')) return 'claude';
  const env = String(process.env.HARNESS_HOOK_RUNTIME || '').toLowerCase();
  if (env === 'codex' || env === 'claude') return env;
  const i = input || {};
  if (i.tool_name === 'apply_patch') return 'codex';
  if (i.turn_id !== undefined && i.prompt_id === undefined) return 'codex';
  return 'claude';
}

// 비밀 파일 — 절대 커밋하지 않는다. 템플릿(.env.example 등)과 공개 키(.pub)는 비밀이 아니다.
//   [2026-10-29 감사] AGENTS 규칙(.env* · *.pem · *.key · id_rsa* · .npmrc · credentials* · *.tfstate · service-account*.json)보다 좁았다 —
//   .envrc · id_rsa_github · credentials-prod.json · credentials.bak 를 guard 와 commitAll 이 함께 커밋했다. 글롭 그대로 맞춘다.
//   credentials* 중 소스 · 문서(credentials.js · credentials_test.py)는 같은 이름의 코드다 — 비밀이 아니다.
const SOURCE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|java|cs|kt|kts|php|rs|swift|c|cc|cpp|h|hpp|scala|sh|ps1|md|rst|html|css|vue|svelte)$/;
function isSecretPath(p) {
  const base = String(p || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!base) return false;
  if (base.startsWith('.env') || /\.env$/.test(base)) return !/\.(example|sample|template|dist|defaults)$/.test(base);   // .env* · prod.env
  if (/\.(pem|key|p12|pfx|p8|jks|keystore|ppk)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return !base.endsWith('.pub');                          // id_rsa* · id_ed25519_work
  if (base === '.npmrc' || base === '.pypirc' || base === '.netrc' || base === '_netrc' || base === '.git-credentials') return true;   // 레지스트리 토큰 · 자격 증명
  if (/\.tfstate(\.backup)?$/.test(base)) return true;                                                 // terraform 상태 — 리소스 비밀이 평문으로 든다
  if (/^\.?credentials/.test(base)) return !SOURCE_EXT.test(base);                                    // credentials* (AWS credentials · credentials-prod.json · credentials.bak)
  if (/^service[-_]?account.*\.json$/.test(base)) return true;                                         // GCP 서비스 계정 키
  return false;
}

// 실경로 — 심볼릭 링크 · Windows 짧은 이름(8.3)을 풀어 git 이 알려 주는 경로와 같은 표기로. 없는 경로는 있는 조상까지 풀고 나머지를 붙인다.
//   [2026-10-13 CI 실측] macOS 임시 폴더(/var → /private/var) · Windows 짧은 이름(C:\Users\RUNNER~1 ↔ runneradmin)에서
//   같은 폴더를 다른 폴더로 봐서 guard 가 `rm -rf .` 를 막지 못했고 · 세션 파일 경로를 잃고 · 정상 커밋을 거부했다.
function real(p) {
  const abs = path.resolve(String(p));
  try { return fs.realpathSync.native(abs); } catch { /* 아직 없다 */ }
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(real(parent), path.basename(abs));
}
function samePath(a, b) {
  const x = real(a).replace(/[\\/]+$/, ''), y = real(b).replace(/[\\/]+$/, '');
  return IS_WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// 절대/상대 경로 p 를 저장소 루트 기준 상대 경로(슬래시)로. 저장소 밖 · .git · .harness-worktrees 는 null.
function repoRel(root, cwd, p) {
  if (!p || typeof p !== 'string') return null;
  const abs = real(path.resolve(cwd || root, p));
  let rel = path.relative(real(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  rel = rel.split(path.sep).join('/');
  const first = rel.split('/')[0].toLowerCase();
  if (first === '.git' || first === '.harness-worktrees') return null;
  return rel;
}

// 하네스 작업 worktree 안에서는 git 을 하네스(cli)가 소유한다 — 대화형 훅이 커밋하거나 기록하지 않는다.
function isHarnessWorktree(root) {
  return /[\\/]\.harness-worktrees[\\/]/i.test(root + path.sep);
}

// 가벼운 길(light lane) — `cli.js start` 가 만든 worktree 에서 **사람이 모는** 세션이 일한다(무인 작업자 없음 · task.mode 'light').
//   그 세션은 메인 체크아웃의 세션처럼 기록하고 자기 파일을 커밋한다. → { id, task } 또는 null.
const LANE_RE = /[\\/]\.harness-worktrees[\\/](t-\d{8}-\d{6}-[0-9a-f]{4})(?:-\d+)?[\\/]*$/i;
function laneOf(info) {
  if (!info || !info.root || !info.common) return null;
  const m = LANE_RE.exec(String(info.root));
  if (!m) return null;
  const f = path.join(harnessDir(info.common), 'tasks', m[1], 'task.json');
  let task = null;
  for (const x of [f, f + '.bak']) { try { task = JSON.parse(fs.readFileSync(x, 'utf8')); break; } catch { /* 없거나 깨졌다 — 직전 판 */ } }
  return task && typeof task === 'object' && task.mode === 'light' ? { id: m[1], task } : null;
}
// 대화형 훅이 손대지 않는 곳 — 무인 작업자의 worktree(가벼운 길은 아니다).
function harnessOwned(info) { return !!info && isHarnessWorktree(info.root) && !laneOf(info); }

// 세션 파일 전부를 그대로(훅 전용 필드 포함). state.readSessions 는 엔진용 네 필드만 남긴다 — 게시판(board · status)은 이것을 읽는다.
function listSessions(common) {
  const dir = path.join(harnessDir(common), 'sessions');
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let s = null; try { s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    if (!s.session_id) s.session_id = n.slice(0, -5);
    if (!Array.isArray(s.files)) s.files = [];
    out.push(s);
  }
  return out;
}

// ── 플랫폼이 아는 산 세션 ──
//   `claude agents --json`(Claude Code ≥ 2.1.302 · 약 0.4초 · TTY 불필요) → [{ pid, cwd, kind, startedAt, sessionId, name, status: busy|idle }].
//   게시판(board · status)은 "어느 세션이 살아 있나" 를 이것으로 먼저 본다 — last_seen 어림은 이것이 없을 때(명령 없음 · 실패 · 3초 초과)만.
//   30초 캐시(<common>/harness/agents-cache.json · 실패도 기억한다) — PreToolUse 쓰기 검사가 매번 띄우지 않게.
//   시험은 진짜 claude 를 부르지 않는다: HARNESS_AGENTS_JSON=<파일>(캐시 없이 그 내용 · 없거나 깨졌으면 실패로) ·
//   HARNESS_AGENTS_CMD='["node","x.js"]'(대신 돌릴 argv — 캐시를 거친다) · HARNESS_AGENTS=off(쓰지 않는다).
const AGENTS_TTL_MS = 30 * 1000, AGENTS_TIMEOUT_MS = 3000, LIVE_MS = 30 * 60 * 1000;
function parseAgents(text) {
  let v; try { v = JSON.parse(String(text || '').replace(/^﻿/, '')); } catch { return null; }
  if (!Array.isArray(v)) return null;
  return v.filter(a => a && typeof a === 'object' && a.sessionId)
    .map(a => ({ sessionId: String(a.sessionId), pid: a.pid == null ? null : a.pid, cwd: a.cwd || null, kind: a.kind || null, name: a.name || null, status: a.status || null, startedAt: a.startedAt || null }));
}
function agentsArgv() {
  const o = process.env.HARNESS_AGENTS_CMD;
  if (o) { try { const v = JSON.parse(o); return Array.isArray(v) && v.length && v.every(x => typeof x === 'string') ? v : null; } catch { return null; } }
  try { return [require('../lib/exe').resolve('claude'), 'agents', '--json']; } catch { return null; }   // 설치 안 됨 · .exe 아님
}
function platformAgents(common) {
  const env = process.env;
  if (env.HARNESS_AGENTS_JSON) { try { return parseAgents(fs.readFileSync(env.HARNESS_AGENTS_JSON, 'utf8')); } catch { return null; } }
  if (/^(off|0|false|no)$/i.test(env.HARNESS_AGENTS || '')) return null;
  const src = env.HARNESS_AGENTS_CMD || 'claude';
  const file = common ? path.join(harnessDir(common), 'agents-cache.json') : null;
  const now = Date.now();
  if (file) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8')), age = now - Date.parse(c.at);
      if (c.source === src && age >= 0 && age < AGENTS_TTL_MS) return Array.isArray(c.agents) ? c.agents : null;
    } catch { /* 캐시 없음 · 깨짐 — 다시 묻는다 */ }
  }
  let agents = null;
  const argv = agentsArgv();
  if (argv) {
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true, timeout: AGENTS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    if (!r.error && r.status === 0) agents = parseAgents(r.stdout);
  }
  if (file) { try { writeJsonAtomic(file, { at: new Date(now).toISOString(), source: src, agents }); } catch { /* 캐시를 못 써도 결과는 쓴다 */ } }
  return agents;
}
// 세션 파일 s 에 맞는 플랫폼 항목(sessionId 가 같다) — 목록이 없거나 없으면 null.
function agentOf(s, agents) { return Array.isArray(agents) && s ? agents.find(a => a.sessionId === String(s.session_id)) || null : null; }
// 산 세션인가. Claude 세션은 플랫폼 목록이 있으면 그것만 믿는다 — 목록에 없으면 last_seen 과 무관하게 산 세션이 아니다.
//   Codex 세션(claude agents 에 나오지 않는다) · 목록이 없을 때: ended_at 없음 · last_seen 30분 안.
function sessionLive(s, agents, now) {
  if (!s) return false;
  if (Array.isArray(agents) && (s.runtime || 'claude') === 'claude') return !!agentOf(s, agents);
  if (s.ended_at) return false;
  const t = Date.parse(s.last_seen || '');
  return !!t && (now || Date.now()) - t <= LIVE_MS;
}

// git status --porcelain -z 로 미커밋 경로(스테이징 · 수정 · 삭제 · 추적 안 됨). key: 비교용(Windows 는 소문자) → git 표기.
//   files 를 주면 그 경로만 본다 — 큰 저장소에서 전체 status 는 Codex SessionEnd 상한(3초)을 넘긴다.
//   경로는 문자 그대로(literal) · Windows 는 대소문자 무시(icase). 명령줄이 너무 길어지면 전체를 본다.
const SCOPE_MAX_CHARS = 24000;
function scopeSpecs(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const magic = IS_WIN ? ':(literal,icase)' : ':(literal)';
  const specs = [...new Set(files.filter(f => typeof f === 'string' && f))].map(f => magic + f);
  if (!specs.length) return null;
  return specs.reduce((n, s) => n + s.length + 3, 0) > SCOPE_MAX_CHARS ? null : specs;
}
function dirtyPaths(root, files) {
  const specs = scopeSpecs(files);
  const r = module.exports.git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '--untracked-files=all', ...(specs ? ['--', ...specs] : [])]);
  if (r.status !== 0) throw new Error('git status failed: ' + r.stderr.trim());
  const out = new Map();
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    const xy = e.slice(0, 2), p = e.slice(3);
    out.set(keyOf(p), p);
    if (xy[0] === 'R' || xy[0] === 'C') { const orig = parts[++i]; if (orig && xy[0] === 'R') out.set(keyOf(orig), orig); }
  }
  return out;
}
function keyOf(p) { return IS_WIN ? p.toLowerCase() : p; }

// 세션이 기록한 파일 중 지금 미커밋인 것 — git 표기로. 비밀 파일은 따로 나눈다.
function uncommittedOf(root, files) {
  const dirty = dirtyPaths(root, files);
  const mine = [], secrets = [];
  const seen = new Set();
  for (const f of files || []) {
    const k = keyOf(f);
    if (seen.has(k) || !dirty.has(k)) continue;
    seen.add(k);
    const g = dirty.get(k);
    (isSecretPath(g) ? secrets : mine).push(g);
  }
  return { mine, secrets };
}

function hasIdentity(root) {
  const n = git(root, ['config', 'user.name']), e = git(root, ['config', 'user.email']);
  return n.status === 0 && n.stdout.trim() && e.status === 0 && e.stdout.trim();
}

// 정확히 그 파일들만 커밋한다. `git commit -- <files>` 는 --only 라서 다른 스테이징 항목은 그대로 둔다.
//   index.lock 이 잡혀 있으면(다른 git 이 도는 중) 잠깐 기다렸다가 다시 한다.
function commitFiles(root, files, message) {
  if (!files.length) return { ok: true, sha: null, skipped: true };
  const id = hasIdentity(root) ? [] : ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost'];
  const run = (args) => {
    let r;
    for (let i = 0; i < 12; i++) {
      r = git(root, args, { timeout: 60000 });
      if (r.status === 0 || !/index\.lock|Unable to create .*\.lock|File exists/i.test(r.stderr)) return r;
      sleepMs(250);
    }
    return r;
  };
  const add = run(['--literal-pathspecs', 'add', '-A', '--', ...files]);
  if (add.status !== 0) return { ok: false, error: 'git add: ' + add.stderr.trim() };
  // 훅 안의 커밋은 사람이 없다 — pre-commit 훅(느린 린트 · 대화형 확인)과 gpg 서명 프롬프트(pinentry)가
  //   시간 상한을 넘겨 커밋을 잃게 한다. 이 wip 커밋은 사람이 나중에 다시 보고 정리한다.
  const c = run([...id, '-c', 'commit.gpgsign=false', '--literal-pathspecs', 'commit', '-q', '--no-verify', '-m', message, '--', ...files]);
  if (c.status !== 0) return { ok: false, error: 'git commit: ' + (c.stderr.trim() || c.stdout.trim()) };
  const h = git(root, ['rev-parse', 'HEAD']);
  return { ok: true, sha: h.stdout.trim() };
}

function listForReason(files, max) {
  const m = max || 30;
  const shown = files.slice(0, m).map(f => '`' + f + '`').join(', ');
  return files.length > m ? `${shown} 외 ${files.length - m}개` : shown;
}

module.exports = {
  real, IS_WIN, readStdinJson, git, repoInfo, harnessDir, safeId, sessionPath, sid8, sleepMs,
  loadSession, updateSession, writeJsonAtomic, logError, detectRuntime, isSecretPath, samePath, repoRel,
  isHarnessWorktree, laneOf, harnessOwned, listSessions, platformAgents, parseAgents, agentOf, sessionLive, LIVE_MS, dirtyPaths, uncommittedOf, commitFiles, listForReason, keyOf, LOCK,
};

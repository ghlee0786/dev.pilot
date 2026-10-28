'use strict';
// v5 git — 하네스의 git 쓰기는 전부 여기서 한다. reset --hard · 강제 push · stash 는 없다.
//   공유 .git 의 잠금 경합(index.lock · config.lock)은 백오프로 재시도한다(병렬 worktree 에서 실측된 함정).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const S = require('./state');

const LOCK_ERR = /index\.lock|config\.lock|\.lock': File exists|Unable to create '.*\.lock'|could not lock|cannot lock ref|Another git process/i;
const BACKOFF_MS = [200, 400, 800, 1600, 3200];

function run(cwd, args, o) {
  const opt = o || {};
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, input: opt.input, env: opt.env ? { ...process.env, ...opt.env } : process.env });
  return { ok: r.status === 0, code: r.status, out: String(r.stdout || ''), err: String(r.stderr || (r.error && r.error.message) || '') };
}
// [자동 이슈 #58] 다시 시도한 뒤에도 남은 잠금 파일(index.lock …)은 운영 오류다 — 하네스 결함으로 기록하지 않고(GIT_LOCKED) 무엇을 하면 되는지 알린다(#20 과 같은 안내).
const LEFT_LOCK = /Unable to create '([^'\n]+\.lock)': File exists/;
function fail(args, r) {
  const lock = LEFT_LOCK.exec(r.err);
  const hint = lock ? ` — ${lock[1]} is left over; if no git command is running (editor, another session), delete that file and run the command again` : '';
  return Object.assign(new Error(`git ${args.join(' ')} failed (${r.code}): ${r.err.trim().slice(0, 600)}${hint}`), { code: lock ? 'GIT_LOCKED' : 'GIT_FAILED', stderr: r.err, stdout: r.out });
}
// 기본: 실패하면 던지고 stdout(끝 공백 제거)을 돌려준다. allowFail 이면 {ok, out, err}.
function git(cwd, args, o) {
  const opt = o || {};
  let r;
  for (let i = 0; ; i++) {
    r = run(cwd, args, opt);
    if (r.ok || !opt.retryLock || i >= BACKOFF_MS.length || !LOCK_ERR.test(r.err)) break;
    S.sleepSync(BACKOFF_MS[i] + Math.floor(Math.random() * 100));
  }
  if (opt.allowFail) return { ok: r.ok, out: r.out.replace(/\s+$/, ''), err: r.err, code: r.code };
  if (!r.ok) throw fail(args, r);
  return r.out.replace(/\s+$/, '');
}

// 커밋 신원: 저장소 설정을 쓰고, 없을 때만 harness 신원으로.
const IDENTITY = new Map();
function identityArgs(cwd) {
  const key = path.resolve(cwd);
  if (IDENTITY.has(key)) return IDENTITY.get(key);
  const r = git(cwd, ['config', '--get-regexp', '^user\\.(name|email)$'], { allowFail: true }).out;
  const has = k => new RegExp(`^user\\.${k} \\S`, 'mi').test(r);
  const v = [...(has('name') ? [] : ['-c', 'user.name=harness']), ...(has('email') ? [] : ['-c', 'user.email=harness@localhost']), '-c', 'commit.gpgsign=false'];
  IDENTITY.set(key, v);
  return v;
}

function headSha(cwd, ref) { const r = git(cwd, ['rev-parse', '--verify', '-q', (ref || 'HEAD') + '^{commit}'], { allowFail: true }); return r.ok ? r.out : null; }
function currentBranch(cwd) { const r = git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true }); return r.ok && r.out ? r.out : null; }
function branchExists(cwd, b) { return git(cwd, ['show-ref', '--verify', '-q', `refs/heads/${b}`], { allowFail: true }).ok; }
function tagExists(cwd, t) { return git(cwd, ['show-ref', '--verify', '-q', `refs/tags/${t}`], { allowFail: true }).ok; }
function isAncestor(cwd, a, b) { return git(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).ok; }

// 저장소가 없거나 커밋이 없으면 빈 첫 커밋을 만든다.
function ensureRepo(root) {
  const dir = path.resolve(root);
  if (!git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true }).ok) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
  }
  const top = S.repoRoot(dir);
  if (!headSha(top)) git(top, [...identityArgs(top), 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'harness: initial empty commit'], { retryLock: true });
  return top;
}

// porcelain v1 -z 파싱. [{x, y, path, orig}] — 경로는 저장소 상대 posix.
function statusEntries(cwd, o) {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...((o && o.ignored) ? ['--ignored=matching'] : [])];
  const r = git(cwd, args, { allowFail: true });
  if (!r.ok) return [];
  const parts = r.out.split('\0'), out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.length < 4) continue;
    const x = p[0], y = p[1], file = p.slice(3);
    const e = { x, y, path: file, code: x + y };
    if (x === 'R' || x === 'C') e.orig = parts[++i];
    out.push(e);
  }
  return out;
}
function dirtyFiles(cwd) { return statusEntries(cwd).filter(e => e.code !== '!!'); }
function isClean(cwd) { return dirtyFiles(cwd).length === 0; }
// worktree 안의 무시된(gitignore) 파일 중 .worktreeinclude 로 복사된 뒤 그대로인 것을 뺀 목록(M4) — git 밖이라 worktree 를
//   지우면 사라진다. include = task.worktree_include([{path, sha1}]) 또는 그 경로 목록. 저장소 상대 posix 경로.
// [2026-10-03 · .NET 라이브러리 · 웹 서비스] .NET 빌드 산출물(obj/ · bin/Debug|Release/)도 — 검사(dotnet test)가 돌 때마다 worktree 가 남았다(4,000여 개). bin/ 의 다른 파일은 여전히 본다.
const CACHE_RE = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|\.hypothesis|node_modules|\.cache|\.gradle|\.vs|obj|bin\/(?:Debug|Release))(\/|$)|\.py[cod]$/i;
// 폴더째 무시되는 경로는 git 이 폴더 한 줄(`docs/`)로 보고한다 — 복사 기록(파일 단위)과 맞추려면 펼친다.
//   [2026-09-30 실측 · Python 서비스 저장소] .worktreeinclude 로 복사한 .claude/rules/ · docs/ 의 한 파일이 폴더로 보고돼 "git 밖 변경" 으로 잡혔다.
function expandDir(wt, rel) {
  if (!rel.endsWith('/')) return [rel];
  const out = [];
  const walk = (abs, prefix) => {
    let ents = []; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = prefix + e.name;
      if (e.isDirectory()) { if (!CACHE_RE.test(r + '/')) walk(path.join(abs, e.name), r + '/'); }
      else out.push(r);
    }
  };
  walk(path.join(wt, rel), rel);
  return out;
}
// 프로젝트가 "버려도 되는 런타임 부산물" 로 선언한 경로(AGENTS.md · CLAUDE.md 의 outside_git_ok: ["data/*.db", ...]).
//   worktree 의 사본과 메인 체크아웃 둘 다 본다 — AGENTS.md 가 gitignore 돼 worktree 에는 만든 때의 사본만 있을 수 있다(실측: gc 가 낡은 사본을 읽었다).
function outsideOkPatterns(wt) {
  const roots = [wt];
  try { const main = mainWorktree(wt); if (main && !samePath(main, wt)) roots.push(main); } catch { /* 메인을 못 찾으면 worktree 만 */ }
  const out = [];
  for (const r of roots) for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    let t = ''; try { t = fs.readFileSync(path.join(r, f), 'utf8'); } catch { continue; }
    const m = /^\s*outside_git_ok:\s*\[([^\]]*)\]/m.exec(t);
    if (!m) continue;
    for (const g of m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)) {
      out.push(new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$', 'i'));
    }
    break;
  }
  return out;
}
function ignoredChanges(wt, include) {
  const inc = new Map((include || []).map(x => typeof x === 'string' ? [x, null] : [x.path, x.sha1]));
  const ok = outsideOkPatterns(wt);
  // 캐시·바이트코드는 git 밖 산출물로 치지 않는다 — worktree 를 남길 이유가 아니다(실측: __pycache__ 가 worktree 를 붙잡았다).
  return statusEntries(wt, { ignored: true }).filter(e => e.code === '!!').map(e => e.path).filter(p => !CACHE_RE.test(p))
    .flatMap(p => expandDir(wt, p)).filter(p => !CACHE_RE.test(p))
    .filter(p => !ok.some(re => re.test(p)))
    .filter(p => !(inc.has(p) && (inc.get(p) == null || inc.get(p) === sha1(path.join(wt, p)))));
}
// [자동 이슈 #57] 검사가 다시 쓴 추적 파일 중 outside_git_ok 로 선언된 것을 HEAD 로 되돌린다 — 검사 산출물이 작업 브랜치에 커밋되지 않게.
//   추적되지 않은 파일과 무시된 파일은 그대로 둔다. 되돌린 경로를 돌려준다.
function restoreOutsideOk(wt) {
  const ok = outsideOkPatterns(wt);
  if (!ok.length) return [];
  const paths = dirtyFiles(wt).filter(e => e.code !== '??' && !e.orig && ok.some(re => re.test(e.path))).map(e => e.path);
  for (let i = 0; i < paths.length; i += 100) git(wt, ['checkout', '-q', 'HEAD', '--', ...paths.slice(i, i + 100).map(p => `:(literal)${p}`)], { retryLock: true, allowFail: true });
  return paths;
}
// 이미 있는 git 저장소(worktree 포함)인가. 없는 경로는 false.
function isRepo(dir) { return fs.existsSync(dir) && git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true }).ok; }

// git add 가 넣지 못한 경로(오류 문구에서). 예: 커밋 없는 중첩 저장소 'sub/' · Windows 예약 이름 nul · 읽을 수 없는 파일.
const UNADDABLE = [
  /error: '([^'\n]+)' does not have a commit checked out/g, /unable to index file '?([^'\n]+?)'?\s*$/gm, /error: open\("([^"\n]+)"\)/g,
  /short read while indexing '?([^'\n]+?)'?\s*$/gm, /error: ([^\n:]+): failed to insert into database/g, /error: invalid path '([^'\n]+)'/g,
  /error: ([^\n:]+): can only add regular files, symbolic links or git-directories/g,
];
function unaddablePaths(err) {
  const out = new Set();
  for (const re of UNADDABLE) { re.lastIndex = 0; let m; while ((m = re.exec(String(err || '')))) out.add(m[1].trim().replace(/\\/g, '/').replace(/\/+$/, '')); }
  return [...out].filter(Boolean);
}
// 비밀 경로 판정은 훅과 한 곳(hooks/_common.isSecretPath)에서 — 목록을 넓히면 양쪽이 같이 넓어진다.
function isSecretPath(p) { return require('../hooks/_common').isSecretPath(p); }

// 모든 변경(추적 안 된 것 포함, 무시된 것 제외)을 커밋. 변경이 없으면 null.
//   · 비밀 경로(.env · *.pem · 키 …)는 색인에서 빼고 커밋하지 않는다(H5) — opt.excluded 배열이 있으면 거기에 적는다.
//   · add 가 못 넣는 경로는 빼고 다시 시도한다(L1) — opt.skipped 배열에 적는다. 그래도 실패하면 던진다.
// cwd 가 git 작업 트리의 **루트 자신**인가(하위 폴더·등록이 사라진 빈 폴더면 git 이 위의 저장소를 본다). branch 를 주면 그 브랜치인지도.
function isWorktreeRoot(dir, branch) {
  if (!fs.existsSync(dir)) return false;
  const top = git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top.ok || !samePath(top.out, dir)) return false;
  if (branch) { const b = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }); if (!b.ok || b.out !== branch) return false; }
  return true;
}
// [버그 2026-10-01 · Python 서비스 저장소] 등록이 사라진 빈 worktree 폴더에서 cancel 이 commitAll 을 부르면 `add -A -- :/` 가 **메인 저장소**
//   (사용자 브랜치)의 남의 미커밋 변경을 하네스 이름으로 커밋할 수 있었다. 하네스 커밋은 자기 worktree 의 루트에서만 한다 — 아니면 던진다.
function commitAll(cwd, message, o) {
  const opt = o || {};
  if (!isWorktreeRoot(cwd, opt.branch)) throw Object.assign(new Error(`refusing to commit: ${cwd} is not the root of ${opt.branch ? `the ${opt.branch} worktree` : 'a git working tree'} (it may be a leftover folder inside another repository)`), { code: 'NOT_WORKTREE_ROOT' });
  const skip = [];
  for (let i = 0; ; i++) {
    const r = git(cwd, ['add', '-A', '--', ...(opt.paths || [':/']), ...skip.map(p => `:(exclude,literal)${p}`)], { retryLock: true, allowFail: true });
    if (r.ok) break;
    const bad = unaddablePaths(r.err).filter(p => !skip.includes(p));
    if (!bad.length || i >= 8) throw fail(['add', '-A'], r);
    skip.push(...bad);
  }
  if (skip.length && Array.isArray(opt.skipped)) for (const p of skip) if (!opt.skipped.includes(p)) opt.skipped.push(p);
  // [2026-09-30 실측 · Python 서비스 저장소] 저장소의 `plan.md` 무시 패턴이 Windows(core.ignorecase)에서 PLAN.md 까지 막아 계획이 커밋되지 않았다.
  //   하네스 자신의 폴더(.harness/)는 무시 규칙과 상관없이 넣는다 — 재개의 근거다.
  if (!opt.paths && fs.existsSync(path.join(cwd, '.harness'))) git(cwd, ['add', '-f', '--', '.harness'], { retryLock: true, allowFail: true });
  const stagedList = () => git(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACMRT'], { allowFail: true }).out.split('\0').filter(Boolean);
  const secrets = stagedList().filter(isSecretPath);
  if (secrets.length) {
    const hasHead = !!headSha(cwd);
    for (let i = 0; i < secrets.length; i += 100) {
      const chunk = secrets.slice(i, i + 100);
      git(cwd, hasHead ? ['reset', '-q', '--', ...chunk.map(p => `:(literal)${p}`)] : ['rm', '-q', '--cached', '--', ...chunk.map(p => `:(literal)${p}`)], { retryLock: true });
    }
    if (Array.isArray(opt.excluded)) for (const p of secrets) if (!opt.excluded.includes(p)) opt.excluded.push(p);
  }
  const staged = git(cwd, ['diff', '--cached', '--name-only'], { allowFail: true }).out;
  if (!staged && !opt.allowEmpty) return null;
  git(cwd, [...identityArgs(cwd), 'commit', '-q', '--no-verify', ...(opt.allowEmpty ? ['--allow-empty'] : []), '-m', message], { retryLock: true });
  return headSha(cwd);
}

function ensureExclude(excludeFile, pattern) {
  let text = ''; try { text = fs.readFileSync(excludeFile, 'utf8'); } catch { /* 없음 */ }
  const bare = pattern.replace(/^\/|\/$/g, '');
  const re = new RegExp(`^/?${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?\\s*$`, 'm');
  if (re.test(text)) return false;
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  // 원자적으로(임시 파일 → 이름 바꾸기). [2026-10-13 릴리스 CI 실측] 동시에 뜬 작업 4개가 읽고-고쳐-쓰기를 겹쳐 사용자의 exclude 파일이 깨졌다.
  const tmp = `${excludeFile}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text + (text && !text.endsWith('\n') ? '\n' : '') + pattern + '\n');
  fs.renameSync(tmp, excludeFile);
  return true;
}

// worktree 생성은 `worktree` 잠금 아래에서 직렬로 — 공유 .git/config.lock 경합을 없앤다.
// branch 가 없으면 -b 로 base 에서 만들고, 있으면 그 브랜치를 체크아웃한다. detach 면 분리 HEAD.
function addWorktree(root, wt, o) {
  const opt = o || {};
  const P = S.paths(root);
  return S.withLockSync(root, 'worktree', () => {
    ensureExclude(P.excludeFile, '.harness-worktrees/');   // 잠금 안에서 — 동시 작업이 같은 파일을 겹쳐 쓰지 않게
    ensureExclude(P.excludeFile, '.harness-build/');   // 언어 팩의 빌드 폴더(C/C++ cmake · meson) — 매 턴 커밋에 빌드 산출물이 섞이지 않게
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    let args;
    if (opt.detach) args = ['worktree', 'add', '-q', '--detach', wt, opt.base || 'HEAD'];
    else if (branchExists(root, opt.branch)) args = ['worktree', 'add', '-q', wt, opt.branch];
    else args = ['worktree', 'add', '-q', '-b', opt.branch, wt, opt.base || 'HEAD'];
    git(root, args, { retryLock: true });
    return wt;
  }, { waitMs: opt.waitMs == null ? 120000 : opt.waitMs });
}

function worktreeList(root) {
  const r = git(root, ['worktree', 'list', '--porcelain'], { allowFail: true });
  if (!r.ok) return [];
  const out = []; let cur = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: path.resolve(line.slice(9)), branch: null, head: null, detached: false, bare: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
  }
  return out;
}
// 같은 폴더인가 — 실경로로 비교한다(심볼릭 링크 · Windows 짧은 이름. hooks/_common.real 참고).
const samePath = (a, b) => require('../hooks/_common').samePath(a, b);
function worktreeRegistered(root, wt) { return worktreeList(root).some(w => samePath(w.path, wt)); }
// 대상 브랜치가 체크아웃된 worktree(하네스 worktree 제외). 없으면 null.
function checkoutOf(root, branch) {
  const P = S.paths(root);
  return worktreeList(root).find(w => w.branch === branch && !samePath(path.dirname(w.path), P.worktreesDir)) || null;
}
function mainWorktree(root) { const l = worktreeList(root); return l.length ? l[0].path : root; }

// 깨끗할 때만 지운다(--force 없음). 링크를 따라가지 않는다(git 이 지운다). 실패하면 {ok:false, error}.
//   o.include 가 있으면(배열 — task.worktree_include) 무시된 파일 변경이 있을 때도 지우지 않는다(M4).
function removeWorktree(root, wt, o) {
  if (!fs.existsSync(wt)) { git(root, ['worktree', 'prune'], { allowFail: true }); return { ok: true, removed: false }; }
  // 등록이 사라진 폴더에서 isClean 을 부르면 git 이 위의 메인 저장소를 본다 — 먼저 등록부터 확인한다(버그 2026-10-01).
  if (!worktreeRegistered(root, wt)) {
    git(root, ['worktree', 'prune'], { allowFail: true });
    if (removeEmptyDir(wt)) return { ok: true, removed: true, recovered: 'the registration was already gone; removed the empty folder' };
    return { ok: false, error: `${wt} is not a registered worktree and it is not empty — inspect it and remove it by hand`, leftover: true };
  }
  if (!isClean(wt)) return { ok: false, error: 'worktree has uncommitted changes' };
  if (o && Array.isArray(o.include)) {
    const ig = ignoredChanges(wt, o.include);
    if (ig.length) return { ok: false, error: `ignored files changed in the worktree (not in git; removing the worktree would lose them): ${ig.slice(0, 5).join(', ')}${ig.length > 5 ? ` … (+${ig.length - 5})` : ''}`, ignored: ig };
  }
  // 하네스가 채운 서브모듈 사본 — 고쳐졌으면 지우지 않고 남긴다(git 은 서브모듈이 든 worktree 를 지우지 못한다).
  const subKept = dropSubmoduleClones(root, wt);
  if (subKept.length) return { ok: false, error: `submodule copies were changed in the worktree (their changes are not in the branch): ${subKept.join(', ')}` };
  let r = null, first = null;
  for (let i = 0; i < 3; i++) {
    r = git(root, ['worktree', 'remove', wt], { allowFail: true, retryLock: true });
    if (r.ok) break;
    if (!first) first = r.err.trim();
    // [버그 2026-10-01] 1차 시도가 등록과 파일은 지우고 폴더만 못 지운 뒤(죽은 프로세스의 핸들), 2차부터는 'is not a working tree' 가 되어
    //   진짜 이유를 덮고 거부로 끝났다. 등록이 사라졌으면 prune 하고 남은 빈 폴더를 치운다.
    if (/is not a working tree/i.test(r.err) && !worktreeRegistered(root, wt)) {
      git(root, ['worktree', 'prune'], { allowFail: true });
      const gone = removeEmptyDir(wt);
      if (gone) { try { const parent = path.dirname(wt); if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* 다른 worktree 가 남아 있다 */ } return { ok: true, removed: true, recovered: first }; }
      return { ok: false, error: `the worktree registration is gone but the folder ${wt} is not empty — inspect it and remove it by hand (first error: ${first.slice(0, 200)})`, leftover: true };
    }
    S.sleepSync(300 * (i + 1));   // Windows: 백신·열린 핸들이 잠깐 잡고 있을 수 있다.
  }
  if (!r.ok) return { ok: false, error: (first && first !== r.err.trim() ? `${first.slice(0, 200)} (then: ${r.err.trim().slice(0, 100)})` : r.err.trim()).slice(0, 320) };
  try { const parent = path.dirname(wt); if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* 다른 worktree 가 남아 있다 */ }
  return { ok: true, removed: true };
}

// 비어 있는(하위 폴더도 비어 있는) 폴더만 지운다 → 지웠으면 true. 파일이 하나라도 있으면 건드리지 않는다.
function removeEmptyDir(dir) {
  const hasFile = d => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; } return ents.some(e => e.isDirectory() ? hasFile(path.join(d, e.name)) : true); };
  if (!fs.existsSync(dir)) return true;
  if (hasFile(dir)) return false;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return !fs.existsSync(dir); } catch { return false; }
}

// 작업 worktree 자리를 쓸 수 있게 비운다 → null(비었거나 이미 그 브랜치의 worktree) | 못 비운 이유(문자열).
//   [2026-10-14~15 자동 이슈 #1 · #2 · #5] Windows 에서 다른 프로세스가 파일을 잡고 있으면 worktree 삭제가 늦게 끝난다 —
//   등록은 남거나 사라졌고 .git 파일은 지워졌고 파일이 남은 폴더에 accept 가 커밋하려다, resume 이 worktree add 를 하려다 죽었다.
//   남은 파일이 사라질 때까지 기다린다(지우지 않는다 — 깨끗할 때만 지우기 시작한 폴더라 내용은 브랜치에 있다).
//   [2026-10-15 자동 이슈 #8 · #10 · #11] 기다려도 사라지지 않았다 — 끝난 작업의 폴더를 붙잡은 프로세스(고아 testhost 등)가 끝나지 않고,
//   잠긴 파일 때문에 git 이 등록만 지우고 파일을 남긴 경우다. 사람이 지워야 했다. 이제: 붙잡은 프로세스를 끝내고, 브랜치와 다른 파일은
//   o.salvageDir 에 보관한 뒤(읽지 못한 파일이 있으면 지우지 않는다) 폴더를 지운다. o.onCleared({ killed, salvaged, dir }) 로 알린다.
function clearWorktreeSlot(root, wt, branch, waitMs, o) {
  if (!fs.existsSync(wt)) return null;
  if (worktreeRegistered(root, wt) && isWorktreeRoot(wt, branch)) return null;
  if (fs.existsSync(path.join(wt, '.git'))) return `${wt} exists but is not a working tree of ${branch} — inspect it`;
  git(root, ['worktree', 'prune'], { allowFail: true });
  const killed = killProcsIn(wt);
  const sv = o && o.salvageDir ? salvageLeftover(root, wt, branch, o.salvageDir) : { copied: [], unreadable: [] };
  const until = Date.now() + (waitMs == null ? 20000 : waitMs);   // 못 비우면 옆 경로로 간다(useAltWorktree) — 오래 기다리지 않는다
  for (;;) {
    git(root, ['worktree', 'prune'], { allowFail: true });
    if (!sv.unreadable.length) { try { fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* 잠긴 파일 — 아래에서 다시 */ } }
    if (removeEmptyDir(wt)) { if (o && o.onCleared) o.onCleared({ killed, salvaged: sv.copied, dir: o.salvageDir }); return null; }
    if (Date.now() >= until) {
      const holders = procsIn(wt).map(p => `${p.name}(${p.pid})`);
      return `the previous worktree ${wt} is still being removed (another process still holds files in it${holders.length ? `: ${holders.join(', ')}` : ''}${sv.unreadable.length ? `; could not read ${sv.unreadable.length} file(s) to check them against the branch` : ''}) — wait a minute and try again`;
    }
    S.sleepSync(1000);
  }
}

// 줄바꿈 복원 — [2026-10-17 자동 보고 5d6643b86c24] Windows 작업자가 LF 파일을 CRLF 로 통째로 바꿔 저장해 변경 규모가 몇 배로 부풀고
//   메인과 파일 전체가 충돌했다. 커밋 전에, 고친 파일 중 HEAD 와 줄바꿈이 통째로 달라진 것(새 줄바꿈이 절반 이상)을 HEAD 의 줄바꿈으로 되돌린다.
//   git 이 줄바꿈을 바꾸는 저장소(core.autocrlf · text/eol 속성)와 바이너리는 손대지 않는다. → 되돌린 파일(저장소 상대)
function eolStats(buf) {
  let crlf = 0, lf = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) { if (i > 0 && buf[i - 1] === 0x0d) crlf++; else lf++; }
  return { crlf, lf };
}
function toEol(buf, crlf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (!crlf && b === 0x0d && buf[i + 1] === 0x0a) continue;
    if (crlf && b === 0x0a && !(i > 0 && buf[i - 1] === 0x0d)) out.push(0x0d);
    out.push(b);
  }
  return Buffer.from(out);
}
function keepEol(wt) {
  const ac = git(wt, ['config', '--get', 'core.autocrlf'], { allowFail: true }).out.trim().toLowerCase();
  if (ac === 'true' || ac === 'input') return [];
  const files = statusEntries(wt).filter(e => /M/.test(e.code)).map(e => e.path.replace(/\\/g, '/'));
  if (!files.length) return [];
  const normalized = new Set();
  for (const l of git(wt, ['check-attr', 'text', 'eol', '--', ...files], { allowFail: true }).out.split(/\r?\n/)) {
    const m = /^(.*): (text|eol): (.*)$/.exec(l);
    if (m && !/^(unset|unspecified)$/.test(m[3])) normalized.add(m[1]);
  }
  const fixed = [];
  for (const f of files) {
    if (normalized.has(f)) continue;
    const abs = path.join(wt, f);
    let cur; try { cur = fs.readFileSync(abs); } catch { continue; }
    if (cur.length > 8 * 1024 * 1024 || cur.includes(0)) continue;
    const b = spawnSync('git', ['show', `HEAD:${f}`], { cwd: wt, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
    if (b.status !== 0 || !b.stdout || b.stdout.includes(0)) continue;
    const sb = eolStats(b.stdout), sc = eolStats(cur), total = sc.crlf + sc.lf;
    let fixedBuf = null;
    if (sb.crlf === 0 && sb.lf > 0 && sc.crlf > 0 && sc.crlf * 2 >= total) fixedBuf = toEol(cur, false);
    else if (sb.lf === 0 && sb.crlf > 0 && sc.lf > 0 && sc.lf * 2 >= total) fixedBuf = toEol(cur, true);
    if (!fixedBuf) continue;
    try { fs.writeFileSync(abs, fixedBuf); fixed.push(f); } catch { /* 다음 턴에 */ }
  }
  return fixed;
}
// 원래 자리를 비우지 못했을 때 옆 경로(<wt>-2, -3 …)를 쓴다 — 비어 있거나 이미 그 브랜치의 worktree 인 첫 자리. 찾으면 P 를 옮기고 true.
//   [2026-10-16 자동 이슈 #16] 편집기 언어 서버 · 빌드 서버가 남은 폴더를 잠가 accept 가 반복 거부됐다(손으로 지워도 다시 잠김).
//   잠근 프로세스는 끝내지 않는다(사용자의 편집기일 수 있다) — 남은 폴더는 gc 가 다시 치운다.
function useAltWorktree(root, task, P, why, log) {
  for (let n = 2; n < 10; n++) {
    const alt = `${P.wt.replace(/-\d+$/, '')}-${n}`;
    if (fs.existsSync(alt) && !(worktreeRegistered(root, alt) && isWorktreeRoot(alt, task.branch))) continue;
    S.retargetWorktree(P, alt);
    task.worktree_alt = alt;
    S.log(root, task.id, { event: 'worktree_alt', wt: alt, why: String(why).slice(0, 300) });
    if (log) log(`[pilot] ${task.id} — 원래 worktree 자리가 잠겨 있어 ${alt} 에서 진행한다(남은 폴더는 node harness/cli.js gc 가 다시 치운다)`);
    return true;
  }
  return false;
}
// clearWorktreeSlot 의 o — 보관은 작업 기록 폴더(tasks/<id>/leftover-<시각>/) · 치운 일은 작업 로그와 진행 줄에 남긴다.
function slotOpts(root, id, taskDir, log) {
  return {
    salvageDir: path.join(taskDir, `leftover-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    onCleared: x => {
      S.log(root, id, { event: 'leftover_cleared', killed: x.killed.map(k => `${k.name}(${k.pid})`), salvaged: x.salvaged.length, dir: x.salvaged.length ? x.dir : null });
      if (log) log(`[pilot] ${id} — 남은 worktree 폴더를 치웠다${x.killed.length ? ` · 붙잡던 프로세스 ${x.killed.map(k => k.name).join(', ')} 를 끝냄` : ''}${x.salvaged.length ? ` · 브랜치와 다른 파일 ${x.salvaged.length}개를 ${x.dir} 에 보관` : ''}`);
    },
  };
}
// 이 폴더 안의 실행 파일이거나 명령줄이 이 폴더를 가리키는 프로세스 — 이 프로세스와 부모는 빼고. [{ pid, name }]
function procsIn(dir) {
  const self = new Set([process.pid, process.ppid]);
  const variants = [...new Set([path.resolve(dir), path.resolve(dir).replace(/\\/g, '/')])].map(s => s.toLowerCase());
  let rows = [];
  if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process | ForEach-Object { '{0}\t{1}\t{2}\t{3}' -f $_.ProcessId, $_.Name, $_.ExecutablePath, ($_.CommandLine -replace '[\\r\\n\\t]', ' ') }";
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 32 << 20 });
    rows = String(r.stdout || '').split(/\r?\n/).map(l => l.split('\t')).filter(c => c.length >= 4).map(([pid, name, exe, cmd]) => ({ pid: Number(pid), name, text: `${exe} ${cmd}` }));
  } else {
    const r = spawnSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8', timeout: 15000, maxBuffer: 32 << 20 });
    rows = String(r.stdout || '').split('\n').map(l => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: Number(m[1]), name: m[2], text: m[3] }));
  }
  // 경로 뒤가 구분자 · 따옴표 · 공백 · 끝일 때만 그 폴더다 — [2026-10-17 적대적 검증] 접두어로만 비교해 …/<id> 를 치우다
  //   옆 경로 …/<id>-2 에서 도는 살아 있는 작업을 잡았다.
  const hit = text => { const t = text.toLowerCase(); return variants.some(v => { for (let i = t.indexOf(v); i >= 0; i = t.indexOf(v, i + 1)) { const c = t[i + v.length]; if (c === undefined || /[\\/"'\s]/.test(c)) return true; } return false; }); };
  return rows.filter(x => x.pid && !self.has(x.pid) && hit(x.text)).map(({ pid, name }) => ({ pid, name }));
}
function killProcsIn(dir) {
  const found = procsIn(dir);
  for (const p of found) require('./proc').killTree(p.pid);
  return found;
}
// 남은 폴더의 파일 중 브랜치 내용과 다른 것(캐시 제외)을 dest 로 복사 → { copied: [상대 경로], unreadable: [...] }
function salvageLeftover(root, wt, branch, dest) {
  const tree = new Map();
  const ls = git(root, ['ls-tree', '-r', '-z', branch], { allowFail: true });
  for (const ent of ls.ok ? ls.out.split('\0') : []) { const tab = ent.indexOf('\t'); if (tab > 0) tree.set(ent.slice(tab + 1), ent.slice(0, tab).split(' ')[2]); }
  const copied = [], unreadable = [];
  const walk = rel => {
    let ents = []; try { ents = fs.readdirSync(path.join(wt, rel), { withFileTypes: true }); } catch { unreadable.push(rel || '.'); return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (CACHE_RE.test(r)) continue;
      if (e.isDirectory()) { walk(r); continue; }
      if (!e.isFile()) continue;
      let buf; try { buf = fs.readFileSync(path.join(wt, r)); } catch { unreadable.push(r); continue; }
      const sha = crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
      if (tree.get(r) === sha) continue;
      fs.mkdirSync(path.dirname(path.join(dest, r)), { recursive: true });
      fs.writeFileSync(path.join(dest, r), buf);
      copied.push(r);
    }
  };
  walk('');
  return { copied, unreadable };
}

function diffNames(cwd, from, to, extra) {
  const r = git(cwd, ['diff', '--name-only', '-z', '--no-renames', ...(extra || []), from, ...(to ? [to] : [])], { allowFail: true });
  return r.ok ? r.out.split('\0').filter(Boolean) : [];
}
function mergeBase(cwd, a, b) { const r = git(cwd, ['merge-base', a, b], { allowFail: true }); return r.ok ? r.out : null; }
function unmergedFiles(cwd) { return git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], { allowFail: true }).out.split('\0').filter(Boolean); }
function mergeInProgress(cwd) { return git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }).ok; }
// 충돌 표지(L2): `=======` 한 줄은 rst/markdown 제목 밑줄과 같다 — <<<<<<< 와 >>>>>>> 가 모두 있을 때만 충돌로 본다.
const MARKER_OPEN_RE = /^<{7}(?: |$)/m, MARKER_CLOSE_RE = /^>{7}(?: |$)/m;
const MARKER_RE = MARKER_OPEN_RE;   // 옛 이름(여는 표지) — 판정은 hasConflictMarkers 로
function hasConflictMarkersText(text) { const t = String(text || ''); return MARKER_OPEN_RE.test(t) && MARKER_CLOSE_RE.test(t); }
function hasConflictMarkers(file) { try { return hasConflictMarkersText(fs.readFileSync(file, 'utf8')); } catch { return false; } }

// .worktreeinclude: 거기 적힌 패턴에 맞고 무시된(gitignore) 파일만 새 worktree 로 복사한다.
function worktreeIncludeFiles(root) {
  const inc = path.join(root, '.worktreeinclude');
  if (!fs.existsSync(inc)) return [];
  const r = git(root, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${inc}`], { allowFail: true });
  const cand = r.ok ? r.out.split('\0').filter(Boolean) : [];
  if (!cand.length) return [];
  const ig = git(root, ['check-ignore', '-z', '--stdin'], { allowFail: true, input: cand.join('\0') + '\0' });
  return ig.out.split('\0').filter(Boolean);
}
const sha1 = file => { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };

// ── worktree 의 의존: 서브모듈 · 저장소 밖 형제 폴더 ─────────────────────
// [2026-10-03 · .NET 라이브러리 저장소] 서브모듈(gitlink)은 새 worktree 에서 빈 폴더다 — 그것을 참조하는 프로젝트가 빌드되지 않는다.
//   메인 체크아웃의 그 경로가 기록된 커밋을 가진 git 저장소면 `clone --shared`(객체 공유 · 네트워크 없음)로 기록된 커밋을 꺼낸다.
//   메인의 중첩 저장소는 읽기만 한다. worktree 를 지울 때 이 사본은 깨끗하고 기록된 커밋 그대로일 때만 지운다(아니면 worktree 를 남긴다).
function gitlinks(wt) {
  const r = git(wt, ['ls-files', '-s', '-z'], { allowFail: true });
  const out = [];
  for (const e of (r.ok ? r.out.split('\0') : [])) { const m = /^160000 ([0-9a-f]{40,64}) \d\t(.+)$/.exec(e); if (m) out.push({ sha: m[1], path: m[2] }); }
  return out;
}
const isEmptyDir = d => { try { return fs.readdirSync(d).length === 0; } catch { return !fs.existsSync(d); } };
function fillSubmodules(root, wt) {
  const done = [];
  for (const l of gitlinks(wt)) {
    const src = path.join(root, l.path), dst = path.join(wt, l.path);
    if (!isEmptyDir(dst)) continue;
    const top = git(src, ['rev-parse', '--show-toplevel'], { allowFail: true });
    if (!top.ok || !samePath(top.out, src) || !git(src, ['cat-file', '-e', `${l.sha}^{commit}`], { allowFail: true }).ok) continue;
    fs.mkdirSync(dst, { recursive: true });
    if (!git(root, ['clone', '-q', '--shared', '--no-checkout', src, dst], { allowFail: true }).ok) continue;
    if (git(dst, ['checkout', '-q', '--detach', l.sha], { allowFail: true }).ok) done.push(l.path);
  }
  return done;
}
// worktree 안의 하네스가 만든 서브모듈 사본(대체 객체 = 메인의 그 저장소)을 지운다. force 가 아니면 깨끗하고 기록된 커밋일 때만.
function dropSubmoduleClones(root, wt, o) {
  const kept = [];
  for (const l of gitlinks(wt)) {
    const dst = path.join(wt, l.path);
    let alt = ''; try { alt = fs.readFileSync(path.join(dst, '.git', 'objects', 'info', 'alternates'), 'utf8').trim(); } catch { continue; }   // 하네스 사본이 아니다
    const srcObjects = git(path.join(root, l.path), ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { allowFail: true }).out;
    if (!srcObjects || !alt.split(/\r?\n/).some(a => samePath(a, srcObjects))) continue;
    if (!(o && o.force)) {
      const head = git(dst, ['rev-parse', 'HEAD'], { allowFail: true }).out, st = git(dst, ['status', '--porcelain'], { allowFail: true });
      if (head !== l.sha || !st.ok || st.out) { kept.push(l.path); continue; }
    }
    // 빈 폴더로 되돌린다(git 이 만든 처음 모양) — 폴더째 지우면 git 이 worktree 를 "바뀜" 으로 보고 지우지 않는다.
    try { fs.rmSync(dst, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); fs.mkdirSync(dst, { recursive: true }); } catch { kept.push(l.path); }
  }
  return kept;
}
// [2026-10-03 · .NET 앱 저장소] csproj 가 저장소 밖 형제(..\..\.NET 라이브러리 저장소)를 참조한다. worktree 는 <root>/.harness-worktrees/<id>/
//   라 같은 상대 경로가 .harness-worktrees/<이름> 이 된다. 프로젝트 블록의 `worktree_links: ["../<이름>"]` 마다 그 자리에 메인의 형제 폴더로 가는
//   링크(Windows 디렉터리 정션 · POSIX 심볼릭 링크)를 한 번 만든다 — worktree 밖이라 작업이 끝나도 남고 다음 작업이 쓴다. `../<이름>` 한 단계만 받는다.
function worktreeLinks(root, wt) {
  const made = [];
  for (const e of require('./checks').yamlList(root, 'worktree_links') || []) {
    const m = /^\.\.[\\/]([^\\/]+?)[\\/]?$/.exec(String(e).trim());
    if (!m || m[1] === '..' || m[1] === '.') continue;
    const target = path.resolve(root, '..', m[1]), link = path.join(path.dirname(wt), m[1]);
    try {
      if (!fs.statSync(target).isDirectory()) continue;
      let present = false; try { fs.lstatSync(link); present = true; } catch { /* 없음 */ }
      if (!present) { fs.symlinkSync(target, link, 'junction'); made.push(m[1]); }
    } catch { /* 대상이 없다 · 만들 수 없다 — 검사가 빨개지고 보고에 남는다 */ }
  }
  return made;
}

// .worktreeinclude 의 무시된 파일을 복사하고, worktree 의 의존(서브모듈 · 형제 폴더 링크)을 채운다. 반환: 복사한 파일 [{path, sha1}].
function copyWorktreeInclude(root, wt) {
  try { fillSubmodules(root, wt); worktreeLinks(root, wt); } catch { /* 의존 준비 실패는 작업을 멈추지 않는다 — 검사가 보여 준다 */ }
  const copied = [];
  for (const rel of worktreeIncludeFiles(root)) {
    const src = path.join(root, rel), dst = path.join(wt, rel);
    try {
      if (!fs.statSync(src).isFile() || fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push({ path: rel, sha1: sha1(dst) });
    } catch { /* 복사 실패는 작업을 멈추지 않는다 */ }
  }
  return copied;
}

module.exports = {
  git, identityArgs, headSha, isWorktreeRoot, removeEmptyDir, clearWorktreeSlot, slotOpts, useAltWorktree, keepEol, procsIn, killProcsIn, salvageLeftover, currentBranch, branchExists, tagExists, isAncestor, ensureRepo, isRepo, statusEntries, dirtyFiles, isClean, ignoredChanges,
  commitAll, unaddablePaths, isSecretPath, ensureExclude, addWorktree, worktreeList, worktreeRegistered, checkoutOf, mainWorktree, removeWorktree, samePath,
  diffNames, mergeBase, unmergedFiles, mergeInProgress, hasConflictMarkers, hasConflictMarkersText, MARKER_RE, restoreOutsideOk, worktreeIncludeFiles, copyWorktreeInclude, sha1, LOCK_ERR,
  gitlinks, fillSubmodules, dropSubmoduleClones, worktreeLinks,
};

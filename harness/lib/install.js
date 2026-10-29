'use strict';
// lib/install.js — 대상 저장소에 하네스를 심고 걷는다(설계 §8). 멱등: 두 번째 설치는 아무 파일도 바꾸지 않는다.
//
//   install({ target, source, dryRun, force }) → { ok, target, changed: [경로], skipped: [{path, reason}], notes: [문장], report }
//   uninstall({ target, dryRun })              → 같은 모양
//   대상에 우리 것이 아닌 harness/ 가 있으면(버전 마커 harness/.harness-version 도, 설치 기록도 없음) 아무것도 쓰지 않고
//   ok:false 로 끝난다 — force 일 때만 덮어쓴다.
//
//   심는 것: harness/ 사본(대상이 원본이면 생략) · AGENTS.md 관리 블록 · CLAUDE.md 의 `@AGENTS.md` ·
//            .claude/settings.json 훅 · .codex/hooks.json 훅(저장소 것 — 전역 ~/.codex 는 절대 쓰지 않는다) ·
//            스킬 harness(.claude/skills · .agents/skills) · .git/info/exclude 의 `.harness-worktrees/` ·
//            (예전 판 --track-docs 의 .gitignore 관리 블록은 uninstall 이 걷는다)
//   기록: <git-common-dir>/harness/install.json — 무엇을 새로 만들었고 무엇을 어떻게 고쳤는지.
//         uninstall 은 이것으로 원본을 바이트 그대로 되돌린다(사용자가 그 사이 고친 것은 보존하고 우리 것만 걷는다).
const fs = require('node:fs');
const path = require('node:path');
const C = require('../hooks/_common');

// 예전 템플릿(template/CLAUDE.md)의 줄 → 지금 문구. 글자 그대로 같은 줄만 바꾼다.
//   [2026-10-20 사용자 보고] 대화형 세션이 "서브에이전트는 적게" 지침 때문에 독립적인 시험 · 검토 11개를 하나씩 차례로 돌렸다.
//   [2026-10-25 Light] 나눈 일은 factory 가 아니라 각자 lane(`start`) — factory 를 가리키던 줄도 새 문구로.
const SPLIT_LINE = '- 서로 독립적인 일(조사 · 시나리오 시험 · 검토 · 서로 다른 파일의 작업)은 서브에이전트로 나눠 한 메시지에서 동시에 띄운다. 같은 파일을 여러 에이전트가 고치게 나누지 않는다 — 그렇게 나눠야 하면 각자 레인(`start`).';
const LEGACY_CLAUDE_LINES = [
  ['- 서로 독립적인 일(조사 · 시나리오 시험 · 검토 · 서로 다른 파일의 작업)은 서브에이전트로 나눠 한 메시지에서 동시에 띄운다. 같은 파일을 여러 에이전트가 고치게 나누지 않는다 — 그렇게 나눠야 하면 각자 lane(`start`) · `go --owns`.', SPLIT_LINE],
  ['- 서브에이전트는 정말 독립적인 큰 일에만, 적게 쓴다.', SPLIT_LINE],
  ['- 서로 독립적인 일(조사 · 시나리오 시험 · 검토 · 서로 다른 파일의 작업)은 서브에이전트로 나눠 한 메시지에서 동시에 띄운다. 같은 파일을 여러 에이전트가 고치게 나누지 않는다 — 그렇게 나눠야 하면 `factory` · `go --owns`.', SPLIT_LINE],
  ['- 별도의 검증 단계나 검증용 서브에이전트를 두지 않는다 — 저장소 테스트 명령의 종료 코드가 판정이다.',
    '- 판정은 저장소 테스트 명령의 종료 코드다 — 에이전트의 의견으로 판정하지 않는다. 시험을 쓰고 돌리는 서브에이전트는 된다(그 시험이 판정이 된다).'],
];

const BEGIN = '<!-- harness:begin -->';
const END = '<!-- harness:end -->';
const EXCLUDE_LINE = '.harness-worktrees/';
const GI_BEGIN = '# harness:docs-begin';
const GI_END = '# harness:docs-end';
const SKIP_DIRS = new Set(['tests', 'test', 'node_modules', '.git']);
// 우리 훅 = 우리가 만드는 명령 문자열 그대로(리뷰 M11 — 경로 어디든 harness/hooks/ 가 들어간 사용자 훅을 지우지 않는다).
//   Codex commandWindows 는 설치 때의 절대 경로다 — 저장소를 옮긴 뒤 재설치해도 옛 경로의 것을 알아보게 경로 부분은 열어 둔다.
const HOOK_NAMES = '(?:guard|track|stop|session-end|lang|board)';
const OURS_CLAUDE = new RegExp(`^node "\\$\\{CLAUDE_PROJECT_DIR\\}/harness/hooks/${HOOK_NAMES}\\.js"$`);
const OURS_CODEX = new RegExp(`^node "\\$\\(git rev-parse --show-toplevel\\)/harness/hooks/${HOOK_NAMES}\\.js" --codex$`);
const OURS_CODEX_WIN = new RegExp(`^node "?(?:[^"]*[\\\\/])?harness[\\\\/]hooks[\\\\/]${HOOK_NAMES}\\.js"? --codex$`);
// harness/ 사본의 버전 마커(리뷰 M12). 이 파일(또는 설치 기록)이 없는 기존 harness/ 는 남의 것 — force 없이 덮어쓰지 않는다.
const MARKER = '.harness-version';
const MARKER_TEXT = 'harness 5\n# node harness/cli.js install 이 만든 사본이다 — 재설치가 이 폴더를 덮어쓴다. 지우면 재설치에 --force 가 필요하다.\n';

// ── 훅 정의 ──
// Claude: ${CLAUDE_PROJECT_DIR} 는 세션 시작 루트에 고정된다 — cwd 가 하위 폴더나 worktree 로 옮겨도 경로가 깨지지 않는다(Claude 조사 §4 · §10.3).
function claudeHooks() {
  const h = (x, timeout) => ({ type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/harness/hooks/${x}.js"`, timeout });
  // [2026-10-25] mcp__.* — git · GitHub MCP 서버의 쓰기 도구가 guard 를 비켜 갔다. 파일 시스템 MCP 의 쓰기도 세션 파일에 기록한다.
  //   board — 세션 게시판(같은 체크아웃의 다른 세션 · 같은 목표 알림 · 남의 미커밋 파일 편집 전 묻기 · 가벼운 길의 환경).
  return {
    // guard 는 실패(오류 · 시간 초과 · 셸 없음)해도 막는다 — [2026-10-29 Claude Code 문서] onFailure 가 없으면 Git for Windows 가 있을 때 실패가 통과로 끝난다(v2.1.295+ · 옛 판은 이 키를 무시)
    PreToolUse: [{ matcher: 'Bash|PowerShell|mcp__.*', hooks: [{ ...h('guard', 10), onFailure: 'block' }] }, { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [h('board', 10)] }],
    PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|mcp__.*__(write_file|edit_file|move_file|create_file)', hooks: [h('track', 10)] }],
    UserPromptSubmit: [{ hooks: [h('lang', 10), h('board', 10)] }],          // 응답 언어 — 매 턴 상기(2026-10-13) · 게시판
    SessionStart: [{ hooks: [h('board', 10)] }],
    Stop: [{ hooks: [h('stop', 30), h('lang', 10)] }],
    SessionEnd: [{ hooks: [h('session-end', 30)] }],     // 기본 예산 1.5초 → 커밋할 시간을 준다(최대 60)
  };
}
// Codex(Codex 조사 §4 의 형식: command + commandWindows). `--codex` 로 런타임을 알린다.
//   Codex 는 명령을 세션 cwd 에서 돌린다 — 상대 경로면 하위 폴더에서 훅이 무음으로 실패한다(리뷰 L10).
//   command 는 셸이 루트를 찾고, commandWindows 는 설치 때 계산한 절대 경로(슬래시)를 쓴다. 저장소를 옮기면 재설치한다.
function codexHooks(root) {
  const winBase = root ? `"${path.resolve(root).split(path.sep).join('/')}/harness/hooks/` : '"harness/hooks/';
  const h = (x, timeout) => ({
    type: 'command',
    command: `node "$(git rev-parse --show-toplevel)/harness/hooks/${x}.js" --codex`,
    commandWindows: `node ${winBase}${x}.js" --codex`,
    timeout,
  });
  return {
    PreToolUse: [{ matcher: 'Bash|shell|local_shell|exec_command|unified_exec', hooks: [h('guard', 10)] }],
    PostToolUse: [{ matcher: 'apply_patch|Edit|Write', hooks: [h('track', 10)] }],
    UserPromptSubmit: [{ hooks: [h('lang', 10), h('board', 10)] }],      // 게시판은 요청 때만(Codex 는 CLAUDE_ENV_FILE 이 없다)
    Stop: [{ hooks: [h('stop', 30), h('lang', 10)] }],
    SessionEnd: [{ hooks: [h('session-end', 3)] }],      // Codex SessionEnd 상한 3초
  };
}

// 대화형 세션이 "자기 파일만 커밋하고 끝낸다" 를 묻지 않고 할 수 있게 — 커밋과 읽기 전용 git 만 허용한다.
//   [2026-09-29 실측] 허용이 없으면 Stop 훅이 커밋을 요구해도 모델의 git commit 이 승인 대기에 걸린다.
//   위험한 git(push · reset --hard · clean · rebase · 직접 merge …)은 guard 훅이 계속 막는다.
// 하네스 보고(report)는 묻지 않고 — 사용자가 이슈 발행에 개입하지 않게(2026-10-13 사용자 결정).
const OUR_ALLOW = [...['add', 'commit', 'status', 'diff', 'log', 'show'].flatMap(c => [`Bash(git ${c}:*)`, `PowerShell(git ${c}:*)`]),
  'Bash(node harness/cli.js report:*)', 'PowerShell(node harness/cli.js report:*)'];
const str = v => (typeof v === 'string' ? v : '');
const isOurs = h => !!h && typeof h === 'object' &&
  (OURS_CLAUDE.test(str(h.command)) || OURS_CODEX.test(str(h.command)) || OURS_CODEX_WIN.test(str(h.commandWindows)));
const clone = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 설치 전부터 사용자 설정에 있던 OUR_ALLOW 항목 — 이것들은 사용자 것이라 걷지 않는다(리뷰 M11).
//   설치 기록에 있으면 그것, 기록에 원본이 있으면 원본에서, 기록이 없으면(첫 설치) 지금 파일에서.
function preexistingAllow(me, current) {
  const pick = o => (o && o.permissions && Array.isArray(o.permissions.allow) ? o.permissions.allow.filter(x => OUR_ALLOW.includes(x)) : []);
  if (me && Array.isArray(me.allow_preexisting)) return me.allow_preexisting;
  if (me && me.original != null) { try { return pick(JSON.parse(me.original.replace(/^﻿/, ''))); } catch { return []; } }
  if (me) return [];
  return pick(current);
}

// 우리 훅을 걷는다. dropEmpty: 우리 때문에 비게 된 그룹 · 이벤트 · hooks 키를 지운다(uninstall).
//   설치 때는 이벤트 키를 남겨 둔다 — 그래야 다시 넣을 때 키 순서가 그대로여서 두 번째 설치가 바이트 그대로다.
//   keepAllow: 설치 전부터 있던 allow 항목 — 우리 목록과 같아도 남긴다.
function stripOurs(obj, dropEmpty, keepAllow) {
  const out = clone(obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {});
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) return out;
  let touched = false;
  for (const ev of Object.keys(out.hooks)) {
    const groups = out.hooks[ev];
    if (!Array.isArray(groups)) continue;
    let evTouched = false;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const hs = g.hooks.filter(h => !isOurs(h));
      if (hs.length === g.hooks.length) { kept.push(g); continue; }
      evTouched = true;
      if (hs.length) kept.push({ ...g, hooks: hs });
    }
    if (evTouched) touched = true;
    if (evTouched && dropEmpty && !kept.length) delete out.hooks[ev];
    else out.hooks[ev] = kept;
  }
  if (touched && dropEmpty && !Object.keys(out.hooks).length) delete out.hooks;
  const p = out.permissions;
  const keep = new Set(keepAllow || []);
  const oursAllow = x => OUR_ALLOW.includes(x) && !keep.has(x);
  if (p && typeof p === 'object' && Array.isArray(p.allow) && p.allow.some(oursAllow)) {
    p.allow = p.allow.filter(x => !oursAllow(x));
    if (dropEmpty && !p.allow.length) delete p.allow;
    if (dropEmpty && !Object.keys(p).length) delete out.permissions;
  }
  return out;
}

function addOurs(obj, ours, opts) {
  const out = clone(obj);
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) out.hooks = {};
  for (const [ev, groups] of Object.entries(ours)) {
    if (!Array.isArray(out.hooks[ev])) out.hooks[ev] = [];
    out.hooks[ev].push(...clone(groups));
  }
  if (opts && opts.allow) {
    if (!out.permissions || typeof out.permissions !== 'object' || Array.isArray(out.permissions)) out.permissions = {};
    if (!Array.isArray(out.permissions.allow)) out.permissions.allow = [];
    out.permissions.allow.push(...OUR_ALLOW.filter(x => !out.permissions.allow.includes(x)));
  }
  return out;
}

// ── 파일 도구 ──
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function eolOf(text) { return text && /\r\n/.test(text) ? '\r\n' : '\n'; }
function withEol(text, eol) { return eol === '\n' ? text : text.replace(/\r?\n/g, eol); }
function indentOf(text) { const m = /\n([ \t]+)"/.exec(text || ''); return m ? m[1] : 2; }
function stringify(obj, like) {
  const eol = eolOf(like);
  const trailing = like == null || /\n$/.test(like);
  return withEol(JSON.stringify(obj, null, indentOf(like)), eol) + (trailing ? eol : '');
}
function rel(root, file) { return path.relative(root, file).split(path.sep).join('/'); }

function* walk(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase())) yield* walk(p, base); }
    else if (e.isFile() && !/\.test\.js$|\.log$|\.tmp$/i.test(e.name)) yield path.relative(base, p);
  }
}

// ── 계획과 적용 ──
// ops: { file, content | null(삭제) } — 적용은 끝에 한 번에(dryRun 이면 적용하지 않는다).
function makeCtx(opts) {
  const target = path.resolve(opts.target || process.cwd());
  const info = C.repoInfo(target);
  if (!info) throw new Error(`git 저장소가 아닙니다: ${target} — 먼저 git init 하세요`);
  const root = info.root;
  const manifestFile = path.join(C.harnessDir(info.common), 'install.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { manifest = null; }
  if (!manifest || typeof manifest !== 'object') manifest = { version: 1, files: {}, dirs: [] };
  if (!manifest.files) manifest.files = {};
  if (!Array.isArray(manifest.dirs)) manifest.dirs = [];
  const before = JSON.stringify(manifest);
  return { opts, root, common: info.common, manifestFile, manifest, before, ops: [], changed: [], skipped: [], notes: [] };
}

function put(ctx, file, content) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (content === null) { if (cur !== null) { ctx.ops.push({ file, content: null }); ctx.changed.push(rel(ctx.root, file)); } return; }
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (cur && cur.equals(buf)) return;
  // 새로 만드는 폴더를 기록한다 — uninstall 이 비었을 때만 지운다.
  let d = path.dirname(file);
  const newDirs = [];
  while (!fs.existsSync(d) && C.samePath(d, ctx.root) === false && !path.relative(ctx.root, d).startsWith('..')) { newDirs.push(rel(ctx.root, d)); d = path.dirname(d); }
  for (const nd of newDirs) if (!ctx.manifest.dirs.includes(nd)) ctx.manifest.dirs.push(nd);
  ctx.ops.push({ file, content: buf });
  ctx.changed.push(rel(ctx.root, file));
}

function entry(ctx, key, init) {
  if (!ctx.manifest.files[key]) ctx.manifest.files[key] = init();
  return ctx.manifest.files[key];
}

function apply(ctx) {
  if (ctx.opts.dryRun) return;
  for (const op of ctx.ops) {
    if (op.content === null) {
      try { fs.unlinkSync(op.file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      // harness/ 안에서 지운 파일의 폴더가 비면 지운다(새 판에서 빠진 lib/gone/ 같은 것 — harness/ 자체는 남긴다)
      const top = path.join(ctx.root, 'harness');
      for (let d = path.dirname(op.file); d.length > top.length && d.startsWith(top + path.sep); d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
      continue;
    }
    fs.mkdirSync(path.dirname(op.file), { recursive: true });
    fs.writeFileSync(op.file, op.content);
  }
}

function saveManifest(ctx, remove) {
  if (ctx.opts.dryRun) return;
  if (remove) { try { fs.unlinkSync(ctx.manifestFile); } catch { /* 없음 */ } return; }
  if (JSON.stringify(ctx.manifest) === ctx.before && fs.existsSync(ctx.manifestFile)) return;
  C.writeJsonAtomic(ctx.manifestFile, ctx.manifest);
}

// cli.js 는 r.report 를 그대로 출력하고 r.ok === false 면 1 로 끝난다.
function summary(ctx, verb) {
  const changed = [...new Set(ctx.changed)];
  const L = [`pilot ${verb}${ctx.opts.dryRun ? ' (dry run — 아무것도 쓰지 않음)' : ''}: ${ctx.root}`];
  if (!changed.length) L.push('  바뀐 것 없음');
  // harness/ 사본은 파일이 많다 — 한 줄로 묶는다.
  const copies = changed.filter(c => c.startsWith('harness/'));
  for (const c of changed.filter(x => !x.startsWith('harness/'))) L.push(`  ${ctx.opts.dryRun ? '바꿀' : '바뀜'}: ${c}`);
  if (copies.length) L.push(`  ${ctx.opts.dryRun ? '바꿀' : '바뀜'}: harness/ (${copies.length}개 파일)`);
  for (const s of ctx.skipped) L.push(`  건너뜀: ${s.path} — ${s.reason}`);
  for (const n of ctx.notes) L.push(`  참고: ${n}`);
  return { ok: true, target: ctx.root, changed, skipped: ctx.skipped, notes: ctx.notes, dryRun: !!ctx.opts.dryRun, report: L.join('\n') };
}

// source 는 harness 폴더 자체이거나 그것을 담은 저장소 루트다(cli.js 는 `harness/..` 를 넘긴다) — 둘 다 받는다.
function resolveSource(src) {
  const s = path.resolve(src || path.join(__dirname, '..'));
  const isHarness = d => fs.existsSync(path.join(d, 'template', 'AGENTS.block.md')) && fs.existsSync(path.join(d, 'hooks', 'guard.js'));
  if (isHarness(s)) return s;
  if (isHarness(path.join(s, 'harness'))) return path.join(s, 'harness');
  throw new Error(`하네스 원본을 찾지 못했습니다: ${s} (template/AGENTS.block.md · hooks/guard.js 가 있어야 합니다)`);
}

// ── install ──
function install(opts) {
  opts = opts || {};
  const source = resolveSource(opts.source);
  const ctx = makeCtx(opts);
  const { root } = ctx;

  // 1) harness/ 사본
  const destHarness = path.join(root, 'harness');
  if (C.samePath(destHarness, source)) ctx.skipped.push({ path: 'harness/', reason: '대상 저장소가 원본이다 — 복사하지 않는다' });
  else {
    const foreign = foreignHarness(ctx, destHarness);
    if (foreign && !opts.force) return refuse(ctx, foreign);
    // [2026-09-30 실측 · Python 서비스 저장소] 다른 세션의 작업이 돌고 있는 저장소에 재설치해 harness/ 파일 3개를 바꿨다 — 그 프로세스는 이미
    //   읽어 둔 모듈로 돌아 해는 없었지만, 도는 중에 엔진 파일을 갈아 끼우는 것은 하지 않는다. 주인이 살아 있는 작업이 있으면 멈춘다.
    const running = runningTasks(root);
    if (running.length && !opts.force) return refuse(ctx, `실행 중인 하네스 작업이 있다(${running.join(', ')}) — 끝난 뒤에 다시 설치한다`);
    if (foreign) ctx.notes.push(`--force: 기존 harness/ (${foreign}) 를 덮어썼다 — 같은 이름의 파일만 바뀌고 나머지는 남는다.`);
    const copied = new Set();
    for (const r of walk(source, source)) {
      if (r === MARKER) continue;                                  // 마커는 아래에서 따로 쓴다
      const dest = path.join(destHarness, r);
      const key = rel(root, dest);
      const existed = fs.existsSync(dest);
      copied.add(key);
      entry(ctx, key, () => ({ created: !existed }));
      put(ctx, dest, fs.readFileSync(path.join(source, r)));
    }
    // [v7] 새 판에서 빠진 하네스 파일(loop.js · factory.js …)은 지운다 — 설치 기록에 하네스가 깐 것으로 적힌 harness/ 파일만(사용자 파일은 기록에 없다)
    for (const key of Object.keys(ctx.manifest.files)) {
      if (!key.startsWith('harness/') || copied.has(key) || key === rel(root, path.join(destHarness, MARKER)) || !ctx.manifest.files[key].created) continue;
      put(ctx, path.join(root, key), null);
      delete ctx.manifest.files[key];
    }
    const marker = path.join(destHarness, MARKER);
    const markerExisted = fs.existsSync(marker);
    entry(ctx, rel(root, marker), () => ({ created: !markerExisted }));
    put(ctx, marker, MARKER_TEXT);
  }

  // 2) AGENTS.md 관리 블록
  const blockBody = fs.readFileSync(path.join(source, 'template', 'AGENTS.block.md'), 'utf8').replace(/\s+$/, '');
  const agentsFile = path.join(root, 'AGENTS.md');
  const agents = readText(agentsFile);
  if (agents === null) {
    entry(ctx, 'AGENTS.md', () => ({ created: true }));
    put(ctx, agentsFile, `${BEGIN}\n${blockBody}\n${END}\n`);
  } else {
    const eol = eolOf(agents);
    const block = withEol(`${BEGIN}\n${blockBody}\n${END}`, eol);
    const b = agents.indexOf(BEGIN), e = b >= 0 ? agents.indexOf(END, b) : -1;
    if (b >= 0 && e >= 0) put(ctx, agentsFile, agents.slice(0, b) + block + agents.slice(e + END.length));
    else {
      const sep = agents === '' ? '' : agents.endsWith(eol) ? eol : eol + eol;
      entry(ctx, 'AGENTS.md', () => ({ created: false, sep }));
      put(ctx, agentsFile, agents + sep + block + eol);
    }
  }

  // 3) CLAUDE.md — `@AGENTS.md` 한 줄(Claude 는 CLAUDE.md 가 있으면 AGENTS.md 를 스스로 읽지 않는다 — import 가 공유 방식)
  const claudeFile = path.join(root, 'CLAUDE.md');
  const claude = readText(claudeFile);
  if (claude === null) {
    entry(ctx, 'CLAUDE.md', () => ({ created: true }));
    put(ctx, claudeFile, fs.readFileSync(path.join(source, 'template', 'CLAUDE.md')));
  } else if (LEGACY_CLAUDE_LINES.some(([old]) => claude.split(/\r?\n/).includes(old))) {
    // 예전 템플릿이 넣은 줄을 글자 그대로 찾아 새 문구로(사용자가 고친 줄 · 다른 내용은 그대로) — 이미 설치된 프로젝트에도 바뀐 지침이 닿게
    const eol = eolOf(claude);
    const next = claude.split(/\r?\n/).map(l => { const hit = LEGACY_CLAUDE_LINES.find(([old]) => old === l); return hit ? hit[1] : l; }).join(eol);
    entry(ctx, 'CLAUDE.md', () => ({ created: false, migrated: true }));
    put(ctx, claudeFile, next);
  } else if (!/^@AGENTS\.md[ \t]*\r?$/m.test(claude)) {
    const eol = eolOf(claude);
    const nl = claude.indexOf('\n');
    let at, ins;
    if (/^#{1,6} /.test(claude) && nl >= 0) { at = nl + 1; ins = `${eol}@AGENTS.md${eol}`; }
    else { at = 0; ins = `@AGENTS.md${eol}${eol}`; }
    entry(ctx, 'CLAUDE.md', () => ({ created: false, inserted: ins, at }));
    put(ctx, claudeFile, claude.slice(0, at) + ins + claude.slice(at));
  }

  // 4) 훅 설정 — Claude · Codex(저장소)
  mergeJson(ctx, path.join(root, '.claude', 'settings.json'), claudeHooks(), { allow: true });
  mergeJson(ctx, path.join(root, '.codex', 'hooks.json'), codexHooks(root));

  // 5) 스킬 — 같은 원본 한 벌을 두 곳에
  const skill = fs.readFileSync(path.join(source, 'skill', 'SKILL.md'));
  for (const dir of ['.claude/skills/harness', '.agents/skills/harness']) {
    const f = path.join(root, ...dir.split('/'), 'SKILL.md');
    const existed = fs.existsSync(f);
    entry(ctx, `${dir}/SKILL.md`, () => ({ created: !existed }));
    put(ctx, f, skill);
  }

  // 6) .git/info/exclude — worktree 폴더를 git 에서 숨긴다
  const exFile = path.join(ctx.common, 'info', 'exclude');
  const ex = readText(exFile);
  const hasLine = ex !== null && ex.split(/\r?\n/).some(l => l.trim() === EXCLUDE_LINE || l.trim() === '/' + EXCLUDE_LINE);
  if (!hasLine) {
    const eol = eolOf(ex);
    const added = (ex && !ex.endsWith('\n') ? eol : '') + EXCLUDE_LINE + eol;
    if (!ctx.manifest.exclude) ctx.manifest.exclude = { added, created: ex === null };
    put(ctx, exFile, (ex || '') + added);
  }


  ctx.notes.push(
    'Codex: 프로젝트 .codex/ 층은 신뢰된 프로젝트에서만 읽힌다(config.toml `[projects.\'<repo>\'] trust_level = "trusted"`). ' +
    '새 훅은 해시를 신뢰할 때까지 건너뛴다 — Codex 에서 `/hooks` 로 검토·신뢰하세요. 전역 ~/.codex 는 건드리지 않았습니다.',
    'Claude Code: 대화형 세션은 워크스페이스를 신뢰한 뒤에만 .claude/settings.json 훅을 실행한다.',
  );
  apply(ctx);
  saveManifest(ctx);
  return summary(ctx, 'install');
}

// ── 예전 판(--track-docs)이 더한 .gitignore 블록 — uninstall 이 걷는다 ──
function untrackDocs(ctx) {
  const giFile = path.join(ctx.root, '.gitignore');
  const gi = readText(giFile);
  if (gi === null) return;
  const b = gi.indexOf(GI_BEGIN), e = b >= 0 ? gi.indexOf(GI_END, b) : -1;
  if (b < 0 || e < 0) return;
  const eol = eolOf(gi), mg = ctx.manifest.gitignore_docs;
  let before = gi.slice(0, b), after = gi.slice(e + GI_END.length);
  if (after.startsWith(eol)) after = after.slice(eol.length);
  else if (after.startsWith('\n')) after = after.slice(1);
  if (mg && mg.sep && before.endsWith(mg.sep)) before = before.slice(0, -mg.sep.length);
  const next = before + after;
  put(ctx, giFile, mg && mg.created && !next ? null : next);
}

function mergeJson(ctx, file, ours, opts) {
  const key = rel(ctx.root, file);
  const text = readText(file);
  let obj = {};
  if (text !== null) {
    try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { ctx.skipped.push({ path: key, reason: `JSON 이 아니어서 건드리지 않았다: ${e.message}` }); return; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { ctx.skipped.push({ path: key, reason: 'JSON 객체가 아니어서 건드리지 않았다' }); return; }
  }
  const keep = opts && opts.allow ? preexistingAllow(ctx.manifest.files[key], obj) : [];
  const merged = addOurs(stripOurs(obj, false, keep), ours, opts);
  if (text !== null && same(merged, obj)) return;
  entry(ctx, key, () => ({ ...(text === null ? { created: true } : { created: false, original: text }), ...(opts && opts.allow ? { allow_preexisting: keep } : {}) }));
  put(ctx, file, stringify(merged, text));
}

// 기존 harness/ 가 우리 것이 아닌가 — 이유(문장) 또는 null. 우리 것 = 버전 마커가 있거나 설치 기록이 harness/ 를 가리킨다.
//   비어 있는 폴더는 덮어써도 잃을 것이 없다.
function foreignHarness(ctx, destHarness) {
  let st;
  try { st = fs.statSync(destHarness); } catch { return null; }
  if (!st.isDirectory()) return 'harness 가 폴더가 아니다';
  if (fs.existsSync(path.join(destHarness, MARKER))) return null;
  if (Object.keys(ctx.manifest.files).some(k => k.startsWith('harness/'))) return null;
  let n = 0;
  try { n = fs.readdirSync(destHarness).length; } catch { n = 0; }
  return n ? `harness/${MARKER} 가 없다 — 하네스 설치본이 아니다` : null;
}

// 주인 프로세스가 살아 있는 실행 중 작업의 id 목록.
function runningTasks(root) {
  try {
    const S = require('./state');
    return S.listTasks(S.mainRoot(root)).filter(t => t.status === 'running' && t.owner && S.ownerAlive(t.owner)).map(t => t.id);
  } catch { return []; }   // 상태를 못 읽으면(처음 설치 등) 도는 작업도 없다
}

function refuse(ctx, why) {
  const L = [`pilot install 중단: ${ctx.root}`, `  기존 harness/ 를 덮어쓰지 않았다 — ${why}.`,
    '  아무것도 바꾸지 않았다. 그 폴더를 옮기거나, 덮어써도 되면 `node harness/cli.js install --force` 로 다시 실행하세요.'];
  return { ok: false, target: ctx.root, changed: [], skipped: [{ path: 'harness/', reason: why }], notes: [], dryRun: !!ctx.opts.dryRun, report: L.join('\n') };
}

// ── uninstall ──
function uninstall(opts) {
  opts = opts || {};
  const ctx = makeCtx(opts);
  const { root, manifest } = ctx;
  const m = key => manifest.files[key] || null;

  // harness/ 사본 · 스킬 — 우리가 만든 파일만
  for (const [key, e] of Object.entries(manifest.files)) {
    if (!(key.startsWith('harness/') || /^\.(claude|agents)\/skills\/harness\/SKILL\.md$/.test(key))) continue;
    if (e && e.created) put(ctx, path.join(root, ...key.split('/')), null);
  }
  if (!Object.keys(manifest.files).length) {
    // 기록이 없으면(다른 곳에서 설치) 스킬만 우리 것으로 확실하다 — 경로가 우리 이름이다.
    for (const dir of ['.claude/skills/harness', '.agents/skills/harness']) put(ctx, path.join(root, ...dir.split('/'), 'SKILL.md'), null);
    ctx.notes.push('설치 기록(install.json)이 없어 harness/ 사본은 남겨 두었다.');
  }

  // AGENTS.md
  const agentsFile = path.join(root, 'AGENTS.md');
  const agents = readText(agentsFile);
  if (agents !== null) {
    const b = agents.indexOf(BEGIN), e = b >= 0 ? agents.indexOf(END, b) : -1;
    if (b >= 0 && e >= 0) {
      const eol = eolOf(agents);
      let before = agents.slice(0, b), after = agents.slice(e + END.length);
      if (after.startsWith(eol)) after = after.slice(eol.length);
      const me = m('AGENTS.md');
      if (me && me.sep && before.endsWith(me.sep)) before = before.slice(0, -me.sep.length);
      else if (!me && before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
      const next = before + after;
      put(ctx, agentsFile, me && me.created && !next.trim() ? null : next);
    }
  }

  // CLAUDE.md
  const claudeFile = path.join(root, 'CLAUDE.md');
  const claude = readText(claudeFile);
  const mc = m('CLAUDE.md');
  if (claude !== null && mc) {
    if (mc.created) {
      const tpl = readText(path.join(__dirname, '..', 'template', 'CLAUDE.md'));
      if (claude === tpl) put(ctx, claudeFile, null);
      else ctx.skipped.push({ path: 'CLAUDE.md', reason: '설치가 만든 파일이지만 그 뒤에 바뀌어 남겨 두었다' });
    } else if (mc.inserted) {
      const at = claude.indexOf(mc.inserted, Math.max(0, (mc.at || 0) - 1));
      const k = at >= 0 ? at : claude.indexOf(mc.inserted);
      if (k >= 0) put(ctx, claudeFile, claude.slice(0, k) + claude.slice(k + mc.inserted.length));
    }
  }

  // 훅 설정
  for (const f of [path.join(root, '.claude', 'settings.json'), path.join(root, '.codex', 'hooks.json')]) {
    const key = rel(root, f);
    const text = readText(f);
    if (text === null) continue;
    let obj;
    try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch { ctx.skipped.push({ path: key, reason: 'JSON 이 아니어서 건드리지 않았다' }); continue; }
    const me = m(key);
    const stripped = stripOurs(obj, true, preexistingAllow(me, null));     // 설치 전부터 있던 allow 는 남긴다
    if (same(stripped, obj)) continue;
    let original = null;
    try { original = me && me.original != null ? JSON.parse(me.original.replace(/^﻿/, '')) : null; } catch { original = null; }
    if (original && same(stripped, original)) put(ctx, f, me.original);                    // 바이트 그대로
    else if (me && me.created && !Object.keys(stripped).length) put(ctx, f, null);
    else put(ctx, f, stringify(stripped, text));
  }

  // .gitignore — install --track-docs 의 관리 블록만(다른 줄은 바이트 그대로)
  untrackDocs(ctx);

  // .git/info/exclude
  const exFile = path.join(ctx.common, 'info', 'exclude');
  const ex = readText(exFile);
  if (ex !== null) {
    const mx = manifest.exclude;
    let next = ex;
    if (mx && mx.added && ex.endsWith(mx.added)) next = ex.slice(0, -mx.added.length);
    else if (mx) next = ex.replace(new RegExp(`^${EXCLUDE_LINE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\r?\\n?`, 'm'), '');
    if (next !== ex) put(ctx, exFile, mx && mx.created && !next ? null : next);
  }

  apply(ctx);
  // 우리가 만든 폴더 — 비었을 때만, 깊은 것부터.
  const dirs = [...manifest.dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  if (!Object.keys(manifest.files).length) dirs.push('.claude/skills/harness', '.agents/skills/harness');
  for (const d of dirs) {
    const abs = path.join(root, ...d.split('/'));
    try {
      if (fs.readdirSync(abs).length === 0) { if (!opts.dryRun) fs.rmdirSync(abs); ctx.changed.push(d + '/'); }
    } catch { /* 없거나 비지 않음 — 남긴다 */ }
  }
  saveManifest(ctx, true);
  return summary(ctx, 'uninstall');
}

module.exports = { install, uninstall, claudeHooks, codexHooks, stripOurs, addOurs, BEGIN, END, GI_BEGIN, GI_END };

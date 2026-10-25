#!/usr/bin/env node
'use strict';
// hooks/guard.js — PreToolUse(셸 도구): 되돌릴 수 없는 명령만 막는다(설계 §0.8 · §7).
//   Claude: Bash · PowerShell  /  Codex: Bash(셸) — 둘 다 tool_input.command.
//   막는 것: push · pull · reset --hard · 브랜치를 옮기는 reset/branch -f/-M/checkout -B/switch -C/update-ref · commit --amend ·
//            clean -f · branch -D · 작업 트리 전체 checkout/restore/rm -r · rebase · 직접 merge(--ff-only 포함) · stash(list/show 외 전부) ·
//            루트/홈/드라이브 루트/.git(하위 포함) 재귀 삭제 · 대상이 변수/치환이라 풀 수 없는 재귀 삭제 · 비밀 파일 add/commit.
//   막지 않는 것: 문자열 속 언급(grep · echo · 커밋 메시지 · heredoc 본문), 하네스 CLI, 읽기 전용 git,
//            진행 중인 merge/rebase 를 끝내거나 되돌리는 --continue/--abort/--quit(/--skip), 색인만 푸는 restore --staged.
//   제어 구문(if/then/do/else …) 뒤의 명령도 명령으로 본다.
//   출력: 두 런타임 모두 `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason` (exit 0).
//   내부 오류는 열어 둔다(허용) — 대신 <common>/harness/hook-errors.log 에 남긴다.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const C = require('./_common');

// ─────────────────────────── 어휘 분석 ───────────────────────────
// 셸 문자열을 "단순 명령" 목록으로 나눈다. 각 명령은 따옴표를 벗긴 단어 배열이다.
//   구분자: ; && || | & 개행 ( ) { }  ·  $( … ) 와 `…`(bash) 는 안쪽을 따로 명령으로 꺼낸다(실행되므로).
//   heredoc 본문과 따옴표 안은 데이터 — 명령 위치에 오지 않으므로 언급만으로는 걸리지 않는다.
//   mode: 'bash'(\ 이스케이프 · ` 치환) | 'ps'(` 이스케이프 · '' 이스케이프 · @' '@ here-string).
const SUB = '\u0001';

// [2026-10-21 사용 분석 · 재생 검증] 따옴표 안의 > · < 는 데이터다 — `grep "string>\|JToken"` 이 `x>파일` 리디렉션으로 오인돼 막혔다.
//   lexer 는 따옴표 안의 > · < 를 표식으로 바꾸고, 다시 명령으로 읽을 때(lex 입구 — bash -c · cmd /c · eval · 별칭이 모두 여기를 지난다)만 되돌린다.
const QGT = '\u0002', QLT = '\u0003';
const quotedCh = c => (c === '>' ? QGT : c === '<' ? QLT : c);
const unquote = x => String(x).replace(/\u0002/g, '>').replace(/\u0003/g, '<');

function lex(src, mode) {
  const out = [];
  const st = { i: 0 };
  lexInto(unquote(String(src || '')), mode, st, out, false);
  return out;
}

function lexInto(s, mode, st, out, nested) {
  let words = [], w = '', inWord = false, depth = 0;
  const heredocs = [];
  const endWord = () => { if (inWord) { words.push(w); w = ''; inWord = false; } };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  const sub = () => {           // $( … ) — 안쪽을 명령으로 꺼내고 단어에는 자리표시만 남긴다.
    lexInto(s, mode, st, out, true);
    w += SUB; inWord = true;
  };
  const backtickSub = () => {   // bash `…`
    let j = st.i, inner = '';
    while (j < s.length && s[j] !== '`') { if (s[j] === '\\' && j + 1 < s.length) { inner += s[j + 1]; j += 2; continue; } inner += s[j++]; }
    st.i = j + 1;
    for (const c of lex(inner, mode)) out.push(c);
    w += SUB; inWord = true;
  };
  const readHeredocBodies = () => {
    for (const h of heredocs.splice(0)) {
      while (st.i < s.length) {
        let e = s.indexOf('\n', st.i); if (e < 0) e = s.length;
        let line = s.slice(st.i, e).replace(/\r$/, '');
        st.i = e + 1;
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.delim) break;
      }
    }
  };

  while (st.i < s.length) {
    const ch = s[st.i], nx = s[st.i + 1];
    if (ch === ' ' || ch === '\t' || ch === '\r') { endWord(); st.i++; continue; }
    if (ch === '\n') { endCmd(); st.i++; if (heredocs.length) readHeredocBodies(); continue; }
    if (ch === ';') { endCmd(); st.i++; continue; }
    if (ch === '&') {
      if (nx === '&') { endCmd(); st.i += 2; continue; }
      if (nx === '>' || (inWord && /[0-9>]$/.test(w) && w.endsWith('>'))) { w += ch; inWord = true; st.i++; continue; }
      endCmd(); st.i++; continue;
    }
    if (ch === '|') { endCmd(); st.i += (nx === '|' || nx === '&') ? 2 : 1; continue; }
    if (ch === '(') {
      if (inWord && w.endsWith('$')) { w = w.slice(0, -1); st.i++; sub(); continue; }
      if (inWord && /[<>]$/.test(w)) { w = w.slice(0, -1); st.i++; sub(); continue; }   // <( … ) 프로세스 치환
      endCmd(); depth++; st.i++; continue;
    }
    if (ch === ')') {
      if (nested && depth === 0) { endCmd(); st.i++; return; }
      endCmd(); if (depth > 0) depth--; st.i++; continue;
    }
    if (ch === '{' || ch === '}') {
      if (ch === '{' && inWord && w.endsWith('$')) {         // ${VAR}
        const e = s.indexOf('}', st.i); const stop = e < 0 ? s.length : e;
        w += s.slice(st.i, stop + 1); st.i = stop + 1; continue;
      }
      if (inWord) { w += ch; st.i++; continue; }
      endCmd(); st.i++; continue;
    }
    if (ch === '#' && !inWord) {                              // 주석
      const e = s.indexOf('\n', st.i); st.i = e < 0 ? s.length : e; continue;
    }
    if (ch === '<' && nx === '<' && s[st.i + 2] !== '<' && mode === 'bash') {   // heredoc
      endWord(); st.i += 2;
      let strip = false; if (s[st.i] === '-') { strip = true; st.i++; }
      while (s[st.i] === ' ' || s[st.i] === '\t') st.i++;
      let delim = '';
      while (st.i < s.length && !/[\s;&|<>()]/.test(s[st.i])) {
        const c = s[st.i];
        if (c === '\'' || c === '"') { const e = s.indexOf(c, st.i + 1); const stop = e < 0 ? s.length : e; delim += s.slice(st.i + 1, stop); st.i = stop + 1; continue; }
        if (c === '\\') { delim += s[st.i + 1] || ''; st.i += 2; continue; }
        delim += c; st.i++;
      }
      if (delim) heredocs.push({ delim, strip });
      continue;
    }
    if (ch === '\'') {
      inWord = true;
      if (mode === 'ps' && w.endsWith('@') && /^\r?\n/.test(s.slice(st.i + 1, st.i + 3))) {   // @' … '@
        w = w.slice(0, -1);
        const e = s.indexOf('\n\'@', st.i); const stop = e < 0 ? s.length : e;
        w += s.slice(st.i + 1, stop); st.i = e < 0 ? s.length : stop + 3; continue;
      }
      st.i++;
      while (st.i < s.length) {
        if (s[st.i] === '\'') {
          if (mode === 'ps' && s[st.i + 1] === '\'') { w += '\''; st.i += 2; continue; }
          st.i++; break;
        }
        w += quotedCh(s[st.i++]);
      }
      continue;
    }
    if (ch === '"') {
      inWord = true;
      if (mode === 'ps' && w.endsWith('@') && /^\r?\n/.test(s.slice(st.i + 1, st.i + 3))) {   // @" … "@
        w = w.slice(0, -1);
        const e = s.indexOf('\n"@', st.i); const stop = e < 0 ? s.length : e;
        w += s.slice(st.i + 1, stop); st.i = e < 0 ? s.length : stop + 3; continue;
      }
      st.i++;
      while (st.i < s.length) {
        const c = s[st.i];
        if (c === '"') {
          if (mode === 'ps' && s[st.i + 1] === '"') { w += '"'; st.i += 2; continue; }
          st.i++; break;
        }
        if (mode === 'bash' && c === '\\' && st.i + 1 < s.length && '"\\$`\n'.includes(s[st.i + 1])) { w += s[st.i + 1]; st.i += 2; continue; }
        if (mode === 'ps' && c === '`' && st.i + 1 < s.length) { w += s[st.i + 1]; st.i += 2; continue; }
        if (c === '$' && s[st.i + 1] === '(') { st.i += 2; sub(); continue; }
        if (mode === 'bash' && c === '`') { st.i++; backtickSub(); continue; }
        w += quotedCh(c); st.i++;
      }
      continue;
    }
    if (ch === '`') {
      if (mode === 'bash') { st.i++; backtickSub(); continue; }
      if (nx === '\n' || (nx === '\r' && s[st.i + 2] === '\n')) { st.i += nx === '\r' ? 3 : 2; continue; }   // 줄 이음
      w += nx || ''; inWord = true; st.i += 2; continue;
    }
    if (ch === '\\' && mode === 'bash') {
      if (nx === '\n') { st.i += 2; continue; }
      if (nx === undefined) { st.i++; continue; }
      w += nx; inWord = true; st.i += 2; continue;
    }
    w += ch; inWord = true; st.i++;
  }
  endCmd();
}

// ─────────────────────────── 판정 ───────────────────────────
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'busybox']);
const PWSH = new Set(['powershell', 'pwsh']);
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'time', 'command', 'builtin', 'exec', 'nice', 'ionice', 'timeout', 'env', 'stdbuf', 'xargs', 'wsl', 'start-process', 'noglob', 'caffeinate']);
const DELETERS = new Set(['rm', 'rmdir', 'rd', 'remove-item', 'ri', 'del', 'erase', 'rimraf']);
const CD = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
// 제어 구문 예약어 — 명령 자리 앞에 붙는다: `if x; then git reset --hard; fi` · `for b in …; do git push …; done`.
//   벗기고 뒤의 명령을 본다(벗기지 않으면 첫 단어가 then/do 라서 통과했다 — 리뷰 M9).
const CONTROL = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '!']);

function prog(word) {
  let b = String(word || '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase();
  return b.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

// 명령 문자열 전체를 본다. 첫 번째 차단 사유를 돌려주거나 null.
//   문법은 하나만 쓴다(도구가 정한다). 두 문법으로 겹쳐 읽으면 한쪽이 다른 쪽의 데이터(heredoc 본문 등)를
//   명령으로 오독해 오탐한다 — 실측: bash `$(cat <<'EOF' … (git push) … EOF)` 를 PowerShell 로 읽으면 걸린다.
// 분석 문맥 — 셸 명령(analyze)과 파일 쓰기 도구(Edit · Write) 검사가 같은 경계를 쓴다
function ctxFor(opts) {
  const cwd = opts.cwd || process.cwd();
  // 작업자 모드의 경계는 처음 cwd 의 worktree 로 고정한다 — [2026-10-17 적대적 검증] `cd <메인 저장소> && rm -rf src` 에서
  //   경계를 cd 뒤의 저장소(메인)로 다시 잡아 메인의 소스 삭제가 "안쪽" 으로 판정됐다.
  // 경계는 하네스 worktree(<메인>/.harness-worktrees/<id>) — [2026-10-19 현장] worktree 안의 하위 git 저장소에서는 repoInfo 가
  //   그 하위 저장소를 돌려줘 worktree 의 다른 부분을 "밖" 으로 봤다. 경로 모양으로 먼저 찾고, 아니면 git 으로.
  const wtm = opts.worker && opts.wtRoot === undefined ? /^(.*?)[\\/]\.harness-worktrees[\\/](t-\d{8}-\d{6}-[0-9a-f]{4}(?:-\d+)?)(?=[\\/]|$)/.exec(cwd) : null;
  const info0 = opts.wtRoot === undefined && opts.worker && !wtm ? C.repoInfo(cwd) : null;
  const wtRoot = opts.wtRoot !== undefined ? opts.wtRoot : wtm ? path.join(wtm[1], '.harness-worktrees', wtm[2]) : (info0 ? info0.root : null);
  // 메인 저장소(공통 .git 의 부모) — 임시 폴더 안에 있어도 그 안은 임시 폴더 예외를 받지 않는다
  const mainRoot = opts.mainRoot !== undefined ? opts.mainRoot : wtm ? wtm[1] : (info0 && path.basename(info0.common).toLowerCase() === '.git' ? path.dirname(info0.common) : null);
  const ctx = { cwd, root: undefined, depth: opts.depth || 0, worker: !!opts.worker, wtRoot, mainRoot, cwdUnknown: !!opts.cwdUnknown, vars: opts.vars || {}, loops: opts.loops || {}, gitReadOnly: !!opts.gitReadOnly };
  return ctx;
}

function analyze(command, opts) {
  const ctx = ctxFor(opts);
  // 지금 폴더를 돌려주는 치환($(pwd) · (Resolve-Path .).Path · (Get-Location).Path · $PWD.Path)은 $PWD 와 같다 — 그때의 cwd 로 푼다
  if (opts.worker) command = String(command).replace(/\$\(\s*pwd\s*\)|`pwd`|\$\(\s*\(\s*(?:Resolve-Path\s+\.|Get-Location)\s*\)\.Path\s*\)|\(\s*(?:Resolve-Path\s+\.|Get-Location)\s*\)\.Path|\$\(\s*Get-Location\s*\)|\$PWD\.Path/gi, '$PWD');
  return analyzeString(command, opts.mode || 'bash', ctx);
}

function analyzeString(src, mode, ctx) {
  if (ctx.depth > 6) return null;
  const cmds = lex(src, mode);
  for (const words of cmds) {
    const r = analyzeCommand(words, mode, ctx);
    if (r) return r;
  }
  return null;
}

// 같은 명령 안의 변수 대입(W=… · $root = … · $wt=…)을 기억한다 — 작업자 모드가 "$W/old" 같은 경로를 풀 수 있게. [2026-10-19 현장 오탐]
//   반복 변수(for d in a b · foreach ($d in 'a','b'))는 값 목록으로 — 경로마다 값을 하나씩 넣어 모두 안쪽이어야 통과한다.
function rememberVar(words0, ctx) {
  const w = words0.filter(x => x !== '');
  if (w[0] === 'for' && w[2] === 'in' && /^[A-Za-z_]\w*$/.test(w[1] || '')) { ctx.loops[w[1].toLowerCase()] = w.slice(3); return false; }
  if (w.length === 3 && w[1] === 'in' && /^\$[A-Za-z_]\w*$/.test(w[0])) { ctx.loops[w[0].slice(1).toLowerCase()] = w[2].split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean); return true; }
  let m = w.length === 1 && /^\$?([A-Za-z_]\w*)=(.*)$/s.exec(w[0]);
  if (!m && w.length === 3 && w[1] === '=' && /^\$[A-Za-z_]\w*$/.test(w[0])) m = [null, w[0].slice(1), w[2]];
  // PowerShell 이어붙이기: $x = A + 'B' · $x=A + 'B'
  if (!m) { const h = /^\$([A-Za-z_]\w*)(?:=(.+))?$/s.exec(w[0] || ''), parts = h && (h[2] != null ? [h[2], ...w.slice(1)] : w[1] === '=' ? w.slice(2) : null);
    if (parts && parts.length >= 3 && parts.length % 2 === 1 && parts.every((x, i) => (i % 2 === 1) === (x === '+'))) m = [null, h[1], parts.filter((_, i) => i % 2 === 0).map(x => expandVars(x.replace(/^["']|["']$/g, ''), ctx)).join('')]; }
  // $x = Join-Path A B · $x=Join-Path A B
  if (!m) { const j = w.length === 5 && w[1] === '=' && /^\$[A-Za-z_]\w*$/.test(w[0]) && /^join-path$/i.test(w[2]) ? [w[0], w[3], w[4]] : w.length === 3 && /^\$[A-Za-z_]\w*=join-path$/i.test(w[0]) ? [w[0].replace(/=.*/, ''), w[1], w[2]] : null;
    if (j) m = [null, j[0].slice(1), `${expandVars(j[1].replace(/^["']|["']$/g, ''), ctx)}${path.sep}${j[2].replace(/^["']|["']$/g, '')}`]; }
  if (!m) return false;
  ctx.vars[m[1].toLowerCase()] = expandVars(String(m[2]).replace(/^["']|["']$/g, ''), ctx);
  return true;
}
// 경로에 반복 변수가 있으면 값마다 넣어 본다 — fn 이 처음 돌려준 사유(없으면 null). 반복 변수가 없으면 undefined.
function eachLoopValue(t, ctx, fn) {
  const names = Object.keys(ctx.loops || {}).filter(n => new RegExp(`\\$\\{?${n}(?![\\w])`, 'i').test(t));
  if (!names.length) return undefined;
  const n = names[0], vals = ctx.loops[n];
  if (!vals.length) return fn(t.replace(new RegExp(`\\$\\{?${n}(?![\\w])`, 'gi'), SUB));
  for (const v of vals) {
    const s = t.replace(new RegExp(`\\$\\{${n}%([^}]*)\\}`, 'gi'), (x, suf) => v.endsWith(suf) ? v.slice(0, -suf.length) : v)
      .replace(new RegExp(`\\$\\{${n}\\}|\\$${n}(?![\\w])`, 'gi'), () => v);
    const r = fn(s); if (r) return r;
  }
  return null;
}
// $NAME · ${NAME} · $env:NAME · %NAME% → 같은 명령에서 정한 값 · 환경 변수(없으면 그대로 — 풀 수 없는 경로로 남는다)
function expandVars(s, ctx) {
  const v = name => { const k = String(name).toLowerCase(); if (ctx && ctx.vars && ctx.vars[k] != null) return ctx.vars[k]; const e = Object.keys(process.env).find(x => x.toLowerCase() === k); return e ? process.env[e] : null; };
  return String(s)
    .replace(/\$env:([A-Za-z_]\w*)/gi, (m, n) => v(n) != null ? v(n) : m)
    .replace(/%([A-Za-z_]\w*)%/g, (m, n) => v(n) != null ? v(n) : m)
    .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => { const n = a || b; if (/^pwd$/i.test(n) && ctx && ctx.cwd) return ctx.cwd; if (/^(home|null)$/i.test(n)) return m; return v(n) != null ? v(n) : m; });
}
function analyzeCommand(words0, mode, ctx) {
  if (ctx.worker && rememberVar(words0, ctx)) return null;
  let words = words0.filter(x => x !== '');
  // 앞의 VAR=값 · 리다이렉션 · 래퍼를 벗긴다.
  for (let guard = 0; guard < 10 && words.length; guard++) {
    const w0 = words[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w0) || /^\d*[<>]/.test(w0) || w0 === '&' || w0 === '.' || CONTROL.has(w0.toLowerCase())) { words = words.slice(1); continue; }
    const p = prog(w0);
    if (WRAPPERS.has(p)) {
      words = words.slice(1);
      while (words.length && (/^-/.test(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || (p === 'timeout' && /^\d/.test(words[0])) || (p === 'sudo' && words[0] === '-u'))) {
        if (['-u', '-n', '-g', '-C', '--user'].includes(words[0]) && p !== 'timeout') words = words.slice(1);
        words = words.slice(1);
      }
      continue;
    }
    break;
  }
  if (!words.length) return null;
  const p = prog(words[0]);
  const args = words.slice(1);

  if (CD.has(p)) {
    const t = args.find(a => !a.startsWith('-'));
    const to = t ? resolveTarget(ctx.cwd, expandVars(String(t).replace(/^["']|["']$/g, ''), ctx)) : null;
    if (to) ctx.cwd = to; else if (t) ctx.cwdUnknown = true;   // 어디로 갔는지 모른다 — 작업자 모드는 그 뒤 상대 경로를 막는다
    ctx.root = undefined;
    return null;
  }
  if (ctx.worker) { const w = checkWorker(p, args, words0, mode, ctx); if (w) return w; }
  const inner = { ...ctx, depth: ctx.depth + 1 };
  if (SHELLS.has(p)) {
    const k = args.findIndex(a => /^-[a-z]*c[a-z]*$/i.test(a) && !a.startsWith('--'));
    if (k >= 0 && args[k + 1] != null) return analyzeString(args[k + 1], 'bash', inner);
    return null;
  }
  if (PWSH.has(p)) {
    const k = args.findIndex(a => /^[-/](c|co|com|comm|comma|comman|command)$/i.test(a));
    if (k >= 0) return analyze(args.slice(k + 1).join(' '), { cwd: ctx.cwd, mode: 'ps', depth: ctx.depth + 1, worker: ctx.worker, wtRoot: ctx.wtRoot, mainRoot: ctx.mainRoot, cwdUnknown: ctx.cwdUnknown, vars: ctx.vars, loops: ctx.loops, gitReadOnly: ctx.gitReadOnly });
    const e = args.findIndex(a => /^[-/](e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedcommand)$/i.test(a));
    if (e >= 0 && args[e + 1]) {
      let decoded = '';
      try { decoded = Buffer.from(args[e + 1], 'base64').toString('utf16le'); } catch { decoded = ''; }
      if (decoded) return analyze(decoded, { cwd: ctx.cwd, mode: 'ps', depth: ctx.depth + 1, worker: ctx.worker, wtRoot: ctx.wtRoot, mainRoot: ctx.mainRoot, cwdUnknown: ctx.cwdUnknown, vars: ctx.vars, loops: ctx.loops, gitReadOnly: ctx.gitReadOnly });
    }
    const f = args.find(a => !a.startsWith('-'));
    if (f && !/\.ps1$/i.test(f)) return analyze(args.filter(a => !/^-/.test(a)).join(' '), { cwd: ctx.cwd, mode: 'ps', depth: ctx.depth + 1, worker: ctx.worker, wtRoot: ctx.wtRoot, mainRoot: ctx.mainRoot, cwdUnknown: ctx.cwdUnknown, vars: ctx.vars, loops: ctx.loops, gitReadOnly: ctx.gitReadOnly });
    return null;
  }
  if (p === 'cmd') {
    const k = args.findIndex(a => /^\/[ck]$/i.test(a));
    if (k >= 0) return analyze(args.slice(k + 1).join(' '), { cwd: ctx.cwd, mode: 'ps', depth: ctx.depth + 1, worker: ctx.worker, wtRoot: ctx.wtRoot, mainRoot: ctx.mainRoot, cwdUnknown: ctx.cwdUnknown, vars: ctx.vars, loops: ctx.loops, gitReadOnly: ctx.gitReadOnly });
    return null;
  }
  if (p === 'eval' || p === 'invoke-expression' || p === 'iex') {
    const body = args.filter(a => !/^-command$/i.test(a)).join(' ');
    return analyzeString(body, mode, inner);
  }
  if (p === 'git') return checkGit(args, ctx);
  if (DELETERS.has(p)) return checkDelete(p, args, mode, ctx);
  if (INLINE_CODE[p]) return checkInlineCode(args, INLINE_CODE[p], inner);
  return null;
}

// ── 인터프리터 한 줄(python -c · node -e …) ──
//   [적대 2026-10-02] `python -c "subprocess.run(['git','push'])"` · `node -e "execSync('git push')"` 는 셸 단어로는 git 이 아니다.
//   코드 안의 문자열 리터럴을 본다: 각 문자열을 셸 명령으로(execSync('git push …') · os.system("…")),
//   그리고 'git' 으로 시작하는 문자열 나열을 git 인자로(['git','push'] · system("git","push")). 문자열 속 단순 언급(print("git push"))도
//   한 줄 코드에서는 막힐 수 있다 — 한 줄 코드는 실행하려고 쓰는 것이므로 오탐보다 우회가 더 비싸다.
const INLINE_CODE = { python: ['-c'], python3: ['-c'], py: ['-c'], node: ['-e', '--eval', '-p', '--print'], deno: ['eval'], bun: ['-e', '--eval'],
  ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'] };
function checkInlineCode(args, flags, ctx) {
  const k = args.findIndex(a => flags.includes(a));
  if (k < 0 || args[k + 1] == null) return null;
  const strs = [];
  const re = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;
  for (let m; (m = re.exec(args[k + 1]));) strs.push((m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]).replace(/\\(.)/g, '$1'));
  for (let i = 0; i < strs.length; i++) {
    if (prog(strs[i]) === 'git') { const r = checkGit(strs.slice(i + 1, i + 9), ctx); if (r) return r; }
    if (/\s/.test(strs[i])) { const r = analyzeString(strs[i], 'bash', ctx); if (r) return r; }
  }
  return null;
}

// ── git ──
const GIT_VALUE_OPTS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--attr-source', '--list-cmds']);
const WHOLE_TREE = new Set(['.', './', '.\\', ':/', ':/.', ':/*', '*', './*', '.\\*', ':(top)', ':(top).', ':(top)*', '-A', ':']);

const REASONS = {
  workerUnresolved: '하네스 작업자는 어디인지 풀 수 없는 경로(변수 · 명령 치환 · 위치를 모르는 cd 뒤의 상대 경로)를 지우거나 쓸 수 없습니다. worktree 안의 구체적인 경로로 적으세요.',
  dockerGlobal: '하네스 작업자는 docker 데몬 전체의 컨테이너 · 이미지 · 볼륨 · 네트워크를 지우거나 멈출 수 없습니다(사용자가 쓰는 서비스일 수 있다). 이 작업의 compose 프로젝트만 docker compose 로 다루세요.',
  workerOwns: '이 작업의 쓰기 소유 경로 밖입니다 — 여러 작업자가 같은 저장소를 동시에 고칠 때 엉키지 않게, 이 작업은 소유 경로 안의 파일만 바꿀 수 있습니다(.harness/<id>/ 와 $TEMP 는 됩니다). 다른 곳이 바뀌어야 하면 DECISIONS.md 에 무엇을 왜 바꿔야 하는지 적으세요.',
  workerGit: '하네스 작업자는 git -C · --git-dir · --work-tree · stash · config 를 읽기로만 쓸 수 있습니다(status · log · diff · show · archive · stash list/show · config --get) — git 상태는 하네스만 바꿉니다.',
  dockerProject: '하네스 작업자는 compose 프로젝트 이름(-p · --project-name)을 바꿀 수 없습니다 — 하네스가 이 작업만의 COMPOSE_PROJECT_NAME 을 줬습니다(메인 체크아웃의 실행 중 컨테이너와 섞이지 않게).',
  outsideWorker: '하네스 작업자는 자기 worktree 밖의 파일 · 폴더를 지우거나 바꿀 수 없습니다(임시 폴더는 된다). worktree 안에서 하세요 — 꼭 필요하면 BLOCKED.md 에 무엇을 왜 해야 하는지 적으세요.',
  // [버그 2026-10-01] AGENTS.md 는 "사용자가 명시한 뒤에만" 이라 적었는데 허락의 길이 없었다 — 좁힌 하네스 명령으로 안내한다.
  push: 'git push 는 직접 실행하지 않습니다. 사용자가 push 를 **명시적으로** 요청했다면 `node harness/cli.js push [<remote>] [<branch>]` 를 쓰세요 — 강제 push 없이 빨리감기만 하고, 원격이 앞서 있으면 거부합니다(실행 때 승인 프롬프트가 뜹니다). 요청이 없었다면 커밋까지만 하고 무엇을 올릴지 보고하세요. 사용자가 직접 올릴 때: 터미널판은 `! git push …`, VS Code 확장은 보기 → 터미널에서 실행합니다.',
  reset: 'git reset --hard 는 미커밋 변경을 되돌릴 수 없게 지웁니다. 커밋을 되돌리려면 `git revert <sha>`, 자기가 고친 파일 하나를 되돌리려면 `git restore -- <file>` 을 쓰세요.',
  clean: 'git clean -f 는 추적 안 된 파일(다른 세션·사람 것 포함)을 지웁니다. `git clean -n` 으로 확인하고, 자기가 만든 파일만 경로를 지정해 지우세요.',
  branch: 'git branch -D 는 병합 안 된 커밋을 잃게 할 수 있습니다. 병합된 브랜치는 `git branch -d`, 하네스 작업 브랜치는 `node harness/cli.js cancel <id>` 로 정리하세요.',
  wholeTree: '작업 트리 전체를 되돌리면 다른 세션·사람의 미커밋 변경까지 사라집니다. 자기가 고친 파일만 경로로 지정하세요: `git restore -- <file>`.',
  force: '강제 checkout/switch 는 미커밋 변경을 버립니다. 먼저 자기 변경을 커밋하고, 강제 옵션 없이 전환하세요.',
  rebase: 'git rebase 는 히스토리를 다시 씁니다. 브랜치 통합은 하네스가 합니다 — 사용자가 받아들인다고 말한 뒤 `node harness/cli.js accept <id>`. (진행 중인 rebase 를 끝내거나 되돌리는 `--continue` · `--skip` · `--abort` · `--quit` 는 통과합니다.)',
  // `--ff-only` 도 막는다: 되감기 병합도 사용자 브랜치를 움직인다. accept 는 `--no-ff` 한 커밋으로 병합하고 작업 기록에 남겨
  //   `cancel` 로 revert 할 수 있다 — 직접 병합(ff 포함)은 그 기록이 없어 되돌릴 근거가 없다.
  merge: '병합은 직접 하지 않습니다(`--ff-only` 포함 — 되감기 병합도 사용자 브랜치를 움직이고, 하네스 기록이 없어 `cancel` 로 되돌릴 수 없습니다). 사용자가 받아들인다고 말한 뒤 `node harness/cli.js accept <id>` 로 합니다(`--no-ff` 한 커밋, `cancel` 로 되돌릴 수 있음). 진행 중인 병합은 `git merge --continue` · `--abort` · `--quit` 로 끝내세요.',
  stash: 'git stash 는 같은 체크아웃의 다른 세션·사람의 미커밋 변경까지 숨기거나(push · save · -u) 섞고(pop · apply) 지웁니다(drop · clear). 자기 파일은 경로를 지정해 커밋하세요. 보기만 하려면 `git stash list` · `git stash show`.',
  pull: 'git pull 은 원격 변경을 사용자 브랜치에 병합/리베이스합니다. `git fetch` 로 가져와 보기만 하고, 통합은 사용자가 직접 합니다.',
  amend: 'git commit --amend 는 이미 있는 커밋(다른 세션·사람 것일 수 있음)을 다시 씁니다. 새 커밋을 만드세요: `git commit -m "<무엇을 왜>" -- <파일들>`.',
  resetMove: 'git reset <커밋> 은 브랜치를 옮겨 커밋을 히스토리에서 떼어 냅니다(--soft/--mixed/--keep 포함). 커밋을 되돌리려면 `git revert <sha>`, 스테이징만 풀려면 `git restore --staged -- <file>`.',
  branchMove: '브랜치를 강제로 옮기거나 덮어쓰는 명령입니다(branch -f/-M/-C · checkout -B · switch -C · update-ref) — 원래 가리키던 커밋을 잃습니다. 새 이름으로 브랜치를 만드세요(`git switch -c <새 이름>`).',
  gitRm: 'git rm -r 로 작업 트리 전체를 지우면 다른 세션·사람의 파일까지 사라집니다. 지울 파일을 경로로 지정하세요(색인에서만 빼려면 `--cached`).',
  worktree: '강제 worktree 제거는 그 안의 미커밋 변경을 지웁니다. 하네스 작업은 `node harness/cli.js cancel <id>` / `gc` 로 정리하세요.',
  delete: '저장소 루트 · 홈 · 드라이브 루트(또는 그 상위) · .git 을 재귀 삭제하는 명령입니다. 지울 파일·폴더를 구체적인 하위 경로로 지정하세요.',
  unresolved: '재귀 삭제 대상이 변수나 명령 치환이라 무엇이 지워질지 알 수 없습니다(저장소 루트 · 홈일 수 있음). 지울 폴더를 구체적인 경로로 적으세요.',
};

// git 이 직접 아는 하위 명령 — 별칭은 이것들을 가리지 못한다(git 규칙). 이 밖의 이름은 별칭인지 본다.
const GIT_BUILTINS = new Set(['add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-ignore', 'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit',
  'config', 'describe', 'diff', 'difftool', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base',
  'mergetool', 'mv', 'notes', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog',
  'show', 'show-ref', 'sparse-checkout', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'version', 'whatchanged', 'worktree']);

function checkGit(args, ctx) {
  let i = 0, gitCwd = ctx.cwd;
  const cliAliases = {};
  while (i < args.length) {
    const a = args[i];
    if (a === '-C') { gitCwd = resolveTarget(gitCwd, args[i + 1] || '.') || gitCwd; i += 2; continue; }
    if (a === '-c') { const m = /^alias\.([^=]+)=([\s\S]*)$/i.exec(args[i + 1] || ''); if (m) cliAliases[m[1].toLowerCase()] = m[2]; i += 2; continue; }
    if (GIT_VALUE_OPTS.has(a)) { i += 2; continue; }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  const sub = (args[i] || '').toLowerCase();
  const rest = args.slice(i + 1);
  if (!sub) return null;
  if (rest.includes('--help') || rest.includes('-h')) return null;
  // [적대 2026-10-02] 별칭(`git -c alias.p=push p` · 저장소/전역 설정의 alias.yeet=push)은 펼쳐서 다시 본다. `!` 별칭은 셸 명령이다.
  if (!GIT_BUILTINS.has(sub) && (ctx.depth || 0) < 6) {
    let val = cliAliases[sub];
    if (val == null) { const r = C.git(gitCwd, ['config', '--get', `alias.${sub}`]); if (r.status === 0) val = r.stdout.replace(/\r?\n$/, ''); }
    if (val != null && val.trim()) {
      const inner = { ...ctx, cwd: gitCwd, depth: (ctx.depth || 0) + 1 };
      if (val.trim().startsWith('!')) return analyzeString(`${val.trim().slice(1)} ${rest.map(x => JSON.stringify(x)).join(' ')}`, 'bash', inner);
      const words = (lex(val, 'bash')[0] || []);
      return checkGit([...words, ...rest], inner);
    }
  }
  const flags = shortFlags(rest);
  const has = (...names) => rest.some(r => names.includes(r));

  switch (sub) {
    case 'push':
      if (has('--dry-run', '-n') || flags.has('n')) return null;
      return REASONS.push;
    case 'pull':
      return REASONS.pull;
    case 'reset':
      return checkReset(rest, gitCwd);
    case 'update-ref':
      return REASONS.branchMove;
    case 'clean':
      if (has('--dry-run') || flags.has('n')) return null;
      return (has('--force') || flags.has('f')) ? REASONS.clean : null;
    case 'branch': {
      const del = flags.has('d') || has('--delete');
      const force = flags.has('f') || has('--force');
      if (flags.has('D') || (del && force)) return REASONS.branch;
      return (force || flags.has('M') || flags.has('C')) ? REASONS.branchMove : null;
    }
    case 'checkout': {
      if (has('--force') || flags.has('f')) return REASONS.force;
      if (flags.has('B')) return REASONS.branchMove;
      const specs = pathspecs(rest, new Set(['-b', '-B', '--orphan', '--conflict', '-t', '--track']));
      return specs.some(x => isWholeTree(x, gitCwd, ctx)) ? REASONS.wholeTree : null;
    }
    case 'switch':
      if (has('--discard-changes', '--force') || flags.has('f')) return REASONS.force;
      return (has('--force-create') || flags.has('C')) ? REASONS.branchMove : null;
    case 'restore': {
      // --staged 만(작업 트리 · 원본 지정 없이)이면 색인만 푼다 — 파일 내용은 그대로라 되돌릴 수 없는 일이 아니다.
      const staged = has('--staged') || flags.has('S');
      const worktree = has('--worktree') || flags.has('W');
      const source = has('--source') || flags.has('s') || rest.some(r => r.startsWith('--source='));
      if (staged && !worktree && !source) return null;
      const specs = pathspecs(rest, new Set(['-s', '--source', '--pathspec-from-file', '--conflict']));
      return specs.some(x => isWholeTree(x, gitCwd, ctx)) ? REASONS.wholeTree : null;
    }
    case 'rebase':
      // 진행 중인 rebase 를 끝내거나 되돌리는 것은 통과 — 막으면 멈춘 rebase 에 갇힌다.
      return has('--abort', '--continue', '--skip', '--quit') ? null : REASONS.rebase;
    case 'merge':
      // 진행 중인 병합을 끝내거나 되돌리는 것만 통과. `--ff-only` 는 막는다(이유는 REASONS.merge).
      return has('--abort', '--continue', '--quit') ? null : REASONS.merge;
    case 'stash':
      return ['list', 'show'].includes((rest[0] || '').toLowerCase()) ? null : REASONS.stash;
    case 'rm': {
      if (has('--cached', '--dry-run') || flags.has('n')) return null;
      if (!flags.has('r')) return null;
      const specs = pathspecs(rest, new Set(['--pathspec-from-file']));
      return specs.some(x => isWholeTree(x, gitCwd, ctx)) ? REASONS.gitRm : null;
    }
    case 'worktree':
      return ((rest[0] || '').toLowerCase() === 'remove' && (has('--force') || flags.has('f'))) ? REASONS.worktree : null;
    case 'add':
      return checkAddSecrets(rest, gitCwd);
    case 'commit':
      if (has('--amend')) return REASONS.amend;
      return checkCommitSecrets(rest, gitCwd, flags);
    default:
      return null;
  }
}

// reset: --hard 는 언제나 막는다. 그 밖(--soft · --mixed · --keep · --merge · 모드 없음)은 브랜치를 옮길 때만 막는다 —
//   경로를 지정한 reset(`git reset -- f` · `git reset HEAD~1 -- f`)과 인자 없는 reset 은 색인만 바꾼다.
function checkReset(rest, gitCwd) {
  if (rest.includes('--hard')) return REASONS.reset;
  if (rest.some(r => r === '-p' || r === '--patch' || r === '--pathspec-from-file' || r.startsWith('--pathspec-from-file='))) return null;
  const k = rest.indexOf('--');
  const before = k >= 0 ? rest.slice(0, k) : rest;
  const after = k >= 0 ? rest.slice(k + 1) : [];
  const pos = before.filter(r => !r.startsWith('-'));
  if (!pos.length || after.length || pos.length > 1) return null;
  const cand = pos[0];
  if (k < 0) { try { if (fs.existsSync(path.resolve(gitCwd, cand))) return null; } catch { /* 경로가 아니다 */ } }
  return movesHead(gitCwd, cand) ? REASONS.resetMove : null;
}

// cand 가 HEAD 와 다른 커밋인가. 풀 수 없으면(저장소 밖 · 없는 이름) 커밋처럼 생긴 이름일 때만 그렇다고 본다(fail-closed).
function movesHead(gitCwd, cand) {
  const c = C.git(gitCwd, ['rev-parse', '-q', '--verify', cand + '^{commit}']);
  if (c.status === 0) {
    const h = C.git(gitCwd, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
    return !(h.status === 0 && h.stdout.trim() === c.stdout.trim());
  }
  return /[~^@]/.test(cand) || /^[0-9a-f]{7,40}$/i.test(cand) || /^(ORIG_HEAD|FETCH_HEAD|MERGE_HEAD)$/.test(cand);
}

function shortFlags(rest) {
  const s = new Set();
  for (const r of rest) { if (r === '--') break; if (/^-[A-Za-z]+$/.test(r)) for (const c of r.slice(1)) s.add(c); }
  return s;
}

function pathspecs(rest, valueOpts) {
  const k = rest.indexOf('--');
  if (k >= 0) return rest.slice(k + 1);
  const out = [];
  for (let j = 0; j < rest.length; j++) {
    const r = rest[j];
    if (valueOpts.has(r)) { j++; continue; }
    if (r.startsWith('-')) continue;
    out.push(r);
  }
  return out;
}

function isWholeTree(spec, gitCwd, ctx) {
  const s = String(spec).trim();
  if (WHOLE_TREE.has(s)) return true;
  if (/^[.\\/]+$/.test(s) || /^:\/?$/.test(s)) return true;
  if (/[*?]/.test(s) && !/[A-Za-z0-9_]/.test(s.replace(/^:\(top\)|^:\//, ''))) return true;
  // `..` 처럼 저장소 루트나 그 위를 가리키는 경로.
  const abs = resolveTarget(gitCwd, s);
  const root = repoRootOf(gitCwd, ctx);
  return !!(abs && root && (C.samePath(abs, root) || isAncestor(abs, root)));
}

// 비밀 파일이 스테이징될 참인가 — 이름으로 직접 지정했거나, 넓은 add(. · -A · 디렉터리)가 쓸어 담을 때.
function checkAddSecrets(rest, gitCwd) {
  if (rest.includes('--dry-run') || shortFlags(rest).has('n')) return null;
  const specs = pathspecs(rest, new Set(['--chmod', '--pathspec-from-file']));
  const named = specs.filter(C.isSecretPath);
  if (named.length) return secretReason('스테이징', named);
  const broad = rest.some(r => ['-A', '--all', '-u', '--update'].includes(r)) || shortFlags(rest).has('A') || shortFlags(rest).has('u');
  if (!specs.length && !broad) return null;
  const st = C.git(gitCwd, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...(specs.length ? specs : [':/'])]);
  if (st.status !== 0) return null;
  const hits = st.stdout.split('\0').filter(e => e.length > 3).map(e => e.slice(3)).filter(C.isSecretPath);
  return hits.length ? secretReason('스테이징', hits) : null;
}

function checkCommitSecrets(rest, gitCwd, flags) {
  const found = new Set();
  const staged = C.git(gitCwd, ['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '-z']);
  if (staged.status === 0) staged.stdout.split('\0').filter(C.isSecretPath).forEach(f => found.add(f));
  if (flags.has('a') || rest.includes('--all')) {
    const mod = C.git(gitCwd, ['-c', 'core.quotepath=false', 'diff', '--name-only', '-z']);
    if (mod.status === 0) mod.stdout.split('\0').filter(C.isSecretPath).forEach(f => found.add(f));
  }
  const k = rest.indexOf('--');
  if (k >= 0) rest.slice(k + 1).filter(C.isSecretPath).forEach(f => found.add(f));
  return found.size ? secretReason('커밋', [...found]) : null;
}

function secretReason(what, files) {
  return `비밀 파일로 보이는 ${C.listForReason(files, 10)} 을(를) ${what}하려 합니다. 이 파일은 빼고 필요한 파일만 경로로 지정해 add 하세요(비밀 파일은 .gitignore 에 추가). 이미 스테이징했다면 \`git restore --staged -- <file>\`.`;
}

// ── 삭제 ──
// 작업자 모드(--worker): 자기 worktree 밖의 파일 · 폴더는 지우지 못한다. [2026-10-16 실측] 허용 목록을 걷어 낸(open) 작업자가
//   저장소 밖 폴더를 rm -rf 로 지웠다 — 대화형 guard 는 위험한 대상(루트 · 홈 · 저장소 · .git)만 막는다.
//   [2026-10-17 적대적 검증] 경계는 처음 worktree(ctx.wtRoot) — cd 로 옮겨 다녀도 바뀌지 않는다. 풀 수 없는 경로(변수 · cd 뒤 상대 경로)는 막는다.
//   allowTmp: 임시 폴더(os.tmpdir · TEMP · TMP · TMPDIR)는 쓰고 지워도 된다.
const tmpRoots = () => [os.tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR].filter(Boolean).map(t => C.real(path.resolve(t)));
function workerTarget(t0, mode, ctx, allowTmp) {
  let t = String(t0).trim().replace(/^["']|["']$/g, '');
  if (!t || /^(\/dev\/null|nul|\$null)$/i.test(t)) return null;
  t = t.replace(/^\$\{?PWD\}?(?=$|[\\/])/i, () => ctx.cwd);
  const lv = eachLoopValue(t, ctx, s => workerTarget(s, mode, ctx, allowTmp)); if (lv !== undefined) return lv;
  t = expandVars(t, ctx);   // 변수 값의 \ 도 함께 바꾸도록 푼 뒤에 — [2026-10-19 CI macOS]
  if (mode === 'ps' && !C.IS_WIN) t = t.replace(/\\/g, '/');
  // Git Bash 의 /tmp 는 사용자 임시 폴더다(C:\tmp 가 아니다) — 임시 폴더로 바꿔 같은 검사를 거친다(메인 저장소 예외 · ../ 포함).
  //   POSIX 의 /tmp 는 실제 경로 그대로 본다. [2026-10-19 CI Linux] 그대로 통과시키니 /tmp 아래의 모든 것이 통과했다.
  if (C.IS_WIN && /^\/tmp(\/|$)/.test(t)) t = path.join(os.tmpdir(), t.slice(4));
  const relative = !path.isAbsolute(expandHome(t)) && !/^[a-zA-Z]:/.test(t) && !/^\//.test(t);
  if (relative && ctx.cwdUnknown) return `${REASONS.workerUnresolved} (대상: ${t})`;
  const abs = resolveTarget(ctx.cwd, t);
  if (!abs) return `${REASONS.workerUnresolved} (대상: ${t.replace(new RegExp(SUB, 'g'), '$(…)')})`;
  const root = ctx.wtRoot || repoRootOf(ctx.cwd, ctx);
  if (!root) return null;
  const norm = C.real(abs);
  if (C.samePath(norm, root) || isAncestor(root, norm)) return ownsCheck(root, norm, t, ctx);
  const inMain = ctx.mainRoot && (C.samePath(norm, C.real(ctx.mainRoot)) || isAncestor(C.real(ctx.mainRoot), norm));
  if (allowTmp && !inMain && tmpRoots().some(r => C.samePath(norm, r) || isAncestor(r, norm))) return null;
  // [2026-10-21 사용 분석] 작업자가 시스템 임시 폴더 아무 곳(…\Temp\x.py)에 쓰다 막혀 같은 시도를 되풀이했다 — 쓸 수 있는 임시 폴더를 알려 준다
  const tmpHint = allowTmp && process.env.TEMP ? ` 임시 파일은 이 작업의 임시 폴더에: ${process.env.TEMP}` : '';
  return `${REASONS.outsideWorker} (대상: ${t})${tmpHint}`;
}
// 쓰기 소유권(PRD R3) — 작업에 소유 경로(HARNESS_OWNS: glob 의 JSON 배열)가 있으면 worktree 안이라도 그 밖은 쓰지도 지우지도 못한다.
//   [2026-10-20] 여러 작업자가 한 저장소를 동시에 고칠 때 엉키지 않게 하는 첫 벽. 하네스 기록(.harness/<id>/)은 언제나 된다.
//   glob: ** = 아무 깊이 · * = 한 단계 안 · ? = 한 글자 · 글자만 있으면 그 파일이나 그 폴더 아래 전부. Windows 는 대소문자 무시.
function ownedGlobs() {
  const raw = process.env.HARNESS_OWNS;
  if (!raw) return null;
  try { const a = JSON.parse(raw); return Array.isArray(a) && a.length ? a.map(String) : null; } catch { return null; }
}
function globRe(g) {
  const p = String(g).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/[*?]/.test(p)) return new RegExp(`^${p.replace(/[.+^${}()|[\]]/g, '\\$&')}(/.*)?$`, C.IS_WIN ? 'i' : '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') { re += p[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += p[i + 2] === '/' ? 2 : 1; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, C.IS_WIN ? 'i' : '');
}
function owned(rel, globs) { return globs.some(g => globRe(g).test(rel)); }
function ownsCheck(root, norm, t, ctx) {
  const globs = ctx.owns !== undefined ? ctx.owns : ownedGlobs();
  if (!globs) return null;
  const rel = path.relative(C.real(root), norm).replace(/\\/g, '/');
  if (rel === '') return `${REASONS.workerOwns} (대상: worktree 전체)`;
  if (/^\.harness(\/|$)/.test(rel) || owned(rel, globs) || gitIgnored(root, rel)) return null;
  return `${REASONS.workerOwns} (대상: ${rel} · 소유: ${globs.join(', ')})`;
}
// [2026-10-25 사용 분석 · C++ 저장소] git 이 무시하는 곳(build/ 같은 산출물)은 worktree 마다 따로라 다른 작업자와 엉키지 않는다 —
//   소유 경로로 막으니 카드 작업자가 자기 빌드 폴더를 지우고 다시 만들지 못해 우회했다. 추적되는 파일은 무시 규칙에 걸려도 막는다(check-ignore 기본).
function gitIgnored(root, rel) {
  try { return require('node:child_process').spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, windowsHide: true, timeout: 5000 }).status === 0; } catch { return false; }
}
// 파일 쓰기 도구(Edit · Write · MultiEdit · NotebookEdit) — 셸 명령과 같은 경계(worktree · 소유 경로)
function checkFileWrite(file, cwd, owns) {
  const ctx = ctxFor({ cwd, worker: true });
  if (owns !== undefined) ctx.owns = owns;
  return workerTarget(String(file), 'bash', ctx, true);
}

function outsideWorktree(targets, mode, ctx) {
  for (const t of targets) { const r = workerTarget(t, mode, ctx, true); if (r) return r; }
  return null;
}
// 작업자 모드에서만 보는 것 — 삭제 말고도 worktree 밖을 바꾸는 길: 리다이렉션 · 쓰기 cmdlet · cp/mv · robocopy · find -delete ·
//   한 줄 코드 속 삭제/쓰기 경로 · docker 데몬 전체를 바꾸는 명령(자동 보고 caed67b9a2f1 와 같은 계열).
const WRITE_CMDLETS = new Set(['set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc', 'out-file', 'tee', 'tee-object', 'new-item', 'ni']);
const COPY_MOVE = new Set(['cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename-item', 'rni', 'xcopy']);
const valueOf = (args, names) => { const k = args.findIndex(a => names.test(a)); return k >= 0 && args[k + 1] != null ? args[k + 1] : null; };
// Windows 식 옵션(/Y · /MIR · /XD:…) — '/' 뒤에 영문자만 오고 다른 '/' 가 없다. POSIX 절대 경로(/tmp/x)를 옵션으로 버리지 않게.
const WIN_OPT = /^\/[A-Za-z]+(:[^/]*)?$/;
const positionals = args => { const out = []; for (let i = 0; i < args.length; i++) { const a = args[i]; if (/^-/.test(a) || (WIN_OPT.test(a) && a.length <= 6)) { if (/^-(path|literalpath|lp|destination|filepath|value|encoding|itemtype|name|filter|include|exclude)$/i.test(a)) i++; continue; } out.push(a); } return out; };
function checkWorker(p, args, words0, mode, ctx) {
  // 리다이렉션: `> 파일` · `>>파일` · 붙여 쓴 `x>>/c/k.txt`
  for (let i = 0; i < words0.length; i++) {
    const w = String(words0[i]);
    if (/\s/.test(w)) continue;
    const m = /^(?:\d*|&)>>?(.*)$/.exec(w) || /^[^<>]*?\d*>>?(.+)$/.exec(w);
    if (!m) continue;
    const target = m[1] || words0[i + 1];
    if (!target || /^&/.test(target)) continue;
    const r = workerTarget(target, mode, ctx, true); if (r) return r;
  }
  if (WRITE_CMDLETS.has(p)) {
    const t = valueOf(args, /^-(path|literalpath|lp|filepath)$/i) || positionals(args)[0];
    if (t) { const r = workerTarget(t, mode, ctx, true); if (r) return r; }
  }
  if (COPY_MOVE.has(p)) {
    const pos = positionals(args), dest = valueOf(args, /^-destination$/i) || (pos.length > 1 ? pos[pos.length - 1] : null);
    const srcs = valueOf(args, /^-(path|literalpath|lp)$/i) ? [valueOf(args, /^-(path|literalpath|lp)$/i)] : (pos.length > 1 ? pos.slice(0, -1) : pos);
    const moving = /^(mv|move|move-item|mi|ren|rename-item|rni)$/.test(p);
    for (const t of [...(dest ? [dest] : []), ...(moving ? srcs : [])]) { const r = workerTarget(t, mode, ctx, true); if (r) return r; }
  }
  if (p === 'robocopy') {
    const pos = args.filter(a => !WIN_OPT.test(a));   // /MIR · /XD … 만 옵션 — POSIX 절대 경로(/tmp/…)는 경로다(CI 실측)
    const moving = args.some(a => /^\/(mov|move)$/i.test(a));
    for (const t of [pos[1], ...(moving ? [pos[0]] : [])].filter(Boolean)) { const r = workerTarget(t, mode, ctx, true); if (r) return r; }
  }
  if (p === 'find' && args.some((a, i) => a === '-delete' || (/^-(exec|execdir|ok|okdir)$/.test(a) && /^(rm|rmdir|unlink|del|shred)$/.test(prog(args[i + 1] || ''))))) {
    for (const t of args.slice(0, Math.max(0, args.findIndex(a => /^[-(!]/.test(a))))) { const r = workerTarget(t, mode, ctx, true); if (r) return r; }
  }
  if (INLINE_CODE[p]) {
    const k = args.findIndex(a => INLINE_CODE[p].includes(a)), code = k >= 0 ? String(args[k + 1] || '') : '';
    if (/rmSync|rmdirSync|unlinkSync|rimraf|\brm\(|rmtree|os\.remove|os\.unlink|os\.rmdir|\.unlink\(|writeFileSync|appendFileSync|renameSync|shutil\.move|open\([^)]*['"][wa]/.test(code)) {
      for (const m of code.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g)) {
        const s = (m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]).replace(/\\(.)/g, '$1');
        // '/api/ha/status' 같은 URL 경로는 파일이 아니다 — '/' 로 시작하면 맨 위 폴더가 실제로 있을 때만 경로로 본다(2026-10-19 현장 오탐)
        if (/^\/[^/]/.test(s) && !/^\/tmp(\/|$)/.test(s)) { const top = resolveTarget(ctx.cwd, `/${s.split('/')[1]}`); if (!top || !fs.existsSync(top)) continue; }
        if (/^([a-zA-Z]:[\\/]|\/|~|\.\.)/.test(s)) { const r = workerTarget(s, mode, ctx, true); if (r) return r; }
      }
    }
  }
  if (p === 'git') { const r = workerGit(args, mode, ctx); if (r) return r; }
  if (p === 'docker' || p === 'docker-compose') {
    const sub = args.find(a => !a.startsWith('-')) || '';
    const compose = p === 'docker-compose' || sub === 'compose';
    // -p 는 하네스가 준 이름($COMPOSE_PROJECT_NAME)일 때만 — 다른 이름은 메인 체크아웃의 컨테이너를 덮어쓸 수 있다
    const pi = args.findIndex(a => /^(-p|--project-name)(=|$)/.test(a));
    const pv = pi < 0 ? null : (/=/.test(args[pi]) ? args[pi].replace(/^[^=]*=/, '') : String(args[pi + 1] || '')).replace(/^["']|["']$/g, '');
    if (compose && pi >= 0 && !(/^\$\{?COMPOSE_PROJECT_NAME\}?$|^\$env:COMPOSE_PROJECT_NAME$/i.test(pv) || (process.env.COMPOSE_PROJECT_NAME && pv === process.env.COMPOSE_PROJECT_NAME))) return REASONS.dockerProject;
    // 지우거나 멈추는 것만 — docker images · network ls · ps 같은 읽기는 그대로(2026-10-19 현장 오탐)
    const k = args.indexOf(sub), act = (args.slice(k + 1).find(a => !a.startsWith('-')) || '').toLowerCase();
    if (!compose && (/^(rm|rmi|stop|kill|restart|pause|prune)$/i.test(sub) || (/^(container|volume|network|image|system|builder)$/i.test(sub) && /^(rm|remove|prune|stop|kill|restart|pause|delete|disconnect)$/.test(act)))) {
      // [2026-10-21 사용 분석 · 재생 검증] 지시문은 "docker run 으로 띄운 것은 $COMPOSE_PROJECT_NAME 접두어로 이름 짓고 끝나면 지워라" 인데 여기서 막혀 모순이었다.
      //   대상 이름이 모두 이 작업의 접두어($COMPOSE_PROJECT_NAME · $HARNESS_DATA_NS — 값이든 변수 표기든)로 시작하면 통과. prune · system 은 언제나 전역이라 막는다.
      if (/^(prune|system|builder)$/i.test(sub) || act === 'prune') return REASONS.dockerGlobal;
      const rest = args.slice(/^(container|volume|network|image)$/i.test(sub) ? args.indexOf(act, k + 1) + 1 : k + 1);
      const names = []; for (let i = 0; i < rest.length; i++) { const a = rest[i]; if (/^(-t|--time|-s|--signal)$/i.test(a)) { i++; continue; } if (a.startsWith('-')) continue; names.push(String(a).replace(/^["']|["']$/g, '')); }
      const prefixes = ['COMPOSE_PROJECT_NAME', 'HARNESS_DATA_NS'].flatMap(v => [`$${v}`, `\${${v}}`, `$env:${v}`, ...(process.env[v] ? [process.env[v]] : [])]);
      const ours = n => prefixes.some(pf => n.toLowerCase().startsWith(pf.toLowerCase()));
      if (!names.length || !names.every(ours)) return REASONS.dockerGlobal;
    }
  }
  return null;
}
// 작업자 모드의 git -C · --git-dir · --work-tree · stash · config — 권한 deny 대신 여기서 읽기 형태만 통과시킨다(policy.GUARD_GIT).
//   그 밖의 git 쓰기(commit · reset · checkout …)는 권한 deny 가 그대로 막는다.
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'describe', 'cat-file', 'shortlog',
  'archive', 'rev-list', 'for-each-ref', 'merge-base', 'ls-remote', 'name-rev', 'check-ignore', 'count-objects', 'show-ref', 'cherry', 'range-diff', 'whatchanged', 'version', 'help']);
function workerGit(args, mode, ctx) {
  let i = 0, scoped = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') { scoped = true; i++; continue; }
    if (/^--(git-dir|work-tree)=/.test(a)) { scoped = true; continue; }
    if (a === '-c' || a === '--namespace') { i++; continue; }
    if (/^-/.test(a)) continue;
    break;
  }
  const sub = String(args[i] || '').toLowerCase(), rest = args.slice(i + 1);
  if (sub === 'stash') return /^(list|show)$/.test(rest[0] || '') ? null : REASONS.workerGit;
  if (sub === 'config') {
    if (rest.some(a => /^(--(unset|unset-all|add|replace-all|rename-section|remove-section|edit)|-e)$/.test(a))) return REASONS.workerGit;
    return rest.some(a => /^(--get(-all|-regexp|-urlmatch)?|--list|-l)$/.test(a)) || rest.filter(a => !/^-/.test(a)).length <= 1 ? null : REASONS.workerGit;
  }
  if (!scoped && !ctx.gitReadOnly) return null;   // Monitor 명령에는 권한의 git deny 접두가 붙지 않는다 — 거기서는 모든 git 을 읽기만
  if (sub === 'apply' && rest.some(a => /^--(check|stat|numstat|summary)$/.test(a)) && !rest.some(a => /^--(index|cached|3way)$/.test(a))) return null;
  // 목록 · 현재 이름만(branch --show-current · branch -a · remote -v · tag -l) — 만들기 · 지우기 · 이름 바꾸기는 아니다
  if ((sub === 'branch' || sub === 'tag' || sub === 'remote') && (rest.length === 0 || rest.every(a => /^(--show-current|--list|-l|-a|--all|-r|--remotes|-v|-vv|--verbose|--contains|--merged|--no-merged|--sort=.*|--format=.*|--points-at)$/.test(a) || (!/^-/.test(a) && rest.some(b => /^(--list|-l|--contains|--merged|--no-merged|--points-at)$/.test(b)))))) return null;
  if (!GIT_READ.has(sub)) return REASONS.workerGit;
  if (sub === 'archive') { const o = valueOf(rest, /^(-o|--output)$/) || (rest.find(a => /^--output=/.test(a)) || '').replace(/^--output=/, ''); if (o) return workerTarget(o, mode, ctx, true); }
  return null;
}
function checkDelete(p, args, mode, ctx) {
  let recursive = p === 'rimraf';
  const targets = [];
  let endOpts = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && /^\/[sS]$/.test(a) && ['rmdir', 'rd', 'del', 'erase'].includes(p)) { recursive = true; continue; }
    if (!endOpts && /^\/[a-zA-Z]$/.test(a) && ['rmdir', 'rd', 'del', 'erase'].includes(p)) continue;
    if (!endOpts && /^--?r(e(c(u(r(s(e|ive)?)?)?)?)?)?$/i.test(a)) { recursive = true; continue; }
    if (!endOpts && /^-[a-zA-Z]+$/.test(a) && a.length <= 4 && /[rR]/.test(a) && !/^-(path|literalpath|filter|include|exclude)$/i.test(a)) { recursive = true; continue; }
    if (!endOpts && /^-(path|literalpath|lp|filter|include|exclude)$/i.test(a)) { if (/^-(path|literalpath|lp)$/i.test(a) && args[j + 1] != null) targets.push(args[++j]); else j++; continue; }
    if (!endOpts && a.startsWith('-')) continue;
    for (const t of a.split(',')) if (t) targets.push(t);
  }
  if (ctx.worker) { const o = outsideWorktree(targets, mode, ctx); if (o) return o; }
  // PowerShell 의 rm/rmdir/Remove-Item 은 폴더에 -Recurse 가 없으면 확인을 묻는다 — 재귀 삭제가 아니다.
  if (!recursive) return null;
  for (const t0 of targets) {
    const t = mode === 'ps' && !C.IS_WIN ? t0.replace(/\\/g, '/') : t0;
    const d = isDangerousTarget(t, ctx);
    if (d) return (d === 'unresolved' ? REASONS.unresolved : REASONS.delete) + ` (대상: ${t.replace(new RegExp(SUB, 'g'), '$(…)')})`;
  }
  return null;
}

// 풀 수 없는 대상(변수 · 명령 치환)은 fail-closed: 마지막 경로 조각이 구체적인 이름일 때만 통과한다.
//   `"$TMPDIR/build"` 통과 · `"$X"` · `$X/*` · `${ROOT}/..` · `$(git rev-parse --show-toplevel)` 차단.
function unresolvedIsDangerous(s) {
  const last = String(s).split(/[\\/]+/).filter(Boolean).pop();
  if (!last) return true;
  if (last.includes(SUB) || last.includes('$') || /%[^%]+%/.test(last)) return true;
  return /^[.*?]+$/.test(last);
}

function expandHome(t) {
  const home = os.homedir();
  let s = String(t).trim();
  s = s.replace(/^~(?=$|[\\/])/, home)
    .replace(/^\$\{?HOME\}?(?=$|[\\/])/i, home)
    .replace(/^\$env:(USERPROFILE|HOME)(?=$|[\\/])/i, home)
    .replace(/^%(USERPROFILE|HOME)%(?=$|[\\/])/i, home)
    .replace(/^\$env:(SystemDrive)(?=$|[\\/])/i, (process.env.SystemDrive || 'C:') + '\\')
    .replace(/^%SystemDrive%(?=$|[\\/])/i, (process.env.SystemDrive || 'C:') + '\\');
  return s;
}

function resolveTarget(cwd, t) {
  let s = expandHome(t);
  if (!s || s.includes(SUB)) return null;
  if (/^\$/.test(s) || /%[^%]+%/.test(s)) return null;           // 알 수 없는 변수
  if (C.IS_WIN) {
    const m = /^\/(?:mnt\/)?([a-zA-Z])(\/|$)(.*)$/.exec(s);     // Git Bash /c/…
    if (m) s = `${m[1].toUpperCase()}:\\${m[3] || ''}`;
    if (/^[a-zA-Z]:$/.test(s)) s += '\\';
  }
  try { return path.resolve(cwd, s); } catch { return null; }
}

function isAncestor(a, b) {           // a 가 b 의 (엄격한) 상위인가
  const rel = path.relative(C.real(a), C.real(b));   // 실경로로(심볼릭 링크 · 짧은 이름)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function repoRootOf(cwd, ctx) {
  if (ctx && ctx.root !== undefined && ctx.rootFor === cwd) return ctx.root;
  const info = C.repoInfo(cwd);
  const roots = [];
  if (info) {
    roots.push(info.root);
    if (path.basename(info.common).toLowerCase() === '.git') roots.push(path.dirname(info.common));
  }
  const r = roots[0] || null;
  if (ctx) { ctx.root = r; ctx.rootFor = cwd; ctx.roots = roots; ctx.common = info ? info.common : null; }
  return r;
}

function isDangerousTarget(t, ctx) {
  let s = String(t).trim().replace(/^["']|["']$/g, '');
  // 끝의 /* · /. 는 "그 폴더의 내용 전부" — 폴더 자체와 같이 본다.
  s = s.replace(/([\\/])\*$/, '$1').replace(/([\\/])\.$/, '$1');
  if (s === '*' || s === '.*' || s === '') s = '.';
  s = s.replace(/^\$\{?PWD\}?(?=$|[\\/])/i, () => ctx.cwd);                                     // 셸의 $PWD = 지금 cwd
  if (ctx.worker) { const lv = eachLoopValue(s, ctx, x => isDangerousTarget(x, ctx)); if (lv !== undefined) return lv; s = expandVars(s, ctx); }   // 같은 명령에서 정한 변수($p = "…") · 반복 변수
  if (/^[a-zA-Z]:[\\/]*$/.test(s)) return true;                                                  // 드라이브 루트(C:\) — 어느 플랫폼에서든 막는다
  const abs = resolveTarget(ctx.cwd, s);
  if (!abs) return unresolvedIsDangerous(s) ? 'unresolved' : false;
  // 실경로로 — 심볼릭 링크 · Windows 짧은 이름(C:\Users\RUNNER~1)으로 적힌 대상도 저장소 루트 · .git · 홈으로 알아본다(2026-10-13 CI 실측).
  const norm = C.real(abs);
  if (path.parse(norm).root && C.samePath(norm, path.parse(norm).root)) return true;          // / · C:\
  const homes = [os.homedir(), process.env.HOME, process.env.USERPROFILE].filter(Boolean).map(C.real);
  for (const h of homes) if (C.samePath(norm, h) || isAncestor(norm, h)) return true;
  repoRootOf(ctx.cwd, ctx);
  const gitDirs = [...(ctx.roots || []).map(r => path.join(r, '.git')), ...(ctx.common ? [ctx.common] : [])];
  for (const r of ctx.roots || []) if (C.samePath(norm, r) || isAncestor(norm, r)) return true;
  // .git 과 그 아래(objects · refs · harness 상태) — 히스토리와 하네스 기록이 사라진다.
  for (const g of gitDirs) if (C.samePath(norm, g) || isAncestor(g, norm)) return true;
  return false;
}

// ─────────────────────────── 진입점 ───────────────────────────
// 문법: Claude 의 PowerShell 도구 → ps, Bash 도구 → bash(Windows 에서도 Git Bash).
//   Codex 의 셸 도구는 Windows 에서 PowerShell 로 돈다(Codex 조사 §8) → ps, 그 밖에서는 bash.
function modeFor(tool, runtime) {
  if (tool === 'PowerShell') return 'ps';
  if (runtime === 'codex') return process.platform === 'win32' ? 'ps' : 'bash';
  return 'bash';
}

function decide(input, runtime, opts) {
  const worker = !!(opts && opts.worker);
  const tool = String(input.tool_name || '');
  if (!tool || tool === 'apply_patch' || tool.startsWith('mcp__')) return null;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object') return null;
  const cwd = input.cwd && typeof input.cwd === 'string' ? input.cwd : process.cwd();
  // 파일 쓰기 도구 — 작업자 모드에서만(worktree 밖 · 소유 경로 밖을 막는다). 대화형 세션의 편집은 막지 않는다.
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) { const file = ti.file_path || ti.notebook_path; return worker && file ? checkFileWrite(file, cwd) : null; }
  const c = ti.command != null ? ti.command : ti.cmd;
  // Codex 는 argv 배열(["powershell","-Command","…"] · ["bash","-lc","…"])로 줄 수 있다 — 이미 쪼개진 단어다.
  if (Array.isArray(c)) return c.length ? analyzeCommand(c.map(String), modeFor(tool, runtime), { cwd, root: undefined, depth: 0, worker, vars: {}, loops: {} }) : null;
  if (typeof c !== 'string' || !c.trim()) return null;
  return analyze(c, { cwd, mode: modeFor(tool, runtime || C.detectRuntime(input)), worker, gitReadOnly: worker && tool === 'Monitor' });
}

function main() {
  let input = null;
  try {
    const r = C.readStdinJson();
    if (!r.input) { if (r.error !== 'empty stdin') C.logError('guard', r.error); return; }
    input = r.input;
    const reason = decide(input, C.detectRuntime(input), { worker: process.argv.includes('--worker') });   // 작업자 모드 — policy 의 open 설정이 붙인다
    if (!reason) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[pilot guard] ${reason}` },
    }) + '\n');
  } catch (e) {
    C.logError('guard', e, input && input.cwd);
  }
}

if (require.main === module) { main(); process.exitCode = 0; }
module.exports = { lex, analyze, decide, checkFileWrite, globRe, isDangerousTarget, checkGit };

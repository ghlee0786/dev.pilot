#!/usr/bin/env node
'use strict';
// hooks/guard.js — PreToolUse(셸 도구): 되돌릴 수 없는 명령만 막는다(설계 §0.8 · §7).
//   Claude: Bash · PowerShell  /  Codex: Bash(셸) — 둘 다 tool_input.command.  Claude 의 mcp__* 도구도 — git · GitHub 류 서버의 쓰기 도구를 막는다.
//   막는 것: push(send-pack 포함) · pull · reset --hard(read-tree -u · checkout-index -f -a 포함) · 브랜치를 옮기는 reset/branch -f/-M/checkout -B/switch -C/update-ref ·
//            commit --amend · filter-branch · clean -f · branch -D · 작업 트리 전체 checkout/restore/rm -r · 다른 세션이 고치는 미커밋 파일의 checkout/restore ·
//            rebase · 직접 merge(--ff-only 포함) · stash(list/show 외 전부) · gh/glab 의 PR 병합 · 원격 ref/파일 쓰기 · 저장소 삭제 ·
//            루트/홈/드라이브 루트/세션 저장소/.git(하위 포함) 재귀 삭제 · 대상이 변수/치환이라 풀 수 없는 재귀 삭제 · 비밀 파일 add/commit.
//   git 옵션은 git 이 받는 꼴 그대로 읽는다: long option 약어(--har = --hard) · --no-<옵션> 부정(마지막 것이 이긴다) · 옵션 값 자리(-m -h · -o --dry-run 은 값).
//   셸이 실행하는 것은 다 본다: -c 문자열 · stdin(heredoc · here-string · 파이프) · $( ) · ${x:-$( )} · 래퍼(winpty · setsid · Start-Process …).
//   막지 않는 것: 문자열 속 언급(grep · echo · 커밋 메시지 · 셸이 아닌 명령의 heredoc 본문), 하네스 CLI, 읽기 전용 git,
//            진행 중인 merge/rebase 를 끝내거나 되돌리는 --continue/--abort/--quit(/--skip), 색인만 푸는 restore --staged.
//   제어 구문(if/then/do/else …) 뒤의 명령도 명령으로 본다.
//   출력: 두 런타임 모두 `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason` (exit 0).
//   내부 오류: git · 삭제(rm · Remove-Item · rd · del)를 언급하는 명령이면 막는다(fail-closed) — 그 밖은 열어 둔다. 둘 다 <common>/harness/hook-errors.log 에 남긴다.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const C = require('./_common');

// ─────────────────────────── 어휘 분석 ───────────────────────────
// 셸 문자열을 "단순 명령" 목록으로 나눈다. 각 명령은 따옴표를 벗긴 단어 배열이다.
//   구분자: ; && || | & 개행 ( ) { }  ·  $( … ) 와 `…`(bash) 는 안쪽을 따로 명령으로 꺼낸다(실행되므로).
//   heredoc 본문과 따옴표 안은 데이터 — 명령 위치에 오지 않으므로 언급만으로는 걸리지 않는다.
//   다만 heredoc 본문은 그 명령의 단어 끝에 HD 표식으로 붙이고(셸이 stdin 으로 받으면 명령이다), 파이프 뒤 명령에는 앞 명령을 pipedFrom 으로 단다.
//   mode: 'bash'(\ 이스케이프 · ` 치환) | 'ps'(` 이스케이프 · '' 이스케이프 · @' '@ here-string).
const SUB = '\u0001';
const HD = '\u0005';                          // heredoc 본문(그 명령의 stdin) — 단어 맨 앞 표식
const MK = '\u0006';                          // $(mktemp …) 자리표시 — 이 명령이 방금 만든 임시 경로
const OPEN = '\u0004(', CLOSE = '\u0004)';    // bash 서브셸 경계 — ( … ) · $( … ) · `…` 안에서 바꾼 cwd 는 밖에 남지 않는다
const isMark = c => c.length === 1 && (c[0] === OPEN || c[0] === CLOSE);

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
  let words = [], w = '', inWord = false, depth = 0, pipeFrom = null;
  const heredocs = [];
  const endWord = () => { if (inWord) { words.push(w); w = ''; inWord = false; } };
  const endCmd = () => {
    endWord();
    if (words.length) { if (pipeFrom) words.pipedFrom = pipeFrom; pipeFrom = null; out.push(words); }
    words = [];
  };
  // 치환 안쪽의 명령이 mktemp 하나뿐이면 자리표시를 MK 로 — `tmp=$(mktemp -d); … rm -rf "$tmp"` 는 방금 만든 폴더를 지운다(감사 2026-10-29 오탐).
  const subMark = cmds => { const c = cmds.filter(x => !isMark(x)); return c.length === 1 && prog(c[0][0]) === 'mktemp' ? MK : SUB; };
  const sub = () => {           // $( … ) — 안쪽을 명령으로 꺼내고 단어에는 자리표시만 남긴다.
    const before = out.length;
    if (mode === 'bash') out.push([OPEN]);
    lexInto(s, mode, st, out, true);
    if (mode === 'bash') out.push([CLOSE]);
    w += subMark(out.slice(before)); inWord = true;
  };
  const backtickSub = () => {   // bash `…`
    let j = st.i, inner = '';
    while (j < s.length && s[j] !== '`') { if (s[j] === '\\' && j + 1 < s.length) { inner += s[j + 1]; j += 2; continue; } inner += s[j++]; }
    st.i = j + 1;
    const cmds = lex(inner, mode);
    out.push([OPEN], ...cmds, [CLOSE]);
    w += subMark(cmds); inWord = true;
  };
  const readHeredocBodies = () => {
    for (const h of heredocs.splice(0)) {
      const body = [];
      while (st.i < s.length) {
        let e = s.indexOf('\n', st.i); if (e < 0) e = s.length;
        let line = s.slice(st.i, e).replace(/\r$/, '');
        st.i = e + 1;
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.delim) break;
        body.push(line);
      }
      h.cmd.push(HD + body.join('\n'));
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
    if (ch === '|') {
      if (nx === '|') { endCmd(); st.i += 2; continue; }
      endWord();
      const up = words.length ? words : [...out].reverse().find(c => !isMark(c)) || null;
      endCmd(); pipeFrom = up;
      st.i += nx === '&' ? 2 : 1; continue;
    }
    if (ch === '(') {
      if (inWord && w.endsWith('$')) { w = w.slice(0, -1); st.i++; sub(); continue; }
      if (inWord && /[<>]$/.test(w)) { w = w.slice(0, -1); st.i++; sub(); continue; }   // <( … ) 프로세스 치환
      // [2026-10-29 감사] PowerShell 인자 자리의 ( … ) 는 식이다 — 안쪽은 실행되고 값은 알 수 없다(Remove-Item -Recurse (Get-Location)).
      if (mode === 'ps' && (inWord || words.length)) { st.i++; sub(); continue; }
      endCmd(); depth++; if (mode === 'bash') out.push([OPEN]); st.i++; continue;
    }
    if (ch === ')') {
      if (nested && depth === 0) { endCmd(); st.i++; return; }
      endCmd(); if (depth > 0) { depth--; if (mode === 'bash') out.push([CLOSE]); } st.i++; continue;
    }
    if (ch === '{' || ch === '}') {
      if (ch === '{' && inWord && w.endsWith('$')) {         // ${VAR} · ${x:-$(cmd)} — [2026-10-29 감사] 기본값 안의 치환도 실행된다
        let d = 0;
        while (st.i < s.length) {
          const c = s[st.i];
          if (c === '\\' && mode === 'bash') { w += s.slice(st.i, st.i + 2); st.i += 2; continue; }
          if (c === '$' && s[st.i + 1] === '(') { st.i += 2; sub(); continue; }
          if (c === '`' && mode === 'bash') { st.i++; backtickSub(); continue; }
          if (c === '\'') { const e = s.indexOf('\'', st.i + 1); const stop = e < 0 ? s.length : e; w += s.slice(st.i, stop + 1); st.i = stop + 1; continue; }
          w += c; st.i++;
          if (c === '{') d++;
          else if (c === '}' && --d === 0) break;
        }
        continue;
      }
      if (inWord) { w += ch; st.i++; continue; }
      endCmd(); st.i++; continue;
    }
    if (ch === '#' && !inWord) {                              // 주석
      const e = s.indexOf('\n', st.i); st.i = e < 0 ? s.length : e; continue;
    }
    if (ch === '<' && nx === '<' && s[st.i + 2] === '<' && mode === 'bash') { endWord(); w = '<<<'; inWord = true; st.i += 3; continue; }   // here-string — 뒤 단어가 stdin
    if (ch === '<' && nx === '<' && mode === 'bash') {   // heredoc
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
      if (delim) heredocs.push({ delim, strip, cmd: words });
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
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const PWSH = new Set(['powershell', 'pwsh']);
// [2026-10-29 감사] winpty(Git Bash) · setsid · busybox … 도 래퍼다. 값을 받는 옵션(timeout -s KILL · wsl -d Ubuntu)은 값까지 벗긴다.
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'time', 'command', 'builtin', 'exec', 'nice', 'ionice', 'timeout', 'env', 'stdbuf', 'xargs', 'wsl', 'noglob', 'caffeinate',
  'winpty', 'setsid', 'unbuffer', 'chronic', 'torsocks', 'proxychains', 'proxychains4', 'strace', 'ltrace', 'watch', 'busybox', 'nocorrect']);
const WRAP_VALUE = {
  sudo: ['-u', '-g', '-C', '-h', '-p', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--close-from', '--command-timeout'],
  doas: ['-u', '-C'], timeout: ['-s', '-k', '--signal', '--kill-after'], nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'], env: ['-u', '-C', '--unset', '--chdir'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  xargs: ['-I', '-n', '-P', '-d', '-a', '-E', '-L', '-s', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines', '--max-chars', '--eof'],
  wsl: ['-d', '--distribution', '-u', '--user', '--cd', '--shell-type', '--distribution-id'], watch: ['-n', '--interval'], caffeinate: ['-t', '-w'],
  strace: ['-o', '-e', '-p', '-s', '-u', '-a', '-b', '-E', '-I', '-O', '-P', '-S', '-X'], ltrace: ['-o', '-e', '-p', '-s', '-u', '-a', '-n'],
};
const START = new Set(['start-process', 'saps', 'start']);
const DELETERS = new Set(['rm', 'rmdir', 'rd', 'remove-item', 'ri', 'del', 'erase', 'rimraf']);
const CD = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location', 'popd', 'pop-location']);
// 제어 구문 예약어 — 명령 자리 앞에 붙는다: `if x; then git reset --hard; fi` · `for b in …; do git push …; done`.
//   벗기고 뒤의 명령을 본다(벗기지 않으면 첫 단어가 then/do 라서 통과했다 — 리뷰 M9).
const CONTROL = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '!']);
const ECHO = new Set(['echo', 'printf', 'write-output', 'write']);
const CATS = new Set(['cat', 'type', 'get-content', 'gc', 'more']);

function prog(word) {
  let b = String(word || '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase();
  return b.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

// 명령 문자열 전체를 본다. 첫 번째 차단 사유를 돌려주거나 null.
//   문법은 하나만 쓴다(도구가 정한다). 두 문법으로 겹쳐 읽으면 한쪽이 다른 쪽의 데이터(heredoc 본문 등)를
//   명령으로 오독해 오탐한다 — 실측: bash `$(cat <<'EOF' … (git push) … EOF)` 를 PowerShell 로 읽으면 걸린다.
// 분석 문맥 — cwd0 은 세션의 처음 cwd(그 저장소는 cd 뒤에도 지킨다). cwdUnknown: false | 'unknown'(어디로 갔는지 모름) | 'temp'(방금 만든 임시 폴더).
function ctxFor(opts) {
  const cwd = opts.cwd || process.cwd();
  return { cwd, cwd0: cwd, depth: opts.depth || 0, cwdUnknown: opts.cwdUnknown || false, prevCwd: null, dirs: [], vars: opts.vars || {}, aliases: {}, rootCache: {}, sid: opts.sid || null };
}
const child = ctx => ({ ...ctx, dirs: ctx.dirs.slice(), depth: ctx.depth + 1 });

function analyze(command, opts) {
  const ctx = ctxFor(opts);
  return analyzeString(command, opts.mode || 'bash', ctx);
}

function analyzeString(src, mode, ctx) {
  if (ctx.depth > 6) return null;
  if (mode === 'ps') { const r = apiDeletes(src, ctx); if (r) return r; }
  const cmds = lex(src, mode);
  const scopes = [];
  for (const words of cmds) {
    if (words.length === 1 && words[0] === OPEN) { scopes.push({ cwd: ctx.cwd, cwdUnknown: ctx.cwdUnknown, prevCwd: ctx.prevCwd, dirs: ctx.dirs.slice() }); continue; }
    if (words.length === 1 && words[0] === CLOSE) { const sc = scopes.pop(); if (sc) Object.assign(ctx, sc); continue; }
    const r = analyzeCommand(words, mode, ctx);
    if (r) return r;
  }
  return null;
}
function analyzeTexts(texts, mode, ctx) {
  for (const t of texts) { const r = analyzeString(t, mode, ctx); if (r) return r; }
  return null;
}

// $NAME · ${NAME} · $env:NAME · %NAME% → 같은 명령에서 정한 값 · 환경 변수(없으면 그대로 — 풀 수 없는 경로로 남는다)
function expandVars(s, ctx) {
  const v = name => { const k = String(name).toLowerCase(); if (ctx && ctx.vars && ctx.vars[k] != null) return ctx.vars[k]; const e = Object.keys(process.env).find(x => x.toLowerCase() === k); return e ? process.env[e] : null; };
  return String(s)
    .replace(/\$env:([A-Za-z_]\w*)/gi, (m, n) => v(n) != null ? v(n) : m)
    .replace(/%([A-Za-z_]\w*)%/g, (m, n) => v(n) != null ? v(n) : m)
    .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => { const n = a || b; if (/^pwd$/i.test(n) && ctx && ctx.cwd) return ctx.cwdUnknown ? m : ctx.cwd; if (/^(home|null)$/i.test(n)) return m; return v(n) != null ? v(n) : m; });
}
// 단어 하나가 통째로 변수면($p · ${p}) 따옴표 없는 확장처럼 공백으로 나눈다.
function expandWord(word, ctx) {
  const e = expandVars(word, ctx);
  return e !== word && /^\$\{?[A-Za-z_]\w*\}?$/.test(word) ? e.split(/\s+/).filter(Boolean) : [e];
}
const setVar = (ctx, name, val) => { ctx.vars[String(name).toLowerCase()] = val; };

function analyzeCommand(words0, mode, ctx) {
  // heredoc 본문(HD) · here-string(<<<)은 이 명령의 stdin 이다 — 인자에서 빼 둔다.
  const docs = [];
  let words = [];
  for (let j = 0; j < words0.length; j++) {
    const x = words0[j];
    if (x === '') continue;
    if (x[0] === HD) { docs.push(x.slice(1)); continue; }
    if (mode === 'bash' && x.startsWith('<<<')) { const b = x.length > 3 ? x.slice(3) : words0[++j]; if (b != null) docs.push(b); continue; }
    words.push(x);
  }
  const piped = words0.pipedFrom || null;
  let viaXargs = false;
  if (words.length && /^(export|local|declare|typeset|readonly)$/.test(words[0])) {
    for (const a of words.slice(1)) { const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(a); if (m) setVar(ctx, m[1], m[2]); }
    return null;
  }
  // 앞의 VAR=값 · 리다이렉션 · 래퍼를 벗긴다.
  for (let guard = 0; guard < 12 && words.length; guard++) {
    const w0 = words[0];
    const asg = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(w0);
    if (asg) { setVar(ctx, asg[1], asg[2]); words = words.slice(1); continue; }
    if (mode === 'ps') {
      // [2026-10-29 감사] PowerShell 대입: `$c='push'` · `$c = 'push'` 는 값을 기억하고, `$x = git push` 의 오른쪽은 명령이다.
      const pa = /^\$([A-Za-z_]\w*)=([\s\S]+)$/.exec(w0);
      if (pa) { setVar(ctx, pa[1], [pa[2], ...words.slice(1)].join(' ')); words = words.slice(1); continue; }
      if (/^\$[A-Za-z_]\w*$/.test(w0) && words[1] === '=') {
        // 오른쪽이 명령(여러 단어 · Verb-Noun cmdlet · pwd 류)이면 값은 그 출력이다 — 모른다(SUB). 한 단어 리터럴만 값으로 기억한다.
        const rhs = words.slice(2);
        const isCmd = rhs.length !== 1 || /^[A-Za-z]+-[A-Za-z]+$/.test(rhs[0]) || /^(pwd|gl|gi|gci|ls|dir|git|cmd|powershell|pwsh)$/i.test(rhs[0]);
        setVar(ctx, w0.slice(1), isCmd ? SUB : rhs[0]); words = rhs; continue;
      }
    }
    if (/^\d*[<>]/.test(w0) || w0 === '&' || w0 === '.' || CONTROL.has(w0.toLowerCase())) { words = words.slice(1); continue; }
    if (/[$%]/.test(w0)) { const e = expandWord(w0, ctx); if (e.join(' ') !== w0) { words = [...e, ...words.slice(1)]; continue; } }   // 명령 자리의 변수($g → git)
    const p = prog(w0);
    if (WRAPPERS.has(p)) {
      if (p === 'xargs') viaXargs = true;
      const vals = WRAP_VALUE[p] || [];
      let dur = p === 'timeout';
      words = words.slice(1);
      while (words.length) {
        const x = words[0];
        if (p === 'env' && /^(-S|--split-string)$/.test(x) && words[1] != null) { words = [...words[1].split(/\s+/).filter(Boolean), ...words.slice(2)]; continue; }   // env -S "git push"
        if (vals.includes(x)) { words = words.slice(2); continue; }
        if (/^-/.test(x) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) { words = words.slice(1); continue; }
        if (dur && /^\d/.test(x)) { words = words.slice(1); dur = false; continue; }
        break;
      }
      continue;
    }
    break;
  }
  if (!words.length) return null;
  const p = prog(words[0]);
  const args = words.slice(1);
  const stdin = () => stdinTexts(docs, piped, mode, ctx);

  if (CD.has(p)) return changeDir(p, args, ctx);
  if (SHELLS.has(p)) {
    const k = args.findIndex(a => /^-[a-z]*c[a-z]*$/i.test(a) && !a.startsWith('--'));
    if (k >= 0 && args[k + 1] != null) return analyzeString(args[k + 1], 'bash', child(ctx));
    // [2026-10-29 감사] 스크립트 파일 없이(또는 -s) 띄운 셸은 stdin 을 명령으로 읽는다 — heredoc · here-string · 파이프(`echo 'git push' | sh`).
    if (!args.some(a => !a.startsWith('-')) || args.includes('-s')) return analyzeTexts(stdin(), 'bash', child(ctx));
    return null;
  }
  if (PWSH.has(p)) return checkPwsh(args, ctx, stdin);
  if (p === 'cmd') {
    // Git Bash 는 /c 를 C:/ 로 바꾸므로 `cmd //c …` 로 쓴다(감사 2026-10-29). cmd 의 ^ 는 이스케이프다(git ^push = git push).
    const caret = x => x.replace(/\^(.)/g, '$1');
    const k = args.findIndex(a => /^\/{1,2}[ck]$/i.test(a));
    if (k >= 0) return analyzeString(caret(args.slice(k + 1).join(' ')), 'ps', child(ctx));
    if (!args.some(a => !/^\/{1,2}/.test(a))) return analyzeTexts(stdin().map(caret), 'ps', child(ctx));   // `echo git push | cmd`
    return null;
  }
  if (p === 'eval' || p === 'invoke-expression' || p === 'iex') {
    // 같은 셸에서 돈다 — 안의 cd 도 밖에 남는다. 파이프로 받은 문자열(`'git push' | iex`)도 명령이다.
    const body = args.filter(a => !/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a)).join(' ');
    ctx.depth++;
    try { return analyzeString(body, mode, ctx) || (p === 'eval' ? null : analyzeTexts(stdin(), 'ps', ctx)); } finally { ctx.depth--; }
  }
  if (START.has(p)) return checkStart(p, args, mode, ctx);
  if (p === 'git') return checkGit(args, ctx);
  if (p === 'gh' || p === 'glab') return checkForgeCli(p, args);
  if (DELETERS.has(p)) return checkDelete(p, args, mode, ctx, (viaXargs || mode === 'ps') ? piped : null);
  const spec = INLINE_CODE[p] || (/^python[\d.]*w?$/.test(p) ? INLINE_CODE.python : null);
  if (spec) return checkInlineCode(args, spec, child(ctx));
  return null;
}

// 셸 · iex 가 stdin 으로 받는 문자열: heredoc · here-string, 그리고 파이프 앞 명령이 내보내는 것을 알 수 있을 때(echo · printf · cat <<EOF · cat 파일 · PS 문자열).
function stdinTexts(docs, piped, mode, ctx) {
  const out = docs.slice();
  if (!piped) return out;
  const up = [], upDocs = [];
  for (const x of piped) { if (x[0] === HD) upDocs.push(x.slice(1)); else if (x !== '') up.push(x); }
  const p = prog(up[0]);
  if (ECHO.has(p)) out.push(up.slice(1).filter(a => !/^-[neE]+$/.test(a)).join(' ').replace(/\\n/g, '\n'));
  else if (CATS.has(p)) {
    out.push(...upDocs);
    for (const f of up.slice(1).filter(a => !a.startsWith('-'))) {
      try { const abs = path.resolve(ctx.cwd, f); if (fs.statSync(abs).size < 1024 * 1024) out.push(fs.readFileSync(abs, 'utf8')); } catch { /* 없는 파일 — 볼 것이 없다 */ }
    }
  } else if (mode === 'ps' && up.length === 1) out.push(up[0]);       // 'git push' | iex — 문자열 하나가 명령 자리에 있다
  return out;
}

// ── cd · pushd · popd ──
//   [2026-10-29 감사] 어디로 갔는지 모르면(변수 · 치환 · 인자 없는 cd = 홈 · 빈 popd) 그 뒤의 상대 경로 재귀 삭제는 보수적으로 본다(isDangerousTarget).
function isAbsLike(raw) {
  const s = expandHome(raw);
  return path.isAbsolute(s) || /^[a-zA-Z]:/.test(s) || (C.IS_WIN && /^\/(mnt\/)?[a-zA-Z](\/|$)/.test(s));
}
const hasDotDot = s => /(^|[\\/])\.\.([\\/]|$)/.test(s);
function changeDir(p, args, ctx) {
  const prev = ctx.cwdUnknown ? null : ctx.cwd;
  const go = (cwd, unknown) => { ctx.prevCwd = prev; if (cwd) ctx.cwd = cwd; ctx.cwdUnknown = unknown; return null; };
  if (p === 'popd' || p === 'pop-location') { const d = ctx.dirs.pop(); return d ? go(d.cwd, d.unknown) : go(null, 'unknown'); }
  if (p === 'pushd' || p === 'push-location') ctx.dirs.push({ cwd: ctx.cwd, unknown: ctx.cwdUnknown });
  const t = args.find(a => a === '-' || !a.startsWith('-'));
  if (t == null) return go(null, 'unknown');                     // 인자 없는 cd(bash 는 홈) · 인자 없는 pushd(맞바꿈)
  if (t === '-') return ctx.prevCwd ? go(ctx.prevCwd, false) : go(null, 'unknown');
  const raw = expandVars(String(t).replace(/^["']|["']$/g, ''), ctx);
  if (raw.startsWith(MK) && !hasDotDot(raw) && !raw.includes(SUB)) return go(null, 'temp');
  if (ctx.cwdUnknown && !isAbsLike(raw)) return go(null, ctx.cwdUnknown === 'temp' && hasDotDot(raw) ? 'unknown' : ctx.cwdUnknown);
  const to = resolveTarget(ctx.cwd, raw);
  return to ? go(to, false) : go(null, 'unknown');
}

// ── powershell / pwsh ──
//   [2026-10-29 감사] 값을 받는 옵션(-ExecutionPolicy Bypass)의 값을 명령으로 읽어 `powershell -ExecutionPolicy Bypass git push` 가 통과했다.
const PS_VALUE_OPTS = ['executionpolicy', 'ep', 'windowstyle', 'workingdirectory', 'wd', 'version', 'outputformat', 'of', 'inputformat', 'if', 'configurationname', 'psconsolefile', 'settingsfile', 'custompipename'];
function checkPwsh(args, ctx, stdin) {
  const sub = s => analyzeString(s, 'ps', child(ctx));
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    const m = /^[-/]([A-Za-z]+)(?::([\s\S]*))?$/.exec(a);
    if (!m) {
      if (/\.ps1$/i.test(a)) return null;                     // 스크립트 파일(pwsh 의 위치 인자) — 볼 수 없다
      return sub(args.slice(j).join(' '));                     // Windows PowerShell 의 위치 인자는 -Command
    }
    const n = m[1].toLowerCase();
    if ('command'.startsWith(n)) {
      const script = (m[2] != null ? [m[2], ...args.slice(j + 1)] : args.slice(j + 1)).join(' ');
      return script.trim() === '-' || !script.trim() ? analyzeTexts(stdin(), 'ps', child(ctx)) : sub(script);
    }
    if (n === 'e' || n === 'ec' || (n.startsWith('en') && 'encodedcommand'.startsWith(n))) {
      const v = m[2] != null ? m[2] : args[j + 1];
      let decoded = '';
      try { decoded = Buffer.from(String(v || ''), 'base64').toString('utf16le'); } catch { decoded = ''; }
      return decoded ? sub(decoded) : null;
    }
    if ('file'.startsWith(n)) return null;
    if (m[2] == null && (n === 'w' || n === 'v' || PS_VALUE_OPTS.includes(n) || (n.length >= 2 && PS_VALUE_OPTS.some(x => x.startsWith(n))))) j++;
  }
  return analyzeTexts(stdin(), 'ps', child(ctx));               // 명령 없이 띄우면 stdin 을 읽는다
}

// ── Start-Process · start ──
//   [2026-10-29 감사] -ArgumentList 'push origin main' · 'reset','--hard' 는 한 단어로 남아 하위 명령으로 읽히지 않았다 — 펼쳐서 다시 본다.
function checkStart(p, args, mode, ctx) {
  if (p === 'start' && mode !== 'ps') return analyzeCommand(args.filter(a => !/^\/{1,2}[A-Za-z]+$/.test(a)), mode, ctx);   // cmd 의 start /b …
  let file = null; const argl = [];
  const take = j => { let v = args[j] || ''; while (v.endsWith(',') && args[j + 1] != null) v += args[++j]; return [v, j]; };
  for (let j = 0; j < args.length; j++) {
    const m = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(args[j]);
    if (!m) { const [v, k] = take(j); j = k; if (file == null) file = v; else argl.push(v); continue; }
    const n = m[1].toLowerCase();
    const val = () => { if (m[2] != null) return m[2]; const [v, k] = take(j + 1); j = k; return v; };
    if (n === 'path' || n === 'pspath' || 'filepath'.startsWith(n)) file = val();
    else if (n === 'args' || 'argumentlist'.startsWith(n)) argl.push(val());
    else if (['workingdirectory', 'verb', 'windowstyle', 'redirectstandardoutput', 'redirectstandarderror', 'redirectstandardinput', 'credential', 'environment'].some(x => x.startsWith(n) && n.length >= 2)) val();
  }
  if (!file) return null;
  const words = [file, ...argl.flatMap(v => v.split(',')).flatMap(v => v.trim().split(/\s+/)).filter(Boolean)];
  return analyzeCommand(words, mode, ctx);
}

// ── 인터프리터 한 줄(python -c · node -e …) ──
//   [적대 2026-10-02] `python -c "subprocess.run(['git','push'])"` · `node -e "execSync('git push')"` 는 셸 단어로는 git 이 아니다.
//   코드 안의 문자열 리터럴을 본다: 각 문자열을 셸 명령으로(execSync('git push …') · os.system("…")),
//   그리고 'git' 으로 시작하는 문자열 나열을 git 인자로(['git','push'] · system("git","push")). 문자열 속 단순 언급(print("git push"))도
//   한 줄 코드에서는 막힐 수 있다 — 한 줄 코드는 실행하려고 쓰는 것이므로 오탐보다 우회가 더 비싸다.
//   [2026-10-29 감사] 플래그는 결합형(--eval=…) · 묶음형(node -pe · python -Ic)도 읽고, 파일 API 재귀 삭제(fs.rmSync · shutil.rmtree)도 본다.
const INLINE_CODE = { python: { s: 'c' }, python3: { s: 'c' }, py: { s: 'c' }, node: { s: 'ep', l: ['eval', 'print'] }, deno: { sub: 'eval' }, bun: { s: 'e', l: ['eval'] },
  ruby: { s: 'e' }, perl: { s: 'eE' }, php: { s: 'r' } };
function inlineCodes(args, spec) {
  const out = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (spec.sub && a === spec.sub) { if (args[j + 1] != null) out.push(args[j + 1]); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('='); const n = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      if (spec.l && spec.l.includes(n)) { if (eq >= 0) out.push(a.slice(eq + 1)); else if (args[j + 1] != null) out.push(args[++j]); }
      continue;
    }
    if (/^-[A-Za-z]/.test(a) && spec.s) {
      for (let k = 1; k < a.length && /[A-Za-z]/.test(a[k]); k++) {
        if (!spec.s.includes(a[k])) continue;
        if (a.slice(k + 1)) out.push(a.slice(k + 1));          // -cprint(1) · (node -pe 의 e 처럼 플래그일 수도 — 둘 다 본다)
        if (args[j + 1] != null) out.push(args[j + 1]);
        break;
      }
    }
  }
  return out;
}
function checkInlineCode(args, spec, ctx) {
  for (const code of inlineCodes(args, spec)) { const r = scanCode(code, ctx); if (r) return r; }
  return null;
}
function scanCode(code, ctx) {
  const d = apiDeletes(code, ctx);
  if (d) return d;
  const strs = [];
  const re = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;
  for (let m; (m = re.exec(code));) strs.push((m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]).replace(/\\(.)/g, '$1'));
  for (let i = 0; i < strs.length; i++) {
    if (prog(strs[i]) === 'git') { const r = checkGit(strs.slice(i + 1, i + 9), ctx); if (r) return r; }
    if (/\s/.test(strs[i])) { const r = analyzeString(strs[i], 'bash', ctx); if (r) return r; }
  }
  return null;
}
// 파일 API 로 하는 재귀 삭제 — 셸의 rm -rf 와 같은 대상 규칙(node fs.rmSync · python shutil.rmtree · ruby FileUtils.rm_rf · .NET [IO.Directory]::Delete).
const API_DELETE = /(?:\brmSync|\brmdirSync|\bfs(?:\.promises)?\.rm(?:dir)?|\bshutil\.rmtree|\bFileUtils\.(?:rm_rf|rm_r|remove_dir|remove_entry(?:_secure)?)|\brmtree|\bremove_tree|\bremove_dir_all|\brimraf(?:\.sync)?|\bDirectory\]?::Delete|\bDirectory\.Delete)\s*\(?\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gi;
function apiDeletes(code, ctx) {
  API_DELETE.lastIndex = 0;
  for (let m; (m = API_DELETE.exec(code));) {
    const d = isDangerousTarget(m[2], ctx);
    if (d) return deleteReason(d, m[2]);
  }
  return null;
}

// ── gh · glab CLI ──
//   [2026-10-29 감사] MCP 의 PR 병합 · 원격 쓰기는 막는데 같은 일을 하는 gh 는 통과했다 — 같은 판정을 한다.
function checkForgeCli(p, args) {
  const pos = [];
  for (let j = 0; j < args.length; j++) { const a = args[j]; if (a === '-R' || a === '--repo') { j++; continue; } if (!a.startsWith('-')) pos.push(a.toLowerCase()); }
  const [a0, a1] = pos;
  if ((a0 === 'pr' || a0 === 'mr') && a1 === 'merge') return REASONS.forge;
  if (a0 === 'repo' && (a1 === 'delete' || (p === 'gh' && a1 === 'sync'))) return REASONS.forge;
  if (p === 'gh' && a0 === 'api') return checkGhApi(args.slice(args.findIndex(x => x.toLowerCase() === 'api') + 1));
  return null;
}
function checkGhApi(a) {
  let method = null, fields = false, endpoint = null;
  const vals = [];
  for (let j = 0; j < a.length; j++) {
    const x = a[j];
    let m;
    if ((m = /^(?:-X|--method)(?:=?(.+))?$/.exec(x))) { method = String(m[1] || a[++j] || '').toUpperCase(); continue; }
    if (/^(-f|-F|--field|--raw-field|--input)$/.test(x)) { fields = true; vals.push(String(a[++j] || '')); continue; }
    if (/^(-f|-F).|^--(raw-)?field=|^--input=/.test(x)) { fields = true; vals.push(x); continue; }
    if (/^(-H|--header|--jq|-q|-t|--template|--cache|-p|--preview|--hostname)$/.test(x)) { j++; continue; }
    if (!x.startsWith('-') && endpoint == null) endpoint = x;
  }
  method = method || (fields ? 'POST' : 'GET');
  if (method === 'GET') return null;
  const e = String(endpoint || '').replace(/^\//, '').toLowerCase();
  if (e === 'graphql') return vals.some(v => /mutation/i.test(v) && /(mergePullRequest|deleteRef|updateRefs?|createCommitOnBranch|deleteRepository|mergeBranch|enablePullRequestAutoMerge)/i.test(v)) ? REASONS.forge : null;
  if (/\/merges?(\/|$)|\/git\/refs(\/|$)|\/contents\/|\/branches\/[^/]+\/rename/.test(e) || (method === 'DELETE' && /^repos\/[^/]+\/[^/]+\/?$/.test(e))) return REASONS.forge;
  return null;
}

// ── git ──
const GIT_VALUE_OPTS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--attr-source', '--list-cmds']);
const WHOLE_TREE = new Set(['.', './', '.\\', ':/', ':/.', ':/*', '*', './*', '.\\*', ':(top)', ':(top).', ':(top)*', '-A', ':']);

const REASONS = {
  // [버그 2026-10-01] AGENTS.md 는 "사용자가 명시한 뒤에만" 이라 적었는데 허락의 길이 없었다 — 좁힌 하네스 명령으로 안내한다.
  push: 'git push 는 직접 실행하지 않습니다. 사용자가 push 를 **명시적으로** 요청했다면 `node harness/cli.js push [<remote>] [<branch>]` 를 쓰세요 — 강제 push 없이 빨리감기만 하고, 원격이 앞서 있으면 거부합니다(실행 때 승인 프롬프트가 뜹니다). 요청이 없었다면 커밋까지만 하고 무엇을 올릴지 보고하세요. 사용자가 직접 올릴 때: 터미널판은 `! git push …`, VS Code 확장은 보기 → 터미널에서 실행합니다.',
  reset: 'git reset --hard 는 미커밋 변경을 되돌릴 수 없게 지웁니다(read-tree -u · checkout-index -f -a 도 같다). 커밋을 되돌리려면 `git revert <sha>`, 자기가 고친 파일 하나를 되돌리려면 `git restore -- <file>` 을 쓰세요.',
  clean: 'git clean -f 는 추적 안 된 파일(다른 세션·사람 것 포함)을 지웁니다. `git clean -n` 으로 확인하고, 자기가 만든 파일만 경로를 지정해 지우세요.',
  branch: 'git branch -D 는 병합 안 된 커밋을 잃게 할 수 있습니다. 병합된 브랜치는 `git branch -d`, 하네스 작업 브랜치는 `node harness/cli.js cancel <id>` 로 정리하세요.',
  wholeTree: '작업 트리 전체를 되돌리면 다른 세션·사람의 미커밋 변경까지 사라집니다. 자기가 고친 파일만 경로로 지정하세요: `git restore -- <file>`.',
  force: '강제 checkout/switch 는 미커밋 변경을 버립니다. 먼저 자기 변경을 커밋하고, 강제 옵션 없이 전환하세요.',
  rebase: 'git rebase 는 히스토리를 다시 씁니다(filter-branch 도 같다). 브랜치 통합은 하네스가 합니다 — 사용자가 받아들인다고 말한 뒤 `node harness/cli.js accept <id>`. (진행 중인 rebase 를 끝내거나 되돌리는 `--continue` · `--skip` · `--abort` · `--quit` 는 통과합니다.)',
  // `--ff-only` 도 막는다: 되감기 병합도 사용자 브랜치를 움직인다. accept 는 `--no-ff` 한 커밋으로 병합하고 작업 기록에 남겨
  //   `cancel` 로 revert 할 수 있다 — 직접 병합(ff 포함)은 그 기록이 없어 되돌릴 근거가 없다.
  merge: '병합은 직접 하지 않습니다(`--ff-only` 포함 — 되감기 병합도 사용자 브랜치를 움직이고, 하네스 기록이 없어 `cancel` 로 되돌릴 수 없습니다). 사용자가 받아들인다고 말한 뒤 `node harness/cli.js accept <id>` 로 합니다(`--no-ff` 한 커밋, `cancel` 로 되돌릴 수 있음). 진행 중인 병합은 `git merge --continue` · `--abort` · `--quit` 로 끝내세요.',
  stash: 'git stash 는 같은 체크아웃의 다른 세션·사람의 미커밋 변경까지 숨기거나(push · save · -u) 섞고(pop · apply) 지웁니다(drop · clear). 자기 파일은 경로를 지정해 커밋하세요. 보기만 하려면 `git stash list` · `git stash show`.',
  pull: 'git pull 은 원격 변경을 사용자 브랜치에 병합/리베이스합니다. `git fetch` 로 가져와 보기만 하고, 통합은 사용자가 직접 합니다.',
  amend: 'git commit --amend 는 이미 있는 커밋(다른 세션·사람 것일 수 있음)을 다시 씁니다. 새 커밋을 만드세요: `git commit -m "<무엇을 왜>" -- <파일들>`.',
  resetMove: 'git reset <커밋> 은 브랜치를 옮겨 커밋을 히스토리에서 떼어 냅니다(--soft/--mixed/--keep 포함). 커밋을 되돌리려면 `git revert <sha>`, 스테이징만 풀려면 `git restore --staged -- <file>`.',
  branchMove: '브랜치를 강제로 옮기거나 덮어쓰는 명령입니다(branch -f · 이미 있는 이름으로 -M/-C · checkout -B · switch -C · update-ref) — 원래 가리키던 커밋을 잃습니다. 새 이름으로 브랜치를 만드세요(`git switch -c <새 이름>`).',
  gitRm: 'git rm -r 로 작업 트리 전체를 지우면 다른 세션·사람의 파일까지 사라집니다. 지울 파일을 경로로 지정하세요(색인에서만 빼려면 `--cached`).',
  worktree: '강제 worktree 제거는 그 안의 미커밋 변경을 지웁니다. 하네스 작업은 `node harness/cli.js cancel <id>` / `gc` 로 정리하세요.',
  delete: '저장소 루트 · 홈 · 드라이브 루트(또는 그 상위) · .git 을 재귀 삭제하는 명령입니다. 지울 파일·폴더를 구체적인 하위 경로로 지정하세요.',
  unresolved: '재귀 삭제 대상이 변수나 명령 치환(또는 파이프 입력)이라 무엇이 지워질지 알 수 없습니다(저장소 루트 · 홈일 수 있음). 지울 폴더를 구체적인 경로로 적으세요.',
  cwdUnknown: '앞의 cd 가 어디로 갔는지 알 수 없어서(변수 · 명령 치환 · 인자 없는 cd · popd) 이 상대 경로 재귀 삭제가 저장소 루트 · .git · 홈을 지울 수 있습니다. 절대 경로로 적거나 cd 없이 경로를 지정하세요.',
  gitUnresolved: 'git 하위 명령이 변수나 명령 치환이라 무엇을 실행할지 알 수 없습니다. 하위 명령을 그대로 적으세요.',
  forge: '원격 저장소를 바꾸는 명령입니다(PR/MR 병합 · 원격 브랜치/파일 쓰기 · 저장소 삭제 · 동기화) — 밖으로 나가는 일이라 막습니다. 병합은 사용자가 받아들인다고 말한 뒤 `node harness/cli.js accept <id>`, push 는 사용자가 명시적으로 요청한 뒤 `node harness/cli.js push` 로 합니다. 원격에서만 할 수 있는 일은 사용자에게 맡기세요.',
};

// git 이 직접 아는 하위 명령 — 별칭은 이것들을 가리지 못한다(git 규칙). 이 밖의 이름은 별칭인지 본다.
const GIT_BUILTINS = new Set(['add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-ignore', 'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit',
  'config', 'describe', 'diff', 'difftool', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base',
  'mergetool', 'mv', 'notes', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog',
  'show', 'show-ref', 'sparse-checkout', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'version', 'whatchanged', 'worktree',
  'stage', 'read-tree', 'checkout-index', 'send-pack', 'http-push', 'filter-branch', 'filter-repo', 'commit-tree', 'hash-object', 'write-tree', 'mktree', 'prune']);

// [2026-10-29 감사] git 옵션을 git 처럼 읽는다. 하위 명령마다 값을 받는 옵션(s: 짧은 글자 · l: 긴 이름) — 그 값은 옵션이 아니다(`-m -h` · `-o --dry-run`).
//   예외(dry-run · abort …)만 보는 하위 명령은 넉넉히, 위험 옵션을 보는 하위 명령은 git 이 정말 값을 받는 것만 적는다(값으로 잘못 넘기면 위험 옵션을 놓친다).
const GIT_VAL = {
  push: { s: 'o', l: ['push-option', 'repo', 'receive-pack', 'exec', 'recurse-submodules'] },
  'send-pack': { s: '', l: ['receive-pack', 'exec'] },
  clean: { s: 'e', l: ['exclude'] },
  branch: { s: 'u', l: ['set-upstream-to', 'sort', 'format', 'points-at'] },
  checkout: { s: 'bB', l: ['orphan', 'conflict', 'pathspec-from-file'] },
  switch: { s: 'cC', l: ['create', 'force-create', 'orphan', 'conflict'] },
  restore: { s: 's', l: ['source', 'pathspec-from-file', 'conflict'] },
  rebase: { s: 'sXx', l: ['onto', 'strategy', 'strategy-option', 'exec', 'whitespace'] },
  merge: { s: 'msXF', l: ['message', 'file', 'strategy', 'strategy-option', 'into-name', 'cleanup'] },
  stash: { s: 'm', l: ['message', 'pathspec-from-file'] },
  rm: { s: '', l: ['pathspec-from-file'] },
  add: { s: '', l: ['chmod', 'pathspec-from-file'] },
  stage: { s: '', l: ['chmod', 'pathspec-from-file'] },
  commit: { s: 'mFCct', l: ['message', 'file', 'reuse-message', 'reedit-message', 'template', 'author', 'date', 'cleanup', 'fixup', 'squash', 'trailer', 'pathspec-from-file'] },
  reset: { s: '', l: ['pathspec-from-file'] },
  'update-index': { s: '', l: ['chmod', 'index-version'] },
};
function gitParse(rest, spec) {
  const sp = spec || { s: '', l: [] };
  const toks = [], pos = [], after = [];
  let dd = false;
  for (let j = 0; j < rest.length; j++) {
    const r = rest[j];
    if (dd) { after.push(r); continue; }
    if (r === '--') { dd = true; continue; }
    if (r.startsWith('--')) {
      const eq = r.indexOf('=');
      const n = (eq < 0 ? r.slice(2) : r.slice(2, eq)).toLowerCase();
      const t = { long: n, value: eq < 0 ? null : r.slice(eq + 1) };
      if (eq < 0 && n && sp.l.some(l => l.startsWith(n))) t.value = rest[++j] == null ? null : rest[j];
      toks.push(t); continue;
    }
    if (/^-[^-]/.test(r)) {
      for (let k = 1; k < r.length; k++) {
        const c = r[k];
        if (sp.s.includes(c)) { const v = r.slice(k + 1) || rest[++j]; toks.push({ short: c, value: v == null ? null : v }); break; }
        toks.push({ short: c });
      }
      continue;
    }
    pos.push(r);
  }
  return { toks, pos, after, dd };
}
// 마지막에 나온 것이 이긴다: --X(git 이 받는 약어 포함) · 짧은 글자 → 켬, --no-X → 끔.
function gitOpt(o, longs, shorts) {
  let v = false;
  for (const t of o.toks) {
    if (t.short) { if (shorts && shorts.includes(t.short)) v = true; continue; }
    const n = t.long;
    if (n && longs.some(l => l.startsWith(n))) v = true;
    else if (n.length > 3 && n.startsWith('no-') && longs.some(l => l.startsWith(n.slice(3)))) v = false;
  }
  return v;
}
const gitShort = (o, c) => o.toks.some(t => t.short === c);
// --pathspec-from-file=<f> 의 경로들(‘-’ = stdin 은 알 수 없다 → unknown).
function fromFile(o, gitCwd) {
  const t = o.toks.find(x => x.long && 'pathspec-from-file'.startsWith(x.long) && x.long.length >= 2);
  if (!t || t.value == null) return { specs: [], unknown: false };
  if (t.value === '-') return { specs: [], unknown: true };
  try { return { specs: fs.readFileSync(path.resolve(gitCwd, t.value), 'utf8').split(/\r?\n|\0/).map(x => x.trim()).filter(Boolean), unknown: false }; } catch { return { specs: [], unknown: true }; }
}

function checkGit(args0, ctx) {
  const args = [];
  for (const a of args0) { if (/[$%]/.test(a)) args.push(...expandWord(a, ctx)); else args.push(a); }
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
  if (/[$%\u0001\u0006]/.test(sub)) return REASONS.gitUnresolved;
  // [2026-10-29 감사] -h/--help 는 첫 인자일 때만 도움말로 본다 — 옵션 값 자리(`commit --amend -m -h`)의 -h 는 실제 명령을 실행시켰다.
  if (rest[0] === '-h' || rest[0] === '--help') return null;
  // [적대 2026-10-02] 별칭(`git -c alias.p=push p` · 저장소/전역 설정의 alias.yeet=push)은 펼쳐서 다시 본다. `!` 별칭은 셸 명령이다.
  //   [2026-10-29 감사] 같은 명령 줄에서 정의한 별칭(`git config alias.pp push && git pp`)도 본다.
  if (!GIT_BUILTINS.has(sub) && (ctx.depth || 0) < 6) {
    let val = cliAliases[sub] != null ? cliAliases[sub] : (ctx.aliases || {})[sub];
    if (val == null) { const r = C.git(gitCwd, ['config', '--get', `alias.${sub}`]); if (r.status === 0) val = r.stdout.replace(/\r?\n$/, ''); }
    if (val != null && val.trim()) {
      const inner = { ...ctx, cwd: gitCwd, depth: (ctx.depth || 0) + 1 };
      if (val.trim().startsWith('!')) return analyzeString(`${val.trim().slice(1)} ${rest.map(x => JSON.stringify(x)).join(' ')}`, 'bash', inner);
      const words = lex(val, 'bash').find(c => !isMark(c)) || [];
      return checkGit([...words, ...rest], inner);
    }
  }
  const o = gitParse(rest, GIT_VAL[sub]);

  switch (sub) {
    case 'push':
      return gitOpt(o, ['dry-run'], 'n') ? null : REASONS.push;
    case 'send-pack': case 'http-push':
      return gitOpt(o, ['dry-run']) ? null : REASONS.push;
    case 'pull':
      return REASONS.pull;
    case 'reset':
      return checkReset(o, gitCwd);
    case 'update-ref':
      return REASONS.branchMove;
    case 'clean':
      if (gitOpt(o, ['dry-run'], 'n')) return null;
      return gitOpt(o, ['force'], 'f') ? REASONS.clean : null;
    case 'branch':
      return checkBranch(o, gitCwd);
    case 'checkout': {
      if (gitOpt(o, ['force'], 'f')) return REASONS.force;
      if (gitShort(o, 'B')) return REASONS.branchMove;
      const specs = o.dd ? o.after : o.pos;
      if (specs.some(x => isWholeTree(x, gitCwd, ctx))) return REASONS.wholeTree;
      // `git checkout <브랜치>` 의 첫 위치 인자는 경로가 아니다 — 커밋으로 풀리면 뺀다.
      return peerReason(gitCwd, ctx, () => (o.dd || !o.pos.length || C.git(gitCwd, ['rev-parse', '-q', '--verify', o.pos[0] + '^{commit}']).status !== 0) ? specs : o.pos.slice(1));
    }
    case 'switch':
      if (gitOpt(o, ['discard-changes', 'force'], 'f')) return REASONS.force;
      return gitOpt(o, ['force-create'], 'C') ? REASONS.branchMove : null;
    case 'restore': {
      // --staged 만(작업 트리 · 원본 지정 없이)이면 색인만 푼다 — 파일 내용은 그대로라 되돌릴 수 없는 일이 아니다.
      const staged = gitOpt(o, ['staged'], 'S'), worktree = gitOpt(o, ['worktree'], 'W'), source = gitOpt(o, ['source'], 's');
      if (staged && !worktree && !source) return null;
      const specs = o.dd ? o.after : o.pos;
      if (specs.some(x => isWholeTree(x, gitCwd, ctx))) return REASONS.wholeTree;
      return (!staged || worktree) ? peerReason(gitCwd, ctx, () => specs) : null;
    }
    case 'rebase':
      // 진행 중인 rebase 를 끝내거나 되돌리는 것은 통과 — 막으면 멈춘 rebase 에 갇힌다.
      return gitOpt(o, ['abort', 'continue', 'skip', 'quit']) ? null : REASONS.rebase;
    case 'merge':
      // 진행 중인 병합을 끝내거나 되돌리는 것만 통과. `--ff-only` 는 막는다(이유는 REASONS.merge).
      return gitOpt(o, ['abort', 'continue', 'quit']) ? null : REASONS.merge;
    case 'stash':
      return ['list', 'show'].includes((rest[0] || '').toLowerCase()) ? null : REASONS.stash;
    case 'rm': {
      if (gitOpt(o, ['cached']) || gitOpt(o, ['dry-run'], 'n')) return null;
      if (!gitShort(o, 'r')) return null;
      const specs = [...(o.dd ? o.after : o.pos), ...fromFile(o, gitCwd).specs];
      return specs.some(x => isWholeTree(x, gitCwd, ctx)) ? REASONS.gitRm : null;
    }
    case 'worktree':
      return ((rest[0] || '').toLowerCase() === 'remove' && gitOpt(gitParse(rest.slice(1)), ['force'], 'f')) ? REASONS.worktree : null;
    case 'add': case 'stage':
      return checkAddSecrets(o, gitCwd);
    case 'commit':
      if (gitOpt(o, ['amend'])) return REASONS.amend;
      return checkCommitSecrets(o, gitCwd);
    case 'update-index': {
      if (!gitOpt(o, ['add'])) return null;
      const named = [...o.pos, ...o.after].filter(C.isSecretPath);
      return named.length ? secretReason('스테이징', named) : null;
    }
    case 'read-tree':
      return gitShort(o, 'u') ? REASONS.reset : null;           // -u: 작업 트리를 그 트리로 덮는다(--reset 이면 미커밋 변경을 버린다)
    case 'checkout-index':
      return gitOpt(o, ['force'], 'f') && (gitOpt(o, ['all'], 'a') || (o.dd ? o.after : o.pos).some(x => isWholeTree(x, gitCwd, ctx))) ? REASONS.reset : null;
    case 'filter-branch': case 'filter-repo':
      return REASONS.rebase;
    case 'submodule': {
      const k = rest.findIndex(x => x === 'foreach');
      if (k < 0) return null;
      const cmd = rest.slice(k + 1).filter(x => !/^(--recursive|-q|--quiet)$/.test(x)).join(' ');
      return analyzeString(cmd, 'bash', { ...child(ctx), cwdUnknown: 'unknown' });   // 각 하위 모듈에서 돈다
    }
    case 'config': {
      const k = rest.findIndex(x => /^alias\./i.test(x));
      if (k >= 0 && rest[k + 1] != null && !rest.some(x => /^--(unset|get|list|remove)/.test(x))) (ctx.aliases || (ctx.aliases = {}))[rest[k].slice(6).toLowerCase()] = rest[k + 1];
      return null;
    }
    default:
      return null;
  }
}

// branch: -D · --delete --force 는 지운다. -f 는 옮긴다. -M/-C(= -m/-c --force)는 대상 이름이 이미 있고 원래 이름과 다를 때만 덮어쓴다 —
//   [2026-10-29 감사 오탐] `git branch -M main`(git init 직후 GitHub 안내) 은 새 이름으로 바꿀 뿐이라 막지 않는다.
function checkBranch(o, gitCwd) {
  const del = gitOpt(o, ['delete'], 'd'), force = gitOpt(o, ['force'], 'f');
  if (gitShort(o, 'D') || (del && force)) return REASONS.branch;
  const move = gitShort(o, 'M') || gitShort(o, 'C') || ((gitOpt(o, ['move'], 'm') || gitOpt(o, ['copy'], 'c')) && force);
  if (!move) return force ? REASONS.branchMove : null;
  const target = o.pos[o.pos.length - 1];
  if (!target) return null;
  const source = o.pos.length >= 2 ? o.pos[0] : C.git(gitCwd, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
  const same = (a, b) => C.IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (source && same(source, target)) return null;
  const r = C.git(gitCwd, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]);
  return r.status === 1 ? null : REASONS.branchMove;           // 없다(1)면 새 이름 · 있거나 모르면(오류) 막는다
}

// reset: --hard 는 언제나 막는다. 그 밖(--soft · --mixed · --keep · --merge · 모드 없음)은 브랜치를 옮길 때만 막는다 —
//   경로를 지정한 reset(`git reset -- f` · `git reset HEAD~1 -- f`)과 인자 없는 reset 은 색인만 바꾼다.
function checkReset(o, gitCwd) {
  if (gitOpt(o, ['hard'])) return REASONS.reset;
  if (gitOpt(o, ['patch'], 'p') || o.toks.some(t => t.long && t.long.length >= 2 && 'pathspec-from-file'.startsWith(t.long))) return null;
  const pos = o.pos;
  if (!pos.length || o.after.length || pos.length > 1) return null;
  const cand = pos[0];
  if (!o.dd) { try { if (fs.existsSync(path.resolve(gitCwd, cand))) return null; } catch { /* 경로가 아니다 */ } }
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

// [2026-10-29 감사] 같은 체크아웃의 다른 산 세션이 고치는 미커밋 파일을 checkout/restore 로 되돌리면 그 변경은 되돌릴 수 없게 사라진다
//   (게시판의 확인은 Write/Edit 에만 걸린다). 세션 기록 · 산 세션 판정은 게시판과 같다. 다른 세션 기록이 없으면 git 을 부르지 않는다.
function peerReason(gitCwd, ctx, specsFn) {
  if (!ctx.sid) return null;
  const info = C.repoInfo(gitCwd);
  if (!info) return null;
  const peers = C.listSessions(info.common).filter(s => String(s.session_id) !== ctx.sid && !s.ended_at && s.files.length);
  if (!peers.length) return null;
  const key = x => C.IS_WIN ? x.toLowerCase() : x;
  const rels = specsFn().filter(x => !/[*?[]/.test(x)).map(x => C.repoRel(info.root, gitCwd, x)).filter(Boolean).map(key);
  if (!rels.length) return null;
  const hits = [];
  for (const s of peers) for (const f of s.files) { const k = key(f); if (rels.some(r => k === r || k.startsWith(r + '/'))) hits.push({ s, f }); }
  if (!hits.length) return null;
  const agents = C.platformAgents(info.common);
  const live = hits.filter(h => C.sessionLive(h.s, agents));
  if (!live.length) return null;
  let dirty;
  try { dirty = C.dirtyPaths(info.root, live.map(h => h.f)); } catch { return null; }
  const files = [...new Set(live.filter(h => dirty.has(C.keyOf(h.f))).map(h => h.f))];
  return files.length ? `다른 세션이 고치고 있는 미커밋 파일 ${C.listForReason(files, 10)} 을(를) 되돌리려 합니다 — 그 변경은 되돌릴 수 없게 사라집니다. 자기가 고친 파일만 지정하세요(그 세션과는 SendMessage 로 조율).` : null;
}

// 비밀 파일이 스테이징될 참인가 — 이름으로 직접 지정했거나, 넓은 add(. · -A · 디렉터리)가 쓸어 담을 때.
//   [2026-10-29 감사] -f/--force 면 .gitignore 된 비밀도 들어간다(`git add -f .`) — 무시된 파일까지 본다.
function checkAddSecrets(o, gitCwd) {
  if (gitOpt(o, ['dry-run'], 'n')) return null;
  const ff = fromFile(o, gitCwd);
  const specs = [...o.pos, ...o.after, ...ff.specs];
  const named = specs.filter(C.isSecretPath);
  if (named.length) return secretReason('스테이징', named);
  const broad = gitOpt(o, ['all', 'update'], 'Au') || ff.unknown;
  if (!specs.length && !broad) return null;
  const force = gitOpt(o, ['force'], 'f');
  const st = C.git(gitCwd, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '--untracked-files=all', ...(force ? ['--ignored'] : []), '--', ...(specs.length ? specs : [':/'])]);
  if (st.status !== 0) return null;
  const hits = st.stdout.split('\0').filter(e => e.length > 3).map(e => e.slice(3)).filter(C.isSecretPath);
  return hits.length ? secretReason('스테이징', hits) : null;
}

// 커밋에 들어갈 비밀 파일. [2026-10-29 감사]
//   경로를 준 커밋(`-- <파일>` · `<파일>` · --only)은 그 경로만 커밋한다(작업 트리 내용 그대로) — 색인의 남이 스테이징한 것은 보지 않고(오탐이었다),
//   그 경로가 고르는 추적 파일의 변경을 본다(`git commit -m x .env` 가 새 비밀값을 커밋했다). -i/--include 면 색인 전체 + 경로.
function checkCommitSecrets(o, gitCwd) {
  const found = new Set();
  const take = r => { if (r.status === 0) r.stdout.split('\0').filter(C.isSecretPath).forEach(f => found.add(f)); };
  const Q = ['-c', 'core.quotepath=false'];
  const ff = fromFile(o, gitCwd);
  const specs = [...o.pos, ...o.after, ...ff.specs];
  const withPaths = specs.length > 0 || ff.unknown;
  specs.filter(C.isSecretPath).forEach(f => found.add(f));
  if (!withPaths || gitOpt(o, ['include'], 'i')) take(C.git(gitCwd, [...Q, 'diff', '--cached', '--name-only', '-z']));
  if (!withPaths && gitOpt(o, ['all'], 'a')) take(C.git(gitCwd, [...Q, 'diff', '--name-only', '-z']));
  if (withPaths) {
    const sp = ff.unknown ? [':/'] : specs;
    let r = C.git(gitCwd, [...Q, 'diff', 'HEAD', '--name-only', '-z', '--', ...sp]);
    if (r.status !== 0) r = C.git(gitCwd, [...Q, 'ls-files', '-z', '--', ...sp]);   // 첫 커밋(HEAD 없음)
    take(r);
  }
  return found.size ? secretReason('커밋', [...found]) : null;
}

function secretReason(what, files) {
  return `비밀 파일로 보이는 ${C.listForReason(files, 10)} 을(를) ${what}하려 합니다. 이 파일은 빼고 필요한 파일만 경로로 지정해 add 하세요(비밀 파일은 .gitignore 에 추가). 이미 스테이징했다면 \`git restore --staged -- <file>\`.`;
}

// ── 삭제 ──
//   bash(GNU rm): 짧은 옵션 묶음 어디에든 r/R(-dfrv) · --recursive 약어.  PowerShell(Remove-Item 과 그 별칭): 매개변수 약어 · -Recurse:$true ·
//   -Path:값 · 쉼표 배열(a,b) · 괄호 식(값을 모름).  cmd(rd · del): /s · //s(Git Bash).  [2026-10-29 감사 — 모두 우회였다]
const RM_PS_TARGET = ['path', 'literalpath', 'pspath', 'lp'];
const RM_PS_VALUE = ['filter', 'include', 'exclude', 'credential', 'stream', 'erroraction', 'ea', 'warningaction', 'wa', 'informationaction', 'infa', 'errorvariable', 'ev',
  'warningvariable', 'wv', 'informationvariable', 'iv', 'outvariable', 'ov', 'outbuffer', 'ob', 'pipelinevariable', 'pv', 'progressaction', 'proga'];
const RM_PS_FLAG = ['recurse', 'force', 'whatif', 'confirm', 'usetransaction', 'verbose', 'debug'];
function checkDelete(p, args, mode, ctx, piped) {
  let recursive = p === 'rimraf';
  const targets = [];
  const push = v => { for (const t of String(v == null ? '' : v).split(',')) if (t) targets.push(t); };
  let endOpts = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (endOpts) { push(a); continue; }
    if (a === '--') { endOpts = true; continue; }
    if (/^\/{1,2}[sS]$/.test(a) && ['rmdir', 'rd', 'del', 'erase'].includes(p)) { recursive = true; continue; }
    if (/^\/{1,2}[a-zA-Z]$/.test(a) && ['rmdir', 'rd', 'del', 'erase'].includes(p)) continue;
    if (mode === 'ps' && /^-[A-Za-z]/.test(a)) {
      const m = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(a);
      if (!m) continue;
      const n = m[1].toLowerCase();
      const val = () => { if (m[2] != null) return m[2]; let v = args[++j]; while (v != null && v.endsWith(',') && args[j + 1] != null) v += args[++j]; return v; };
      if (RM_PS_VALUE.includes(n)) { val(); continue; }
      if ('recurse'.startsWith(n)) { recursive = m[2] == null || !/^\$?(false|0)$/i.test(m[2].trim()); continue; }
      if (RM_PS_TARGET.includes(n) || RM_PS_TARGET.some(x => x.startsWith(n))) { push(val()); continue; }
      if (n.length >= 2 && RM_PS_VALUE.some(x => x.startsWith(n))) { val(); continue; }
      if (!RM_PS_FLAG.some(x => x.startsWith(n)) && /r/.test(n)) recursive = true;   // rm -rf 같은 GNU 꼴 — 알 수 없으면 재귀로 본다
      continue;
    }
    if (/^--/.test(a)) { const n = a.slice(2).toLowerCase(); if (n && 'recursive'.startsWith(n)) recursive = true; continue; }
    if (/^-[^-]/.test(a)) { if (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)) recursive = true; continue; }
    if (mode === 'ps') { let v = a; while (v.endsWith(',') && args[j + 1] != null) v += args[++j]; push(v); continue; }
    targets.push(a);
  }
  // PowerShell 의 rm/rmdir/Remove-Item 은 폴더에 -Recurse 가 없으면 확인을 묻는다 — 재귀 삭제가 아니다.
  if (!recursive) return null;
  if (!targets.length) {
    // 파이프 입력(`Get-ChildItem | Remove-Item -Recurse` · `ls -A | xargs rm -rf`) — 앞 명령이 무엇을 넘기는지 알 때만 그 대상으로 본다.
    if (!piped) return null;
    const listed = listedTargets(piped, mode);
    if (!listed) return REASONS.unresolved + ' (대상: 파이프 입력)';
    targets.push(...listed);
  }
  for (const t0 of targets) {
    const t = mode === 'ps' && !C.IS_WIN ? t0.replace(/\\/g, '/') : t0;
    const d = isDangerousTarget(t, ctx);
    if (d) return deleteReason(d, t);
  }
  return null;
}
function deleteReason(d, t) {
  const why = d === 'unresolved' ? REASONS.unresolved : d === 'cwd' ? REASONS.cwdUnknown : REASONS.delete;
  return why + ` (대상: ${String(t).replace(new RegExp(SUB, 'g'), '$(…)').replace(new RegExp(MK, 'g'), '$(mktemp)')})`;
}

// 파이프로 지울 대상을 넘기는 목록 명령(ls · dir · find · Get-ChildItem · Get-Item)이 넘기는 것 — 폴더의 내용은 폴더와 같이 본다. 모르면 null.
const LISTERS = new Set(['ls', 'dir', 'gci', 'get-childitem', 'gi', 'get-item', 'find', 'fd']);
function listedTargets(up0, mode) {
  const up = up0.filter(x => x !== '' && x[0] !== HD);
  const p = prog(up[0]); const a = up.slice(1);
  if (!LISTERS.has(p)) return null;
  const paths = [], filters = [];
  const split = v => String(v == null ? '' : v).split(',').filter(Boolean);
  if (p === 'find' || p === 'fd') {
    let j = 0;
    for (; j < a.length && !/^[-(!]/.test(a[j]); j++) paths.push(a[j]);
    for (; j < a.length; j++) if (/^-i?name$/.test(a[j]) && a[j + 1] != null) filters.push(a[++j]);
  } else if (mode === 'ps' || /^(gci|get-childitem|gi|get-item)$/.test(p)) {
    for (let j = 0; j < a.length; j++) {
      const m = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(a[j]);
      if (!m) { paths.push(...split(a[j])); continue; }
      const n = m[1].toLowerCase(); const val = () => (m[2] != null ? m[2] : a[++j]);
      if (RM_PS_TARGET.includes(n) || (n.length >= 2 && RM_PS_TARGET.some(x => x.startsWith(n)))) paths.push(...split(val()));
      else if (n.length >= 2 && ['filter', 'include'].some(x => x.startsWith(n))) filters.push(...split(val()));
      else if (n.length >= 2 && ['exclude', 'depth', 'attributes'].some(x => x.startsWith(n))) val();
    }
  } else for (const x of a) if (!x.startsWith('-')) paths.push(x);
  if (!paths.length) paths.push('.');
  return filters.length ? paths.flatMap(pp => filters.map(f => pp.replace(/[\\/]+$/, '') + '/' + f)) : paths;
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
  if (!s || s.includes(SUB) || s.includes(MK)) return null;
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

// cwd 가 속한 저장소의 작업 트리 루트들(그 worktree · 메인 체크아웃)과 공통 git 디렉터리 — cwd 마다 한 번만 묻는다.
function rootsOf(cwd, ctx) {
  const cache = (ctx && ctx.rootCache) || {};
  if (cache[cwd]) return cache[cwd];
  const info = C.repoInfo(cwd);
  const roots = [];
  if (info) {
    roots.push(info.root);
    if (path.basename(info.common).toLowerCase() === '.git') roots.push(path.dirname(info.common));
  }
  return (cache[cwd] = { roots, common: info ? info.common : null });
}
function repoRootOf(cwd, ctx) { return rootsOf(cwd, ctx).roots[0] || null; }
const homeDirs = () => [os.homedir(), process.env.HOME, process.env.USERPROFILE].filter(Boolean).map(C.real);

// 글롭(* ? [..])을 실제 이름으로 펼친다(.g* · .??* 는 .git 과 맞는다). 셸과 달리 점 파일도 맞춘다 — 놓치는 쪽보다 막는 쪽.
function globRe(p) {
  let r = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') r += '.*';
    else if (c === '?') r += '.';
    else if (c === '[') {
      const e = p.indexOf(']', i + 2);
      if (e < 0) { r += '\\['; continue; }
      let cls = p.slice(i + 1, e); if (cls[0] === '!') cls = '^' + cls.slice(1);
      r += '[' + cls.replace(/\\/g, '\\\\') + ']'; i = e;
    } else r += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp('^' + r + '$', C.IS_WIN ? 'i' : '');
}
function globExpand(abs) {
  const root = path.parse(abs).root;
  let cur = [root];
  for (const part of abs.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    const next = [];
    if (!/[*?[]/.test(part)) for (const c of cur) next.push(path.join(c, part));
    else {
      const re = globRe(part);
      for (const c of cur) { let names = []; try { names = fs.readdirSync(c); } catch { /* 없는 폴더 — 맞는 것이 없다 */ } for (const n of names) if (re.test(n)) next.push(path.join(c, n)); }
    }
    cur = next.slice(0, 2000);
    if (!cur.length) break;
  }
  return cur;
}

// 어디로 갔는지 모르는 cwd 에서의 상대 경로 — 점 · 글롭뿐인 조각(. .. * .??*), .git, 세션 저장소 · 홈과 그 상위 폴더 이름에 맞는 조각이면 위험으로 본다.
function unknownRelDanger(s, ctx) {
  const comps = s.split(/[\\/]+/).filter(Boolean);
  if (!comps.length) return true;
  const names = new Set(['.git']);
  const addUp = p => { let x = C.real(p); for (;;) { const b = path.basename(x); if (b) names.add(b); const d = path.dirname(x); if (d === x) break; x = d; } };
  for (const r of rootsOf(ctx.cwd0 || ctx.cwd, ctx).roots) addUp(r);
  for (const h of homeDirs()) addUp(h);
  return comps.some(c => /^[.*?]+$/.test(c) || [...names].some(n => globRe(c).test(n)));
}

function isDangerousTarget(t, ctx) {
  let s = expandVars(String(t).trim().replace(/^["']|["']$/g, ''), ctx);
  // $(mktemp …) 가 방금 만든 경로(와 그 아래)는 지워도 된다 — `..` 로 벗어나거나 다른 치환이 섞이면 모른다.
  if (s.includes(MK)) return /^\u0006(?:[\\/]|$)/.test(s) && !hasDotDot(s) && !/[\u0001$%]/.test(s.slice(1)) ? false : 'unresolved';
  // 끝의 /* · /. 는 "그 폴더의 내용 전부" — 폴더 자체와 같이 본다.
  s = s.replace(/([\\/])\*$/, '$1').replace(/([\\/])\.$/, '$1');
  if (s === '*' || s === '.*' || s === '') s = '.';
  if (!ctx.cwdUnknown) s = s.replace(/^\$\{?PWD\}?(?=$|[\\/])/i, () => ctx.cwd);              // 셸의 $PWD = 지금 cwd
  if (/^[a-zA-Z]:[\\/]*$/.test(s)) return true;                                                  // 드라이브 루트(C:\) — 어느 플랫폼에서든 막는다
  if (ctx.cwdUnknown && !isAbsLike(s)) {
    if (s.includes(SUB) || /\$|%[^%]+%/.test(s)) return 'unresolved';
    if (ctx.cwdUnknown === 'temp' && !hasDotDot(s)) return false;
    return unknownRelDanger(s, ctx) ? 'cwd' : false;
  }
  const abs = resolveTarget(ctx.cwd, s);
  if (!abs) return unresolvedIsDangerous(s) ? 'unresolved' : false;
  if (/[*?[]/.test(abs)) { for (const h of globExpand(abs)) { const d = concreteDanger(h, ctx); if (d) return d; } return false; }
  return concreteDanger(abs, ctx);
}

// 실경로로 — 심볼릭 링크 · Windows 짧은 이름(C:\Users\RUNNER~1)으로 적힌 대상도 저장소 루트 · .git · 홈으로 알아본다(2026-10-13 CI 실측).
//   [2026-10-29 감사] 세션 저장소(처음 cwd 의 저장소)는 cd 로 그 밖에 나간 뒤에도 지킨다 — `cd .. && rm -rf repo` 가 통과했다.
function concreteDanger(abs, ctx) {
  const norm = C.real(abs);
  if (path.parse(norm).root && C.samePath(norm, path.parse(norm).root)) return true;          // / · C:\
  for (const h of homeDirs()) if (C.samePath(norm, h) || isAncestor(norm, h)) return true;
  for (const info of [rootsOf(ctx.cwd, ctx), rootsOf(ctx.cwd0 || ctx.cwd, ctx)]) {
    for (const r of info.roots) if (C.samePath(norm, r) || isAncestor(norm, r)) return true;
    // .git 과 그 아래(objects · refs · harness 상태) — 히스토리와 하네스 기록이 사라진다.
    const gitDirs = [...info.roots.map(r => path.join(r, '.git')), ...(info.common ? [info.common] : [])];
    for (const g of gitDirs) if (C.samePath(norm, g) || isAncestor(g, norm)) return true;
  }
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

// ── MCP 도구 ──
//   [2026-10-25 보안 구멍] mcp__ 도구는 모두 통과였다 — git · GitHub MCP 서버로 reset · checkout · commit · push · 직접 merge 가 guard 를 비켜 갔다.
//   이름(mcp__<서버>__<도구>)으로만 본다. 읽기(status · diff · log · show · get_* · list_* · search_*)와 이슈 · 댓글 도구는 그대로 둔다.
//   Codex 의 MCP 도구 이름은 다를 수 있다 — mcp__ 꼴만 다룬다.
//   [2026-10-29 감사] GitLab 병합 도구(merge_merge_request · accept_merge_request)가 없었고, 서버 이름에 git 글자가 없으면(gh · scm) 건너뛰었다 —
//   원격 쓰기에만 쓰이는 도구 이름(push_files · merge_pull_request …)과 git_<쓰기> 꼴은 서버 이름과 상관없이 막는다.
const MCP_GIT_WRITE = new Set(['reset', 'checkout', 'commit', 'add', 'create_branch', 'delete_branch', 'merge', 'rebase', 'push', 'pull', 'stash', 'clean', 'tag', 'cherry_pick', 'revert']);
const MCP_FORGE_WRITE = new Set(['push_files', 'merge_pull_request', 'create_or_update_file', 'delete_file', 'update_pull_request_branch', 'create_repository', 'fork_repository', 'create_branch',
  'merge_merge_request', 'accept_merge_request']);
const MCP_FORGE_ONLY = new Set(['push_files', 'merge_pull_request', 'create_or_update_file', 'update_pull_request_branch', 'merge_merge_request', 'accept_merge_request']);
const MCP_ROUTE = 'git 쓰기는 Bash · PowerShell 의 git 명령으로 하세요(guard 가 검사합니다 — 자기 파일만 `git add -- <파일>` · `git commit -m "<무엇을 왜>" -- <파일>`, 되돌리기는 `git revert`). push 는 사용자가 명시적으로 요청한 뒤 `node harness/cli.js push`, 병합은 사용자가 받아들인다고 말한 뒤 `node harness/cli.js accept <id>`.';
// git_branch 는 목록 보기다 — 지우는 인자가 있을 때만 쓰기로 본다.
function mcpDeletes(ti) {
  if (!ti || typeof ti !== 'object') return false;
  for (const [k, v] of Object.entries(ti)) {
    if (/^(delete|remove|force_delete|d|D)$/.test(k) && v) return true;
    if (typeof v === 'string' && /^(action|operation|op|mode|command|type)$/i.test(k) && /^(delete|remove|-d|-D|--delete)$/i.test(v.trim())) return true;
    if (Array.isArray(v) && v.some(x => /^(-d|-D|--delete)$/.test(String(x)))) return true;
  }
  return false;
}
function checkMcp(tool, ti) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (!m) return null;
  const server = m[1], name = m[2].toLowerCase().replace(/-/g, '_');
  const forgeMsg = () => `MCP 서버 \`${server}\` 의 \`${m[2]}\` 는 원격 저장소를 바꿉니다(push · 병합 · 파일 쓰기 · 브랜치/저장소 만들기 · 지우기) — 밖으로 나가는 일이라 막습니다. ${MCP_ROUTE} 이슈 · 댓글 · 읽기 도구는 그대로 됩니다.`;
  const ft = name.replace(/^(github|gitlab|gitea|bitbucket)_/, '');
  if (/github|gitlab|gitea|bitbucket/i.test(server)) return (MCP_FORGE_WRITE.has(ft) || ft.startsWith('delete_')) ? forgeMsg() : null;
  if (MCP_FORGE_ONLY.has(ft)) return forgeMsg();
  if (!/git/i.test(server) && !name.startsWith('git_')) return null;
  const t = name.replace(/^git_/, '');
  if (!(MCP_GIT_WRITE.has(t) || (t === 'branch' && mcpDeletes(ti)))) return null;
  const what = /^(push|pull)$/.test(t) ? '원격과 주고받는 git(push · pull)'
    : /^(merge|rebase|cherry_pick)$/.test(t) ? '브랜치를 통합하거나 히스토리를 다시 쓰는 git'
      : /^(reset|checkout|clean|stash)$/.test(t) ? '미커밋 변경을 지우거나 숨길 수 있는 git'
        : 'git 상태를 바꾸는 쓰기';
  return `MCP 서버 \`${server}\` 의 \`${m[2]}\` 는 ${what}입니다 — guard 가 검사할 수 없는 길이라 막습니다. ${MCP_ROUTE} 상태 · diff · log · show 같은 읽기 도구는 그대로 됩니다.`;
}

function decide(input, runtime, opts) {
  const tool = String(input.tool_name || '');
  if (!tool || tool === 'apply_patch') return null;
  if (tool.startsWith('mcp__')) return checkMcp(tool, input.tool_input);
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object') return null;
  const cwd = input.cwd && typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return null;   // 대화형 세션의 편집은 막지 않는다
  const c = ti.command != null ? ti.command : ti.cmd;
  const sid = input.session_id != null ? String(input.session_id) : null;
  // Codex 는 argv 배열(["powershell","-Command","…"] · ["bash","-lc","…"])로 줄 수 있다 — 이미 쪼개진 단어다.
  if (Array.isArray(c)) return c.length ? analyzeCommand(c.map(String), modeFor(tool, runtime), ctxFor({ cwd, sid })) : null;
  if (typeof c !== 'string' || !c.trim()) return null;
  return analyze(c, { cwd, sid, mode: modeFor(tool, runtime || C.detectRuntime(input)) });
}

// [2026-10-29 감사] 판정 중 예외는 허용으로 끝났다(onFailure:block 은 비 0 종료 · 시간 초과에만 걸린다) —
//   git · 삭제를 언급하는 명령이면 막는다(fail-closed). 그 밖은 열어 둔다. 둘 다 기록한다.
const RISKY_WORD = /(^|[^A-Za-z0-9_-])(git|rm|rmdir|rd|del|erase|ri|rimraf|remove-item|gh|glab)([^A-Za-z0-9_-]|$)/i;
function failClosed(input) {
  if (!input || typeof input !== 'object') return false;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const c = ti.command != null ? ti.command : ti.cmd;
  const text = Array.isArray(c) ? c.join(' ') : typeof c === 'string' ? c : '';
  return RISKY_WORD.test(text) || /^mcp__.*git/i.test(String(input.tool_name || ''));
}

function main() {
  let input = null;
  try {
    const r = C.readStdinJson();
    if (!r.input) { if (r.error !== 'empty stdin') C.logError('guard', r.error); return; }
    input = r.input;
    const reason = decide(input, C.detectRuntime(input));
    if (!reason) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[pilot guard] ${reason}` },
    }) + '\n');
  } catch (e) {
    C.logError('guard', e, input && input.cwd);
    if (failClosed(input)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[pilot guard] 명령을 검사하던 중 내부 오류가 났습니다 — git · 삭제 명령은 안전을 위해 막습니다. 명령을 더 단순하게(여러 번으로) 나눠 다시 시도하세요(오류는 .git/harness/hook-errors.log 에 남았습니다).' },
      }) + '\n');
    }
  }
}

if (require.main === module) { main(); process.exitCode = 0; }
module.exports = { lex, analyze, decide, isDangerousTarget, checkGit, checkMcp };

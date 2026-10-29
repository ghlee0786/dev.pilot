#!/usr/bin/env node
'use strict';
// hooks/guard.js — PreToolUse(셸 도구): 되돌릴 수 없는 명령만 막는다(설계 §0.8 · §7).
//   Claude: Bash · PowerShell  /  Codex: Bash(셸) — 둘 다 tool_input.command.  Claude 의 mcp__* 도구도 — git · GitHub 류 서버의 쓰기 도구를 막는다.
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
  const ctx = { cwd, root: undefined, depth: opts.depth || 0, cwdUnknown: !!opts.cwdUnknown, vars: opts.vars || {} };
  return ctx;
}

function analyze(command, opts) {
  const ctx = ctxFor(opts);
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

// $NAME · ${NAME} · $env:NAME · %NAME% → 같은 명령에서 정한 값 · 환경 변수(없으면 그대로 — 풀 수 없는 경로로 남는다)
function expandVars(s, ctx) {
  const v = name => { const k = String(name).toLowerCase(); if (ctx && ctx.vars && ctx.vars[k] != null) return ctx.vars[k]; const e = Object.keys(process.env).find(x => x.toLowerCase() === k); return e ? process.env[e] : null; };
  return String(s)
    .replace(/\$env:([A-Za-z_]\w*)/gi, (m, n) => v(n) != null ? v(n) : m)
    .replace(/%([A-Za-z_]\w*)%/g, (m, n) => v(n) != null ? v(n) : m)
    .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => { const n = a || b; if (/^pwd$/i.test(n) && ctx && ctx.cwd) return ctx.cwd; if (/^(home|null)$/i.test(n)) return m; return v(n) != null ? v(n) : m; });
}
function analyzeCommand(words0, mode, ctx) {
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
  const inner = { ...ctx, depth: ctx.depth + 1 };
  if (SHELLS.has(p)) {
    const k = args.findIndex(a => /^-[a-z]*c[a-z]*$/i.test(a) && !a.startsWith('--'));
    if (k >= 0 && args[k + 1] != null) return analyzeString(args[k + 1], 'bash', inner);
    return null;
  }
  if (PWSH.has(p)) {
    const k = args.findIndex(a => /^[-/](c|co|com|comm|comma|comman|command)$/i.test(a));
    if (k >= 0) return analyze(args.slice(k + 1).join(' '), { cwd: ctx.cwd, mode: 'ps', depth: ctx.depth + 1, cwdUnknown: ctx.cwdUnknown, vars: ctx.vars });
    const e = args.findIndex(a => /^[-/](e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedcommand)$/i.test(a));
    if (e >= 0 && args[e + 1]) {
      let decoded = '';
      try { decoded = Buffer.from(args[e + 1], 'base64').toString('utf16le'); } catch { decoded = ''; }
      if (decoded) return analyze(decoded, { cwd: ctx.cwd, mode: 'ps', depth: ctx.depth + 1, cwdUnknown: ctx.cwdUnknown, vars: ctx.vars });
    }
    const f = args.find(a => !a.startsWith('-'));
    if (f && !/\.ps1$/i.test(f)) return analyze(args.filter(a => !/^-/.test(a)).join(' '), { cwd: ctx.cwd, mode: 'ps', depth: ctx.depth + 1, cwdUnknown: ctx.cwdUnknown, vars: ctx.vars });
    return null;
  }
  if (p === 'cmd') {
    const k = args.findIndex(a => /^\/[ck]$/i.test(a));
    if (k >= 0) return analyze(args.slice(k + 1).join(' '), { cwd: ctx.cwd, mode: 'ps', depth: ctx.depth + 1, cwdUnknown: ctx.cwdUnknown, vars: ctx.vars });
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

// ── MCP 도구 ──
//   [2026-10-25 보안 구멍] mcp__ 도구는 모두 통과였다 — git · GitHub MCP 서버로 reset · checkout · commit · push · 직접 merge 가 guard 를 비켜 갔다.
//   이름(mcp__<서버>__<도구>)으로만 본다. 읽기(status · diff · log · show · get_* · list_* · search_*)와 이슈 · 댓글 도구는 그대로 둔다.
//   Codex 의 MCP 도구 이름은 다를 수 있다 — mcp__ 꼴만 다룬다.
const MCP_GIT_WRITE = new Set(['reset', 'checkout', 'commit', 'add', 'create_branch', 'delete_branch', 'merge', 'rebase', 'push', 'pull', 'stash', 'clean', 'tag', 'cherry_pick', 'revert']);
const MCP_FORGE_WRITE = new Set(['push_files', 'merge_pull_request', 'create_or_update_file', 'delete_file', 'update_pull_request_branch', 'create_repository', 'fork_repository', 'create_branch']);
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
  if (/github|gitlab|gitea|bitbucket/i.test(server)) {
    const t = name.replace(/^(github|gitlab|gitea|bitbucket)_/, '');
    if (!MCP_FORGE_WRITE.has(t) && !t.startsWith('delete_')) return null;
    return `MCP 서버 \`${server}\` 의 \`${m[2]}\` 는 원격 저장소를 바꿉니다(push · 병합 · 파일 쓰기 · 브랜치/저장소 만들기 · 지우기) — 밖으로 나가는 일이라 막습니다. ${MCP_ROUTE} 이슈 · 댓글 · 읽기 도구는 그대로 됩니다.`;
  }
  if (!/git/i.test(server)) return null;
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
  // Codex 는 argv 배열(["powershell","-Command","…"] · ["bash","-lc","…"])로 줄 수 있다 — 이미 쪼개진 단어다.
  if (Array.isArray(c)) return c.length ? analyzeCommand(c.map(String), modeFor(tool, runtime), { cwd, root: undefined, depth: 0, vars: {} }) : null;
  if (typeof c !== 'string' || !c.trim()) return null;
  return analyze(c, { cwd, mode: modeFor(tool, runtime || C.detectRuntime(input)) });
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
  }
}

if (require.main === module) { main(); process.exitCode = 0; }
module.exports = { lex, analyze, decide, isDangerousTarget, checkGit, checkMcp };

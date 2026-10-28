'use strict';
// v5 검사 — 발견 · 실행 · 요약 파싱 · 판정. 완료 판정은 사용자가 준 검사와 저장소의 기존 명령만 쓴다.
const fs = require('node:fs'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CHECK_TIMEOUT_MS = 15 * 60 * 1000, CAP = 256 * 1024;
const IS_WIN = process.platform === 'win32';
const DEFAULT_ALLOW = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'py', 'pytest', 'pip', 'dotnet', 'go', 'cargo', 'make', 'tsc', 'jest', 'vitest'];

// ── 명령 문자열 → argv ────────────────────────────────────────────────
// 셸 연산자(&& || | ; > <)가 있으면 셸 문자열 하나로 둔다(argv 길이 1 · 실행은 셸로).
const SHELL_OPS = /(^|\s)(&&|\|\||\||;|>>?|<|2>&1)(\s|$)/;
function splitCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return [];
  if (SHELL_OPS.test(s)) return [s];
  const out = []; let cur = '', q = null, any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}
const isShellString = argv => argv.length === 1 && /\s/.test(argv[0]);
const display = argv => isShellString(argv) ? argv[0] : argv.map(a => /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');

// ── 발견 ───────────────────────────────────────────────────────────────
function yamlTestCommand(file) {
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  return yamlTestCommandOf(text);
}
function yamlTestCommandOf(text) {
  if (text == null) return null;
  const m = /^\s*test_command:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  let v = m[1].replace(/\s+#.*$/, '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v && !/^(none|null|~|없음)$/i.test(v) ? v : null;
}
// 프로젝트 블록(AGENTS.md · CLAUDE.md 의 yaml)의 숫자 값 — 예: check_timeout_min: 45
function yamlNumber(root, name) {
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    let t = ''; try { t = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const m = new RegExp('^\\s*' + name + ':\\s*["\']?(\\d+(?:\\.\\d+)?)', 'm').exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}
// 프로젝트 블록의 문자열 값 — 예: reply_language: "Korean" · transcribe_command: "whisper \"{in}\" …". 없으면 null.
function yamlString(root, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    let t = ''; try { t = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const m = new RegExp('^[ \\t]*' + esc + ':[ \\t]*(.+?)[ \\t]*\\r?$', 'm').exec(t);
    if (!m) continue;
    let v = m[1];
    if (/^"/.test(v)) { try { v = JSON.parse(v.replace(/\s+#.*$/, '')); } catch { v = v.replace(/^"|"$/g, ''); } }
    else if (/^'/.test(v)) v = v.replace(/^'|'$/g, '');
    else v = v.replace(/\s+#.*$/, '');
    if (String(v).trim()) return String(v).trim();
  }
  return null;
}
// 프로젝트 블록의 문자열 목록 — 흐름형 `name: ["a", 'b', c]` 또는 블록형 `name:` 다음 줄들의 `- a`. 없으면 null.
//   예: worker_allow: ["Bash(docker build:*)"]. 따옴표 안의 쉼표·괄호는 값의 일부다.
function yamlListOf(text, name) {
  if (text == null) return null;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unq = v => { v = v.trim(); return (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) ? v.slice(1, -1) : v; };
  const flow = new RegExp('^[ \\t]*' + esc + ':[ \\t]*\\[(.*)$', 'm').exec(text);
  if (flow) {
    const s = flow[1], out = []; let cur = '', q = null, closed = false;
    for (let i = 0; i < s.length && !closed; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === ',' || c === ']') { if (cur.trim()) out.push(unq(cur)); cur = ''; if (c === ']') closed = true; continue; }
      cur += c;
    }
    return out.filter(Boolean);
  }
  const block = new RegExp('^([ \\t]*)' + esc + ':[ \\t]*(?:#.*)?\\r?$', 'm').exec(text);
  if (!block) return null;
  const out = [];
  for (const line of text.slice(block.index + block[0].length).split(/\r?\n/).slice(1)) {
    const m = /^[ \t]*-[ \t]+(.+?)[ \t]*$/.exec(line);
    if (!m) { if (!line.trim()) continue; break; }
    const v = /^["']/.test(m[1]) ? m[1] : m[1].replace(/[ \t]+#.*$/, '');
    if (unq(v)) out.push(unq(v));
  }
  return out;
}
function yamlList(root, name) {
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    let t = ''; try { t = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const v = yamlListOf(t, name);
    if (v) return v;
  }
  return null;
}
const readText = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };

// 저장소 종류 — 언어 팩(langs.js)이 정한다(PRD R5 · 언어 중립)
function repoKinds(root) { return require('./langs').detect(root); }

// 사용자 검사가 있으면 그것, 없으면 저장소에서 발견, 없으면 none.
// projectRoot: 프로젝트 블록(test_command)을 먼저 읽을 곳 — 부른 체크아웃. 지시 파일이 커밋 전이거나 git 밖(CLAUDE.md)이면 worktree 에는 옛 판이 있다
//   ([2026-10-03 · .NET 앱 저장소] 그래서 단위 테스트 대신 솔루션 전체 dotnet test 가 돌았다). 없으면 root(worktree).
function discover(root, userChecks, projectRoot) {
  const user = (userChecks || []).map(c => Array.isArray(c) ? c : splitCommand(c)).filter(a => a.length);
  if (user.length) return { source: 'user', commands: user };
  for (const dir of [...new Set([projectRoot, root].filter(Boolean))]) {
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const v = yamlTestCommand(path.join(dir, f));
      if (v) return { source: 'detected', commands: [splitCommand(v)], from: f };
    }
  }
  // 언어 팩 순서대로 처음 찾은 테스트 명령(node · python · dotnet · go · rust · java · c/c++)
  const t = require('./langs').testCommand(root);
  if (t) return { source: 'detected', commands: t.commands, from: t.from };
  return { source: 'none', commands: [] };
}

// 워커가 실행해도 되는 프로그램: 검사 명령의 argv[0] + 저장소 종류.
const KIND_ALLOW = new Proxy({}, { get: (_, k) => require('./langs').allowFor([String(k)]) });   // 언어 팩의 허용 프로그램
function programName(argv) {
  const first = isShellString(argv) ? splitCommand(argv[0].split(SHELL_OPS)[0])[0] : argv[0];
  if (!first) return null;
  const base = String(first).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');   // Windows 경로는 POSIX 에서도 \ 로 자른다
  return /^[A-Za-z0-9_.+-]+$/.test(base) ? base : null;
}
// 임의 실행기(M8): `Bash(bash:*)` 를 허용하면 워커가 무엇이든 돌린다(git push 포함). 사용자 검사가 `bash x.sh` 여도 넣지 않는다 —
//   검사는 하네스가 돌리고, 워커는 직접 그 스크립트를 부르지 못할 뿐이다. git 은 policy 가 따로 다룬다(읽기 전용만).
const NEVER_ALLOW = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'env', 'git', 'sudo', 'xargs', 'wsl', 'busybox', 'start', 'call']);
function allowCommands(root, checks) {
  const set = new Set();
  const lint = checks && checks.lint && checks.lint.command ? [splitCommand(String(checks.lint.command).replace(/{files}/g, ''))] : [];   // 작업자가 린트도 직접 돌릴 수 있게
  for (const argv of [...((checks && checks.commands) || []), ...lint]) {
    const p = programName(argv);
    if (p && NEVER_ALLOW.has(p.toLowerCase())) continue;
    if (p && (DEFAULT_ALLOW.includes(p) || (checks.source === 'user'))) set.add(p);
  }
  const kinds = repoKinds(root);
  for (const k of kinds) for (const p of KIND_ALLOW[k] || []) set.add(p);
  // [평가 2026-10-02] 빈 저장소(그린필드)는 종류를 모른다 — 허용이 비면 작업자가 만든 코드를 한 번도 못 돌린다. 기본 프로그램을 준다.
  //   (node 저장소에서 이미 주는 것과 같은 종류의 능력이다. git 은 여전히 deny · ref 보호가 막는다.)
  if (!kinds.length && !((checks && checks.commands) || []).length) for (const p of DEFAULT_ALLOW) set.add(p);
  return [...set];
}

// ── 린트(프로젝트 블록 lint_command) ───────────────────────────────────
// {files} 가 있으면 작업이 바꾼 파일(저장소 상대 · 있는 것만)로 바꾼 셸 문자열 하나 — 바뀐 파일이 없으면 null(돌리지 않는다).
//   {files} 가 없으면 저장소 전체를 린트하는 명령 그대로.
const shq = f => /^[A-Za-z0-9_.,:=+/\@-]+$/.test(f) ? f : `"${String(f).replace(/"/g, '\\"')}"`;
function lintArgv(cmd, files) {
  const c = String(cmd || '').trim();
  if (!c) return null;
  if (!/{files}/.test(c)) return splitCommand(c);
  if (!(files || []).length) return null;
  return [c.replace(/{files}/g, files.map(shq).join(' '))];
}
// [자동 이슈 #38] 작업에 기록된 린트를 프로젝트 블록의 지금 lint_command 에 맞춘다(resume · accept) — 작업 뒤 {files} 로 바꿔도
//   시작 때 값으로 계속 거절했다. dirs 순서대로 처음 찾은 값을 쓴다. 바뀌었으면 { from, to }, 그대로면 null.
function syncLint(task, dirs) {
  let now = null;
  for (const d of dirs) { if (d && (now = yamlString(d, 'lint_command'))) break; }
  const was = task.checks.lint ? task.checks.lint.command : null;
  if ((now || null) === (was || null)) return null;
  if (now) task.checks.lint = { command: now, files: /{files}/.test(now), baseline_ok: null, last: null };
  else delete task.checks.lint;
  return { from: was, to: now || null };
}

// ── 검사 정의(M6) ─────────────────────────────────────────────────────
// 검사 명령 문자열은 작업 시작 때 고정되지만, 그 명령이 읽는 정의(package.json scripts.test · pytest 설정 · 명령이 가리키는 스크립트)는
//   모델이 worktree 에서 고칠 수 있다. 고쳤으면 보고하고(checks_modified), npm test 는 기준의 scripts.test 로 판정한다.
const scriptsOf = text => { try { const s = JSON.parse(text).scripts; return s && typeof s === 'object' ? s : {}; } catch { return null; } };
function npmTestScript(root) { const s = scriptsOf(readText(root, 'package.json')); return s && typeof s.test === 'string' ? s.test : null; }
const argvOf = c => Array.isArray(c) ? (isShellString(c) ? splitCommand(c[0].split(SHELL_OPS)[0]) : c) : splitCommand(String(c || ''));
function isNpmTest(argv) {
  if (isShellString(argv)) return false;
  const p = programName(argv), rest = argv.slice(1).join(' ');
  return p === 'npm' && /^(test|t|tst|run test|run-script test)$/.test(rest);
}
// 작업 시작 때 기록해 둘 정의.
function definitions(root) { return { npm_test: npmTestScript(root) }; }
// 판정에 쓸 명령: npm test 인데 scripts.test 가 기준과 다르면 기준의 스크립트를 셸로(npm 처럼 node_modules/.bin 을 PATH 앞에).
function commandsForJudge(root, checks) {
  const defs = (checks && checks.defs) || {};
  return ((checks && checks.commands) || []).map(argv => {
    if (!isNpmTest(argv) || typeof defs.npm_test !== 'string') return argv;
    if (npmTestScript(root) === defs.npm_test) return argv;
    return { argv: [defs.npm_test], shell: true, bin: path.join(root, 'node_modules', '.bin'), label: `${display(argv)} (judged with scripts.test from the base commit: ${defs.npm_test})` };
  });
}
function iniSection(text, re) {
  if (text == null) return null;
  const lines = String(text).split(/\r?\n/), out = []; let on = false;
  for (const l of lines) { if (/^\s*\[/.test(l)) on = re.test(l); if (on) out.push(l.trimEnd()); }
  return out.join('\n');
}
// 바뀐 검사 정의 파일 목록. o = { changed: [저장소 상대], commands, source, from, readBase(rel), readHead(rel) } (읽을 수 없으면 null).
function checksModified(o) {
  const changed = new Set((o.changed || []).map(f => f.replace(/\\/g, '/')));
  const out = new Set();
  const differs = (rel, pick) => changed.has(rel) && pick(o.readBase(rel)) !== pick(o.readHead(rel));
  const cmds = (o.commands || []).map(argvOf);
  const programs = new Set(cmds.map(a => programName(a)).filter(Boolean));
  const tokens = cmds.flat().map(t => String(t).replace(/\\/g, '/').replace(/^\.\//, ''));
  if ([...programs].some(p => ['npm', 'pnpm', 'yarn'].includes(p))) {
    const pick = t => { const s = t == null ? null : scriptsOf(t); return s ? JSON.stringify([s.pretest, s.test, s.posttest]) : null; };
    if (differs('package.json', pick)) out.add('package.json');
  }
  if (tokens.some(t => /(^|\/)pytest(\.exe)?$/i.test(t)) || programs.has('pytest')) {
    for (const rel of changed) if (rel === 'pytest.ini' || /(^|\/)conftest\.py$/.test(rel)) out.add(rel);
    if (differs('pyproject.toml', t => iniSection(t, /^\s*\[tool\.pytest/))) out.add('pyproject.toml');
    if (differs('setup.cfg', t => iniSection(t, /^\s*\[tool:pytest\]/))) out.add('setup.cfg');
    if (differs('tox.ini', t => iniSection(t, /^\s*\[pytest\]/))) out.add('tox.ini');
  }
  for (const f of ['CLAUDE.md', 'AGENTS.md']) if (o.from === f && differs(f, yamlTestCommandOf)) out.add(f);
  // 명령이 가리키는 파일(node check.js · node tests/run.js · python -m pytest tests/x.py …) — 기준에 있던 것만.
  for (const t of tokens) if (t && !t.startsWith('-') && changed.has(t) && o.readBase(t) != null) out.add(t);
  return [...out].sort();
}

// ── 요약 파싱 ─────────────────────────────────────────────────────────
function lastNum(s, re) { let m, v = null; const g = new RegExp(re.source, 'gim'); while ((m = g.exec(s))) v = Number(m[1]); return v; }
// node:test(tap `# pass` · spec `ℹ pass`) · `결과: N PASS / M FAIL` · pytest `== 2 failed, 3 passed in 0.1s ==` · dotnet `Failed: 1, Passed: 3` · jest/vitest `Tests: 1 failed, 3 passed`.
function parseSummary(text) {
  const s = String(text || '');
  const p = lastNum(s, /^[ \t]*(?:#|ℹ)[ \t]*pass[ \t]+(\d+)[ \t]*\r?$/), f = lastNum(s, /^[ \t]*(?:#|ℹ)[ \t]*fail[ \t]+(\d+)[ \t]*\r?$/);
  if (p != null || f != null) return { found: true, pass: p || 0, fail: f || 0 };
  const kr = [...s.matchAll(/결과:\s*(\d+)\s*PASS\s*\/\s*(\d+)\s*FAIL/g)].pop();
  if (kr) return { found: true, pass: Number(kr[1]), fail: Number(kr[2]) };
  const py = [...s.matchAll(/^=+ (.*?\b(?:passed|failed|error|errors)\b.*?) in [\d.]+s(?: \([^)]*\))? =+\s*$/gm)].pop();
  if (py) { const n = w => { const m = new RegExp(`(\\d+) ${w}`).exec(py[1]); return m ? Number(m[1]) : 0; }; return { found: true, pass: n('passed'), fail: n('failed') + n('errors?') }; }
  // [2026-09-30 실측 · Python 서비스 저장소] `pytest -q`(와 -n auto)의 마지막 줄에는 === 테두리가 없다: "2 failed, 7070 passed, 66 skipped in 312.45s (0:05:12)"
  const pyq = [...s.matchAll(/^[ \t]*((?:\d+ (?:failed|passed|skipped|deselected|xfailed|xpassed|warnings?|errors?)(?:, )?)+) in [\d.]+s(?: \([^)]*\))?[ \t]*\r?$/gm)].pop();
  if (pyq && /\b(passed|failed|errors?)\b/.test(pyq[1])) { const n = w => { const m = new RegExp(`(\\d+) ${w}\\b`).exec(pyq[1]); return m ? Number(m[1]) : 0; }; return { found: true, pass: n('passed'), fail: n('failed') + n('errors?') }; }
  // dotnet(VSTest): 테스트 프로젝트마다 한 줄 — 모두 더한다. 한국어 Windows 에서는 "실패!  - 실패: 1, 통과: 9, …"(2026-10-03 실측).
  const dn = [...s.matchAll(/(?:Failed|실패):\s*(\d+),\s*(?:Passed|통과):\s*(\d+)/g)];
  if (dn.length) return { found: true, pass: dn.reduce((a, m) => a + Number(m[2]), 0), fail: dn.reduce((a, m) => a + Number(m[1]), 0) };
  const mtp = [...s.matchAll(/^\s*Test summary: total: \d+, failed: (\d+), succeeded: (\d+)/gm)].pop();   // dotnet 10 Microsoft.Testing.Platform
  if (mtp) return { found: true, pass: Number(mtp[2]), fail: Number(mtp[1]) };
  const js = [...s.matchAll(/^\s*Tests:\s+(.*)$/gm)].pop();
  if (js && /\b(passed|failed)\b/.test(js[1])) { const n = w => { const m = new RegExp(`(\\d+) ${w}`).exec(js[1]); return m ? Number(m[1]) : 0; }; return { found: true, pass: n('passed'), fail: n('failed') }; }
  const lg = require('./langs').parseSummary(s);   // cargo · go · ctest · maven(언어 팩)
  if (lg) return lg;
  return { found: false, pass: 0, fail: 0 };
}

// ── 실행 ───────────────────────────────────────────────────────────────
function killTree(pid) {
  if (pid == null) return;
  if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 끝남 */ } } }
}
function childEnv(binDir) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|NODE_TEST_CONTEXT)$/.test(k)) delete env[k];
  if (binDir) {   // Windows 의 이름은 Path — 대소문자를 가리지 않고 같은 키를 고친다.
    const k = Object.keys(env).find(x => x.toUpperCase() === 'PATH') || 'PATH';
    env[k] = binDir + path.delimiter + (env[k] || '');
  }
  return env;
}
const winQuote = a => /^[A-Za-z0-9_.,:=+\/\\@-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`;
// Windows cmd 는 실행 파일 경로의 '/' 를 스위치로 읽는다('tools/bin/ok.cmd' → 'tools' + '/bin…') — 명령마다 첫 단어의 '/' 를 '\' 로.
//   [2026-10-18 자동 이슈 #18] --check '.venv/Scripts/python -m pytest' 가 매번 실패해 정체됐다. 인자(경로 · URL)는 건드리지 않는다.
const winProg = tok => (/\//.test(tok) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(tok) && !/^-/.test(tok) ? tok.replace(/\//g, '\\') : tok);
const winShell = s => String(s).replace(/(^|&&|\|\||\||;)(\s*)("[^"]*"|[^\s"&|;]+)/g, (m, op, sp, tok) => op + sp + winProg(tok));
function spawnSpec(argv, forceShell) {
  if (forceShell || isShellString(argv)) return { cmd: IS_WIN ? winShell(argv.join(' ')) : argv.join(' '), args: [], shell: true };
  if (/^node(\.exe)?$/i.test(argv[0])) return { cmd: process.execPath, args: argv.slice(1), shell: false };
  // Windows: npm·npx 등은 .cmd — 셸 없이 띄울 수 없다.
  if (IS_WIN) return { cmd: [winProg(argv[0]), ...argv.slice(1)].map(winQuote).join(' '), args: [], shell: true };
  return { cmd: argv[0], args: argv.slice(1), shell: false };
}

// 출력이 이만큼 멈추면 멈춘 것으로 본다 — 멈춘 테스트를 떼어 낼 줄 아는 러너(언어 팩 hang)에만. o.stallMs: 0 이면 끔.
const STALL_MS = Number(process.env.HARNESS_CHECK_STALL_MS) || 5 * 60 * 1000;   // 환경 값은 테스트용
// 검사의 부모가 끝난 뒤 남은 출력을 기다리는 시간 — 그 뒤에도 파이프가 닫히지 않으면 자손이 붙든 것으로 본다(#53).
const EXIT_GRACE_MS = 3000;
function runCheck(cwd, argv, o) {
  const timeoutMs = Math.max(1000, (o && o.timeoutMs) || CHECK_TIMEOUT_MS);
  const opt = o || {};
  const stallMs = opt.stallMs != null ? opt.stallMs : (require('./langs').hangFor(argv) ? STALL_MS : 0);
  return new Promise(resolve => {
    const t0 = Date.now(), spec = spawnSpec(argv, opt.shell);
    let out = '', total = 0, tail = '', timedOut = false, stalled = false, done = false, child, timer, stallTimer;
    const stop = why => { if (done || timedOut) return; timedOut = true; stalled = why === 'stall'; killTree(child.pid); setTimeout(() => finish(null), 5000).unref(); };
    const arm = () => { if (!stallMs) return; clearTimeout(stallTimer); stallTimer = setTimeout(() => stop('stall'), stallMs); };
    const push = b => { arm(); total += b.length; const s = b.toString('utf8'); if (out.length < CAP) out += s; else tail = (tail + s).slice(-CAP); };
    const finish = (code, err) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(stallTimer);
      const output = out + (tail ? `\n…[${total - out.length - tail.length} bytes omitted]…\n` + tail : '') + (err ? `\n[spawn error] ${err}` : '');
      const s = parseSummary(output);
      const ok = code === 0 && !timedOut && !(s.found && s.fail > 0);
      resolve({ command: opt.label || display(argv), argv, exit_code: code, timed_out: timedOut, ...(stalled ? { stalled: true } : {}), found: s.found, pass: s.found ? s.pass : (ok ? 1 : 0), fail: s.found ? s.fail : (ok ? 0 : 1), ok, output, ms: Date.now() - t0 });
    };
    try { child = spawn(spec.cmd, spec.args, { cwd, env: { ...childEnv(opt.bin), ...require('./proc').isolationEnv(cwd) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: spec.shell, detached: !IS_WIN }); }
    catch (e) { return finish(null, e.message); }
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    arm();
    child.stdout.on('data', push); child.stderr.on('data', push);
    child.on('error', e => finish(null, e.message));
    child.on('close', code => finish(code));
    // [2026-10-28 자동 이슈 #53] 검사(dotnet test)는 끝났는데 남은 자손(MSBuild 노드 · nodeReuse)이 출력 파이프를 붙들어 'close' 가 오지 않았다 —
    //   결과가 상한(15분)까지 돌아오지 않았다. 부모가 끝나면 잠시 남은 출력을 받고, 그래도 닫히지 않으면 남은 자손을 거두고 결과를 낸다.
    child.on('exit', code => {
      if (done || timedOut) return;
      const t = setTimeout(() => {
        if (done || timedOut) return;
        // 부모는 이미 거둬졌다 — 그 pid 하나에 신호를 보내지 않는다(재사용됐을 수 있다). 그룹 · 자손 목록으로만 거둔다.
        try { require('./resources').reapDescendants(child.pid, t0); } catch { /* 거두기 실패는 결과를 막지 않는다 */ }
        try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* 이미 닫힘 */ }
        finish(code);
      }, EXIT_GRACE_MS);
      t.unref();
    });
  });
}

// o.serialRoot 가 있으면 그 프로젝트의 검사를 하나씩 돌린다(잠금 "checks" · 프로젝트 블록 serial_checks: true).
//   [2026-10-15 자동 이슈 #4] 같은 시험 DB 를 쓰는 작업 둘이 동시에 검사하다 서로 멈췄다. 기다리는 동안 이벤트 루프를 막지 않는다(stop 을 받는다).
async function runAll(cwd, commands, o) {
  if (o && o.serialRoot) {
    const S = require("./state"); let h;
    for (;;) {
      try { h = S.acquire(o.serialRoot, "checks"); break; }
      catch (e) { if (e.code !== "LOCK_HELD") throw e; await new Promise(r => setTimeout(r, 1000)); }
    }
    try { return await runAll(cwd, commands, { ...o, serialRoot: null }); } finally { h.release(); }
  }
  const results = [];
  // 항목은 argv 배열, 또는 { argv, shell, bin, label }(commandsForJudge 가 만든 대체 명령).
  for (const c of commands || []) {
    if (Array.isArray(c)) results.push(await runCheck(cwd, c, o));
    else results.push(await runCheck(cwd, c.argv, { ...(o || {}), shell: c.shell, bin: c.bin, label: c.label }));
  }
  return summarize(results);
}
// 실패한 검사는 한 번 더 돌린다 — 다시 돌려 통과하면 불안정(flaky)이다. 그 결과로 판정하고 불안정한 명령 이름을 돌려준다.
//   [2026-10-03 실측] 코드 변경 없이 1 · 2 · 16 건 실패 후 통과 — 작업자가 없는 버그를 고치느라 이어 가기를 썼다. 모델 판정이 아니라 재실행이다.
async function runJudged(cwd, commands, o) {
  const first = await runAll(cwd, commands, o);
  if (first.ok || (o && o.rerun === false)) return { judged: first, flaky: [] };
  const idx = first.results.map((r, i) => (r.ok || r.timed_out ? -1 : i)).filter(i => i >= 0);
  if (!idx.length) return { judged: first, flaky: [] };
  const again = await runAll(cwd, idx.map(i => commands[i]), o);
  const results = first.results.slice(), flaky = [];
  idx.forEach((i, k) => { results[i] = again.results[k]; if (again.results[k].ok) flaky.push(first.results[i].command); });
  return { judged: summarize(results), flaky };
}
// 멈춘 테스트 떼어 내기 — 기준선에서 시간 초과된 검사의 멈춘 테스트를 언어 팩이 짚어 빼고 다시 돌린다(최대 4번).
//   [2026-10-20 실측 · 음성 비서 Python 저장소] 오디오 장치를 기다리는 테스트 하나가 2% 지점에서 영원히 멈춰, 전체 pytest 가 매번 15분 상한에 걸렸다 —
//   찾은 검사는 버려져 검사 없이 돌았고, 사용자가 준 검사였다면 작업이 끝날 수 없었다. 뺀 테스트는 보고서에 남긴다(조용히 빼지 않는다).
//   → { argv, excluded: [테스트], result } · 떼어 낼 수 없으면 null
async function isolateHangs(cwd, argv, o) {
  const hang = (o && o.hang) || require('./langs').hangFor(argv);   // o.hang: 테스트가 끼우는 가짜 러너
  if (!hang) return null;
  let cur = argv.slice();
  const excluded = [];
  for (let i = 0; i < 4; i++) {
    const r = await runCheck(cwd, cur, { ...o, stallMs: o && o.stallMs != null ? o.stallMs : STALL_MS });
    if (!r.timed_out) return excluded.length ? { argv: cur, excluded, result: r } : null;
    const step = hang.next(cur, r.output);
    if (!step) return null;
    if (step.exclude) excluded.push(step.exclude);
    cur = step.argv;
  }
  return null;
}
function summarize(results) {
  return { ok: results.every(r => r.ok), pass: results.reduce((a, r) => a + r.pass, 0), fail: results.reduce((a, r) => a + r.fail, 0), results };
}
// 기록용(출력 제외).
const brief = j => j && { ok: j.ok, pass: j.pass, fail: j.fail, results: j.results.map(r => ({ command: r.command, ok: r.ok, pass: r.pass, fail: r.fail, exit_code: r.exit_code, timed_out: r.timed_out, found: r.found })) };

// 통과, 또는 기준선이 빨갔고 나빠지지 않음: 기준선에서 통과하던 명령은 여전히 통과 · 실패하던 명령의 실패 수는 늘지 않음.
//   "나빠지지 않음" 은 저장소에 원래 있던(발견된) 검사에만 쓴다 — 사용자가 준 검사는 새 동작을 묘사하므로 기준선이 빨간 게
//   당연하고, 거기에 "나빠지지 않음" 을 쓰면 아무것도 안 한 턴이 done 이 된다(opts.notWorse=false).
//   "나빠지지 않음" 은 증명할 수 있을 때만(H3) — 명령마다:
//     기준선 통과 → 지금도 통과 · 요약을 읽을 수 없으면(기준선이든 지금이든) 판정 불가 = 나빠짐 · 시간 초과가 새로 생김 = 나빠짐 ·
//     요약은 0 fail 인데 exit≠0(기준선과 같은 상태가 아니면) = 설명 안 되는 실패 = 나빠짐 · fail 증가 · pass 감소 · 전체 수 감소(테스트 삭제) = 나빠짐.
function worseThan(r, b) {
  if (!b) return true;
  if (b.ok) return !r.ok;
  if (!r.found || !b.found) return true;
  if (r.timed_out && !b.timed_out) return true;
  const exitBad = x => x.exit_code !== 0;
  if (r.fail === 0 && exitBad(r) && !(b.fail === 0 && b.exit_code === r.exit_code)) return true;
  if (exitBad(r) && !exitBad(b)) return true;
  return r.fail > b.fail || r.pass < b.pass || (r.pass + r.fail) < (b.pass + b.fail);
}
function judge(current, baseline, opts) {
  if (current.ok) return { verdict: 'pass', why: 'all checks pass' };
  const allow = !opts || opts.notWorse !== false;
  if (allow && baseline && !baseline.ok && baseline.results && baseline.results.length === current.results.length) {
    const worse = current.results.some((r, i) => worseThan(r, baseline.results[i]));
    if (!worse) return { verdict: 'not_worse', why: `baseline was red — the checks were already failing before the task (baseline ${baseline.pass} pass / ${baseline.fail} fail); now ${current.pass} pass / ${current.fail} fail — not worse, but the checks do not prove this work` };
  }
  return { verdict: 'fail', why: `${current.fail} failing` };
}

// ── 실패 서명 · 발췌 ──────────────────────────────────────────────────
const clean = l => l.replace(/\s*\(\d+(?:\.\d+)?m?s\)/g, '').replace(/\s+/g, ' ').trim();
const HEADER = /^\s*(?:Uncaught\s+)?[A-Za-z_$][\w$]*(?:Error|Exception)(?:\s*\[[^\]]+\])?:|^E\s{2,}\S/;
function firstAssertion(r) {
  const lines = String(r.output || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!HEADER.test(lines[i])) continue;
    const parts = [];
    for (let j = i; j < lines.length && parts.length < 4; j++) {
      const t = lines[j].trim();
      if (j > i && /^at\s/.test(t)) break;
      if (t) parts.push(clean(t));
    }
    return parts.join(' ').slice(0, 300);
  }
  const named = lines.find(l => /^\s*✖\s/.test(l) || /^not ok \d+/.test(l));
  if (named) return clean(named);
  if (r.timed_out) return 'TIMEOUT';
  const last = lines.map(l => l.trim()).filter(Boolean).slice(-3).join(' | ');
  return clean(last).slice(0, 300) || `exit ${r.exit_code}`;
}
function signature(judged) {
  return JSON.stringify(judged.results.filter(r => !r.ok).map(r => [r.command, r.fail, firstAssertion(r)]));
}
function clip(text, head, tail) {
  const s = String(text == null ? '' : text);
  if (s.length <= head + tail) return s;
  return s.slice(0, head) + `\n…[${s.length - head - tail} chars omitted]…\n` + s.slice(s.length - tail);
}
function failureExcerpt(judged) {
  return judged.results.filter(r => !r.ok).map(r =>
    `### \`${r.command}\` — exit ${r.exit_code == null ? 'none' : r.exit_code}${r.timed_out ? ' (timed out)' : ''}${r.found ? ` · ${r.pass} pass / ${r.fail} fail` : ''}\n\`\`\`\n${clip(r.output, 1500, 2500).trim()}\n\`\`\``).join('\n\n');
}

module.exports = { lintArgv, syncLint, yamlNumber, yamlString, yamlList, yamlListOf, spawnSpec, DEFAULT_ALLOW, NEVER_ALLOW, CHECK_TIMEOUT_MS, splitCommand, display, isShellString, discover, repoKinds, allowCommands, programName, parseSummary,
  runCheck, runAll, runJudged, isolateHangs, STALL_MS, summarize, brief, judge, worseThan, signature, firstAssertion, failureExcerpt, clip, killTree, childEnv,
  definitions, commandsForJudge, checksModified, isNpmTest, npmTestScript, yamlTestCommandOf };

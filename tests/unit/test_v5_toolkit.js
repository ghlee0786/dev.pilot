'use strict';
// 도구 점검(toolkit) — 저장소 스택(빌드 파일 · 깊이 무관) · 설치된 스킬 · 플러그인 · MCP(사용자 · 저장소 · Codex) · 주의할 MCP(보관된 서버) ·
//   세션 시작 한 줄(저장소마다 하루 한 번 · 끌 수 있다) · CLI. 사용자 HOME 은 읽지 않는다(HARNESS_TOOLKIT_HOME · CODEX_HOME 을 임시로).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const R = makeReporter('도구 점검 — 스택 · 설치 목록 · 없는 것 · 주의 · 세션 시작 한 줄');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-toolkit-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const WIN = process.platform === 'win32';
function repo(name, files) {
  const d = path.join(base, name); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false');
  for (const [f, t] of Object.entries(files)) write(path.join(d, f), t);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
const saved = {}; for (const k of ['HARNESS_TOOLKIT_HOME', 'CODEX_HOME', 'HARNESS_TOOLKIT_HINT']) { saved[k] = process.env[k]; delete process.env[k]; }

try {
  const T = require('../../harness/lib/toolkit');
  // 저장소: Qt 는 두 단계 아래 CMakeLists 에만 · 커밋된 CMake 빌드 산출물(.sln)은 .NET 이 아니다
  const rq = repo('qtapp', { 'CMakeLists.txt': 'project(x)\nadd_subdirectory(apps/client)\n', 'apps/client/CMakeLists.txt': 'find_package(Qt6 REQUIRED COMPONENTS Widgets)\n', 'apps/client/main.cpp': 'int main(){}\n', 'apps/client/build/check/Project.sln': 'x\n' });
  const rd = repo('wpf', { 'App/App.csproj': '<Project><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>\n' });
  const re = repo('empty', { 'README.md': 'x\n' });
  const sq = T.stacks(rq), sd = T.stacks(rd);
  R.check('[TK-01] 스택: 두 단계 아래 CMakeLists 의 Qt 를 찾는다 · 커밋된 빌드 산출물 .sln 은 .NET 이 아니다 · .csproj 는 .NET', sq.includes('cpp') && sq.includes('qt') && !sq.includes('dotnet') && sd.includes('dotnet'), JSON.stringify({ sq, sd }));

  // 빈 HOME: 맞는 도구가 하나도 없다
  const h0 = path.join(base, 'home0'); fs.mkdirSync(h0, { recursive: true });
  process.env.CODEX_HOME = path.join(base, 'codex0');
  const c0 = T.check({ root: rq, home: h0 }), ids0 = c0.missing.map(e => e.id);
  R.check('[TK-02] 빈 HOME · C++/Qt 저장소: clangd-lsp · qt-agent-skills · context7 가 없다고 나온다(Windows 면 Microsoft Learn 도) · .NET 도구는 나오지 않는다',
    ['clangd-lsp', 'qt-agent-skills', 'context7'].every(x => ids0.includes(x)) && ids0.includes('microsoft-learn-mcp') === WIN && !ids0.includes('csharp-lsp') && !ids0.includes('dotnet-skills'), JSON.stringify(ids0));

  // 설치된 HOME: 플러그인 · 스킬 · 사용자 MCP · 저장소 MCP(.claude.json projects · .mcp.json) · Codex MCP 를 모두 읽는다
  const h1 = path.join(base, 'home1');
  const wrapper = path.join(h1, '.claude', 'mcp', 'github-mcp.cmd');
  write(wrapper, '@echo off\r\nnpx -y @modelcontextprotocol/server-github\r\n');
  write(path.join(h1, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'clangd-lsp@claude-plugins-official': [{ scope: 'user' }] } }));
  fs.mkdirSync(path.join(h1, '.claude', 'skills', 'qt-cpp-review'), { recursive: true });
  write(path.join(h1, '.claude.json'), JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, github: { command: 'cmd', args: ['/c', wrapper] } },
    projects: { [rq.replace(/\\/g, '/')]: { mcpServers: { 'ms-docs': { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } } } } }));
  process.env.CODEX_HOME = path.join(base, 'codex1');
  write(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "x"\n[mcp_servers.windbg]\ncommand = "uvx"\n[mcp_servers.windbg.env]\nA = "1"\n');
  const c1 = T.check({ root: rq, home: h1 }), ids1 = c1.missing.map(e => e.id);
  R.check('[TK-03] 설치된 것은 없다고 하지 않는다: 플러그인(clangd) · 스킬(qt-…) · 사용자 MCP(context7) · 저장소 MCP(Microsoft Learn) · Codex MCP(windbg)',
    !['clangd-lsp', 'qt-agent-skills', 'context7', 'microsoft-learn-mcp', 'mcp-windbg'].some(x => ids1.includes(x)) && c1.installed.includes('clangd-lsp') && c1.inventory.mcp.some(m => m.scope === 'codex' && m.name === 'windbg') && c1.inventory.mcp.filter(m => m.name === 'windbg').length === 1,
    JSON.stringify({ ids1, installed: c1.installed, mcp: c1.inventory.mcp.map(m => [m.name, m.scope]) }));
  R.check('[TK-04] 주의: 래퍼 스크립트 안의 보관된 github 참조 서버를 찾아 알린다', c1.warnings.some(w => w.id === 'github-archived' && w.mcp === 'github'), JSON.stringify(c1.warnings));
  const txt = T.format(c1);
  R.check('[TK-05] 보고: 스택 · 설치 수 · 지금/시험 · 설치 방법 · 주의 · 목록 기준일 · 읽기만 한다', /스택: cpp, qt/.test(txt) && /설치됨: 스킬 1 · 플러그인 1/.test(txt) && /주의:/.test(txt) && /목록 기준일 2026-10-25/.test(txt) && /읽기만 한다/.test(txt), txt);

  // 세션 시작 한 줄 — 지금 넣을 것이 없고 주의도 없으면 null
  const h2 = path.join(base, 'home2');
  write(path.join(h2, '.claude.json'), JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['@upstash/context7-mcp'] } } }));
  process.env.CODEX_HOME = path.join(base, 'codex0');
  R.check('[TK-06] 한 줄: 없는 도구 · 주의가 있으면 이름과 toolkit 명령 · 모두 있으면 null(조용히)', /clangd-lsp/.test(T.hint({ root: rq, home: h0 }) || '') && /toolkit/.test(T.hint({ root: rq, home: h0 }) || '') && T.hint({ root: re, home: h2 }) === null,
    String(T.hint({ root: re, home: h2 })));

  // board 훅 SessionStart: 저장소마다 하루 한 번 · HARNESS_TOOLKIT_HINT=off 면 없음
  const HOOK = path.join(__dirname, '..', '..', 'harness', 'hooks', 'board.js');
  const env = { ...process.env, HARNESS_TOOLKIT_HOME: h0, CODEX_HOME: path.join(base, 'codex0'), HARNESS_AGENTS: 'off' };
  for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE', 'GIT_DIR', 'GIT_WORK_TREE']) delete env[k];
  const start = (sid, e) => { const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, cwd: rq, source: 'startup' }), encoding: 'utf8', env: e, windowsHide: true, timeout: 30000 }); try { return r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { return 'UNPARSEABLE:' + r.stdout; } };
  const s1 = start('tk-1111', env), s2 = start('tk-2222', env);
  const ctx = s1 && s1.hookSpecificOutput && s1.hookSpecificOutput.additionalContext;
  R.check('[TK-07] board SessionStart: 첫 세션에 [pilot toolkit] 한 줄(hookEventName SessionStart) · 같은 날 둘째 세션은 조용하다', s1 && s1.hookSpecificOutput.hookEventName === 'SessionStart' && /\[pilot toolkit\].*clangd-lsp/.test(ctx) && s2 === null, JSON.stringify({ s1, s2 }));
  fs.rmSync(path.join(rq, '.git', 'harness', 'toolkit-hint.json'), { force: true });
  R.check('[TK-07] HARNESS_TOOLKIT_HINT=off 면 세션 시작에 아무것도 싣지 않는다', start('tk-3333', { ...env, HARNESS_TOOLKIT_HINT: 'off' }) === null);

  // CLI
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'harness', 'cli.js'), 'toolkit', '--root', rq, '--json'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HARNESS_TOOLKIT_HOME: h0 }, timeout: 60000 });
  let j = null; try { j = JSON.parse(cli.stdout); } catch { /* 아래에서 실패 */ }
  R.check('[TK-08] CLI toolkit --json: exit 0 · 스택 · 없는 것', cli.status === 0 && j && j.stacks.includes('qt') && j.missing.some(e => e.id === 'clangd-lsp'), `${cli.status} ${cli.stdout.slice(0, 300)} ${cli.stderr.slice(0, 300)}`);
} catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
finally {
  for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ }
}
R.done();

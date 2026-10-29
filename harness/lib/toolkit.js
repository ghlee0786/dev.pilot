'use strict';
// 도구 점검(toolkit) — 이 저장소의 스택에 맞는 스킬 · MCP · 플러그인 중 설치된 것 · 없는 것 · 위험한 것을 보인다.
//   [2026-10-26 사용자 요청] "프로젝트를 할 때 반드시 스킬과 MCP 를 확인해, 업무 · 지시를 가장 효율적으로 할 방안을 찾아야 한다".
//   읽기만 한다 — 설치 · 설정 변경은 사용자가 정한다. 목록은 2026-10-25 MCP · 스킬 조사에서 고른 것(오래되면 알린다).
//   읽는 곳: ~/.claude/skills · <저장소>/.claude/skills · ~/.claude/plugins/installed_plugins.json · ~/.claude.json(mcpServers · projects[저장소])
//            · <저장소>/.mcp.json · $CODEX_HOME/config.toml([mcp_servers.*]). 모델 · 네트워크를 부르지 않는다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const REVIEWED_AT = '2026-10-25', STALE_DAYS = 60;
// tier: now = 지금 넣을 만함 · try = 시험해 볼 만함. stacks: langs 팩 id + qt · web · windows · '*'(모든 저장소).
const CATALOG = [
  { id: 'clangd-lsp', kind: 'plugin', tier: 'now', stacks: ['cpp'], has: { plugin: /clangd/i },
    why: '고칠 때마다 진단 · 심볼 단위 정의/참조 — C++ 빌드 왕복이 준다(compile_commands.json 필요)', install: '/plugin install clangd-lsp@claude-plugins-official · clangd 를 PATH 에', url: 'https://code.claude.com/docs/en/plugins/code-intelligence' },
  { id: 'csharp-lsp', kind: 'plugin', tier: 'now', stacks: ['dotnet'], has: { plugin: /csharp/i },
    why: '고칠 때마다 진단 · 심볼 단위 정의/참조 — 느린 .NET 빌드 왕복이 준다', install: '/plugin install csharp-lsp@claude-plugins-official · dotnet tool install -g csharp-ls', url: 'https://code.claude.com/docs/en/plugins/code-intelligence' },
  { id: 'pyright-lsp', kind: 'plugin', tier: 'now', stacks: ['python'], has: { plugin: /pyright/i },
    why: '고칠 때마다 타입 진단 · 정의/참조', install: '/plugin install pyright-lsp@claude-plugins-official', url: 'https://code.claude.com/docs/en/plugins/code-intelligence' },
  { id: 'typescript-lsp', kind: 'plugin', tier: 'now', stacks: ['node'], has: { plugin: /typescript/i },
    why: '고칠 때마다 타입 진단 · 정의/참조', install: '/plugin install typescript-lsp@claude-plugins-official', url: 'https://code.claude.com/docs/en/plugins/code-intelligence' },
  { id: 'dotnet-skills', kind: 'plugin', tier: 'now', stacks: ['dotnet'], has: { plugin: /dotnet/i, skill: /dotnet/i },
    why: '.NET 공식 테스트 스킬 — 러너(VSTest · MTP) 감지 · 커버리지 · 정적 호출(DateTime.Now 등)을 주입형으로', install: 'github.com/dotnet/skills 안내대로 마켓 추가 후 dotnet-test', url: 'https://github.com/dotnet/skills' },
  { id: 'microsoft-learn-mcp', kind: 'mcp', tier: 'now', stacks: ['dotnet', 'cpp'], when: 'windows', has: { mcp: /learn\.microsoft|microsoft[-_ ]?learn|mslearn/i },
    why: 'WPF · .NET · Win32 · MSBuild · MSVC 공식 문서 · 샘플 검색(읽기 전용 · Public Preview)', install: 'claude mcp add --transport http microsoft-learn https://learn.microsoft.com/api/mcp', url: 'https://github.com/MicrosoftDocs/mcp' },
  { id: 'qt-agent-skills', kind: 'skill', tier: 'now', stacks: ['qt'], has: { skill: /\bqt\b|qt-/i, plugin: /\bqt\b|qt-/i },
    why: 'Qt 공식 — C++ 리뷰(린터 60여 규칙) · QML 시험 실행 · CMake 설정', install: 'github.com/TheQtCompanyRnD/agent-skills 안내대로', url: 'https://github.com/TheQtCompanyRnD/agent-skills', risk: 'Windows 셸에서의 동작은 확인되지 않았다' },
  { id: 'mcp-windbg', kind: 'mcp', tier: 'try', stacks: ['cpp', 'dotnet'], when: 'windows', has: { mcp: /windbg/i },
    why: '현장 크래시 덤프(.dmp) 분석 — cdb · !analyze -v · MSVC/PDB', install: 'github.com/svnscha/mcp-windbg 안내대로(Python 3.10+ · Debugging Tools for Windows)', url: 'https://github.com/svnscha/mcp-windbg', risk: '덤프에 고객 데이터가 섞인다 — PII 제거를 켠다' },
  { id: 'playwright-mcp', kind: 'mcp', tier: 'now', stacks: ['web'], has: { mcp: /playwright/i },
    why: '웹 UI 탐색 · 시나리오 확인(--caps=testing 이면 회귀 시험 코드로)', install: 'claude mcp add playwright -- npx -y @playwright/mcp --isolated', url: 'https://github.com/microsoft/playwright-mcp', risk: '세션이 여럿이면 --isolated' },
  { id: 'context7', kind: 'mcp', tier: 'now', stacks: ['*'], has: { mcp: /context7/i },
    why: '라이브러리 · 프레임워크의 최신 문서 조회', install: 'claude mcp add context7 -- npx -y @upstash/context7-mcp', url: 'https://github.com/upstash/context7' },
  { id: 'codex-plugin-cc', kind: 'plugin', tier: 'try', stacks: ['*'], has: { plugin: /codex/i },
    why: '다른 모델의 교차 리뷰(/codex:review) — 같은 모델끼리의 편향을 줄인다(참고용 · 게이트 아님)', install: 'github.com/openai/codex-plugin-cc 안내대로', url: 'https://github.com/openai/codex-plugin-cc', risk: 'rescue 는 worktree 밖을 고칠 수 있다 — review 만 쓴다' },
];
// 설치된 것 중 주의할 것
const WARNINGS = [
  { id: 'github-archived', test: m => /^github/i.test(m.name) && /@modelcontextprotocol\/server-github/i.test(m.detail),
    text: m => `MCP "${m.name}" 는 보관(archived)된 예전 참조 서버(@modelcontextprotocol/server-github)다 — 보안 업데이트가 없다. 공식 github/github-mcp-server(쓰기 툴셋은 끈 채)로 바꾼다` },
  { id: 'shell-mcp', test: m => /desktop-?commander|windows-mcp|serena/i.test(`${m.name} ${m.detail}`),
    text: m => `MCP "${m.name}" 는 셸 · 파일 쓰기 도구를 가진다 — guard 는 MCP 중 git · GitHub 쓰기만 막는다. 셸 · 레지스트리 도구는 끄고 쓴다` },
];

const homeDir = o => (o && o.home) || process.env.HARNESS_TOOLKIT_HOME || os.homedir();
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const dirsIn = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } };
const samePath = (a, b) => { const n = p => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b); };

// MCP 항목 하나 — 명령이 래퍼 스크립트(.cmd · .bat · .ps1 · .sh)면 그 안에서 실제 서버를 본다(64KB 까지)
function mcpEntry(name, v, scope) {
  const parts = [v && v.command, ...((v && v.args) || []), v && v.url].filter(x => typeof x === 'string');
  let detail = parts.join(' ');
  for (const p of parts) if (/\.(cmd|bat|ps1|sh)$/i.test(p)) { try { if (fs.statSync(p).size < 65536) detail += ' ' + fs.readFileSync(p, 'utf8'); } catch { /* 없으면 명령만 */ } }
  return { name, scope, detail };
}
function inventory(root, o) {
  const home = homeDir(o), inv = { skills: [], plugins: [], mcp: [] };
  for (const [d, scope] of [[path.join(home, '.claude', 'skills'), 'user'], [path.join(root, '.claude', 'skills'), 'project']]) for (const n of dirsIn(d)) inv.skills.push({ name: n, scope });
  const ip = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  for (const k of Object.keys((ip && ip.plugins) || {})) inv.plugins.push({ name: k });
  const cj = readJson(path.join(home, '.claude.json')) || {};
  for (const [k, v] of Object.entries(cj.mcpServers || {})) inv.mcp.push(mcpEntry(k, v, 'user'));
  for (const [p, v] of Object.entries(cj.projects || {})) if (samePath(p, root)) for (const [k, s] of Object.entries((v && v.mcpServers) || {})) inv.mcp.push(mcpEntry(k, s, 'local'));
  for (const [k, v] of Object.entries((readJson(path.join(root, '.mcp.json')) || {}).mcpServers || {})) inv.mcp.push(mcpEntry(k, v, 'project'));
  try {   // Codex: [mcp_servers.<이름>] 머리줄만(하위 표 [mcp_servers.x.env] 는 같은 이름)
    const toml = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), 'utf8');
    const seen = new Set();
    for (const m of toml.matchAll(/^\s*\[mcp_servers\.("?)([^\]."]+)\1(?:\.[^\]]*)?\]\s*$/gm)) if (!seen.has(m[2])) { seen.add(m[2]); inv.mcp.push({ name: m[2], scope: 'codex', detail: '' }); }
  } catch { /* Codex 없음 */ }
  return inv;
}

// 스택 — langs 팩 + 빌드 파일(CMakeLists · .pro · .csproj · .sln · package.json)로 C++ · Qt · .NET · 웹 · windows.
//   [2026-10-26 실측] C++/Qt 저장소의 Qt 가 apps/<앱>/CMakeLists.txt(두 단계 아래)에만 있다 — git 이 아는 파일 전체에서 찾는다(git 이 아니면 루트와 한 단계 아래).
//   .sln 은 보지 않는다 — CMake 가 만든 Visual Studio 솔루션이 커밋돼 있으면 C++ 저장소가 .NET 으로 잡혔다(apps/<앱>/build/…/Project.sln).
const BUILD_FILE = /(^|\/)(CMakeLists\.txt|package\.json|[^/]+\.(pro|csproj|vbproj|fsproj))$/i;
const NOT_SOURCE = /(^|\/)(node_modules|third_party|vendor|external|build|out|bin|obj|cmake-build-[^/]*)\//i;
function buildFiles(root) {
  const r = require('node:child_process').spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 * 1024 });
  if (r.status === 0) return r.stdout.split('\0').filter(f => BUILD_FILE.test(f) && !NOT_SOURCE.test(f)).slice(0, 300);
  const out = [];
  for (const d of ['', ...dirsIn(root).filter(n => !/^(\.|node_modules$)/.test(n)).slice(0, 40)]) { try { for (const n of fs.readdirSync(path.join(root, d))) if (BUILD_FILE.test(n)) out.push(d ? `${d}/${n}` : n); } catch { /* 못 읽음 */ } }
  return out;
}
function stacks(root) {
  const s = new Set(require('./langs').detect(root));
  for (const f of buildFiles(root)) {
    const base = path.basename(f);
    if (/\.(csproj|vbproj|fsproj)$/i.test(base)) s.add('dotnet');
    if (/\.pro$/i.test(base)) { s.add('cpp'); s.add('qt'); }
    if (base === 'CMakeLists.txt') { s.add('cpp'); if (!s.has('qt')) { try { if (/find_package\s*\(\s*Qt[56]?\b|Qt[56]::/i.test(fs.readFileSync(path.join(root, f), 'utf8'))) s.add('qt'); } catch { /* 못 읽음 */ } } }
    if (base === 'package.json' && !s.has('web')) { const pj = readJson(path.join(root, f)) || {}; if (/"(react|vue|svelte|next|vite|@angular\/core|@playwright\/test)"/.test(JSON.stringify({ ...pj.dependencies, ...pj.devDependencies }))) s.add('web'); }
  }
  if (process.platform === 'win32') s.add('windows');
  return [...s];
}

function present(entry, inv) {
  const h = entry.has || {};
  return (h.plugin && inv.plugins.some(p => h.plugin.test(p.name))) || (h.skill && inv.skills.some(k => h.skill.test(k.name))) || (h.mcp && inv.mcp.some(m => h.mcp.test(`${m.name} ${m.detail}`)));
}
// → { root, stacks, installed:[…], missing:[…], warnings:[…], reviewed_at, stale_days }
function check(o) {
  const root = path.resolve((o && o.root) || process.cwd());
  const inv = inventory(root, o), st = stacks(root);
  const fits = e => (e.stacks.includes('*') || e.stacks.some(x => st.includes(x))) && (!e.when || st.includes(e.when));
  const relevant = CATALOG.filter(fits);
  const age = Math.floor((((o && o.now) || Date.now()) - Date.parse(REVIEWED_AT)) / 86400000);
  return { root, stacks: st, inventory: inv,
    installed: relevant.filter(e => present(e, inv)).map(e => e.id),
    missing: relevant.filter(e => !present(e, inv)).map(({ has, ...e }) => e),
    warnings: inv.mcp.flatMap(m => WARNINGS.filter(w => w.test(m)).map(w => ({ id: w.id, mcp: m.name, text: w.text(m) }))),
    reviewed_at: REVIEWED_AT, stale_days: age };
}
function format(r) {
  const L = [`pilot toolkit — ${r.root}`, `스택: ${r.stacks.filter(s => s !== 'windows').join(', ') || '(못 찾음)'}${r.stacks.includes('windows') ? ' · Windows' : ''}`,
    `설치됨: 스킬 ${r.inventory.skills.length} · 플러그인 ${r.inventory.plugins.length} · MCP ${r.inventory.mcp.length}${r.installed.length ? ` — 이 저장소에 맞는 것: ${r.installed.join(', ')}` : ''}`];
  for (const [tier, title] of [['now', '없음 — 지금 넣을 만한 것'], ['try', '없음 — 시험해 볼 만한 것']]) {
    const xs = r.missing.filter(e => e.tier === tier);
    if (!xs.length) continue;
    L.push(`${title}:`);
    for (const e of xs) L.push(`  - ${e.id} (${e.kind}): ${e.why}`, `      설치: ${e.install}${e.risk ? ` · 주의: ${e.risk}` : ''}`);
  }
  if (r.warnings.length) L.push('주의:', ...r.warnings.map(w => `  - ${w.text}`));
  if (!r.missing.length && !r.warnings.length) L.push('이 저장소에 맞는 목록의 도구는 모두 있다.');
  L.push(`목록 기준일 ${r.reviewed_at}${r.stale_days > STALE_DAYS ? ` — ${r.stale_days}일 지났다: 새 도구 · 보관된 도구를 다시 조사한다` : ''} · 이 명령은 읽기만 한다 — 설치 · 설정 변경은 사용자가 정한다`);
  return L.join('\n');
}
// 세션 시작 한 줄 — 지금 넣을 만한 것이 없거나 주의가 없으면 null(조용히)
function hint(o) {
  const r = check(o), now = r.missing.filter(e => e.tier === 'now').map(e => e.id);
  if (!now.length && !r.warnings.length) return null;
  const parts = [];
  if (now.length) parts.push(`이 저장소(${r.stacks.filter(s => s !== 'windows').join(' · ') || '?'})에 맞는데 없는 도구: ${now.slice(0, 4).join(' · ')}`);
  if (r.warnings.length) parts.push(`주의할 MCP: ${r.warnings.map(w => w.mcp).join(' · ')}`);
  return `[pilot toolkit] ${parts.join(' · ')} — 자세히: node harness/cli.js toolkit. 일에 맞는 스킬 · MCP 가 이미 있으면 그것을 먼저 쓴다 · 없는 것은 사용자에게 제안만 한다(설치는 사용자가 정한다).`;
}

module.exports = { check, format, hint, inventory, stacks, CATALOG, REVIEWED_AT };

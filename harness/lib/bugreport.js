'use strict';
// 버그 보고 — 하네스 자체의 결함(CLI · 작업의 예기치 못한 예외 · 훅 내부 오류)을 가린 이슈 초안으로 만든다.
//   [2026-10-13 사용자 지시] 하네스를 쓰는 사람에게 버그가 생기면 dev.harness 저장소에 이슈가 올라오게.
//   보내는 방법은 미리 채운 이슈 링크(issues/new?title=&body=) — 토큰이 없고, 사람이 내용을 보고 제출한다(밖으로 나가는 일은 한 번 승인).
//   공개 저장소다: 작업 목표 · 프로젝트 경로 · 코드 · 테스트 출력은 넣지 않는다. 오류 문장과 하네스 파일의 스택만, 그것도 가린다.
//   같은 결함은 서명(오류 종류 + 문장 모양 + 하네스 스택 위 3줄)으로 묶는다 — 경로만 다른 같은 결함은 하나.
//   기록: <git-common-dir>/harness/bugs/<서명>.json · 보낸 것: bugs/reported.json
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');

const DEFAULT_REPO = 'ghlee0786/dev.pilot';   // [2026-10-21] dev.harness 에서 이름을 바꿨다 — GitHub 가 옛 주소를 새 주소로 넘겨 주므로 옛 판도 갱신 · 보고가 된다
const MAX_URL = 7500;

function bugsDir(root) { return path.join(require('./state').paths(root).harnessDir, 'bugs'); }
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 가리기 — 하네스 파일 경로(harness/lib · hooks · cli.js)만 남기고 나머지 경로 · 따옴표 안 · 메일 · 사용자 이름 · 호스트를 지운다.
function sanitize(text) {
  let s = String(text || '');
  const keepHarness = p => { const m = /(?:^|[\\/])(harness[\\/](?:lib|hooks)[\\/][\w.-]+\.js|harness[\\/]cli\.js)(:\d+(?::\d+)?)?/i.exec(p); return m ? m[1].replace(/\\/g, '/') + (m[2] || '') : '<path>'; };
  s = s.replace(/'[^'\n]*'|"[^"\n]*"/g, q => (/harness[\\/](lib|hooks|cli)/i.test(q) ? q[0] + keepHarness(q.slice(1, -1)) + q[0] : `${q[0]}…${q[0]}`));
  s = s.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s'"()<>|]+/g, keepHarness);          // Windows 절대 경로 · UNC
  s = s.replace(/(?<![\w.:])\/(?:[^\s'"()<>|/]+\/)+[^\s'"()<>|]*/g, keepHarness);   // POSIX 절대 경로
  s = s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');
  // 사용자 이름 · 호스트 — 짧은 이름(예: 'gh')도 가리되 단어로 떨어진 것만(github · high 같은 낱말은 그대로).
  for (const [v, mask] of [[os.userInfo().username, '<user>'], [os.hostname(), '<host>']]) if (v && v.length >= 2) s = s.replace(new RegExp(`(?<![\\w.-])${esc(v)}(?![\\w-])`, 'gi'), mask);
  return s;
}

// 스택에서 하네스 파일의 줄만(node 내부 · 사용자 파일은 뺀다).
function harnessFrames(stack) {
  return String(stack || '').split(/\r?\n/).filter(l => /^\s*at /.test(l)).map(l => sanitize(l.trim())).filter(l => /harness\/(lib|hooks|cli)/.test(l));
}
function signatureOf(kind, code, message, frames) {
  const shape = sanitize(message).replace(/\d+/g, 'N').replace(/\s+/g, ' ').slice(0, 160);
  const top = frames.slice(0, 3).map(f => f.replace(/:\d+(:\d+)?\)?$/, '').replace(/^at /, ''));
  return crypto.createHash('sha1').update(JSON.stringify([kind, code || null, shape, top])).digest('hex').slice(0, 12);
}
function entryOf(kind, err) {
  const stack = String((err && err.stack) || err || '');
  const message = String((err && err.message) || stack.split(/\r?\n/)[0] || '').split(/\r?\n/)[0];
  const frames = harnessFrames(stack);
  return { kind, code: (err && err.code) || null, message: sanitize(message).slice(0, 300), frames: frames.slice(0, 8), sig: signatureOf(kind, err && err.code, message, frames) };
}

function versions() {
  let harness = null; try { harness = fs.readFileSync(path.join(__dirname, '..', '.harness-version'), 'utf8').split(/\r?\n/)[0].trim(); } catch { /* 원본(설치 사본이 아님) */ }
  // 표식 줄은 늘 "harness 5" 다 — 보고만 보고는 어느 판에서 났는지(이미 고친 결함인지) 알 수 없었다. 릴리스의 harness/VERSION 을 붙인다.
  try { const v = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim(); if (v) harness = `${harness || 'source'} · v${v.replace(/^v/i, '')}`; } catch { /* 릴리스가 아닌 설치 */ }
  let gitv = null; try { gitv = require('node:child_process').spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).stdout.trim().replace(/^git version /, ''); } catch { /* 없음 */ }
  return { harness: harness || 'source', node: process.version, git: gitv, os: `${os.platform()} ${os.release()} ${os.arch()}` };
}

// 결함 하나를 기록(같은 서명이면 count 만 늘린다). 기록 실패는 조용히 — 보고 기능이 하네스를 멈추면 안 된다.
function record(root, kind, err) {
  try {
    const e = entryOf(kind, err), dir = bugsDir(root), f = path.join(dir, `${e.sig}.json`);
    let cur = null; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 처음 */ }
    const now = new Date().toISOString();
    const next = cur ? { ...cur, count: (cur.count || 1) + 1, last_at: now } : { ...e, count: 1, first_at: now, last_at: now, versions: versions() };
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(next, null, 2));
    return next;
  } catch { return null; }
}

function readReported(root) { try { return JSON.parse(fs.readFileSync(path.join(bugsDir(root), 'reported.json'), 'utf8')); } catch { return {}; } }
function markSent(root, sig, count) {
  const r = readReported(root); r[sig] = { at: new Date().toISOString(), count: count || 1 };
  fs.mkdirSync(bugsDir(root), { recursive: true }); fs.writeFileSync(path.join(bugsDir(root), 'reported.json'), JSON.stringify(r, null, 2));
}

// 모으기: bugs/*.json + hook-errors.log(훅 내부 오류). opts.all 이면 보낸 것도.
function collect(root, opts) {
  const map = new Map();
  let files = []; try { files = fs.readdirSync(bugsDir(root)).filter(f => /^[0-9a-f]{12}\.json$/.test(f)); } catch { /* 없음 */ }
  for (const f of files) { try { const e = JSON.parse(fs.readFileSync(path.join(bugsDir(root), f), 'utf8')); map.set(e.sig, e); } catch { /* 깨짐 */ } }
  let log = ''; try { log = fs.readFileSync(path.join(require('./state').paths(root).harnessDir, 'hook-errors.log'), 'utf8'); } catch { /* 없음 */ }
  for (const line of log.split(/\r?\n/).filter(Boolean).slice(-500)) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const e = entryOf(`hook:${j.hook || '?'}`, { message: String(j.error || '').split(/\r?\n/)[0].replace(/^\w*Error: /, ''), stack: String(j.error || '') });
    const cur = map.get(e.sig);
    if (cur) { cur.count = (cur.count || 1) + (cur.kind === e.kind && cur.from_log ? 1 : 0); cur.last_at = j.at > (cur.last_at || '') ? j.at : cur.last_at; }
    else map.set(e.sig, { ...e, count: 1, first_at: j.at, last_at: j.at, from_log: true, versions: versions() });
  }
  const sent = readReported(root);
  const out = [...map.values()].map(e => ({ ...e, sent: sent[e.sig] || null, recurred: !!(sent[e.sig] && (e.count || 1) > (sent[e.sig].count || 1)) }));
  return (opts && opts.all ? out : out.filter(e => !e.sent || e.recurred)).sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
}

// 이슈 초안 — 제목에 서명. existing(같은 서명의 열린 이슈)이 있으면 그 이슈로 안내(재발 댓글).
function draft(e, o) {
  const repo = (o && o.repo) || process.env.HARNESS_BUG_REPO || DEFAULT_REPO;
  const v = e.versions || versions();
  const title = `[auto] ${e.kind}${e.code ? ` ${e.code}` : ''}: ${String(e.message).slice(0, 90)} [${e.sig}]`;
  const body = ['하네스가 자동으로 만든 결함 보고입니다(내용은 가렸습니다 — 프로젝트 경로 · 작업 내용 · 코드는 없습니다).', '',
    `- 서명: \`${e.sig}\` · 종류: ${e.kind}${e.code ? ` · 코드: ${e.code}` : ''} · 횟수: ${e.count || 1}`,
    `- 하네스: ${v.harness} · Node ${v.node} · git ${v.git || '?'} · OS ${v.os}`, '',
    ...(e.detail != null ? [`**${e.kind === 'improve' ? '더 나은 방향' : e.kind === 'intent' ? '의도와 다르게 동작함' : '하네스 동작 이상'}**`, '', e.detail]
      : ['**오류**', '```', e.message, '```', ...(e.frames && e.frames.length ? ['**하네스 스택**', '```', ...e.frames, '```'] : [])]), '',
    '**재현 · 덧붙일 말(선택)**', '<!-- 무엇을 하던 중이었는지 적어 주세요. 프로젝트 이름 · 경로 · 비밀은 적지 마세요. -->'].join('\n');
  if (o && o.existing && o.existing.html_url) return { title, body, url: o.existing.html_url, existing: o.existing };
  const q = b => `https://github.com/${repo}/issues/new?labels=${encodeURIComponent('bug,auto-report')}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
  let url = q(body);
  for (let cut = body.length; url.length > MAX_URL && cut > 200; cut = Math.floor(cut * 0.8)) url = q(body.slice(0, cut) + '\n…(줄임)');
  return { title, body, url };
}

// 같은 서명의 열린 이슈 찾기(인증 없는 검색 API · 실패하면 null — 새 이슈 링크로 간다). HARNESS_BUG_OFFLINE=1 이면 묻지 않는다.
async function findExisting(sig, repo) {
  if (process.env.HARNESS_BUG_OFFLINE === '1' || typeof fetch !== 'function') return null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue is:open in:title ${sig}`)}`, { signal: ctl.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'harness-bugreport' } });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return (j.items || [])[0] || null;
  } catch { return null; }
}

// ── 자동 발행 ─────────────────────────────────────────────────────────
// [2026-10-13 사용자 결정] 이슈는 자동으로 올라가야 하고 사용자는 되도록 개입하지 않는다.
//   인증: 공개 저장소에 토큰을 넣을 수 없다 — 그 PC 의 GitHub 로그인을 쓴다:
//     HARNESS_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN > `gh auth token` > git 자격 증명 관리자(github.com · 묻지 않음).
//   켜지는 조건: 설치된 사본(harness/.harness-version 이 있다)에서만 · HARNESS_BUG_REPORT=off 나 프로젝트 블록 bug_report: off 면 끈다.
//     원본 저장소(개발 · 테스트)에서는 꺼져 있다 — 테스트가 실제 이슈를 올리면 안 된다. HARNESS_BUG_REPORT=on 이면 원본에서도 켠다(테스트용).
//   같은 서명의 열린 이슈가 있으면 새 이슈 대신 재발 댓글. 하루 새 이슈 5건 상한. 인증이 없으면 쌓아 두고(report 가 링크로 안내) 다음에 올린다.
const API = () => (process.env.HARNESS_GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const DAILY_MAX = 5;
function enabled(root) {
  const v = String(process.env.HARNESS_BUG_REPORT || '').toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  try { if (/^(off|false|no)$/i.test(require('./checks').yamlString(root, 'bug_report') || '')) return false; } catch { /* 블록 없음 */ }
  if (v === 'on' || v === '1' || v === 'true') return true;
  return fs.existsSync(path.join(__dirname, '..', '.harness-version'));
}
function githubToken() {
  for (const k of ['HARNESS_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) if (process.env[k]) return { token: process.env[k].trim(), source: k };
  if (process.env.HARNESS_GITHUB_TOKEN_ONLY_ENV === '1') return null;   // 테스트: 이 PC 의 실제 로그인을 쓰지 않는다
  const { spawnSync } = require('node:child_process');
  try { const r = spawnSync('gh', ['auth', 'token', '-h', 'github.com'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }); if (r.status === 0 && r.stdout.trim()) return { token: r.stdout.trim(), source: 'gh' }; } catch { /* gh 없음 */ }
  // git 자격 증명 — [2026-10-13 실측] GitHub 계정이 둘 저장돼 있으면 이름 없이 물을 때 아무것도 돌려주지 않았다.
  //   HARNESS_GITHUB_USER > 이름 없이 > 자격 증명 관리자에 저장된 계정마다 차례로.
  const fill = user => {
    try {
      const r = spawnSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=github.com\n${user ? `username=${user}\n` : ''}\n`, encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' } });
      const m = r.status === 0 && /^password=(.+)$/m.exec(r.stdout || '');
      return m ? { token: m[1].trim(), source: `git-credential${user ? `:${user}` : ''}` } : null;
    } catch { return null; }
  };
  const users = [process.env.HARNESS_GITHUB_USER || null, null];
  try { const r = spawnSync('git', ['credential-manager', 'github', 'list'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }); if (r.status === 0) users.push(...String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)); } catch { /* GCM 아님 */ }
  for (const u of [...new Set(users.filter((x, i) => i === 1 || x))]) { const t = fill(u); if (t) return t; }
  return null;
}
async function api(method, url, token, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { method, signal: ctl.signal, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'harness-bugreport', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
  } finally { clearTimeout(t); }
}
// 한 건 올리기 — 열린 같은 서명이 있으면 댓글, 없으면 새 이슈. → {ok, url, action} | {ok:false, why}
async function post(root, e, o) {
  const repo = (o && o.repo) || process.env.HARNESS_BUG_REPO || DEFAULT_REPO;
  const tk = (o && o.token) || githubToken();
  if (!tk) return { ok: false, why: 'no-auth' };
  const d = draft(e, { repo });
  const found = await api('GET', `${API()}/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue is:open in:title ${e.sig}`)}`, tk.token).catch(() => null);
  const hit = found && found.ok && (found.json.items || [])[0];
  if (hit) {
    const c = await api('POST', `${API()}/repos/${repo}/issues/${hit.number}/comments`, tk.token, { body: `재발 — 횟수 ${e.count || 1} · 하네스 ${(e.versions || versions()).harness} · ${(e.versions || versions()).os}` }).catch(err => ({ ok: false, status: String(err.message) }));
    return c.ok ? { ok: true, url: hit.html_url, action: 'comment' } : { ok: false, why: `comment ${c.status}` };
  }
  const sent = readReported(root), day = Date.now() - 24 * 3600 * 1000;
  if (Object.values(sent).filter(x => x.action === 'issue' && Date.parse(x.at) > day).length >= DAILY_MAX) return { ok: false, why: 'daily-limit' };
  const labels = ['auto-report', e.kind && /^(intent|improve|bug)$/.test(e.kind) ? e.kind : 'bug'];
  const r = await api('POST', `${API()}/repos/${repo}/issues`, tk.token, { title: d.title, body: d.body, labels }).catch(err => ({ ok: false, status: String(err.message) }));
  return r.ok ? { ok: true, url: r.json.html_url, action: 'issue' } : { ok: false, why: `create ${r.status}` };
}
// 쌓인 것(보내지 않았거나 재발한 것)을 올린다. 켜져 있지 않으면 아무것도 하지 않는다. 실패는 조용히 — 하네스를 멈추지 않는다.
async function autoReport(root, o) {
  if (!enabled(root)) return { skipped: 'disabled', posted: [] };
  const list = collect(root);
  if (!list.length) return { skipped: null, posted: [] };
  const tk = (o && o.token) || githubToken();
  if (!tk) return { skipped: 'no-auth', posted: [], pending: list.length };
  const posted = [];
  for (const e of list.slice(0, 5)) {
    const r = await post(root, e, { ...(o || {}), token: tk }).catch(err => ({ ok: false, why: String(err.message) }));
    if (r.ok) { const s = readReported(root); s[e.sig] = { at: new Date().toISOString(), count: e.count || 1, url: r.url, action: r.action }; fs.mkdirSync(bugsDir(root), { recursive: true }); fs.writeFileSync(path.join(bugsDir(root), 'reported.json'), JSON.stringify(s, null, 2)); posted.push({ sig: e.sig, url: r.url, action: r.action }); }
    else if (r.why === 'daily-limit') break;
  }
  return { skipped: null, posted, source: tk.source };
}

// 작업자 · 세션이 쓰는 보고(하네스가 의도와 다르게 동작함 · 더 나은 방향) — 제목과 본문을 가려서 결함 기록으로 남긴다.
//   프로젝트를 드러내는 말(저장소 폴더 이름 · 원격 주소의 소유자/이름 · git 사용자)도 가린다.
function projectWords(root) {
  const words = new Set();
  try { words.add(path.basename(require('./state').mainRoot(root))); } catch { /* 저장소 아님 */ }
  const { spawnSync } = require('node:child_process');
  try { for (const u of String(spawnSync('git', ['remote', '-v'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout).split(/\s+/)) { const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(u); if (m) { words.add(m[1]); words.add(m[2]); } } } catch { /* 원격 없음 */ }
  try { for (const k of ['user.name', 'user.email']) { const v = spawnSync('git', ['config', k], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(); if (v) words.add(v); } } catch { /* 없음 */ }
  return [...words].filter(w => w && w.length >= 3 && !/^(harness|dev\.harness|origin|github\.com|gitea)$/i.test(w));
}
function maskProject(text, root) { let s = sanitize(text); for (const w of projectWords(root)) s = s.replace(new RegExp(esc(w), 'gi'), '<project>'); return s; }
function note(root, kind, title, body) {
  const k = /^(intent|improve|bug)$/.test(kind) ? kind : 'bug';
  const t = maskProject(String(title || '').split(/\r?\n/)[0], root).slice(0, 120);
  const b = maskProject(String(body || ''), root).slice(0, 4000);
  const sig = crypto.createHash('sha1').update(JSON.stringify([k, t.toLowerCase().replace(/\s+/g, ' ')])).digest('hex').slice(0, 12);
  const dir = bugsDir(root), f = path.join(dir, `${sig}.json`);
  let cur = null; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 처음 */ }
  const now = new Date().toISOString();
  const e = cur ? { ...cur, count: (cur.count || 1) + 1, last_at: now } : { kind: k, code: null, message: t, detail: b, frames: [], sig, count: 1, first_at: now, last_at: now, versions: versions() };
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(e, null, 2));
  return e;
}

function openUrl(url) {
  const { spawn } = require('node:child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch { return false; }
}

module.exports = { DEFAULT_REPO, sanitize, record, collect, draft, findExisting, markSent, openUrl, entryOf, signatureOf, versions,
  enabled, githubToken, post, autoReport, note, maskProject, projectWords };

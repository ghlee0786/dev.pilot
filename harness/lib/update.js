'use strict';
// update — 배포된 최신 릴리스(GitHub Releases)로 이 저장소의 하네스를 갈아 끼운다(CD 의 받는 쪽).
//   [2026-10-13 사용자 결정] 하네스를 dev.harness 에 올리고 CI/CD 로 배포한다.
//   흐름: releases/latest 조회 → 지금 판(harness/VERSION)과 비교 → 릴리스의 *.tar.gz(pilot-<판>.tar.gz)를 임시 폴더에 받아 풀기 →
//         그 사본의 `install --root <저장소>` 로 설치(하네스가 일하는 중이거나 끝나지 않은 v6 작업이 있으면 install 이 거부한다 — 맥락을 잃지 않게).
//   --migrate(손으로만): 끝나지 않은 v6 작업의 이어 가는 법을 적고 설치한다. 자동 갱신은 절대 이행하지 않고 1시간 뒤로 미룬다.
//   [2026-10-29 감사] 판을 붙잡는 장치가 GitHub 의 Pre-release 표시 하나뿐이었다 — 표시에 기대지 않고 저장소 쪽(작업 상태)에서 막는다.
//   --dry-run 은 비교만. 내려받기 · 풀기는 인증 없이(공개 저장소). tar 는 Windows(bsdtar) · POSIX 모두 있다.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');

const API = () => (process.env.HARNESS_GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const repoOf = o => (o && o.repo) || process.env.HARNESS_UPDATE_REPO || process.env.HARNESS_BUG_REPO || require('./bugreport').DEFAULT_REPO;

function currentVersion(harnessDir) {
  try { return fs.readFileSync(path.join(harnessDir || path.join(__dirname, '..'), 'VERSION'), 'utf8').trim() || 'dev'; } catch { return 'dev'; }
}
const norm = v => String(v || '').trim().replace(/^v/i, '');
function newer(a, b) {   // a 가 b 보다 새 판인가(숫자 비교 · dev 는 언제나 낡았다)
  if (norm(b) === 'dev') return norm(a) !== 'dev';
  const pa = norm(a).split(/[.-]/).map(Number), pb = norm(b).split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (Number.isNaN(x) || Number.isNaN(y)) return norm(a) !== norm(b); if (x !== y) return x > y; }
  return false;
}

async function getJson(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'harness-update' } });
    if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status} for ${url}`), { code: 'UPDATE_HTTP' });
    return await r.json();
  } finally { clearTimeout(t); }
}
async function download(url, file) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'harness-update', accept: 'application/octet-stream' } });
    if (!r.ok) throw Object.assign(new Error(`download ${r.status}: ${url}`), { code: 'UPDATE_HTTP' });
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  } finally { clearTimeout(t); }
}

// o = { root, check, repo, auto, migrate } → { ok, current, latest, updated, report }
async function update(o) {
  const root = path.resolve(o.root || process.cwd());
  const repo = repoOf(o);
  const current = currentVersion(path.join(root, 'harness'));
  const rel = await getJson(`${API()}/repos/${repo}/releases/latest`);
  const latest = norm(rel.tag_name);
  const asset = (rel.assets || []).find(a => /\.tar\.gz$/.test(a.name));
  const base = { ok: true, repo, current, latest };
  if (!newer(latest, current)) return { ...base, updated: false, report: `하네스가 최신이다 — 지금 ${current} · 최신 ${latest} (${repo})` };
  if (o.check) return { ...base, updated: false, available: true, report: `새 판이 있다 — 지금 ${current} → ${latest}. 설치: node harness/cli.js update` };
  if (!asset) return { ...base, ok: false, updated: false, report: `릴리스 ${latest} 에 .tar.gz 묶음이 없다 — 설치하지 않았다` };
  // 자동 갱신(--auto): 하네스가 일하는 중이거나 끝나지 않은 v6 작업이 있으면 조용히 미룬다 — 작업 도중 · 이행 없이 하네스를 바꾸지 않는다.
  //   [2026-10-15 실측] 미룬 갱신이 하루 뒤에야 다시 시도돼 옛 판이 계속 쓰였다 — 1시간 뒤 다시 보게 확인 시각을 당겨 둔다.
  //   [2026-10-29 감사] v7 레인은 'running' 이 아니어서 이 미룸이 늘 비어 있었다 — install 과 같은 판정(busy)을 쓴다.
  const AU = require('./autoupdate');
  if (o.auto) {
    const b = require('./install').busy(root);
    const why = [...b.live, ...(b.v6.length ? [`끝나지 않은 v6 작업 ${b.v6.length}개(이행은 손으로: update --migrate)`] : [])];
    if (why.length) {
      AU.defer(root);
      return { ...base, updated: false, skipped: 'busy', report: `자동 갱신 미룸(${current} → ${latest}) — ${why.slice(0, 3).join(' · ')} · 1시간 뒤 다시 본다` };
    }
  }
  const before = o.auto ? AU.dirty(root) : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-update-'));
  try {
    const tgz = path.join(tmp, asset.name);
    await download(asset.browser_download_url, tgz);
    // 상대 경로로만 — Git Bash 의 GNU tar 는 'C:' 를 원격 호스트로 읽는다(bsdtar · GNU tar 모두 되게).
    const x = spawnSync('tar', ['-xzf', asset.name], { cwd: tmp, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (x.status !== 0) throw Object.assign(new Error(`tar failed: ${String(x.stderr).trim().slice(0, 200)}`), { code: 'UPDATE_EXTRACT' });
    const cli = [path.join(tmp, 'harness', 'cli.js'), ...fs.readdirSync(tmp).map(d => path.join(tmp, d, 'harness', 'cli.js'))].find(f => fs.existsSync(f));
    if (!cli) throw Object.assign(new Error('the release archive has no harness/cli.js'), { code: 'UPDATE_EXTRACT' });
    const ins = spawnSync(process.execPath, [cli, 'install', '--root', root, ...(o.migrate && !o.auto ? ['--migrate'] : [])], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
    const out = `${ins.stdout || ''}${ins.stderr || ''}`.trim();
    if (ins.status !== 0) {
      if (o.auto) AU.defer(root);   // 설치가 거부했다(그사이 일이 시작됨 등) — 하루가 아니라 1시간 뒤 다시
      return { ...base, ok: false, updated: false, report: `설치하지 않았다(${latest}): ${out.slice(0, 600)}` };
    }
    // 자동 갱신: 하네스 파일을 git 이 추적하는 저장소면 갱신이 바꾼 것만 따로 커밋(사용자의 미커밋 변경은 넣지 않는다) · 결과를 기록한다.
    let commit = null;
    if (o.auto) {
      try { commit = AU.commitUpdate(root, before, current, latest); } catch (e) { commit = null; }
      AU.writeState(root, { ...AU.readState(root), updated_at: Date.now(), from: current, to: latest, commit });
    }
    return { ...base, updated: true, commit, report: `하네스를 ${current} → ${latest} 로 바꿨다.${commit ? ` (커밋 ${commit.slice(0, 10)})` : ''}\n${out}` };
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 임시 폴더 */ } }
}

module.exports = { update, currentVersion, newer };

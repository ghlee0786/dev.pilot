'use strict';
// 자동 갱신 — 하네스를 쓰는 시점(대화형 세션의 사용자 말 · 하네스 명령)에 하루 한 번 최신 릴리스를 확인하고,
//   새 판이 있으면 별도 프로세스로 `update --auto` 를 띄운다(세션을 막지 않는다).
//   [2026-10-13 사용자 결정 A] CD 로 게시된 릴리스가 설치된 프로젝트에 자동으로 들어가야 한다.
//   켜지는 곳: 설치된 사본(<root>/harness/.harness-version)만 — 원본 저장소 · 테스트는 아니다.
//   끄기: 프로젝트 블록 auto_update: off · 환경 HARNESS_AUTO_UPDATE=off. 확인 기록: <git-common-dir>/harness/auto-update.json
const fs = require('node:fs'), path = require('node:path');

const DAY_MS = 24 * 3600 * 1000, RETRY_MS = 3600 * 1000;   // 작업 중이라 미룬 갱신은 1시간 뒤 다시

function enabled(root) {
  if (/^(off|0|false|no)$/i.test(String(process.env.HARNESS_AUTO_UPDATE || ''))) return false;
  if (!fs.existsSync(path.join(root, 'harness', '.harness-version'))) return false;
  try { if (/^(off|false|no)$/i.test(require('./checks').yamlString(root, 'auto_update') || '')) return false; } catch { /* 블록 없음 */ }
  return true;
}
function stateFile(root) { return path.join(require('./state').paths(root).harnessDir, 'auto-update.json'); }
function readState(root) { try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return {}; } }
function writeState(root, s) { try { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); fs.writeFileSync(stateFile(root), JSON.stringify(s, null, 2)); } catch { /* 기록 실패는 무시 */ } }
// 미룬 갱신 — 하루가 아니라 1시간 뒤 다시 확인하게 확인 시각을 당겨 둔다(일하는 중 · 끝나지 않은 v6 작업 · 설치 거부). 자동 갱신은 거부를 크게 알리지 않는다.
function defer(root) { writeState(root, { ...readState(root), checked_at: Date.now() - DAY_MS + RETRY_MS, deferred_at: Date.now() }); }

// 확인할 때가 됐으면 update --auto 를 띄우고 true. o = { spawn(root), now } — 테스트가 바꿔 끼운다.
function maybe(root0, o) {
  try {
    const root = require('./state').mainRoot(root0);
    if (!enabled(root)) return false;
    const now = (o && o.now) || Date.now();
    const st = readState(root);
    if (st.checked_at && now - st.checked_at < DAY_MS) return false;
    writeState(root, { ...st, checked_at: now });
    ((o && o.spawn) || spawnUpdate)(root);
    return true;
  } catch { return false; }
}
function spawnUpdate(root) {
  const { spawn } = require('node:child_process');
  const log = path.join(require('./state').paths(root).harnessDir, 'auto-update.log');
  const fd = fs.openSync(log, 'a');
  const c = spawn(process.execPath, [path.join(root, 'harness', 'cli.js'), 'update', '--auto', '--root', root], { cwd: root, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  c.unref();
}

// 갱신 뒤: 하네스 파일을 git 이 추적하는 저장소면 갱신이 바꾼 하네스 파일만 따로 커밋한다 — 갱신 전부터 바뀌어 있던 파일(사용자 것)은 넣지 않는다.
const MANAGED = /^(harness\/|AGENTS\.md$|CLAUDE\.md$|\.claude\/settings\.json$|\.claude\/skills\/harness\/|\.codex\/hooks\.json$|\.agents\/skills\/harness\/|\.vscode\/settings\.json$)/;
function dirty(root) {
  const G = require('./git');
  return new Set(G.dirtyFiles(root).map(e => e.path.replace(/\\/g, '/')));
}
function commitUpdate(root, before, from, to) {
  const G = require('./git');
  // harness/ 를 추적하면 새로 생긴 하네스 파일까지, 아니면(로컬 전용) 이미 추적 중인 관리 파일(예: AGENTS.md)만 커밋한다.
  //   [2026-10-13 실측 · .NET 저장소 3곳] AGENTS.md 만 추적하는 저장소에서 갱신된 관리 블록이 미커밋으로 남았다.
  const tracked = new Set(G.git(root, ['ls-files'], { allowFail: true }).out.split(/\r?\n/).filter(Boolean));
  const harnessTracked = [...tracked].some(f => f.startsWith('harness/'));
  const files = [...dirty(root)].filter(f => MANAGED.test(f) && !before.has(f) && (harnessTracked || tracked.has(f)));
  if (!files.length) return null;
  G.git(root, ['add', '--', ...files], { retryLock: true });
  G.git(root, [...G.identityArgs(root), 'commit', '-q', '--no-verify', '-m', `chore(harness): 자동 갱신 ${from} → ${to}`, '--', ...files], { retryLock: true });
  return G.headSha(root);
}

module.exports = { enabled, maybe, readState, writeState, defer, dirty, commitUpdate, DAY_MS, RETRY_MS };

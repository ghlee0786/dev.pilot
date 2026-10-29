'use strict';
// 프로세스 도구 — 의존성 없음. 검사(checks) · 정리(resources)가 쓴다.
//   자식 환경에서 CLAUDECODE · CLAUDE_CODE_ENTRYPOINT · NODE_TEST_CONTEXT 를 지운다 — 이 프로세스가
//   Claude Code 안에서, 또는 node:test 안에서 돌아도 자식은 독립된 프로세스여야 한다.
const { spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const SCRUB = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'NODE_TEST_CONTEXT'];

function childEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  // Windows 환경 변수 이름은 대소문자를 가리지 않는다 — 이름을 대문자로 비교해 지운다.
  for (const k of Object.keys(env)) if (SCRUB.includes(k.toUpperCase())) delete env[k];
  return env;
}

// 작업 worktree(레인)에서 도는 검사의 격리 환경 — [2026-10-17 자동 보고 caed67b9a2f1] worktree 의 compose 가 사용자의 실행 중 컨테이너를
//   다시 만들었다(프로젝트 이름이 메인과 같았다). COMPOSE_PROJECT_NAME 은 compose 에서 .env · name: 보다 앞선다.
//   + 작업마다의 임시 폴더(TEMP · TMP · TMPDIR) · 시험 데이터 구역(HARNESS_DATA_NS) · 포트 구역 — 자원 장부(resources.js)가 회수한다.
const WT_RE = /[\\/]\.harness-worktrees[\\/](t-\d{8}-\d{6}-[0-9a-f]{4})(?:-\d+)?(?:[\\/]|$)/;
function isolationEnv(cwd) {
  if (!WT_RE.test(String(cwd || ''))) return {};
  return require('./resources').envFor(cwd);
}

function killTree(pid) {
  if (pid == null) return;
  if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝났다 */ } } }
}

module.exports = { isolationEnv, IS_WIN, SCRUB, childEnv, killTree };

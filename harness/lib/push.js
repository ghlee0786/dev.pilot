'use strict';
// push — 사용자가 명시적으로 말한 뒤에만 부른다(AGENTS.md). guard 는 에이전트의 `git push` 를 막고 이 명령만 통과시킨다.
//   [버그 2026-10-01 · Python 서비스 저장소] 사용자가 "push 해" 를 세 번 말했지만 guard 가 무조건 막았다 — AGENTS.md 는 "명시한 뒤에만" 이라고
//   적어 둔 채 허락을 집행할 길이 없었다. 훅은 사용자의 말을 볼 수 없으므로 허락의 길을 하네스 명령으로 만들고, 그 명령 자체를 좁힌다:
//     - 강제 push · 태그 · 삭제 없음 — `git push <remote> <branch>` 하나.
//     - 결과 브랜치(harness/*)는 올리지 않는다 — 먼저 accept.
//     - 원격이 앞서 있으면(빨리감기가 아니면) 거부 — pull/merge 는 사람이 한다.
//   대화형 Claude Code 에서는 이 명령이 허용 목록에 없어 실행 때 **승인 프롬프트**가 뜬다 — "완성된 결과를 보여 주고 한 번 승인" 의 모양.
//   [dev.pilot #86] 인증 실패를 클로징 끝의 push 에서야 알았고, 어느 계정 · 도우미로 시도했는지 출력에 없었다 —
//     push --dry-run 이 쓰기 권한까지 미리 확인한다(git push --dry-run · 전송 0) · 실패면 원격 · 자격 증명 도우미 · 계정을 보고한다 ·
//     원격 git 호출에 상한(fetch · 확인 60초 · push 180초)과 SSH BatchMode. 비밀(토큰 · 비밀번호 · URL userinfo)은 출력하지 않는다.
const S = require('./state'), G = require('./git');
const { redactSecrets } = require('./bugreport');

function usage(m) { return Object.assign(new Error(m), { code: 'USAGE' }); }
// 원격 git 호출은 자격 증명 창(GCM · 편집기 askpass · 터미널)을 띄우지 않는다 — 저장된 토큰만 쓴다. 없으면 실패를 한 번 알린다(authHint).
//   [2026-10-29 사용자 지시 중계] "토큰을 오래 보유하고 계속 요청하지 마라" — 하네스 push 의 fetch · ls-remote · push 가 매번 창을 띄울 수 있었다.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
// SSH 는 SSH_ASKPASS 가 비어도 콘솔에 직접 묻는다(passphrase · 호스트 키) — 사용자가 ssh 명령을 정하지 않았을 때만 BatchMode 로 묻지 않게 한다.
//   ms: 그 호출의 상한 — HTTP 도우미(git-remote-http)도 같은 시간 동안 받은 것이 없으면 스스로 끝낸다(GIT_HTTP_LOW_SPEED_*).
//   spawnSync 의 상한은 git 만 끊는다 — Windows 에서 stderr 를 물려받은 도우미가 응답 없는 서버를 기다리면 하네스가 돌아오지 못했다. 사용자가 정한 값은 덮지 않는다.
//   [#86 리뷰] 사용자가 정한 것은 덮지 않는다 — http.lowSpeed* 설정(URL별 포함) · GIT_SSH(plink 등) · ssh.variant 도.
//   하네스가 ssh 명령을 정할 때는 SSH 도 스스로 끝나게 ConnectTimeout · ServerAlive 를 같은 상한으로 준다.
function noPromptEnv(root, ms) {
  const cfg = key => G.git(root, ['config', '--get-regexp', key], { allowFail: true }).out;
  const s = Math.max(1, Math.ceil((ms || 0) / 1000));
  const http = ms && !process.env.GIT_HTTP_LOW_SPEED_LIMIT && !process.env.GIT_HTTP_LOW_SPEED_TIME && !cfg('^http\\..*lowspeed(limit|time)$') ? { GIT_HTTP_LOW_SPEED_LIMIT: '1', GIT_HTTP_LOW_SPEED_TIME: String(s) } : {};
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || cfg('^(core\\.sshcommand|ssh\\.variant)$')) return { ...NO_PROMPT, ...http };
  return { ...NO_PROMPT, ...http, GIT_SSH_COMMAND: `ssh -o BatchMode=yes${ms ? ` -o ConnectTimeout=${s} -o ServerAliveInterval=15 -o ServerAliveCountMax=${Math.max(1, Math.ceil(s / 15))}` : ''}` };
}
// 상한 — 확인(fetch · ls-remote · 쓰기 확인)은 60초 · push 는 180초. HARNESS_PUSH_TIMEOUT_MS 는 시험용(둘 다 그 값).
const T_CHECK = () => Number(process.env.HARNESS_PUSH_TIMEOUT_MS) || 60000;
const T_PUSH = () => Number(process.env.HARNESS_PUSH_TIMEOUT_MS) || 180000;
const errOf = r => redactSecrets(String(r.err || '').trim());

function plan(o) {
  const root = S.mainRoot(o.root);
  const branch = o.branch || G.currentBranch(root);
  if (!branch) throw usage('push: the main checkout is not on a branch — name the branch');
  if (!G.branchExists(root, branch)) throw usage(`push: no such branch ${branch}`);
  if (/^harness\//.test(branch)) throw usage(`push: ${branch} is a harness result branch — accept it into your branch first, then push that`);
  const remotes = G.git(root, ['remote'], { allowFail: true }).out.split(/\r?\n/).filter(Boolean);
  let remote = o.remote || null;
  if (!remote) {
    const up = G.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], { allowFail: true });
    if (up.ok && up.out.includes('/')) remote = up.out.split('/')[0];
    else if (remotes.length === 1) remote = remotes[0];
    else throw usage(`push: ${branch} has no upstream and there are ${remotes.length} remotes (${remotes.join(', ') || 'none'}) — name the remote`);
  }
  if (!remotes.includes(remote)) throw usage(`push: unknown remote ${remote} (have: ${remotes.join(', ') || 'none'})`);
  const fetched = G.git(root, ['fetch', '--quiet', remote, branch], { allowFail: true, env: noPromptEnv(root, T_CHECK()), timeout: T_CHECK() });
  const remoteRef = `${remote}/${branch}`;
  const remoteSha = G.headSha(root, `refs/remotes/${remoteRef}`);
  const localSha = G.headSha(root, branch);
  const count = range => Number(G.git(root, ['rev-list', '--count', range], { allowFail: true }).out || 0);
  const ahead = remoteSha ? count(`${remoteRef}..${branch}`) : count(branch);
  const behind = remoteSha ? count(`${branch}..${remoteRef}`) : 0;
  const commits = G.git(root, ['log', '--oneline', '-20', remoteSha ? `${remoteRef}..${branch}` : branch], { allowFail: true }).out.split(/\r?\n/).filter(Boolean);
  return { root, remote, branch, localSha, remoteSha, ahead, behind, commits, fetched: fetched.ok, fetchError: fetched.ok ? null : errOf(fetched).slice(0, 200), ...(fetched.timedOut ? { fetchTimedOut: true } : {}) };
}

// ── 진단 — 원격 · 자격 증명 도우미 · 계정(비밀을 만지지 않는 출처만) ──
//   git credential fill 은 부르지 않는다(토큰이 하네스로 들어오고 도우미가 창을 띄울 수 있다). 설정은 바꾸지 않는다 — 힌트만 준다.
const KNOWN_HELPERS = /^(manager(?:-core)?|store|cache|osxkeychain|wincred|libsecret|gnome-keyring)$/i;
function helperName(v) {
  const s = String(v || '').trim();
  if (!s) return null;   // 빈 값은 앞선 도우미 목록을 지운다
  const shell = s.startsWith('!'), word = (shell ? s.slice(1) : s).trim().replace(/^["']/, '').split(/["'\s]/)[0];
  const name = word.replace(/\\/g, '/').split('/').pop().replace(/^git-credential-/, '').replace(/\.(exe|cmd|bat|sh)$/i, '');
  return !shell && KNOWN_HELPERS.test(name) ? name : `custom(${name || '?'})`;   // 셸 본문 · 인자는 보이지 않는다(비밀이 들어 있을 수 있다)
}
function helpersOf(root) {
  const r = G.git(root, ['config', '--show-scope', '--get-all', 'credential.helper'], { allowFail: true });
  const out = [];
  for (const line of r.out.split(/\r?\n/).filter(Boolean)) {
    const [scope, ...rest] = line.split('\t'), name = helperName(rest.join('\t'));
    if (name === null) out.length = 0; else out.push(`${name} (${scope})`);
  }
  return out;
}
// 서버 메시지 · 설정 · URL 의 사용자 이름 — 비밀번호 부분은 버린다
function accountOf(root, rawUrl, stderr) {
  const cfg = G.git(root, ['config', '--get-urlmatch', 'credential.username', rawUrl], { allowFail: true }).out.trim();
  if (cfg && redactSecrets(cfg) === cfg) return { account: cfg, from: 'credential.username' };
  // [#86 리뷰 B1 · 재리뷰 S5] http(s) URL 의 userinfo 는 계정으로 쓰지 않는다 — 토큰을 user 자리에 두는 꼴(https://<토큰>@ · https://<토큰>:x-oauth-basic@)이 흔하다.
  //   http(s) 의 계정은 credential.username · 서버 메시지에서만 · ssh(ssh://user@ · scp user@host:)의 user@ 만 URL 에서 읽는다.
  const u = /^([a-z][a-z0-9+.-]*):\/\/([^\s/@]+)@/i.exec(rawUrl), scp = /^([^\s/@:]+)@[^\s/:]+:/.exec(rawUrl);
  const name = u ? (/^https?$/i.test(u[1]) ? null : u[2].split(':')[0]) : scp ? scp[1] : null;
  const safe = v => (v && redactSecrets(v) === v ? v : null);   // 가리기에 걸리는 값(토큰 꼴)은 계정으로 보이지 않는다
  if (safe(name) && !/^git$/i.test(name)) return { account: name, from: 'remote URL' };
  const m = /denied to ([\w.-]+?)\.?(?:\s|$)/i.exec(stderr || '') || /\bHi ([\w.-]+)!/.exec(stderr || '');
  if (m && safe(m[1])) return { account: m[1], from: 'server message' };
  return { account: null, from: null };
}
// 분류 — 판정이 아니라 보고다(원문은 가린 뒤 함께 보인다)
function kindOf(stderr, timedOut) {
  const s = String(stderr || '');
  if (timedOut || /Operation too slow|Operation timed out|Connection timed out/i.test(s)) return 'timeout';   // 우리 상한 · HTTP 도우미의 같은 상한(GIT_HTTP_LOW_SPEED_*)
  if (/\b403\b|Permission to \S+ denied to|denied to \S+|not allowed to push|protected branch|pre-receive hook declined/i.test(s)) return 'denied';
  if (/Authentication failed|could not read Username|terminal prompts disabled|interactivity has been disabled|\b401\b|Permission denied \(publickey|Invalid username or password|Logon failed/i.test(s)) return 'auth';
  if (/Could not resolve host|Connection refused|Failed to connect|does not appear to be a git repository|unable to access|No such file or directory|Could not read from remote repository/i.test(s)) return 'unreachable';
  return 'unknown';
}
function diagnose(root, remote, stderr, timedOut) {
  const raw = G.git(root, ['remote', 'get-url', '--push', remote], { allowFail: true }).out.trim();
  const acc = accountOf(root, raw, stderr);
  return { kind: kindOf(stderr, timedOut), url: redactSecrets(raw).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/i, '$1'), helpers: helpersOf(root), account: acc.account, accountFrom: acc.from };
}
// 쓰기 권한 확인 — `git push --dry-run` 도 receive-pack 에 접속해 인증 · 권한을 실제로 시험한다(아무것도 쓰지 않는다). 올릴 것이 없어도 한다.
function probe(root, remote, refspec) {
  //   --no-verify: git 은 --dry-run 에도 로컬 pre-push 훅(시험 · 빌드 · LFS 업로드)을 돌린다 — 확인은 훅을 돌리지 않는다(실제 push 는 그대로 돈다).
  //   guard 의 --no-verify 금지는 에이전트의 git 명령 대상이다 — 하네스 내부 호출은 훅을 거치지 않는다.
  const r = G.git(root, ['push', '--dry-run', '--no-verify', '--porcelain', remote, refspec], { allowFail: true, env: noPromptEnv(root, T_CHECK()), timeout: T_CHECK() });
  if (r.ok) return { write: 'ok' };
  const err = errOf(r);
  return { write: kindOf(err, r.timedOut), detail: err.slice(0, 400), diagnose: diagnose(root, remote, err, r.timedOut) };
}
const writeWhy = (pr, remote) => `write access to ${remote} could not be confirmed (${pr.write}) — nothing was sent`;

// 태그 push(릴리스) — `git push <remote> refs/tags/<t>:refs/tags/<t>` 하나. 원격에 같은 이름이 있으면: 같은 커밋이면 할 일 없음 · 다르면 거부(덮어쓰지 않는다).
//   [2026-10-13] dev.harness 릴리스(v 태그 → release.yml)를 올릴 길이 없었다 — guard 는 git push 를 막고 이 명령은 브랜치만 올렸다.
function pushTag(o) {
  const root = S.mainRoot(o.root);
  const tag = String(o.tag || '').trim();
  if (!/^[A-Za-z0-9][\w.\-\/]*$/.test(tag)) throw usage(`push --tag: invalid tag name ${JSON.stringify(tag)}`);
  const local = G.git(root, ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { allowFail: true }).out.trim();
  if (!local) throw usage(`push --tag: no such tag ${tag} in this repository`);
  const remotes = G.git(root, ['remote'], { allowFail: true }).out.split(/\r?\n/).filter(Boolean);
  const remote = o.remote || (remotes.length === 1 ? remotes[0] : null);
  if (!remote) throw usage(`push --tag: there are ${remotes.length} remotes (${remotes.join(', ') || 'none'}) — name the remote`);
  if (!remotes.includes(remote)) throw usage(`push --tag: unknown remote ${remote} (have: ${remotes.join(', ') || 'none'})`);
  const ls = G.git(root, ['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { allowFail: true, env: noPromptEnv(root, T_CHECK()), timeout: T_CHECK() });
  const lines = ls.out.split(/\r?\n/).filter(Boolean).map(l => l.split(/\s+/));
  const peeled = (lines.find(([, r]) => r === `refs/tags/${tag}^{}`) || lines.find(([, r]) => r === `refs/tags/${tag}`) || [])[0] || null;
  const base = { root, remote, branch: `tag ${tag}`, tag, localSha: local, remoteSha: peeled, ahead: 0, commits: [], fetched: ls.ok, fetchError: ls.ok ? null : errOf(ls).slice(0, 200) };
  if (!ls.ok && (AUTH.test(base.fetchError || '') || ls.timedOut)) return { ...base, ok: false, pushed: false, reason: ls.timedOut ? `${remote} did not answer in time — nothing was pushed` : `authentication to ${remote} failed — nothing was pushed`, diagnose: diagnose(root, remote, base.fetchError, ls.timedOut) };
  if (peeled && peeled === local && o.dryRun) {   // [#86 리뷰 N2] 올릴 것이 없어도 dry-run 은 쓰기 권한을 확인한다(브랜치와 같다)
    const pr = probe(root, remote, `refs/tags/${tag}:refs/tags/${tag}`);
    if (pr.write !== 'ok') return { ...base, ok: false, pushed: false, dryRun: true, write: pr.write, writeDetail: pr.detail, diagnose: pr.diagnose, reason: writeWhy(pr, remote) };
    return { ...base, ok: true, pushed: false, dryRun: true, write: 'ok', reason: `nothing to push — ${remote} already has tag ${tag} at ${local.slice(0, 10)}` };
  }
  if (peeled && peeled === local) return { ...base, ok: true, pushed: false, reason: `nothing to push — ${remote} already has tag ${tag} at ${local.slice(0, 10)}` };
  if (peeled) return { ...base, ok: false, refused: true, reason: `${remote} has tag ${tag} at a different commit (${peeled.slice(0, 10)}; local ${local.slice(0, 10)}) — tags are not overwritten; use a new tag name` };
  if (o.dryRun) {
    const pr = probe(root, remote, `refs/tags/${tag}:refs/tags/${tag}`);
    if (pr.write !== 'ok') return { ...base, ok: false, pushed: false, dryRun: true, write: pr.write, writeDetail: pr.detail, diagnose: pr.diagnose, reason: writeWhy(pr, remote) };
    return { ...base, ok: true, pushed: false, dryRun: true, write: 'ok', reason: `would push tag ${tag} (${local.slice(0, 10)})` };
  }
  const r = G.git(root, ['push', remote, `refs/tags/${tag}:refs/tags/${tag}`], { allowFail: true, timeout: T_PUSH(), env: noPromptEnv(root, T_PUSH()) });
  if (!r.ok) { const err = errOf(r); return { ...base, ok: false, pushed: false, reason: `git push failed: ${err.slice(0, 400)}`, diagnose: diagnose(root, remote, err, r.timedOut) }; }
  return { ...base, ok: true, pushed: true, reason: `pushed tag ${tag} (${local.slice(0, 10)}) to ${remote}` };
}

function push(o) {
  if (o.tag) return pushTag(o);
  const p = plan(o);
  // 인증에서 막혔으면 push 도 같은 이유로 막힌다 — 다시 묻지 않고 여기서 한 번 알린다
  if (!p.fetched && (AUTH.test(p.fetchError || '') || p.fetchTimedOut)) return { ...p, ok: false, pushed: false, reason: p.fetchTimedOut ? `${p.remote} did not answer in time — nothing was pushed` : `authentication to ${p.remote} failed — nothing was pushed`, diagnose: diagnose(p.root, p.remote, p.fetchError, p.fetchTimedOut) };
  if (!p.fetched && p.remoteSha == null) {/* 새 브랜치일 수 있다 — push 가 판단한다 */}
  if (p.behind > 0) return { ...p, ok: false, refused: true, reason: `${p.remote}/${p.branch} is ${p.behind} commit(s) ahead of ${p.branch} — not a fast-forward. Bring those commits in yourself (pull/merge), then push again.` };
  // dry-run 은 올릴 것이 없어도 쓰기 권한을 확인한다 — batch 전 사전 확인에는 아직 올릴 커밋이 없을 수 있다
  if (o.dryRun) {
    const pr = probe(p.root, p.remote, `refs/heads/${p.branch}:refs/heads/${p.branch}`);
    if (pr.write !== 'ok') return { ...p, ok: false, pushed: false, dryRun: true, write: pr.write, writeDetail: pr.detail, diagnose: pr.diagnose, reason: writeWhy(pr, p.remote) };
    return { ...p, ok: true, pushed: false, dryRun: true, write: 'ok', reason: p.ahead === 0 ? `nothing to push — ${p.remote}/${p.branch} already has ${p.branch}` : `would push ${p.ahead} commit(s)` };
  }
  if (p.ahead === 0) return { ...p, ok: true, pushed: false, reason: `nothing to push — ${p.remote}/${p.branch} already has ${p.branch}` };
  const r = G.git(p.root, ['push', p.remote, `refs/heads/${p.branch}:refs/heads/${p.branch}`], { allowFail: true, timeout: T_PUSH(), env: noPromptEnv(p.root, T_PUSH()) });
  if (!r.ok) { const err = errOf(r); return { ...p, ok: false, pushed: false, reason: `git push failed: ${err.slice(0, 400)}`, diagnose: diagnose(p.root, p.remote, err, r.timedOut) }; }
  return { ...p, ok: true, pushed: true, reason: `pushed ${p.ahead} commit(s) to ${p.remote}/${p.branch}` };
}

// 인증 실패는 하네스가 고칠 수 없다 — git 이 콘솔 없는 자식으로 돌아 자격 증명 창을 못 띄웠거나 저장된 자격이 없을 때다.
//   [2026-10-01 Python 서비스 저장소] gitea fetch 가 한 번 Authentication failed 로 끝났다가 같은 명령이 곧 통과했다 — 원인은 하네스 밖.
const AUTH = /Authentication failed|could not read Username|terminal prompts disabled|interactivity has been disabled|\b40[13]\b|Permission denied \(publickey/i;
function authHint(r) {
  return AUTH.test(`${r.fetchError || ''}\n${r.reason || ''}\n${r.writeDetail || ''}`) ? `hint: authentication to ${r.remote} failed — run \`git fetch ${r.remote}\` once in your own terminal to store credentials, then run this again` : null;
}

function format(r) {
  const L = [`pilot push — ${r.refused ? 'REFUSED' : r.ok ? (r.pushed ? 'PUSHED' : r.dryRun ? 'DRY RUN' : 'NOTHING TO PUSH') : 'FAILED'}: ${r.branch} → ${r.remote}`, `why: ${r.reason}`];
  if (r.commits && r.commits.length) L.push(`commits (${r.ahead}):`, ...r.commits.map(c => `  ${c}`), ...(r.ahead > r.commits.length ? [`  … (+${r.ahead - r.commits.length})`] : []));
  if (r.write === 'ok') L.push('write: ok (dry run — nothing was sent)');
  else if (r.write) L.push(`write: ${r.write}${r.writeDetail ? ` — ${r.writeDetail}` : ''}`);
  const d = r.diagnose;
  if (d) {
    L.push(`remote: ${r.remote} → ${d.url || '?'}`, `credential helper: ${d.helpers.length ? d.helpers.join(', ') : 'none'}`,
      `account: ${d.account ? `${d.account} (from ${d.accountFrom})` : 'unknown — the credential helper picks one (with several accounts it cannot ask here and fails)'}`);
    if (!d.account && d.helpers.length && (d.kind === 'auth' || d.kind === 'denied')) L.push(`hint: to pick the account, set it yourself (\`git config credential.<url>.username <account>\`) or run \`git fetch ${r.remote}\` once in your own terminal — the harness does not change git settings`);
    if (d.kind === 'timeout') L.push(`hint: ${r.remote} did not answer in time — run \`git fetch ${r.remote}\` in your own terminal to see what it waits for`);
  }
  if (r.fetchError) L.push(`note: fetch failed (${r.fetchError}) — the remote state may be stale`);
  const h = authHint(r); if (h) L.push(h);
  return L.join('\n');
}

module.exports = { plan, push, format, probe, diagnose, helperName, kindOf, noPromptEnv };

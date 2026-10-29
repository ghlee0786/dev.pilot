'use strict';
// push — 사용자가 명시적으로 말한 뒤에만 부른다(AGENTS.md). guard 는 에이전트의 `git push` 를 막고 이 명령만 통과시킨다.
//   [버그 2026-10-01 · Python 서비스 저장소] 사용자가 "push 해" 를 세 번 말했지만 guard 가 무조건 막았다 — AGENTS.md 는 "명시한 뒤에만" 이라고
//   적어 둔 채 허락을 집행할 길이 없었다. 훅은 사용자의 말을 볼 수 없으므로 허락의 길을 하네스 명령으로 만들고, 그 명령 자체를 좁힌다:
//     - 강제 push · 태그 · 삭제 없음 — `git push <remote> <branch>` 하나.
//     - 결과 브랜치(harness/*)는 올리지 않는다 — 먼저 accept.
//     - 원격이 앞서 있으면(빨리감기가 아니면) 거부 — pull/merge 는 사람이 한다.
//   대화형 Claude Code 에서는 이 명령이 허용 목록에 없어 실행 때 **승인 프롬프트**가 뜬다 — "완성된 결과를 보여 주고 한 번 승인" 의 모양.
const S = require('./state'), G = require('./git');

function usage(m) { return Object.assign(new Error(m), { code: 'USAGE' }); }
// 원격 git 호출은 자격 증명 창(GCM · 편집기 askpass · 터미널)을 띄우지 않는다 — 저장된 토큰만 쓴다. 없으면 실패를 한 번 알린다(authHint).
//   [2026-10-29 사용자 지시 중계] "토큰을 오래 보유하고 계속 요청하지 마라" — 하네스 push 의 fetch · ls-remote · push 가 매번 창을 띄울 수 있었다.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };

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
  const fetched = G.git(root, ['fetch', '--quiet', remote, branch], { allowFail: true, env: NO_PROMPT });
  const remoteRef = `${remote}/${branch}`;
  const remoteSha = G.headSha(root, `refs/remotes/${remoteRef}`);
  const localSha = G.headSha(root, branch);
  const count = range => Number(G.git(root, ['rev-list', '--count', range], { allowFail: true }).out || 0);
  const ahead = remoteSha ? count(`${remoteRef}..${branch}`) : count(branch);
  const behind = remoteSha ? count(`${branch}..${remoteRef}`) : 0;
  const commits = G.git(root, ['log', '--oneline', '-20', remoteSha ? `${remoteRef}..${branch}` : branch], { allowFail: true }).out.split(/\r?\n/).filter(Boolean);
  return { root, remote, branch, localSha, remoteSha, ahead, behind, commits, fetched: fetched.ok, fetchError: fetched.ok ? null : String(fetched.err || '').trim().slice(0, 200) };
}

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
  const ls = G.git(root, ['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { allowFail: true, env: NO_PROMPT });
  const lines = ls.out.split(/\r?\n/).filter(Boolean).map(l => l.split(/\s+/));
  const peeled = (lines.find(([, r]) => r === `refs/tags/${tag}^{}`) || lines.find(([, r]) => r === `refs/tags/${tag}`) || [])[0] || null;
  const base = { root, remote, branch: `tag ${tag}`, tag, localSha: local, remoteSha: peeled, ahead: 0, commits: [], fetched: ls.ok, fetchError: ls.ok ? null : String(ls.err || '').trim().slice(0, 200) };
  if (!ls.ok && AUTH.test(base.fetchError || '')) return { ...base, ok: false, pushed: false, reason: `authentication to ${remote} failed — nothing was pushed` };
  if (peeled && peeled === local) return { ...base, ok: true, pushed: false, reason: `nothing to push — ${remote} already has tag ${tag} at ${local.slice(0, 10)}` };
  if (peeled) return { ...base, ok: false, refused: true, reason: `${remote} has tag ${tag} at a different commit (${peeled.slice(0, 10)}; local ${local.slice(0, 10)}) — tags are not overwritten; use a new tag name` };
  if (o.dryRun) return { ...base, ok: true, pushed: false, dryRun: true, reason: `would push tag ${tag} (${local.slice(0, 10)})` };
  const r = G.git(root, ['push', remote, `refs/tags/${tag}:refs/tags/${tag}`], { allowFail: true, timeout: 180000, env: NO_PROMPT });
  if (!r.ok) return { ...base, ok: false, pushed: false, reason: `git push failed: ${String(r.err || '').trim().slice(0, 400)}` };
  return { ...base, ok: true, pushed: true, reason: `pushed tag ${tag} (${local.slice(0, 10)}) to ${remote}` };
}

function push(o) {
  if (o.tag) return pushTag(o);
  const p = plan(o);
  // 인증에서 막혔으면 push 도 같은 이유로 막힌다 — 다시 묻지 않고 여기서 한 번 알린다
  if (!p.fetched && AUTH.test(p.fetchError || '')) return { ...p, ok: false, pushed: false, reason: `authentication to ${p.remote} failed — nothing was pushed` };
  if (!p.fetched && p.remoteSha == null) {/* 새 브랜치일 수 있다 — push 가 판단한다 */}
  if (p.behind > 0) return { ...p, ok: false, refused: true, reason: `${p.remote}/${p.branch} is ${p.behind} commit(s) ahead of ${p.branch} — not a fast-forward. Bring those commits in yourself (pull/merge), then push again.` };
  if (p.ahead === 0) return { ...p, ok: true, pushed: false, reason: `nothing to push — ${p.remote}/${p.branch} already has ${p.branch}` };
  if (o.dryRun) return { ...p, ok: true, pushed: false, dryRun: true, reason: `would push ${p.ahead} commit(s)` };
  const r = G.git(p.root, ['push', p.remote, `refs/heads/${p.branch}:refs/heads/${p.branch}`], { allowFail: true, timeout: 180000, env: NO_PROMPT });
  if (!r.ok) return { ...p, ok: false, pushed: false, reason: `git push failed: ${String(r.err || '').trim().slice(0, 400)}` };
  return { ...p, ok: true, pushed: true, reason: `pushed ${p.ahead} commit(s) to ${p.remote}/${p.branch}` };
}

// 인증 실패는 하네스가 고칠 수 없다 — git 이 콘솔 없는 자식으로 돌아 자격 증명 창을 못 띄웠거나 저장된 자격이 없을 때다.
//   [2026-10-01 Python 서비스 저장소] gitea fetch 가 한 번 Authentication failed 로 끝났다가 같은 명령이 곧 통과했다 — 원인은 하네스 밖.
const AUTH = /Authentication failed|could not read Username|terminal prompts disabled|\b40[13]\b|Permission denied \(publickey/i;
function authHint(r) {
  return AUTH.test(`${r.fetchError || ''}\n${r.reason || ''}`) ? `hint: authentication to ${r.remote} failed — run \`git fetch ${r.remote}\` once in your own terminal to store credentials, then run this again` : null;
}

function format(r) {
  const L = [`pilot push — ${r.refused ? 'REFUSED' : r.ok ? (r.pushed ? 'PUSHED' : r.dryRun ? 'DRY RUN' : 'NOTHING TO PUSH') : 'FAILED'}: ${r.branch} → ${r.remote}`, `why: ${r.reason}`];
  if (r.commits && r.commits.length) L.push(`commits (${r.ahead}):`, ...r.commits.map(c => `  ${c}`), ...(r.ahead > r.commits.length ? [`  … (+${r.ahead - r.commits.length})`] : []));
  if (r.fetchError) L.push(`note: fetch failed (${r.fetchError}) — the remote state may be stale`);
  const h = authHint(r); if (h) L.push(h);
  return L.join('\n');
}

module.exports = { plan, push, format };

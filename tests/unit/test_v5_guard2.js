'use strict';
// guard 감사(2026-10-29) 회귀 — 우회(막아야 하는데 통과하던 것)와 오탐(통과해야 하는데 막던 것).
//   decide() 를 같은 프로세스에서 부른다(모델 호출 없음). 저장소는 전부 임시 git 저장소, 전역 git 설정은 빈 파일로 돌린다.
//   실제 명령은 실행하지 않는다 — 판정만 본다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const R = makeReporter('v5 guard — 감사 회귀(약어 · 셸 입력 · cd · 삭제 · 비밀 · gh · MCP)');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-guard2-'));
const gitGlobal = path.join(base, 'gitconfig-global');
fs.writeFileSync(gitGlobal, '');
process.env.GIT_CONFIG_GLOBAL = gitGlobal;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.HARNESS_AGENTS = 'off';          // 게시판의 산 세션 판정에 진짜 claude 를 부르지 않는다
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[k];

const HOOKS = path.join(__dirname, '..', '..', 'harness', 'hooks');
const G = require(path.join(HOOKS, 'guard.js'));
const C = require(path.join(HOOKS, '_common.js'));

function git(cwd, ...args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function mkRepo(name, files, branch) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch || 'main');
  for (const [f, t] of Object.entries(files || { 'README.md': '# r\n' })) write(path.join(dir, f), t);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=setup', '-c', 'user.email=setup@x', 'commit', '-q', '-m', 'init');
  return dir;
}
const decide = (cwd, command, tool, extra) => {
  try { return G.decide({ hook_event_name: 'PreToolUse', session_id: 'me', cwd, tool_name: tool || 'Bash', tool_input: { command }, ...(extra || {}) }, 'claude'); } catch (e) { return 'THREW:' + e.message; }
};
const show = c => String(c).replace(/\n/g, '\\n').slice(0, 90);
function block(cwd, list, tag) { for (const [c, t] of list) { const r = decide(cwd, c, t); R.check(`[${tag}] 막는다(${t || 'Bash'}): ${show(c)}`, typeof r === 'string' && !/^THREW/.test(r), String(r)); } }
function allow(cwd, list, tag) { for (const [c, t] of list) { const r = decide(cwd, c, t); R.check(`[${tag}] 통과(${t || 'Bash'}): ${show(c)}`, r === null, String(r)); } }

try {
  const repo = mkRepo('repo', { 'README.md': '# g\n', 'src/a.js': 'a\n', 'sub/s.txt': 's\n', 'a.txt': '1\n' });
  git(repo, 'branch', 'feat');
  const outside = path.join(base, 'x'); fs.mkdirSync(outside, { recursive: true });
  const sub = path.join(repo, 'sub');

  // ── 1. git long option 약어 · --no-<옵션> 부정 · 옵션 값 자리의 --dry-run/--abort ──
  block(repo, [
    ['git reset --har'], ['git reset --h'], ['git commit --amen -m x'], ['git commit --am -m x'], ['git clean --forc'], ['git checkout --forc main'],
    ['git branch --del --forc feat'], ['git push -n --no-dry-run origin main'], ['git push --dry-run --no-dry-run origin main'], ['git clean -f -n --no-dry-run'],
    ['git rm -r --cached --no-cached .'], ['git add -n --no-dry-run .env'], ['git push -o --dry-run origin main'], ['git merge -m --abort feat'], ['git rebase -X --abort main'],
    ['git switch --disc main'],
  ], '약어');
  allow(repo, [['git push --dry origin main'], ['git clean -f --dry-run'], ['git rm -r --cach .'], ['git merge --abo'], ['git rebase --cont'], ['git push -n origin main']], '약어');

  // ── 2. -h 는 옵션 값이면 도움말이 아니다 ──
  block(repo, [['git commit --amend -m -h'], ['git stash push -m -h'], ['git merge -m -h feat'], ['git push -o -h origin main'], ['git rebase -X -h main']], '-h');
  allow(repo, [['git push -h'], ['git commit --help'], ['git reset -h']], '-h');

  // ── 3. cd 대상을 풀 수 없음 · 인자 없는 cd · 서브셸 · pushd/popd ──
  const dec3 = (cwd, c, t) => decide(cwd, c, t);
  for (const [cwd, c] of [
    [sub, 'cd "$(git rev-parse --show-toplevel)" && rm -rf .git'], [sub, 'cd "$(git rev-parse --show-toplevel)" && rm -rf ./*'], [sub, 'cd $ROOTX && rm -rf ./*'],
    [sub, 'cd && rm -rf ./*'], [repo, `(cd ${JSON.stringify(outside)} && true) && rm -rf ./* .git`], [repo, 'pushd sub && popd && rm -rf ./*'],
    [repo, `x=$(cd ${JSON.stringify(outside)}; pwd); rm -rf .git`],
  ]) { const r = dec3(cwd, c); R.check(`[cd] 막는다: ${show(c)}`, typeof r === 'string', String(r)); }
  for (const [cwd, c] of [[sub, 'cd "$(git rev-parse --show-toplevel)" && rm -rf build'], [repo, '(cd sub && rm -rf build)'], [repo, 'pushd sub && rm -rf build && popd']]) {
    const r = dec3(cwd, c); R.check(`[cd] 통과: ${show(c)}`, r === null, String(r));
  }
  // cd .. 뒤에도 세션 저장소(처음 cwd 의 저장소)를 지킨다
  const rname = path.basename(repo);
  block(repo, [[`cd .. && rm -rf ${rname}`], [`cd .. && rm -rf ${rname}/.git`], [`Set-Location ..; Remove-Item -Recurse -Force ${rname}`, 'PowerShell'], [`cd .. && rm -rf ${JSON.stringify(repo)}`]], 'cd..');
  allow(repo, [['cd .. && rm -rf x']], 'cd..');
  // PowerShell: 명령 출력을 담은 변수로 옮긴 cwd 는 모른다(명령 글자를 경로로 읽지 않는다)
  block(sub, [['$root = git rev-parse --show-toplevel; Set-Location $root; Remove-Item -Recurse -Force .git', 'PowerShell'], ['$r = Get-Location; Set-Location $r; Remove-Item -Recurse -Force .\\*', 'PowerShell']], 'cd ps');

  // ── 4. 셸 · iex 가 stdin(heredoc · here-string · 파이프)으로 받는 명령 ──
  block(repo, [
    ["bash <<< 'git reset --hard'"], ["bash <<'EOF'\ngit reset --hard\nEOF"], ["sh <<'EOF'\ngit push\nEOF"], ["echo 'git push' | sh"], ["cat <<'EOF' | bash\ngit push\nEOF"],
    ["'git push' | iex", 'PowerShell'], ["'git reset --hard' | Invoke-Expression", 'PowerShell'], ["'git push' | powershell -Command -", 'PowerShell'], ['echo git push | cmd', 'Bash'],
  ], 'stdin');
  allow(repo, [["cat <<'EOF' > x.sh\ngit push\nEOF"], ["echo 'git push' | grep push"], ["bash <<'EOF'\ngit status\nEOF"]], 'stdin');

  // ── 5. 목록 밖 git 하위 명령 ──
  write(path.join(repo, '.env'), 'S=1\n');
  block(repo, [
    ['git stage .env'], ['git update-index --add .env'], ['git read-tree -u --reset HEAD'], ['git checkout-index -a -f'], ['git send-pack ../x main'],
    ['git filter-branch -f --msg-filter cat -- --all'], ["git submodule foreach 'git reset --hard'"], ['git config alias.pp push && git pp'],
  ], 'git 하위');
  allow(repo, [['git stage src/a.js'], ['git read-tree HEAD'], ["git submodule foreach 'git status'"], ['git config alias.st status && git st']], 'git 하위');
  fs.rmSync(path.join(repo, '.env'));

  // ── 6. 커밋 경로: 자기 파일만 지정한 커밋은 남이 스테이징한 비밀 때문에 막지 않는다 · 경로로 지정한 비밀은 막는다 ──
  const sr = mkRepo('secret-staged', { 'a.txt': '1\n' });
  write(path.join(sr, '.env'), 'S=1\n'); git(sr, 'add', '-f', '--', '.env');
  write(path.join(sr, 'a.txt'), '2\n'); git(sr, 'add', '--', 'a.txt');
  allow(sr, [['git commit -m "fix a" -- a.txt'], ['git commit -m "fix a" a.txt'], ['git commit -m "fix a" --only -- a.txt']], '커밋 오탐');
  block(sr, [['git commit -m x'], ['git commit -m x -i -- a.txt']], '커밋 오탐');
  const tr = mkRepo('secret-tracked', { 'a.txt': '1\n' });
  write(path.join(tr, '.env'), 'S=1\n'); git(tr, 'add', '-f', '--', '.env'); git(tr, '-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-q', '-m', 'env');
  write(path.join(tr, '.env'), 'S=NEW\n'); write(path.join(tr, 'list.txt'), '.env\n');
  block(tr, [['git commit -m x .env'], ['git commit -m x .'], ['git commit -m x -- .'], ['git commit -m x -o .env'], ['git commit -m x --pathspec-from-file=list.txt'], ['git commit -m x -i .env']], '커밋 경로');
  allow(tr, [['git commit -m x a.txt']], '커밋 경로');
  const ir = mkRepo('secret-ignored', { '.gitignore': '.env\n', 'a.txt': '1\n' });
  write(path.join(ir, '.env'), 'S=1\n'); write(path.join(ir, 'b.txt'), 'b\n');
  block(ir, [['git add -f .'], ['git add --force .'], ['git add -f -A']], 'add -f');
  allow(ir, [['git add .'], ['git add -A']], 'add -f');

  // ── 7. 변수 · 래퍼 · Start-Process · powershell 위치 인자 · cmd ^ ──
  block(repo, [
    ['p=push; git $p origin main'], ['winpty git push'], ['setsid git push'], ['timeout -s KILL 60 git push'], ['wsl -d Ubuntu git push'],
    ["$c='push'; git $c origin main", 'PowerShell'], ["$g='git'; & $g push", 'PowerShell'], ["Start-Process git -ArgumentList 'push origin main' -Wait", 'PowerShell'],
    ["Start-Process -FilePath git -ArgumentList 'reset','--hard'", 'PowerShell'], ['Start-Process git -ArgumentList push,origin', 'PowerShell'],
    ['powershell -ExecutionPolicy Bypass git push', 'PowerShell'], ['cmd /c git ^push', 'Bash'], ['$x = git push', 'PowerShell'], ['git $UNKNOWN_SUBCOMMAND origin main'],
  ], '감춤');
  allow(repo, [["Start-Process git -ArgumentList 'status'", 'PowerShell'], ['p=status; git $p'], ['powershell -ExecutionPolicy Bypass -File x.ps1', 'PowerShell'], ["$c = 'x'", 'PowerShell']], '감춤');

  // ── 8. 재귀 삭제 인자: 긴 묶음 · -Recurse:$true · -Path:값 · 쉼표 배열 · 괄호 식 · 파이프 입력 · 글롭 · .NET ──
  block(repo, [
    ['rm -dfrv .'], ['rm -rf .??*'], ['rm -rf .g*'], ['ls -A | xargs rm -rf'],
    ['Remove-Item . -Recurse:$true -Force', 'PowerShell'], ['Remove-Item -Recurse:$true -Force .git', 'PowerShell'], ['Remove-Item -Recurse -Force -LiteralPath:.git', 'PowerShell'],
    ['Remove-Item -Recurse -Force -Path:.git', 'PowerShell'], ['Remove-Item -Recurse -Force -Path src,.git', 'PowerShell'], ['Remove-Item -Recurse -Force (Get-Location)', 'PowerShell'],
    ['Remove-Item -Recurse -Force (Join-Path (Get-Location) .git)', 'PowerShell'], ['Get-ChildItem -Force | Remove-Item -Recurse -Force', 'PowerShell'], ['Remove-Item -Recurse -Force .g*', 'PowerShell'],
    ['Remove-Item -Recurse -Force -Path .g*', 'PowerShell'], ["[System.IO.Directory]::Delete('.git', $true)", 'PowerShell'],
  ], '삭제');
  allow(repo, [
    ['rm -rf s*'], ['Remove-Item .\\src -Recurse:$false', 'PowerShell'], ['Get-ChildItem build | Remove-Item -Recurse -Force', 'PowerShell'],
    ['Get-ChildItem -Recurse -Filter bin -Directory | Remove-Item -Recurse -Force', 'PowerShell'], ['find . -name node_modules -type d | xargs rm -rf'], ['Remove-Item -Recurse -Force .\\build', 'PowerShell'],
  ], '삭제');

  // ── 9. Git Bash 의 cmd //c ──
  block(repo, [['cmd //c "rd /s /q .git"'], ['cmd.exe //c rd //s //q .git'], ['cmd //C "rmdir /S /Q ."'], ['cmd //c "git push"']], 'cmd //c');

  // ── 10. 인터프리터 한 줄: 결합형 · 묶음형 플래그 · 파일 API 삭제 ──
  block(repo, [
    ["node --eval=\"require('child_process').execSync('git push')\""], ["node -pe \"require('child_process').execSync('git push')\""], ["python -Ic \"import os; os.system('git push')\""],
    ["node -e \"require('fs').rmSync('.git',{recursive:true,force:true})\""], ["python -c \"import shutil; shutil.rmtree('.git')\""],
  ], '한 줄');
  allow(repo, [["node -e \"require('fs').rmSync('build',{recursive:true})\""], ["node -pe \"1+1\""]], '한 줄');

  // ── 11. MCP: GitLab 병합 · git 글자가 없는 서버 이름 ──
  const mcp = t => G.decide({ hook_event_name: 'PreToolUse', session_id: 'm', cwd: repo, tool_name: t, tool_input: {} }, 'claude');
  for (const t of ['mcp__gitlab__merge_merge_request', 'mcp__gitlab__accept_merge_request', 'mcp__gh__push_files', 'mcp__scm__git_push', 'mcp__forge__merge_pull_request']) R.check(`[mcp] 막는다: ${t}`, typeof mcp(t) === 'string', String(mcp(t)));
  for (const t of ['mcp__scm__git_status', 'mcp__gh__get_pull_request', 'mcp__gitlab__get_merge_request']) R.check(`[mcp] 통과: ${t}`, mcp(t) === null, String(mcp(t)));

  // ── 12. 오탐: branch -M <새 이름> · mktemp 로 만든 임시 폴더 지우기 ──
  const mr = mkRepo('master-repo', { 'a.txt': '1\n' }, 'master');
  allow(mr, [['git branch -M main']], 'branch -M');
  allow(repo, [['git branch -M main'], ['git branch -m old new']], 'branch -M');
  block(repo, [['git branch -M feat main'], ['git branch -C feat main'], ['git branch -f main HEAD~1']], 'branch -M');
  git(mr, 'branch', 'main');
  block(mr, [['git branch -M main']], 'branch -M');
  allow(repo, [['tmp=$(mktemp -d); cd "$tmp" && ls; rm -rf "$tmp"'], ['tmp="$(mktemp -d)" && rm -rf "$tmp/build"'], ['d=$(mktemp -d); cd "$d" && rm -rf ./*']], 'mktemp');
  block(repo, [['tmp=$(mktemp -d); rm -rf "$tmp/.."'], ['tmp=$(echo x); rm -rf "$tmp"']], 'mktemp');

  // ── 13. gh · glab CLI 의 원격 쓰기(MCP 와 같은 판정) ──
  block(repo, [
    ['gh pr merge 12 --merge'], ['gh pr merge 1 --squash --delete-branch'], ['gh api -X PUT repos/o/r/pulls/1/merge'], ['gh api -X DELETE repos/o/r/git/refs/heads/main'],
    ['gh repo delete o/r --yes'], ['gh pr merge 1 --merge', 'PowerShell'], ['gh api --method=PUT repos/o/r/pulls/1/merge'], ['glab mr merge 3'],
    ["gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }'"],
  ], 'gh');
  allow(repo, [['gh pr view 1'], ['gh api repos/o/r/pulls/1'], ['gh pr create --fill'], ['gh issue comment 1 --body "merge later"'], ["gh api graphql -f query='query { viewer { login } }'"]], 'gh');

  // ── 14. ${x:-$(…)} 안의 명령 치환 ──
  block(repo, [['echo ${x:-$(git push)}'], ['echo ${x:-$(git reset --hard HEAD~1)}'], ['cat ${f:-$(git stash)}'], [': ${x:=`git reset --hard`}']], '${}');
  allow(repo, [['echo ${HOME}'], ['echo ${x:-default}']], '${}');

  // ── 15. 비밀 파일 이름 — AGENTS 규칙(.env* · *.pem · *.key · id_rsa* · .npmrc · credentials* · *.tfstate · service-account*.json) ──
  const yes = ['id_rsa_github', 'id_ed25519_work', '.envrc', '.env.production', '.git-credentials', 'credentials-prod.json', 'credentials.bak', 'my.ppk', 'prod.env', 'x.pem', 'a.key', '.npmrc', 'service-account-prod.json', 'infra/x.tfstate'];
  const no = ['credentials.js', 'src/credentials_test.py', 'lib/credentials.ts', '.env.example', '.env.sample', 'id_rsa.pub', 'id_rsa_github.pub', 'environment.ts', 'README.md'];
  R.check('[secret] AGENTS 규칙의 비밀 이름을 모두 비밀로 본다', yes.every(C.isSecretPath), JSON.stringify(yes.filter(f => !C.isSecretPath(f))));
  R.check('[secret] 소스 · 템플릿 · 공개 키는 비밀이 아니다', !no.some(C.isSecretPath), JSON.stringify(no.filter(C.isSecretPath)));
  block(repo, [['git add id_rsa_github'], ['git add .envrc'], ['git add credentials-prod.json']], 'secret');

  // ── 16. 다른 세션이 고치는 미커밋 파일을 셸 git 으로 되돌리기 ──
  const pr = mkRepo('peer', { 'a.txt': '1\n', 'b.txt': '1\n' });
  write(path.join(pr, 'a.txt'), 'peer edit\n'); write(path.join(pr, 'b.txt'), 'my edit\n');
  const now = new Date().toISOString();
  write(path.join(pr, '.git', 'harness', 'sessions', 'peer.json'), JSON.stringify({ session_id: 'peer', runtime: 'claude', files: ['a.txt'], updated_at: now, last_seen: now }));
  write(path.join(pr, '.git', 'harness', 'sessions', 'me.json'), JSON.stringify({ session_id: 'me', runtime: 'claude', files: ['b.txt'], updated_at: now, last_seen: now }));
  block(pr, [['git restore a.txt'], ['git checkout -- a.txt'], ['git restore -- a.txt']], 'peer');
  allow(pr, [['git restore b.txt'], ['git checkout -- b.txt'], ['git restore --staged a.txt'], ['git checkout feat-none 2>/dev/null || true']], 'peer');

  // ── 17. 훅의 git 은 Windows 에서 긴 경로를 켠다(core.longpaths) — MAX_PATH 를 넘는 파일도 미커밋으로 본다 ──
  const lp = mkRepo('lp', { 'a.txt': '1\n' });
  const rel = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'd'.repeat(60), 'long_file_name_for_test.txt'].join('/');
  let made = true; try { write(path.join(lp, ...rel.split('/')), 'x\n'); } catch { made = false; }
  if (made) {
    let dirty = null; try { dirty = C.dirtyPaths(lp); } catch (e) { dirty = String(e); }
    R.check('[longpaths] dirtyPaths 가 MAX_PATH 를 넘는 새 파일을 본다', dirty instanceof Map && [...dirty.values()].includes(rel), dirty instanceof Map ? JSON.stringify([...dirty.values()]) : String(dirty));
    const u = C.uncommittedOf(lp, [rel]);
    R.check('[longpaths] uncommittedOf 도 그 파일을 세션 파일로 잡는다', u.mine.length === 1 && u.mine[0] === rel, JSON.stringify(u));
  } else R.check('[longpaths] 긴 경로 파일을 만들 수 있다(시험 준비)', false, 'fs 쓰기 실패');
} catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 폴더 정리 실패는 결과와 무관 */ } }
R.done();

'use strict';
// v5 대화형 세션 훅 — guard(비가역 명령 차단) · track(세션이 고친 파일) · stop(자기 파일 커밋 강제/자동) · session-end(안전망).
//   훅은 실제로 프로세스로 띄워 stdin JSON 을 준다(설치된 모양 그대로). 저장소는 전부 임시 git 저장소,
//   HOME · USERPROFILE · CODEX_HOME · 전역 git 설정은 임시로 돌린다 — 실제 ~/.claude · ~/.codex 는 건드리지 않는다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { makeReporter } = require('../run.js');
const R = makeReporter('v5 훅 — guard · track · stop · session-end');

const HOOKS = path.join(__dirname, '..', '..', 'harness', 'hooks');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-hooks-'));
const home = path.join(base, 'home');
fs.mkdirSync(home, { recursive: true });
const gitGlobal = path.join(base, 'gitconfig-global');
fs.writeFileSync(gitGlobal, '');
// 저장소 밖에서 훅이 남기는 오류 로그(os.tmpdir()/harness)도 임시 폴더로 — 사용자의 TEMP 에 쓰지 않는다.
const hookTmp = path.join(base, 'tmp'); fs.mkdirSync(hookTmp, { recursive: true });
const ENV = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), GIT_CONFIG_GLOBAL: gitGlobal, GIT_CONFIG_NOSYSTEM: '1', TEMP: hookTmp, TMP: hookTmp, TMPDIR: hookTmp };
for (const k of ['CLAUDE_PROJECT_DIR', 'HARNESS_HOOK_RUNTIME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[k];

function hook(name, payload, args, cwd) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [path.join(HOOKS, name + '.js'), ...(args || [])], { input, encoding: 'utf8', env: ENV, cwd: cwd || base, windowsHide: true, timeout: 30000 });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { json = 'UNPARSEABLE:' + r.stdout; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function hookAsync(name, payload, args, cwd) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [path.join(HOOKS, name + '.js'), ...(args || [])], { env: ENV, cwd: cwd || base, windowsHide: true });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('close', code => resolve({ status: code, stdout: out }));
    c.stdin.end(JSON.stringify(payload));
  });
}
function git(cwd, ...args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV, windowsHide: true }); return (r.stdout || '').trim(); }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function mkRepo(name, files) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files || { 'README.md': '# r\n' })) write(path.join(dir, f), t);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=setup', '-c', 'user.email=setup@x', 'commit', '-q', '-m', 'init');
  return dir;
}
const sessionFile = (repo, sid) => path.join(repo, '.git', 'harness', 'sessions', sid + '.json');
const readSession = (repo, sid) => { try { return JSON.parse(fs.readFileSync(sessionFile(repo, sid), 'utf8')); } catch { return null; } };
const isDeny = r => r.status === 0 && r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.hookEventName === 'PreToolUse' &&
  r.json.hookSpecificOutput.permissionDecision === 'deny' && typeof r.json.hookSpecificOutput.permissionDecisionReason === 'string';
const isAllow = r => r.status === 0 && r.stdout.trim() === '';
const status = repo => (spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8', env: ENV, windowsHide: true }).stdout || '').replace(/\s+$/, '');
// 설치 흐름의 쓰기 전 이벤트 — PreToolUse(Write) = board. [2026-11-02 소유권] stop · session-end 는 쓰기 전 기록이 있어야 대신 커밋한다.
const claudePre = (repo, sid, file) => hook('board', { hook_event_name: 'PreToolUse', session_id: sid, cwd: repo, prompt_id: 'p', tool_name: 'Write', tool_input: { file_path: file, content: 'x' } });
const claudeWrite = (repo, sid, file, tool) => hook('track', { hook_event_name: 'PostToolUse', session_id: sid, cwd: repo, prompt_id: 'p', tool_name: tool || 'Write', tool_input: { file_path: file, content: 'x' }, tool_response: { success: true } });

(async () => {
  try {
    // ── guard ─────────────────────────────────────────────────────────
    const repo = mkRepo('guard', { 'README.md': '# g\n', 'src/a.js': 'a\n' });
    const pre = (command, tool, extra) => hook('guard', { hook_event_name: 'PreToolUse', session_id: 'g1', cwd: repo, prompt_id: 'p', tool_name: tool || 'Bash', tool_input: { command }, ...(extra || {}) });
    const mustBlock = [
      ['git push', 'Bash'], ['git push origin main --force', 'Bash'], ['git -C . push', 'Bash'], ['git   push', 'Bash'],
      ['git --git-dir=.git --work-tree . push', 'Bash'], ['git --no-pager -c core.x=1 push origin', 'Bash'], ['git push; echo done', 'PowerShell'],
      ['echo hi && git push', 'Bash'], ['ls || git push', 'Bash'], ['echo a\ngit push', 'Bash'], ['(cd sub && git push)', 'Bash'],
      ['bash -c "git push"', 'Bash'], ['sh -lc \'git push\'', 'Bash'], ['x=$(git push)', 'Bash'], ['echo `git push`', 'Bash'], ['FOO=1 sudo git push', 'Bash'],
      ['powershell -NoProfile -Command "git push"', 'PowerShell'], ['& "C:\\Program Files\\Git\\cmd\\git.exe" push', 'PowerShell'], ['cmd /c "git push"', 'Bash'],
      ['git reset --hard', 'Bash'], ['git reset --hard HEAD~1', 'PowerShell'], ['git clean -fd', 'Bash'], ['git clean -xdf', 'Bash'], ['git clean --force', 'Bash'],
      ['git branch -D feature', 'Bash'], ['git branch --delete --force feature', 'Bash'], ['git branch -d -f feature', 'Bash'],
      ['git checkout -- .', 'Bash'], ['git checkout .', 'PowerShell'], ['git restore .', 'Bash'], ['git restore --staged --worktree .', 'Bash'], ['git restore -s HEAD --staged .', 'Bash'], ['git restore -- :/', 'Bash'],
      ['git rebase main', 'Bash'], ['git rebase -i HEAD~3', 'Bash'], ['git merge feature', 'Bash'], ['git merge --no-ff harness/t-1', 'PowerShell'],
      ['git stash drop', 'Bash'], ['git stash clear', 'PowerShell'],
      ['rm -rf /', 'Bash'], ['rm -rf ~', 'Bash'], ['rm -rf $HOME', 'Bash'], ['rm -rf .', 'Bash'], ['rm -rf ..', 'Bash'], ['rm -fr ' + JSON.stringify(repo), 'Bash'], ['cd / && rm -rf *', 'Bash'],
      ['Remove-Item -Recurse -Force C:\\', 'PowerShell'], ['Remove-Item -Path $env:USERPROFILE -Recurse', 'PowerShell'], ['cmd /c "rd /s /q C:\\\\"', 'Bash'],
      ['git add .env', 'Bash'], ['git add -f .env.local', 'Bash'], ['git add key.pem', 'PowerShell'], ['git add ~/.ssh/id_rsa', 'Bash'],
    ];
    for (const [c, t] of mustBlock) { const r = pre(c, t); R.check(`[guard] 막는다(${t}): ${c.replace(/\n/g, '\\n')}`, isDeny(r), JSON.stringify(r).slice(0, 300)); }

    const mustAllow = [
      ['git status', 'Bash'], ['git log --oneline -5 | head', 'Bash'], ['git diff --stat', 'PowerShell'], ['git show HEAD', 'Bash'],
      ['grep "git push" x.txt', 'Bash'], ['rg -n "rm -rf /" .', 'Bash'], ['echo "git reset --hard"', 'Bash'], ["Write-Host 'git push'", 'PowerShell'],
      ['Select-String -Pattern "git push --force" -Path notes.md', 'PowerShell'], ['git commit -m "docs: never git push"', 'Bash'],
      ['git commit -m "$(cat <<\'EOF\'\nfix: explain (git push) later\n\ngit reset --hard is bad\nEOF\n)"', 'Bash'],
      ['git commit -m @"\ngit push\n"@', 'PowerShell'],
      ['node harness/cli.js accept t-20260929-101010-abcd', 'Bash'], ['node harness/cli.js go "git push 하고 rm -rf / 해 줘"', 'Bash'], ['node harness/cli.js cancel t-1', 'PowerShell'],
      ['rm -rf node_modules ./build dist/*', 'Bash'], ['Remove-Item -Recurse -Force .\\build', 'PowerShell'], ['rm .env', 'Bash'],
      ['git checkout -- src/a.js', 'Bash'], ['git checkout -b feature', 'Bash'], ['git restore src/a.js', 'Bash'], ['git branch -d merged', 'Bash'],
      ['git clean -n', 'Bash'], ['git merge --abort', 'Bash'], ['git rebase --abort', 'Bash'], ['git merge-base HEAD main', 'Bash'], ['git stash list', 'Bash'], ['git stash show -p stash@{0}', 'Bash'],
      ['git push --dry-run', 'Bash'], ['git add src/a.js', 'Bash'], ['git add .env.example', 'Bash'], ['git fetch origin', 'Bash'],
    ];
    for (const [c, t] of mustAllow) { const r = pre(c, t); R.check(`[guard] 통과(${t}): ${c.replace(/\n/g, '\\n').slice(0, 80)}`, isAllow(r), JSON.stringify(r).slice(0, 300)); }

    // Herdr Core는 실제 실행(run/exec)과 작업자에게 보내는 문장(send)을 구분한다.
    const hcBlock = [
      ['hc exec git push origin main', 'Bash'],
      ['hc run --bg --name check "git reset --hard"', 'Bash'],
      ['hc --json exec --on build --cwd /srv/app --timeout 60 -- git push', 'Bash'],
      ['hc run --on=build --cwd=/srv/app --label=role=test --parent=t1 --outlive-parent --bg git push', 'Bash'],
      ['& "C:\\Program Files\\Herdr Core\\hc.exe" exec --cwd "C:\\repo with spaces" -- git reset --hard', 'PowerShell'],
      ['hc exec --env G=git pwsh -Command "$env:G push"', 'PowerShell'],
      ['hc run --bg bash -lc "git clean -fd"', 'Bash'],
      ['hc exec -i sh <<\'EOF\'\ngit push\nEOF', 'Bash'],
      ['echo "git push" | hc exec --stdin sh', 'Bash'],
      ['hc run \'$g="git"; & $g push origin main\'', 'Bash'],
      ['hc run --on vps \'git pu\\sh origin main\'', 'PowerShell'],
    ];
    for (const [c, t] of hcBlock) { const r = pre(c, t); R.check(`[guard/hc] 실행 내부를 막는다(${t}): ${c}`, isDeny(r), JSON.stringify(r).slice(0, 300)); }
    const hcAllow = [
      ['hc send t7 "git push 하지 말고 git reset --hard 위험을 보고하세요"', 'Bash'],
      ['hc send --wait t7 "git push 차단 검토 완료"', 'Bash'],
      ['hc run --bg --name review reviewer "git push 차단 검토"', 'Bash'],
      ['hc exec --on build --cwd /srv/app git status --short', 'Bash'],
      ['hc exec -- git push --dry-run', 'Bash'],
      ['hc exec "git push"', 'Bash'], // exec는 셸 문자열을 실행하지 않는다.
      ['hc run --help "git push"', 'Bash'],
      ['hc read t7 --lines 100', 'Bash'],
    ];
    for (const [c, t] of hcAllow) { const r = pre(c, t); R.check(`[guard/hc] 읽기·지시문 통과(${t}): ${c}`, isAllow(r), JSON.stringify(r).slice(0, 300)); }
    R.check('[guard/hc] --cwd는 내부 실행에만 적용한다', isDeny(pre('hc exec --cwd src git status; rm -rf .', 'Bash')));

    // 넓은 add 는 실제 작업 트리를 본다 — 추적 안 된 비밀 파일이 쓸려 들어가면 막는다.
    write(path.join(repo, 'src', 'b.js'), 'b\n');
    R.check('[guard] git add -A — 비밀 파일이 없으면 통과', isAllow(pre('git add -A', 'Bash')));
    write(path.join(repo, 'config', '.env'), 'SECRET=1\n');
    const broad = pre('git add -A', 'Bash');
    R.check('[guard] git add -A — 추적 안 된 config/.env 가 있으면 막고 그 파일을 이유에 적는다', isDeny(broad) && /config\/\.env/.test(broad.json.hookSpecificOutput.permissionDecisionReason), broad.stdout);
    R.check('[guard] git add . 도 같다', isDeny(pre('git add .', 'Bash')));
    R.check('[guard] git add src — 비밀 없는 하위 폴더는 통과', isAllow(pre('git add src', 'Bash')));
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
    R.check('[guard] .gitignore 된 비밀은 add -A 로 들어가지 않는다 → 통과', isAllow(pre('git add config src', 'Bash')), pre('git add config src', 'Bash').stdout);
    git(repo, 'add', '-f', 'config/.env');
    const cm = pre('git commit -m "wip"', 'Bash');
    R.check('[guard] git commit — .env 가 스테이징돼 있으면 막는다', isDeny(cm) && /\.env/.test(cm.json.hookSpecificOutput.permissionDecisionReason), cm.stdout);
    git(repo, 'reset', '-q', '--', 'config/.env');
    R.check('[guard] 스테이징을 풀면 커밋 통과', isAllow(pre('git commit -m "wip"', 'Bash')));

    R.check('[guard] 차단 이유에 대신 할 일이 있다(merge → accept)', /node harness\/cli\.js accept/.test(pre('git merge x', 'Bash').json.hookSpecificOutput.permissionDecisionReason));
    // [리뷰 M9] 제어 구문(then/do/else …) 뒤의 위험 명령 · 삭제 대상이 미해결 변수/치환이면 막는다(fail-closed).
    const m9Block = [
      ['for b in a b; do git push origin $b; done', 'Bash'], ['if true; then git reset --hard; fi', 'Bash'], ['while true; do git push; done', 'Bash'],
      ['if git push; then echo ok; fi', 'Bash'], ['if x; then :; else git clean -fd; fi', 'Bash'], ['until false; do git branch -D x; done', 'Bash'],
      ['rm -rf $(git rev-parse --show-toplevel)', 'Bash'], ['rm -rf "$PWD"', 'Bash'], ['rm -rf "$X"', 'Bash'], ['rm -rf $DIR/*', 'Bash'], ['rm -rf "${ROOT}/.."', 'Bash'],
      ['rm -rf `pwd`', 'Bash'], ['Remove-Item -Recurse -Force $dir', 'PowerShell'], ['cmd /c "rd /s /q %TARGET%"', 'Bash'],
    ];
    for (const [c, t] of m9Block) { const r = pre(c, t); R.check(`[guard/M9] 막는다(${t}): ${c}`, isDeny(r), JSON.stringify(r).slice(0, 300)); }
    const m9Allow = [
      ['for f in a b; do echo $f; done', 'Bash'], ['if [ -d build ]; then rm -rf build; fi', 'Bash'], ['rm -rf "$TMPDIR/build"', 'Bash'], ['rm -rf "$PWD/build"', 'Bash'],
      ['Remove-Item -Recurse -Force $env:TEMP\\harness-x', 'PowerShell'], ['rm -f $X', 'Bash'],
    ];
    for (const [c, t] of m9Allow) { const r = pre(c, t); R.check(`[guard/M9] 통과(${t}): ${c}`, isAllow(r), JSON.stringify(r).slice(0, 300)); }

    // [리뷰 M10] 거짓 음성 — 남의 미커밋을 숨기거나 브랜치·히스토리를 움직이는 git, .git 하위 재귀 삭제.
    const m10Block = [
      ['git stash', 'Bash'], ['git stash -u', 'Bash'], ['git stash push -m wip', 'Bash'], ['git stash save wip', 'PowerShell'], ['git stash pop', 'Bash'], ['git stash apply', 'Bash'],
      ['git pull', 'Bash'], ['git pull --rebase origin main', 'PowerShell'], ['git commit --amend -m x', 'Bash'], ['git commit --amend --no-edit', 'Bash'],
      ['git update-ref refs/heads/main HEAD~1', 'Bash'], ['git branch -f main HEAD~1', 'Bash'], ['git branch --force main v1', 'Bash'], ['git branch -M nosuch main', 'Bash'],
      ['git checkout -B main HEAD~1', 'Bash'], ['git switch -C main', 'Bash'], ['git switch --force-create main', 'Bash'],
      ['git reset --soft HEAD~1', 'Bash'], ['git reset --mixed HEAD~1', 'Bash'], ['git reset HEAD~1', 'PowerShell'], ['git reset --keep HEAD^', 'Bash'],
      ['git rm -rf .', 'Bash'], ['git rm -r :/', 'Bash'],
      ['rm -rf .git/objects', 'Bash'], ['rm -rf .git/harness', 'Bash'], ['rm -rf ./.git/refs/heads', 'Bash'], ['Remove-Item -Recurse -Force .git\\objects\\pack', 'PowerShell'],
    ];
    for (const [c, t] of m10Block) { const r = pre(c, t); R.check(`[guard/M10] 막는다(${t}): ${c}`, isDeny(r), JSON.stringify(r).slice(0, 300)); }
    const m10Allow = [
      ['git stash list', 'Bash'], ['git stash show stash@{0}', 'PowerShell'], ['git reset', 'Bash'], ['git reset HEAD', 'Bash'], ['git reset --soft HEAD', 'Bash'],
      ['git reset -- src/a.js', 'Bash'], ['git reset src/a.js', 'Bash'], ['git reset HEAD~1 -- src/a.js', 'Bash'], ['git rm -r --cached .', 'Bash'], ['git rm src/a.js', 'Bash'],
      ['git rm -r -n .', 'Bash'], ['git branch -m old new', 'Bash'], ['git branch -M main', 'Bash'],   // [2026-10-29 감사 오탐] 지금 브랜치(main)를 같은 이름으로 — 덮어쓸 것이 없다 ['git commit -m "amend later"', 'Bash'], ['git checkout -b fresh', 'Bash'], ['rm -f .git/index.lock', 'Bash'],
      ['git fetch --all', 'Bash'],
    ];
    for (const [c, t] of m10Allow) { const r = pre(c, t); R.check(`[guard/M10] 통과(${t}): ${c}`, isAllow(r), JSON.stringify(r).slice(0, 300)); }

    // [적대 2026-10-02] 우회 — git 별칭(명령줄 -c · 저장소 설정) · 인터프리터 한 줄(python -c · node -e …)로 감싼 git.
    git(repo, 'config', 'alias.yeet', 'push');
    git(repo, 'config', 'alias.wipe', '!git reset --hard');
    const bypassBlock = [
      ['git -c alias.p=push p', 'Bash'], ['git -c "alias.p=!git push" p origin', 'Bash'], ['git -c alias.nuke="reset --hard" nuke', 'Bash'],
      ['git yeet', 'Bash'], ['git yeet origin main', 'PowerShell'], ['git wipe', 'Bash'],
      ['python -c "import subprocess; subprocess.run([\'git\', \'push\', \'origin\'])"', 'Bash'], ['python3 -c \'import os; os.system("git reset --hard")\'', 'Bash'],
      ['node -e "require(\'child_process\').execSync(\'git push origin main\')"', 'Bash'], ['node -e "require(\'child_process\').spawnSync(\'git\',[\'stash\'])"', 'PowerShell'],
      ['ruby -e \'system("git", "push")\'', 'Bash'], ['perl -e \'system("git branch -D x")\'', 'Bash'],
    ];
    for (const [c, t] of bypassBlock) { const r = pre(c, t); R.check(`[guard/우회] 막는다(${t}): ${c}`, isDeny(r), JSON.stringify(r).slice(0, 300)); }
    const bypassAllow = [
      ['git -c alias.st=status st', 'Bash'], ['git -c alias.lg="log --oneline" lg -5', 'Bash'], ['python -c "print(1)"', 'Bash'],
      ['node -e "console.log(require(\'child_process\').execSync(\'git status\').toString())"', 'Bash'], ['node -e "console.log(1)"', 'PowerShell'],
    ];
    for (const [c, t] of bypassAllow) { const r = pre(c, t); R.check(`[guard/우회] 통과(${t}): ${c}`, isAllow(r), JSON.stringify(r).slice(0, 300)); }
    git(repo, 'config', '--unset', 'alias.yeet'); git(repo, 'config', '--unset', 'alias.wipe');

    // [리뷰 L10] 진행 중인 병합·리베이스를 끝내거나 되돌리는 명령은 통과 · index 만 푸는 restore --staged 는 통과 · merge --ff-only 는 계속 막는다(이유에 적는다).
    const l10Allow = [
      ['git merge --continue', 'Bash'], ['git merge --quit', 'Bash'], ['git rebase --continue', 'Bash'], ['git rebase --skip', 'PowerShell'], ['git rebase --quit', 'Bash'],
      ['git restore --staged .', 'Bash'], ['git restore -S -- :/', 'Bash'], ['git restore --staged src/a.js', 'Bash'],
    ];
    for (const [c, t] of l10Allow) { const r = pre(c, t); R.check(`[guard/L10] 통과(${t}): ${c}`, isAllow(r), JSON.stringify(r).slice(0, 300)); }
    const ffo = pre('git merge --ff-only feature', 'Bash');
    R.check('[guard/L10] git merge --ff-only 는 막고 이유에 accept 를 쓰는 까닭을 적는다', isDeny(ffo) && /--ff-only/.test(ffo.json.hookSpecificOutput.permissionDecisionReason) && /accept/.test(ffo.json.hookSpecificOutput.permissionDecisionReason), ffo.stdout);

    R.check('[guard] 쓰기 도구는 보지 않는다(대화형)', isAllow(hook('guard', { hook_event_name: 'PreToolUse', session_id: 's', cwd: repo, tool_name: 'Write', tool_input: { file_path: 'x', content: 'git push' } })));

    // [2026-10-25 보안 구멍] mcp__ 도구가 모두 통과였다 — git · GitHub MCP 서버로 reset · commit · push · 병합이 guard 를 비켜 갔다.
    {
      const GD = require(path.join(HOOKS, 'guard.js'));
      const mcp = (tool, ti) => GD.decide({ hook_event_name: 'PreToolUse', session_id: 'm', cwd: repo, tool_name: tool, tool_input: ti || { repo_path: repo } }, 'claude');
      const mcpBlock = [
        ['mcp__git__git_reset'], ['mcp__git__git_checkout', { repo_path: repo, branch_name: 'x' }], ['mcp__git__git_commit', { repo_path: repo, message: 'm' }], ['mcp__git__git_add', { repo_path: repo, files: ['a'] }],
        ['mcp__git__git_create_branch'], ['mcp__git__git_push'], ['mcp__git__git_merge'], ['mcp__git__git_rebase'], ['mcp__git__git_stash'], ['mcp__git__git_clean'], ['mcp__git__git_tag'],
        ['mcp__git__git_cherry_pick'], ['mcp__git__git_revert'], ['mcp__git__git_pull'], ['mcp__git__delete_branch'], ['mcp__local-git__reset'], ['mcp__git__git_branch', { repo_path: repo, delete: true, branch: 'x' }],
        ['mcp__github__push_files'], ['mcp__github__merge_pull_request'], ['mcp__github__create_or_update_file'], ['mcp__github__delete_file'], ['mcp__github__update_pull_request_branch'],
        ['mcp__github__create_repository'], ['mcp__github__fork_repository'], ['mcp__github__create_branch'], ['mcp__gitlab__delete_project'], ['mcp__gitea__push_files'], ['mcp__bitbucket__merge_pull_request'],
      ];
      for (const [t, ti] of mcpBlock) R.check(`[guard/mcp] 막는다: ${t}`, typeof mcp(t, ti) === 'string', String(mcp(t, ti)));
      const mcpAllow = [
        ['mcp__git__git_status'], ['mcp__git__git_diff'], ['mcp__git__git_diff_staged'], ['mcp__git__git_log'], ['mcp__git__git_show'], ['mcp__git__git_branch', { repo_path: repo, branch_type: 'local' }],
        ['mcp__github__get_file_contents'], ['mcp__github__list_commits'], ['mcp__github__search_code'], ['mcp__github__create_issue'], ['mcp__github__add_issue_comment'], ['mcp__github__update_issue'],
        ['mcp__github__get_pull_request'], ['mcp__filesystem__write_file'], ['mcp__memory__add_observations'], ['mcp__claude_ai_Claude_Docs__batch'],
      ];
      for (const [t, ti] of mcpAllow) R.check(`[guard/mcp] 통과: ${t}`, mcp(t, ti) === null, String(mcp(t, ti)));
      const gp = hook('guard', { hook_event_name: 'PreToolUse', session_id: 's', cwd: repo, prompt_id: 'p', tool_name: 'mcp__github__push_files', tool_input: { owner: 'o', repo: 'r', branch: 'main', files: [] } });
      const gc = hook('guard', { hook_event_name: 'PreToolUse', session_id: 's', cwd: repo, prompt_id: 'p', tool_name: 'mcp__git__git_commit', tool_input: { repo_path: repo, message: 'x' } });
      R.check('[guard/mcp] 훅 출력: deny · [pilot guard] · 허용된 길(Bash 의 git · cli.js push · accept)', isDeny(gp) && isDeny(gc) && [gp, gc].every(r => { const why = r.json.hookSpecificOutput.permissionDecisionReason; return /^\[pilot guard\]/.test(why) && /node harness\/cli\.js push/.test(why) && /accept <id>/.test(why) && /Bash/.test(why); }), gp.stdout + gc.stdout);
      R.check('[guard/mcp] 읽기 도구는 훅으로도 통과(출력 없음)', isAllow(hook('guard', { hook_event_name: 'PreToolUse', session_id: 's', cwd: repo, prompt_id: 'p', tool_name: 'mcp__git__git_status', tool_input: { repo_path: repo } })));
    }

    // Codex 페이로드 — 같은 출력 계약. 명령이 argv 배열일 수 있다.
    const cx = (command, tool) => hook('guard', { hook_event_name: 'PreToolUse', session_id: 'c1', turn_id: 't1', model: 'gpt-6', cwd: repo, tool_name: tool || 'Bash', tool_use_id: 'u1', tool_input: { command } }, ['--codex']);
    R.check('[guard/codex] 문자열 git push → deny JSON', isDeny(cx('git push origin main')));
    R.check('[guard/codex] argv ["powershell.exe","-Command","git push"] → deny', isDeny(cx(['powershell.exe', '-Command', 'git push'])));
    R.check('[guard/codex] argv ["bash","-lc","git reset --hard"] → deny', isDeny(cx(['bash', '-lc', 'git reset --hard'])));
    R.check('[guard/codex] argv ["git","status"] → 통과', isAllow(cx(['git', 'status'])));
    R.check('[guard/codex] apply_patch 는 보지 않는다', isAllow(cx('*** Begin Patch\n*** Add File: a\n+git push\n*** End Patch', 'apply_patch')));

    // 실패 시 열림 — 세션을 깨지 않되 기록은 남긴다.
    const errLog = path.join(repo, '.git', 'harness', 'hook-errors.log');
    const bad = hook('guard', '{not json', [], repo);
    R.check('[guard] 깨진 입력 → exit 0 · 출력 없음(허용)', isAll(bad), JSON.stringify(bad));
    R.check('[guard] 깨진 입력은 hook-errors.log 에 남는다', fs.existsSync(errLog) && /"hook":"guard"/.test(fs.readFileSync(errLog, 'utf8')));
    R.check('[guard] 빈 입력 · tool_input 없음 → 허용', isAllow(hook('guard', '', [], repo)) && isAllow(hook('guard', { tool_name: 'Bash', cwd: repo })));
    // [2026-10-29 감사] 판정 중 예외(여기서는 lexer 재귀 한도)는 허용으로 끝났다 — git · 삭제를 언급하면 막고, 그 밖은 열어 둔다. 둘 다 기록한다.
    {
      const deep = n => '$('.repeat(n) + 'true' + ')'.repeat(n);
      const before = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8').length : 0;
      const ex1 = pre(': ' + deep(20000) + ' ; git push --force origin main', 'Bash');
      const ex2 = pre(': ' + deep(20000) + ' ; echo hi', 'Bash');
      const logged = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8').slice(before) : '';
      R.check('[guard] 내부 예외 + git 언급 → deny(내부 오류라고 적는다)', isDeny(ex1) && /내부 오류/.test(ex1.json.hookSpecificOutput.permissionDecisionReason), JSON.stringify(ex1).slice(0, 300));
      R.check('[guard] 내부 예외 + git · 삭제 언급 없음 → 허용(열어 둔다)', isAllow(ex2), JSON.stringify(ex2).slice(0, 300));
      R.check('[guard] 내부 예외는 둘 다 hook-errors.log 에 남는다', (logged.match(/"hook":"guard"/g) || []).length >= 2, logged.slice(0, 300));
    }

    // ── track ─────────────────────────────────────────────────────────
    const tr = mkRepo('track', { 'README.md': '# t\n', 'src/a.js': 'a\n' });
    claudeWrite(tr, 'S1', path.join(tr, 'src', 'a.js'));
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'S1', cwd: path.join(tr, 'src'), prompt_id: 'p', tool_name: 'Edit', tool_input: { file_path: 'b.js', old_string: 'a', new_string: 'b' } });
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'S1', cwd: tr, prompt_id: 'p', tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(tr, 'nb', 'x.ipynb') } });
    claudeWrite(tr, 'S1', path.join(tr, 'src', 'a.js'), 'MultiEdit');
    claudeWrite(tr, 'S1', path.join(base, 'outside.txt'));
    claudeWrite(tr, 'S1', path.join(tr, '.harness-worktrees', 't-1', 'x.js'));
    claudeWrite(tr, 'S1', path.join(tr, '.git', 'config'));
    const s1 = readSession(tr, 'S1');
    R.check('[track] 저장소 상대 경로(슬래시)로 기록 · 상대 경로는 cwd 기준 · 중복 없음',
      s1 && JSON.stringify(s1.files) === JSON.stringify(['src/a.js', 'src/b.js', 'nb/x.ipynb']), JSON.stringify(s1));
    R.check('[track] 세션 파일 모양 {session_id, runtime, files, updated_at}', s1 && s1.session_id === 'S1' && s1.runtime === 'claude' && Array.isArray(s1.files) && !isNaN(Date.parse(s1.updated_at)));

    const patch = '*** Begin Patch\n*** Add File: lib/new.js\n+x\n*** Update File: src/a.js\n@@\n-a\n+b\n*** Update File: old/name.js\n*** Move to: lib/renamed.js\n*** Delete File: gone.js\n*** End Patch\n';
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'C1', turn_id: 't', cwd: tr, tool_name: 'apply_patch', tool_input: { command: patch } }, ['--codex']);
    const c1 = readSession(tr, 'C1');
    R.check('[track/codex] apply_patch 머리줄(Add · Update · Move to · Delete) → 경로 · runtime codex',
      c1 && c1.runtime === 'codex' && ['lib/new.js', 'src/a.js', 'old/name.js', 'lib/renamed.js', 'gone.js'].every(f => c1.files.includes(f)) && c1.files.length === 5, JSON.stringify(c1));
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'C2', turn_id: 't', cwd: tr, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: z.js\n+z\n*** End Patch' } });
    R.check('[track] --codex 없이도 apply_patch 페이로드면 codex 로 본다', (readSession(tr, 'C2') || {}).runtime === 'codex');

    const par = await Promise.all(Array.from({ length: 8 }, (_, i) => hookAsync('track', { hook_event_name: 'PostToolUse', session_id: 'PAR', cwd: tr, prompt_id: 'p', tool_name: 'Write', tool_input: { file_path: path.join(tr, `p${i}.js`) } })));
    const ps = readSession(tr, 'PAR');
    R.check('[track] 동시에 뜬 8개 훅의 경로가 하나도 사라지지 않는다(잠금)', par.every(r => r.status === 0) && ps && ps.files.length === 8, JSON.stringify(ps && ps.files));

    git(tr, 'worktree', 'add', '-q', '-b', 'harness/t-x', path.join(tr, '.harness-worktrees', 't-x'));
    claudeWrite(path.join(tr, '.harness-worktrees', 't-x'), 'WT', path.join(tr, '.harness-worktrees', 't-x', 'w.js'));
    R.check('[track] 하네스 작업 worktree 안의 세션은 기록하지 않는다', readSession(tr, 'WT') === null);
    // 파일 시스템 MCP 의 쓰기 — path · move_file 의 destination(옮기기 전 자리 source 는 기록하지 않는다)
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'FSM', cwd: tr, prompt_id: 'p', tool_name: 'mcp__filesystem__write_file', tool_input: { path: path.join(tr, 'm', 'w.txt'), content: 'x' } });
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'FSM', cwd: tr, prompt_id: 'p', tool_name: 'mcp__filesystem__move_file', tool_input: { source: path.join(tr, 'm', 'from.txt'), destination: path.join(tr, 'm', 'to.txt') } });
    R.check('[track/mcp] 파일 시스템 MCP: write_file 의 path · move_file 의 destination 을 기록 · source 는 아니다', JSON.stringify((readSession(tr, 'FSM') || {}).files) === JSON.stringify(['m/w.txt', 'm/to.txt']), JSON.stringify(readSession(tr, 'FSM')));
    R.check('[track] 깨진 입력 → exit 0', hook('track', '[[[', [], tr).status === 0);

    // ── stop (Claude) ─────────────────────────────────────────────────
    const st = mkRepo('stop', { 'a.js': 'a\n', 'b.js': 'b\n' });
    claudePre(st, 'SA', path.join(st, 'a.js')); claudePre(st, 'SB', path.join(st, 'b.js'));
    write(path.join(st, 'a.js'), 'A\n'); write(path.join(st, 'b.js'), 'B\n');
    claudeWrite(st, 'SA', path.join(st, 'a.js'));
    claudeWrite(st, 'SB', path.join(st, 'b.js'));
    const stop = (sid, active, args, extra) => hook('stop', { hook_event_name: 'Stop', session_id: sid, cwd: st, prompt_id: 'p', stop_hook_active: active, last_assistant_message: 'done', ...(extra || {}) }, args);
    // [2026-09-30 실측] 백그라운드 서브에이전트가 아직 고치는 중이면 막지도(반쯤 된 작업 커밋 요구) 대신 커밋하지도 않는다.
    const bgHead = git(st, 'rev-parse', 'HEAD');
    const bg1 = stop('SA', false, [], { background_tasks: [{ id: 'x', type: 'subagent', status: 'running' }] });
    const bg2 = stop('SA', true, [], { background_tasks: [{ id: 'x', type: 'subagent', status: 'running' }] });
    R.check('[stop/bg] 백그라운드 작업이 도는 중이면 막지 않고 커밋도 하지 않는다', isAllow(bg1) && isAllow(bg2) && git(st, 'rev-parse', 'HEAD') === bgHead && /a\.js/.test(git(st, 'status', '--porcelain')), bg1.stdout + bg2.stdout);
    const bg3 = stop('SA', false, [], { background_tasks: [{ id: 'x', type: 'subagent', status: 'completed' }] });
    R.check('[stop/bg] 끝난 백그라운드 작업만 있으면 평소대로 막는다', bg3.json && bg3.json.decision === 'block', bg3.stdout);
    const b1 = stop('SA', false);
    R.check('[stop] 자기 미커밋 파일이 있으면 decision:block', b1.status === 0 && b1.json && b1.json.decision === 'block' && typeof b1.json.reason === 'string', b1.stdout);
    R.check('[stop] 이유에는 자기 파일만(a.js) — 다른 세션의 b.js 는 없다', b1.json && /`a\.js`/.test(b1.json.reason) && !/b\.js/.test(b1.json.reason) && /커밋되지 않았습니다/.test(b1.json.reason), b1.json && b1.json.reason);
    // [2026-09-29 실측] 막기만 하면 권한 프롬프트에 걸린 모델이 커밋 못 한 채 끝났다 → 한 번 막고, 이어 간 턴 뒤에도 남았으면 훅이 직접 커밋한다.
    const b2 = stop('SA', true);
    const sa = readSession(st, 'SA');
    const saLog = git(st, 'log', '-1', '--name-only', '--format=%s');
    R.check('[stop] 이어 간 턴 뒤에도 남았으면 통과시키고 훅이 직접 커밋한다', isAllow(b2) && sa && sa.last_commit && sa.last_commit.by === 'stop-fallback' && /^wip\(session /.test(saLog) && /a\.js/.test(saLog), JSON.stringify(sa) + ' | ' + saLog);
    R.check('[stop] 대신 커밋할 때도 다른 세션의 b.js 는 넣지 않는다', !/b\.js/.test(saLog) && /b\.js/.test(git(st, 'status', '--porcelain')), saLog);
    // [자동 이슈 #35] "바로 이어서 진행하겠다" 고 해 놓고 아무것도 띄우지 않고 끝나면 한 번 되돌려 보낸다
    {
      const SP = require(path.join(HOOKS, 'stop.js'));
      const tr = (name, rows) => { const f = path.join(base, `tr-${name}.jsonl`); fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return f; };
      const u = text => ({ type: 'user', message: { role: 'user', content: text } });
      const a = (text, tools) => ({ type: 'assistant', message: { role: 'assistant', content: [...(tools || []).map(t => ({ type: 'tool_use', name: t.name, input: t.input || {} })), ...(text ? [{ type: 'text', text }] : [])] } });
      const say = '설치까지 끝났습니다. 다음 단계(병합)는 바로 이어서 진행하겠습니다.';
      const c1 = SP.promiseWithoutAction({ transcript_path: tr('p1', [u('계속해'), a(say)]) });
      const c2 = SP.promiseWithoutAction({ transcript_path: tr('p2', [u('계속해'), a(null, [{ name: 'Bash', input: { command: 'npm run build', run_in_background: true } }]), a(say)]) });
      const c3 = SP.promiseWithoutAction({ transcript_path: tr('p3', [u('계속해'), a('다음 단계를 바로 이어서 진행할까요?')]) });
      const c4 = SP.promiseWithoutAction({ transcript_path: tr('p4', [u('계속해'), a(say)]), stop_hook_active: true });
      const c5 = SP.promiseWithoutAction({ transcript_path: tr('p5', [u('계속해'), a('병합까지 모두 끝냈습니다. 테스트 120개 통과.')]) });
      const c6 = SP.promiseWithoutAction({ transcript_path: tr('p6', [u('계속해'), a(null, [{ name: 'ScheduleWakeup', input: { delaySeconds: 1200 } }]), a(say)]) });
      const c7 = SP.promiseWithoutAction({ transcript_path: tr('p7', [u('이전'), a(null, [{ name: 'Monitor' }]), u('계속해'), a(say)]) });   // 앞 차례의 감시는 이번 차례 것이 아니다
      R.check('[stop/#35] 약속만 하고 아무것도 안 띄우면 되돌려 보냄 · 백그라운드 · 예약 깨우기가 있거나 · 질문 · 이미 되돌린 뒤 · 끝낸 보고는 그냥 둔다',
        !!c1 && /이어서 진행하겠다/.test(c1) && !c2 && !c3 && !c4 && !c5 && !c6 && !!c7, JSON.stringify([!!c1, !!c2, !!c3, !!c4, !!c5, !!c6, !!c7]));
      const hcCases = [
        ['hc run --bg --name review reviewer "검토하세요"', 'Bash', false],
        ['hc --json run --on=build --cwd=/srv/app --bg -- claude "검토하세요"', 'Bash', false],
        ['& "C:\\Program Files\\Herdr Core\\hc.exe" run --cwd "C:\\repo with spaces" --bg claude', 'PowerShell', false],
        ['HC_SESSION=test env -u UNUSED -- nohup hc run --bg reviewer', 'Bash', false],
        ['env -i MODE=review hc.cmd run --bg reviewer', 'Bash', false],
        ['& "C:\\Program Files\\Herdr Core\\hc.ps1" run --bg reviewer', 'PowerShell', false],
        ['env --help hc run --bg reviewer', 'Bash', true],
        ['env MODE=review hc send t7 "hc run --bg reviewer"', 'Bash', true],
        ['hc send t7 "검토하세요"', 'Bash', true],
        ['hc wait t7', 'Bash', true],
        ['hc read t7', 'Bash', true],
        ['hc run reviewer "예시: hc run --bg claude"', 'Bash', true],
        ['hc run --help --bg claude', 'Bash', true],
        ['hc run -- claude --bg', 'Bash', true],
      ];
      hcCases.forEach(([command, name, blocked], i) => {
        const why = SP.promiseWithoutAction({ transcript_path: tr(`hc-${i}`, [u('계속해'), a(null, [{ name, input: { command } }]), a(say)]) });
        R.check(`[stop/hc] 실제 run --bg만 이어 갈 작업이다: ${command}`, !!why === blocked, String(why));
      });
    }
    write(path.join(st, 'a.js'), 'AA\n');
    R.check('[stop] 새 턴(stop_hook_active false)이면 다시 한 번 막는다', (stop('SA', false).json || {}).decision === 'block');
    git(st, 'add', 'a.js'); git(st, '-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-q', '-m', 'a', '--', 'a.js');
    R.check('[stop] 자기 파일이 커밋됐으면 통과(b.js 는 여전히 미커밋이어도)', isAllow(stop('SA', false)) && /b\.js/.test(status(st)));
    R.check('[stop] 기록 없는 세션은 통과', isAllow(stop('NOPE', false)));

    claudePre(st, 'SS', path.join(st, 'c.js')); claudePre(st, 'SS', path.join(st, '.env'));
    write(path.join(st, 'c.js'), 'c\n'); write(path.join(st, '.env'), 'K=1\n');
    claudeWrite(st, 'SS', path.join(st, 'c.js')); claudeWrite(st, 'SS', path.join(st, '.env'));
    const bs = stop('SS', false);
    R.check('[stop] 비밀 파일은 커밋 대상에서 빼고 이유에 따로 경고한다', bs.json && bs.json.decision === 'block' && /`c\.js` —/.test(bs.json.reason) && /비밀 파일로 보이는 `\.env`/.test(bs.json.reason), bs.json && bs.json.reason);
    git(st, 'add', 'c.js'); git(st, '-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-q', '-m', 'c', '--', 'c.js');
    R.check('[stop] 비밀 파일만 남았으면 막지 않는다', isAllow(stop('SS', false)));

    // ── stop (Codex) — 훅이 직접 그 파일만 커밋한다 ────────────────────
    const cr = mkRepo('codex', { 'lib/x.js': 'x\n', 'other.js': 'o\n' });
    const cpatch = '*** Begin Patch\n*** Add File: c1.js\n+c\n*** Update File: lib/x.js\n*** Add File: .env.local\n+S=1\n*** End Patch';
    hook('board', { hook_event_name: 'PreToolUse', session_id: 'codex-sess-1234', turn_id: 't', cwd: cr, tool_name: 'apply_patch', tool_input: { command: cpatch } }, ['--codex']);
    write(path.join(cr, 'c1.js'), 'c\n'); write(path.join(cr, 'lib', 'x.js'), 'X\n'); write(path.join(cr, '.env.local'), 'S=1\n');
    write(path.join(cr, 'other.js'), 'O\n'); write(path.join(cr, 'staged.js'), 's\n'); git(cr, 'add', 'staged.js');
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'codex-sess-1234', turn_id: 't', cwd: cr, tool_name: 'apply_patch', tool_input: { command: cpatch } }, ['--codex']);
    const headBefore = git(cr, 'rev-parse', 'HEAD');
    const cs = hook('stop', { hook_event_name: 'Stop', session_id: 'codex-sess-1234', turn_id: 't', cwd: cr, stop_hook_active: false, last_assistant_message: '## Implemented feature X\nmore detail' }, ['--codex']);
    const committed = git(cr, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
    R.check('[stop/codex] 막지 않는다(출력 없음 · exit 0)', isAllow(cs), JSON.stringify(cs));
    R.check('[stop/codex] 새 커밋에는 세션 파일(c1.js · lib/x.js)만', git(cr, 'rev-parse', 'HEAD') !== headBefore && JSON.stringify(committed) === JSON.stringify(['c1.js', 'lib/x.js']), JSON.stringify(committed));
    // [2026-09-29 실측] 마지막 말(불평일 수 있다) 대신 파일 목록을 메시지로 쓴다.
    R.check('[stop/codex] 메시지 = wip(codex <sid8>): update <그 세션의 파일들>', /^wip\(codex codexses\): update .*c1\.js/.test(git(cr, 'log', '-1', '--format=%s')), git(cr, 'log', '-1', '--format=%s'));
    R.check('[stop/codex] 신원이 없으면 harness <harness@localhost>', git(cr, 'log', '-1', '--format=%an <%ae>') === 'harness <harness@localhost>', git(cr, 'log', '-1', '--format=%an <%ae>'));
    const after = status(cr);
    R.check('[stop/codex] 남의 변경은 그대로: other.js 수정 · staged.js 스테이징 유지', /^ M other\.js$/m.test(after) && /^A  staged\.js$/m.test(after), after);
    R.check('[stop/codex] 비밀 파일(.env.local)은 커밋하지 않고 기록만', /^\?\? \.env\.local$/m.test(after) && !committed.includes('.env.local') && (readSession(cr, 'codex-sess-1234').secrets_left || []).includes('.env.local'), after);
    R.check('[stop/codex] 커밋 뒤 다시 멈추면 할 일 없음(새 커밋 없음)', (() => { const h = git(cr, 'rev-parse', 'HEAD'); hook('stop', { hook_event_name: 'Stop', session_id: 'codex-sess-1234', turn_id: 't2', cwd: cr, stop_hook_active: false }, ['--codex']); return git(cr, 'rev-parse', 'HEAD') === h; })());

    const cpatch2 = '*** Begin Patch\n*** Update File: c1.js\n*** End Patch';
    hook('board', { hook_event_name: 'PreToolUse', session_id: 'codex-sess-1234', turn_id: 't3', cwd: cr, tool_name: 'apply_patch', tool_input: { command: cpatch2 } }, ['--codex']);
    write(path.join(cr, 'c1.js'), 'c2\n');
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'codex-sess-1234', turn_id: 't3', cwd: cr, tool_name: 'apply_patch', tool_input: { command: cpatch2 } }, ['--codex']);
    const lock = path.join(cr, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const pending = hookAsync('stop', { hook_event_name: 'Stop', session_id: 'codex-sess-1234', turn_id: 't3', cwd: cr, stop_hook_active: false }, ['--codex']);
    await new Promise(r => setTimeout(r, 600));
    fs.unlinkSync(lock);
    const lr = await pending;
    R.check('[stop/codex] index.lock 이 잡혀 있으면 기다렸다가 커밋한다', lr.status === 0 && git(cr, 'log', '-1', '--format=%s') === 'wip(codex codexses): update c1.js' && !/c1\.js/.test(status(cr)), git(cr, 'log', '-1', '--format=%s') + ' / ' + status(cr));

    // ── session-end ──────────────────────────────────────────────────
    const se = mkRepo('send', { 'd.js': 'd\n', 'e.js': 'e\n', 'f.js': 'f\n' });
    claudePre(se, 'dddd1111-2222', path.join(se, 'd.js')); claudePre(se, 'eeee', path.join(se, 'e.js'));
    write(path.join(se, 'd.js'), 'D\n'); write(path.join(se, 'e.js'), 'E\n');
    claudeWrite(se, 'dddd1111-2222', path.join(se, 'd.js'));
    claudeWrite(se, 'eeee', path.join(se, 'e.js'));
    const end = (sid, args) => hook('session-end', { hook_event_name: 'SessionEnd', session_id: sid, cwd: se, reason: 'prompt_input_exit' }, args);
    const e1 = end('dddd1111-2222');
    R.check('[session-end] exit 0 · 출력 없음', isAllow(e1), JSON.stringify(e1));
    R.check('[session-end] 남은 자기 파일을 그것만 커밋: wip(session <sid8>): auto-commit at session end',
      git(se, 'log', '-1', '--format=%s') === 'wip(session dddd1111): auto-commit at session end' && git(se, 'show', '--name-only', '--format=', 'HEAD') === 'd.js', git(se, 'log', '-1', '--format=%s'));
    R.check('[session-end] 다른 세션의 e.js 는 미커밋 그대로 · 그 세션 기록도 그대로', /^ M e\.js$/m.test(status(se)) && readSession(se, 'eeee') !== null);
    // 사양 변경(2026-10-25 게시판): 깨끗하게 끝난 세션의 기록은 지우지 않고 ended_at 을 적은 채 files 를 비운다 — 게시판이 끝난 세션을 산 세션으로 보지 않게.
    //   (status 의 주인 분류는 files 로만 하므로 커밋된 파일을 이 세션 것으로 잡지 않는다.) 하루 지난 빈 기록은 session-end 가 치운다.
    const dEnd = readSession(se, 'dddd1111-2222');
    R.check('[session-end] 깨끗하게 끝난 세션: ended_at · end_reason 을 적고 files 는 비운다', dEnd && !isNaN(Date.parse(dEnd.ended_at)) && dEnd.end_reason === 'prompt_input_exit' && Array.isArray(dEnd.files) && dEnd.files.length === 0, JSON.stringify(dEnd));
    {
      const oldEnd = { session_id: 'old-ended', runtime: 'claude', files: [], ended_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() };
      write(sessionFile(se, 'old-ended'), JSON.stringify(oldEnd));
      write(sessionFile(se, 'old-left'), JSON.stringify({ ...oldEnd, session_id: 'old-left', files: ['x.js'] }));
      write(sessionFile(se, 'recent-ended'), JSON.stringify({ ...oldEnd, session_id: 'recent-ended', ended_at: new Date(Date.now() - 3600 * 1000).toISOString() }));
      claudeWrite(se, 'pruner', path.join(se, 'd.js')); end('pruner');
      R.check('[session-end] 끝난 지 하루 지난 빈 기록만 치운다(남은 파일이 있는 기록 · 최근 기록은 둔다)', readSession(se, 'old-ended') === null && readSession(se, 'old-left') !== null && readSession(se, 'recent-ended') !== null,
        JSON.stringify([readSession(se, 'old-ended'), !!readSession(se, 'old-left'), !!readSession(se, 'recent-ended')]));
    }
    claudePre(se, 'ffff', path.join(se, 'f.js')); claudePre(se, 'ffff', path.join(se, 'id_rsa'));
    write(path.join(se, 'f.js'), 'F\n'); write(path.join(se, 'id_rsa'), 'KEY\n');
    claudeWrite(se, 'ffff', path.join(se, 'f.js')); claudeWrite(se, 'ffff', path.join(se, 'id_rsa'));
    end('ffff', ['--codex']);
    const fs1 = readSession(se, 'ffff');
    R.check('[session-end] 비밀 파일은 커밋하지 않고 기록을 남긴다(f.js 만 커밋)',
      git(se, 'show', '--name-only', '--format=', 'HEAD') === 'f.js' && /^\?\? id_rsa$/m.test(status(se)) && fs1 && fs1.ended_at && fs1.secrets_left.includes('id_rsa'), JSON.stringify(fs1));
    R.check('[session-end] 기록 없는 세션 · 깨진 입력 → exit 0 · 기록을 새로 만들지 않는다', isAllow(end('none')) && readSession(se, 'none') === null && hook('session-end', 'nope', [], se).status === 0);

    // ── [2026-10-25 Light] 가벼운 길(task.mode 'light')의 worktree 는 사람이 모는 세션 — track · stop · session-end 가 메인 체크아웃처럼 ──
    {
      const lr = mkRepo('lane', { 'a.js': 'a\n', 'b.js': 'b\n' });
      const lid = 't-20261025-101010-abcd', wid = 't-20261025-101011-beef';
      const lwt = path.join(lr, '.harness-worktrees', lid), wwt = path.join(lr, '.harness-worktrees', wid);
      git(lr, 'worktree', 'add', '-q', '-b', `harness/${lid}`, lwt);
      git(lr, 'worktree', 'add', '-q', '-b', `harness/${wid}`, wwt);
      const taskJson = (id, extra) => write(path.join(lr, '.git', 'harness', 'tasks', id, 'task.json'), JSON.stringify({ id, status: 'open', owner: null, branch: `harness/${id}`, goal: 'lane work', ...extra }));
      taskJson(lid, { mode: 'light' });
      taskJson(wid, { status: 'running' });                                   // 무인 작업 — mode 없음
      const C0 = require(path.join(HOOKS, '_common.js'));
      const iL = C0.repoInfo(lwt), iW = C0.repoInfo(wwt), iM = C0.repoInfo(lr);
      R.check('[lane] laneOf: 가벼운 길의 worktree 만 {id, task} · 무인 작업 worktree · 메인 체크아웃은 null', (C0.laneOf(iL) || {}).id === lid && C0.laneOf(iL).task.mode === 'light' && C0.laneOf(iW) === null && C0.laneOf(iM) === null
        && C0.harnessOwned(iW) === true && C0.harnessOwned(iL) === false && C0.harnessOwned(iM) === false, JSON.stringify([C0.laneOf(iL), C0.laneOf(iW)]));
      const mainHead = git(lr, 'rev-parse', 'main');
      claudePre(lwt, 'LANE1', path.join(lwt, 'a.js'));
      write(path.join(lwt, 'a.js'), 'A\n'); write(path.join(lr, 'b.js'), 'B by someone\n');
      claudeWrite(lwt, 'LANE1', path.join(lwt, 'a.js'));
      claudeWrite(wwt, 'WORK1', path.join(wwt, 'a.js'));
      R.check('[lane] track: 가벼운 길의 세션은 기록한다(worktree 상대 경로) · 무인 작업 worktree 는 여전히 기록하지 않는다', JSON.stringify((readSession(lr, 'LANE1') || {}).files) === '["a.js"]' && readSession(lr, 'WORK1') === null, JSON.stringify(readSession(lr, 'LANE1')));
      const lstop = active => hook('stop', { hook_event_name: 'Stop', session_id: 'LANE1', cwd: lwt, prompt_id: 'p', stop_hook_active: active, last_assistant_message: 'done' });
      const ls1 = lstop(false);
      R.check('[lane] stop: 자기 미커밋 파일이 있으면 막는다', ls1.json && ls1.json.decision === 'block' && /`a\.js`/.test(ls1.json.reason), ls1.stdout);
      const ls2 = lstop(true);
      R.check('[lane] stop: 이어 간 턴 뒤에도 남았으면 그 길의 브랜치에 그 파일만 커밋 · 메인 브랜치 · 메인의 b.js 는 그대로', isAllow(ls2) && git(lwt, 'log', '-1', '--format=%s') === 'wip(session LANE1): update a.js' && git(lwt, 'rev-parse', '--abbrev-ref', 'HEAD') === `harness/${lid}`
        && git(lr, 'rev-parse', 'main') === mainHead && /^ M b\.js$/m.test(status(lr)), git(lwt, 'log', '-1', '--format=%s') + ' | ' + status(lr));
      const lpre = (command, args) => hook('guard', { hook_event_name: 'PreToolUse', session_id: 'LANE1', cwd: lwt, prompt_id: 'p', tool_name: 'Bash', tool_input: { command } }, args);
      const outside = path.join(base, 'lane-outside-dir');
      R.check('[lane] guard: 대화형 세션은 가벼운 길에서 자기 파일을 add · commit 할 수 있다 · push 는 여전히 막는다', isAllow(lpre('git add -- a.js')) && isAllow(lpre('git commit -m "x" -- a.js')) && isDeny(lpre('git push')));
      R.check('[lane] guard: 대화형 규칙이다 — worktree 밖 구체 경로 삭제는 대화형에선 통과', isAllow(lpre(`rm -rf ${JSON.stringify(outside)}`)));
      claudePre(lwt, 'LANE1', path.join(lwt, 'c.js'));
      write(path.join(lwt, 'c.js'), 'c\n');
      claudeWrite(lwt, 'LANE1', path.join(lwt, 'c.js'));
      hook('session-end', { hook_event_name: 'SessionEnd', session_id: 'LANE1', cwd: lwt, reason: 'other' });
      const le = readSession(lr, 'LANE1');
      R.check('[lane] session-end: 남은 자기 파일을 그 길의 브랜치에 커밋 · ended_at', git(lwt, 'log', '-1', '--format=%s') === 'wip(session LANE1): auto-commit at session end' && git(lwt, 'show', '--name-only', '--format=', 'HEAD') === 'c.js' && le && le.ended_at && git(lr, 'rev-parse', 'main') === mainHead, JSON.stringify(le));
    }

    // ── 리뷰 수정: _common ─────────────────────────────────
    const C = require(path.join(HOOKS, '_common.js'));
    // [L10] isSecretPath 확장 — 자격 증명 데이터 파일은 막되 같은 이름의 소스 파일은 막지 않는다.
    const secretYes = ['.npmrc', 'sub/.npmrc', 'credentials', 'credentials.json', '.aws/credentials', 'service-account.json', 'service_account-prod.json', 'keys/app.jks', 'infra/terraform.tfstate', 'terraform.tfstate.backup', 'AuthKey_ABC123.p8'];
    const secretNo = ['credentials.js', 'src/credentials_test.py', 'lib/credentials.ts', 'service-account.md', 'README.md', '.env.example', 'id_rsa.pub', 'tfstate.md'];
    R.check('[L10/secret] 확장된 비밀 경로(.npmrc · credentials* · *.jks · *.tfstate · service-account*.json · *.p8)', secretYes.every(C.isSecretPath), JSON.stringify(secretYes.filter(f => !C.isSecretPath(f))));
    R.check('[L10/secret] 소스 파일(credentials.js 등)은 비밀이 아니다', !secretNo.some(C.isSecretPath), JSON.stringify(secretNo.filter(C.isSecretPath)));
    R.check('[L10/secret] guard: git add credentials.json 을 막는다', isDeny(pre('git add credentials.json', 'Bash')));

    // [L10] Codex SessionEnd 3초 — git status 를 세션 파일로 좁힌다.
    const dp = mkRepo('dirty-scope', { 'a.js': 'a\n', 'b.js': 'b\n' });
    write(path.join(dp, 'a.js'), 'A\n'); write(path.join(dp, 'b.js'), 'B\n'); write(path.join(dp, 'junk', 'u.txt'), 'u\n');
    const scoped = C.dirtyPaths(dp, ['a.js']);
    R.check('[L10/status] dirtyPaths(root, files) 는 그 파일만 본다(b.js · junk/ 는 status 대상이 아니다)', scoped.size === 1 && [...scoped.values()][0] === 'a.js', JSON.stringify([...scoped.values()]));
    R.check('[L10/status] 파일 목록이 없으면 전체를 본다', C.dirtyPaths(dp).size === 3, JSON.stringify([...C.dirtyPaths(dp).values()]));
    const um = C.uncommittedOf(dp, ['A.js', 'b.js', 'gone.js']);
    R.check('[L10/status] uncommittedOf 는 좁힌 status 로도 같은 답(a.js · b.js — Windows 는 대소문자 무시)',
      JSON.stringify(um.mine.sort()) === JSON.stringify(C.IS_WIN ? ['a.js', 'b.js'] : ['b.js']), JSON.stringify(um));

    // [L10] git < 2.31: rev-parse --path-format=absolute 를 모른다 → 대체 경로 + 로그.
    const realGit = C.git;
    const errLogOf = d => { try { return fs.readFileSync(path.join(d, '.git', 'harness', 'hook-errors.log'), 'utf8'); } catch { return ''; } };
    const logBefore = errLogOf(dp);
    try {
      C.git = (cwd, args, o) => args.includes('--path-format=absolute') ? { status: 0, stdout: '--path-format=absolute\n' + realGit(cwd, args.filter(a => a !== '--path-format=absolute'), o).stdout, stderr: '' } : realGit(cwd, args, o);
      const ri = C.repoInfo(path.join(dp, 'junk'));
      R.check('[L10/oldgit] 옵션을 그대로 되울리는 옛 git 에서도 root · common 이 맞다', ri && C.samePath(ri.root, dp) && C.samePath(ri.common, path.join(dp, '.git')), JSON.stringify(ri));
      C.git = (cwd, args, o) => args.includes('--path-format=absolute') ? { status: 128, stdout: '', stderr: 'fatal: unknown option' } : realGit(cwd, args, o);
      const ri2 = C.repoInfo(path.join(dp, 'junk'));
      R.check('[L10/oldgit] 옵션을 거부하는 git 에서도 대체 경로로 찾는다', ri2 && C.samePath(ri2.root, dp) && C.samePath(ri2.common, path.join(dp, '.git')), JSON.stringify(ri2));
    } finally { C.git = realGit; }
    const logAfter = errLogOf(dp);
    R.check('[L10/oldgit] 대체 경로를 쓴 것은 hook-errors.log 에 남는다', logAfter.length > logBefore.length && /path-format/.test(logAfter.slice(logBefore.length)), logAfter.slice(-300));
    // [2026-10-15 자동 이슈 #7] 부하로 git 이 시간 초과(ETIMEDOUT)된 것을 "git < 2.31" 로 기록했다 — 옛 git 이 아니다. 대체 경로로 찾되 기록하지 않는다.
    {
      const before7 = errLogOf(dp);
      const script = `const C=require(${JSON.stringify(path.join(HOOKS, '_common.js'))});const real=C.git;C.git=(cwd,args,o)=>args.includes('--path-format=absolute')?{status:-1,stdout:'',stderr:'spawnSync git ETIMEDOUT'}:real(cwd,args,o);const ri=C.repoInfo(${JSON.stringify(path.join(dp, 'junk'))});process.stdout.write(JSON.stringify(ri))`;
      const r7 = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, env: ENV, timeout: 30000 });
      let ri7 = null; try { ri7 = JSON.parse(r7.stdout); } catch { /* 없음 */ }
      const after7 = errLogOf(dp).slice(before7.length);
      R.check('[L10/timeout] git 시간 초과는 대체 경로로 찾고 "옛 git" 으로 기록하지 않는다(자동 이슈 #7)', ri7 && C.samePath(ri7.root, dp) && !/path-format/.test(after7), `${r7.stdout} ${r7.stderr} | ${after7}`);
    }

    // [L10] 세션 잠금 — 오래된 잠금 빼앗기는 토큰을 확인한다(M5 와 같은 경합) · 해제는 자기 잠금만.
    const lk = mkRepo('lock', { 'a.js': 'a\n' });
    const lkCommon = path.join(lk, '.git');
    const lockDir = C.sessionPath(lkCommon, 'L1') + '.lock';
    const old = new Date(Date.now() - 60000);
    const savedLock = { ...(C.LOCK || {}) };
    try {
      if (C.LOCK) C.LOCK.waitMs = 400;
      fs.mkdirSync(lockDir, { recursive: true }); fs.writeFileSync(path.join(lockDir, 'owner'), 'dead-token'); fs.utimesSync(lockDir, old, old);
      let took = null; try { took = C.updateSession(lkCommon, 'L1', 'claude', s => { s.files.push('a.js'); return s; }); } catch (e) { took = String(e); }
      R.check('[L10/lock] 오래된 잠금은 빼앗아 기록한다 · 끝나면 잠금이 없다', took && took.files && took.files.includes('a.js') && !fs.existsSync(lockDir), JSON.stringify(took));
      // 오래됐다고 본 뒤 · 빼앗기 전에 다른 프로세스가 새 잠금을 잡았다 → 새 잠금을 빼앗지 않는다.
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir, { recursive: true }); fs.writeFileSync(path.join(lockDir, 'owner'), 'dead-token'); fs.utimesSync(lockDir, old, old);
      if (C.LOCK) C.LOCK.beforeTakeover = () => { fs.rmSync(lockDir, { recursive: true, force: true }); fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, 'owner'), 'fresh-owner'); C.LOCK.beforeTakeover = null; };
      let threw = null;
      try { C.updateSession(lkCommon, 'L1', 'claude', s => { s.files.push('stolen.js'); return s; }); } catch (e) { threw = e; }
      let ownerNow = null; try { ownerNow = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'); } catch { ownerNow = null; }
      R.check('[L10/lock] 빼앗기 직전 바뀐 잠금(토큰 다름)은 건드리지 않는다 — 새 주인의 잠금이 그대로',
        ownerNow === 'fresh-owner' && threw && /lock timeout/.test(threw.message) && !((C.loadSession(lkCommon, 'L1') || {}).files || []).includes('stolen.js'), String(threw) + ' owner=' + ownerNow);
      fs.rmSync(lockDir, { recursive: true, force: true });
      // 해제: 내 잠금이 아니면(주인 기록이 없거나 다르면) 지우지 않는다.
      try { C.updateSession(lkCommon, 'L1', 'claude', s => { fs.rmSync(lockDir, { recursive: true, force: true }); fs.mkdirSync(lockDir); return s; }); } catch { /* 판정은 아래 */ }
      R.check('[L10/lock] 해제는 주인 기록이 없는 잠금(남의 새 잠금)을 지우지 않는다', fs.existsSync(lockDir));
      fs.rmSync(lockDir, { recursive: true, force: true });
      try { C.updateSession(lkCommon, 'L1', 'claude', s => { fs.rmSync(lockDir, { recursive: true, force: true }); fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, 'owner'), 'someone-else'); return s; }); } catch { /* 판정은 아래 */ }
      R.check('[L10/lock] 해제는 주인이 다른 잠금을 지우지 않는다', fs.existsSync(lockDir) && fs.readFileSync(path.join(lockDir, 'owner'), 'utf8') === 'someone-else');
      fs.rmSync(lockDir, { recursive: true, force: true });
    } finally { if (C.LOCK) { for (const k of Object.keys(C.LOCK)) delete C.LOCK[k]; Object.assign(C.LOCK, savedLock); } }

    // [L11] 대화형 훅 커밋은 pre-commit 훅 · gpg 서명 프롬프트에 걸리지 않는다.
    const hk = mkRepo('hooked', { 'h.js': 'h\n' });
    write(path.join(hk, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho blocked-by-pre-commit >&2\nexit 1\n');
    try { fs.chmodSync(path.join(hk, '.git', 'hooks', 'pre-commit'), 0o755); } catch { /* Windows 는 무관 */ }
    git(hk, 'config', 'commit.gpgsign', 'true'); git(hk, 'config', 'gpg.program', path.join(base, 'no-such-gpg'));
    claudePre(hk, 'hkhkhkhk', path.join(hk, 'h.js'));
    write(path.join(hk, 'h.js'), 'H\n');
    claudeWrite(hk, 'hkhkhkhk', path.join(hk, 'h.js'));
    const hkHead = git(hk, 'rev-parse', 'HEAD');
    hook('session-end', { hook_event_name: 'SessionEnd', session_id: 'hkhkhkhk', cwd: hk, reason: 'exit' });
    R.check('[L11] pre-commit 훅이 실패하고 commit.gpgsign=true 여도 session-end 커밋이 된다(--no-verify · -c commit.gpgsign=false)',
      git(hk, 'rev-parse', 'HEAD') !== hkHead && git(hk, 'show', '--name-only', '--format=', 'HEAD') === 'h.js', status(hk) + ' | ' + JSON.stringify(readSession(hk, 'hkhkhkhk')));
    hook('board', { hook_event_name: 'PreToolUse', session_id: 'cxcxcxcx', turn_id: 't', cwd: hk, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: h.js\n*** End Patch' } }, ['--codex']);
    write(path.join(hk, 'h.js'), 'H2\n');
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'cxcxcxcx', turn_id: 't', cwd: hk, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: h.js\n*** End Patch' } }, ['--codex']);
    const hkHead2 = git(hk, 'rev-parse', 'HEAD');
    hook('stop', { hook_event_name: 'Stop', session_id: 'cxcxcxcx', turn_id: 't', cwd: hk, stop_hook_active: false }, ['--codex']);
    R.check('[L11] Codex stop 커밋도 같다', git(hk, 'rev-parse', 'HEAD') !== hkHead2, status(hk));

    // ── lang: 한국어로 묻는 세션의 답이 영어로 끝나지 않게(2026-10-13 사용자 보고) ──
    const lrepo = mkRepo('lang', { 'README.md': '# l\n' });
    const lang = (ev, extra, sid) => hook('lang', { hook_event_name: ev, session_id: sid || 'L1', cwd: lrepo, ...(extra || {}) });
    const up = lang('UserPromptSubmit', { prompt: '린트 규칙을 넣어줘' });
    R.check('[lang] 한국어 질문 → 이번 턴 문맥에 언어 규칙을 덧붙인다', up.json && /한국어로 쓴다/.test(up.json.hookSpecificOutput.additionalContext) && up.json.hookSpecificOutput.hookEventName === 'UserPromptSubmit', up.stdout);
    const EN = 'I added the lint rules to the harness. The checks now run the linter after the tests and send any failures back to the worker, and the report shows the result next to the test summary so you can see both at once.';
    const st1 = lang('Stop', { last_assistant_message: EN, stop_hook_active: false });
    R.check('[lang] 그런데 답이 거의 영어면 한 번 되돌린다(block · 한국어로 다시)', st1.json && st1.json.decision === 'block' && /한국어로 다시/.test(st1.json.reason), st1.stdout);
    R.check('[lang] 이미 되돌린 턴(stop_hook_active)은 다시 막지 않는다', isAllow(lang('Stop', { last_assistant_message: EN, stop_hook_active: true })));
    const KO = '린트 규칙을 넣었습니다. 이제 `node harness/cli.js go` 가 테스트 뒤에 `dotnet format --verify-no-changes` 를 돌리고, 실패하면 작업자에게 돌려보냅니다.\n```js\nconst x = runLint(task.checks.lint, worktreePath, { timeoutMs: 60000 });\n```\n경로: C:\\workspace_python\\skill-set\\harness\\lib\\checks.js';
    R.check('[lang] 한국어 답(코드 · 명령 · 경로가 섞여도)은 통과', isAllow(lang('Stop', { last_assistant_message: KO, stop_hook_active: false })));
    const enUp = lang('UserPromptSubmit', { prompt: 'please add the lint rules' }, 'L2');
    R.check('[lang] 영어로 묻는 세션에는 아무것도 하지 않는다(덧붙임 · 되돌림 없음)', isAllow(enUp) && isAllow(lang('Stop', { last_assistant_message: EN, stop_hook_active: false }, 'L2')));
    // [#93] 세션 기록 잠금을 다른 프로세스가 쥐고 있어 기록이 시간 초과로 실패해도, 이번 턴의 언어 규칙은 싣고 실패는 기록한다.
    const langErrLog = () => { try { return fs.readFileSync(path.join(lrepo, '.git', 'harness', 'hook-errors.log'), 'utf8'); } catch { return ''; } };
    const holdLock = sid => { const l = sessionFile(lrepo, sid) + '.lock'; fs.mkdirSync(l, { recursive: true }); fs.writeFileSync(path.join(l, 'owner'), 'someone-else'); return l; };
    const langLock = holdLock('L3');
    const upLocked = lang('UserPromptSubmit', { prompt: '테스트를 고쳐 줘' }, 'L3');
    R.check('[lang][#93] 세션 잠금 시간 초과에도 한국어 질문이면 이번 턴 문맥에 언어 규칙을 덧붙인다', upLocked.status === 0 && upLocked.json && upLocked.json.hookSpecificOutput && /한국어로 쓴다/.test(upLocked.json.hookSpecificOutput.additionalContext), upLocked.stdout);
    R.check('[lang][#93] 잠금 실패는 hook-errors.log 에 남는다', /session lock timeout/.test(langErrLog()), langErrLog().slice(-300));
    fs.rmSync(langLock, { recursive: true, force: true });
    // [#93b] 기록에 이미 user_lang 'ko' 가 있으면 잠그지 않는다 — 잠금이 쥐어져 있어도 기다리지 않고 기록도 그대로.
    const l4 = sessionFile(lrepo, 'L4');
    fs.mkdirSync(path.dirname(l4), { recursive: true });
    fs.writeFileSync(l4, JSON.stringify({ session_id: 'L4', runtime: 'claude', files: [], user_lang: 'ko', updated_at: null }) + '\n');
    const l4Before = fs.statSync(l4).mtimeMs, errBefore = langErrLog().length;
    const lock4 = holdLock('L4');
    const t4 = Date.now(), up4 = lang('UserPromptSubmit', { prompt: '린트를 다시 돌려 줘' }, 'L4'), ms4 = Date.now() - t4;
    R.check('[lang][#93b] user_lang 이 이미 ko 면 잠금이 쥐어져 있어도 문맥을 낸다', up4.json && /한국어로 쓴다/.test(up4.json.hookSpecificOutput.additionalContext), `${ms4}ms ${up4.stdout}`);
    // 잠금을 기다렸다면 5초 뒤 'session lock timeout' 이 기록된다 — 벽시계 대신 그 기록이 없음으로 본다(부하에 흔들리지 않게).
    R.check('[lang][#93b] 잠그지 않았다 — hook-errors.log 에 새 줄이 없고 기록 파일도 그대로다', langErrLog().length === errBefore && fs.statSync(l4).mtimeMs === l4Before, `${ms4}ms ${langErrLog().slice(errBefore, errBefore + 300)}`);
    fs.rmSync(lock4, { recursive: true, force: true });
    // [#93c] user_lang 이 null 이면 첫 한국어 턴에 'ko' 로 쓴다(지금 동작 유지).
    const l5 = sessionFile(lrepo, 'L5');
    fs.writeFileSync(l5, JSON.stringify({ session_id: 'L5', runtime: 'claude', files: [], user_lang: null, updated_at: null }) + '\n');
    lang('UserPromptSubmit', { prompt: '린트를 넣어 줘' }, 'L5');
    let l5After = null; try { l5After = JSON.parse(fs.readFileSync(l5, 'utf8')).user_lang; } catch { /* 아래 단언이 잡는다 */ }
    R.check('[lang][#93c] user_lang 이 null 인 세션은 한국어 턴에 ko 로 기록된다', l5After === 'ko', String(l5After));
    R.check('[lang] 저장소 밖 · 깨진 입력은 조용히 통과', isAllow(hook('lang', { hook_event_name: 'Stop', session_id: 'x', cwd: base, last_assistant_message: EN })) && isAllow(hook('lang', 'not json')) && fs.existsSync(path.join(hookTmp, 'harness', 'hook-errors.log')));

    // ── [2026-11-02 소유권] stop 의 대신 커밋은 '이 세션이 이 checkout 에서 쓴 그 내용' 만 ──
    //   사고: 한 세션이 레인 worktree 의 `.gitignore` 를 고친 뒤 메인 checkout 에서 끝났다 — 원장(공통 .git · 상대 경로만)이
    //   메인의 같은 상대 경로(남의 미커밋 변경)를 '내 파일' 로 보고 한 번 막은 뒤 대신 커밋했다. 경로 기록만으로는 소유가 아니다.
    //   흐름은 설치 그대로: PreToolUse(Write|Edit) = board · 쓰기 · PostToolUse = track. 불확실하면 대신 커밋 0 · 이유를 원장 stop_skipped 에.
    {
      const own = mkRepo('own', { 'x.txt': 'x\n', '.cfg': 'c\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n', 'e.txt': 'e\n', 'f.txt': 'f\n', 'g.txt': 'g\n', 'h.txt': 'h\n', 'i.txt': 'i\n', 'j.txt': 'j\n' });
      const owt = path.join(own, '.harness-worktrees', 't-20261102-000000-aaa1'), owt2 = path.join(own, '.harness-worktrees', 't-20261102-000000-aaa2');
      git(own, 'worktree', 'add', '-q', '-b', 'harness/t-20261102-000000-aaa1', owt);
      git(own, 'worktree', 'add', '-q', '-b', 'harness/t-20261102-000000-aaa2', owt2);
      for (const id of ['t-20261102-000000-aaa1', 't-20261102-000000-aaa2'])
        write(path.join(own, '.git', 'harness', 'tasks', id, 'task.json'), JSON.stringify({ id, status: 'open', owner: null, branch: `harness/${id}`, goal: 'own', mode: 'light' }));
      const edit = (cwd, sid, file, text) => {           // 설치된 한 번의 Write: board(Pre) → 쓰기 → track(Post)
        hook('board', { hook_event_name: 'PreToolUse', session_id: sid, cwd, prompt_id: 'p', tool_name: 'Write', tool_input: { file_path: file, content: text } });
        write(file, text);
        hook('track', { hook_event_name: 'PostToolUse', session_id: sid, cwd, prompt_id: 'p', tool_name: 'Write', tool_input: { file_path: file, content: text }, tool_response: { success: true } });
      };
      const ostop = (cwd, sid, active) => hook('stop', { hook_event_name: 'Stop', session_id: sid, cwd, prompt_id: 'p', stop_hook_active: active, last_assistant_message: 'done' });
      const twice = (cwd, sid) => [ostop(cwd, sid, false), ostop(cwd, sid, true)];
      const head = cwd => git(cwd, 'rev-parse', 'HEAD');
      const skipped = (sid, file, reason) => ((readSession(own, sid) || {}).stop_skipped || []).some(x => x && x.path === file && x.reason === reason);
      const text = f => fs.readFileSync(f, 'utf8');
      const agentsWas = ENV.HARNESS_AGENTS_JSON;
      ENV.HARNESS_AGENTS_JSON = path.join(base, 'own-agents.json'); fs.writeFileSync(ENV.HARNESS_AGENTS_JSON, '[]');   // 산 세션 목록 = 비어 있음(실제 claude 0)

      // T1 같은 세션이 checkout 을 옮김 — 레인에서 쓰고 그 레인에서 커밋한 뒤 메인에서 끝남 · 메인의 같은 경로는 남의 변경
      edit(owt, 'OT1', path.join(owt, '.cfg'), 'lane cfg\n');
      git(owt, '-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-q', '-m', 'lane cfg', '--', '.cfg');
      write(path.join(own, '.cfg'), 'someone else cfg\n');
      let h0 = head(own); const t1 = twice(own, 'OT1');
      R.check('[own/T1] 세션이 checkout 을 옮겨도 메인의 같은 상대 경로(남의 변경)는 대신 커밋하지 않는다 · 사유 root_mismatch',
        head(own) === h0 && text(path.join(own, '.cfg')) === 'someone else cfg\n' && isAllow(t1[1]) && skipped('OT1', '.cfg', 'root_mismatch'), JSON.stringify([t1.map(r => r.stdout), readSession(own, 'OT1')]));

      // T2 다른 worktree 의 같은 상대 경로 — 레인 2 에 내 미커밋 b.txt · 메인 b.txt 는 남의 변경
      edit(owt2, 'OT2', path.join(owt2, 'b.txt'), 'mine b\n');
      write(path.join(own, 'b.txt'), 'other b\n');
      h0 = head(own); const t2 = twice(own, 'OT2');
      R.check('[own/T2] 메인에서 끝나도 레인 2 의 내 파일 이름으로 메인 b.txt 를 커밋하지 않는다 · 사유 root_mismatch',
        head(own) === h0 && text(path.join(own, 'b.txt')) === 'other b\n' && isAllow(t2[1]) && skipped('OT2', 'b.txt', 'root_mismatch'), JSON.stringify(t2.map(r => r.stdout)));
      const h2 = head(owt2); const t2b = twice(owt2, 'OT2');
      R.check('[own/T2] 원래 레인 2 에서 끝나면 그 b.txt 만 그 레인 브랜치에 대신 커밋(정상 경로 유지)',
        isAllow(t2b[1]) && head(owt2) !== h2 && git(owt2, 'log', '-1', '--name-only', '--format=') === 'b.txt' && head(own) === h0, JSON.stringify(t2b.map(r => r.stdout)));

      // T3 첫 쓰기 전부터 dirty — 남이 고친 c.txt 를 이 세션이 다시 고쳤다(내용이 섞임)
      write(path.join(own, 'c.txt'), 'other c\n');
      edit(own, 'OT3', path.join(own, 'c.txt'), 'other c\nmine c\n');
      h0 = head(own); const t3 = twice(own, 'OT3');
      R.check('[own/T3] 첫 쓰기 전에 이미 미커밋이던 파일은 대신 커밋하지 않는다 · 사유 pre_existing_dirty',
        head(own) === h0 && /mine c/.test(text(path.join(own, 'c.txt'))) && isAllow(t3[1]) && skipped('OT3', 'c.txt', 'pre_existing_dirty'), JSON.stringify(t3.map(r => r.stdout)));

      // T4 마지막 기록 뒤 외부 변경 — 이 세션이 쓴 뒤 다른 손이 같은 파일을 고쳤다
      edit(own, 'OT4', path.join(own, 'd.txt'), 'mine d\n');
      write(path.join(own, 'd.txt'), 'mine d\nother d\n');
      h0 = head(own); const t4 = twice(own, 'OT4');
      R.check('[own/T4] 마지막 기록 뒤 파일이 바뀌었으면 대신 커밋하지 않는다 · 사유 external_change',
        head(own) === h0 && isAllow(t4[1]) && skipped('OT4', 'd.txt', 'external_change'), JSON.stringify(t4.map(r => r.stdout)));

      // T5 다른 살아 있는 세션이 같은 checkout 의 같은 파일을 기록 중
      edit(own, 'OT5A', path.join(own, 'e.txt'), 'shared e\n');
      edit(own, 'OT5B', path.join(own, 'e.txt'), 'shared e\n');     // 같은 내용 — 지문은 둘 다 맞다
      h0 = head(own); const t5 = twice(own, 'OT5A');
      R.check('[own/T5] 다른 산 세션이 같은 파일을 기록했으면 대신 커밋하지 않는다 · 사유 other_session_same_file',
        head(own) === h0 && isAllow(t5[1]) && skipped('OT5A', 'e.txt', 'other_session_same_file'), JSON.stringify(t5.map(r => r.stdout)));

      // T6 옛 원장(files 가 문자열 배열 · root · 지문 없음) — 호환은 유지하되 대신 커밋은 하지 않는다
      write(path.join(own, 'f.txt'), 'legacy f\n');
      write(sessionFile(own, 'OT6'), JSON.stringify({ session_id: 'OT6', runtime: 'claude', files: ['f.txt'], updated_at: new Date().toISOString() }));
      h0 = head(own); const t6 = twice(own, 'OT6');
      R.check('[own/T6] 옛 문자열 원장 항목은 막을 때 알리기만 하고 대신 커밋하지 않는다 · 사유 legacy_no_fingerprint',
        head(own) === h0 && isAllow(t6[1]) && skipped('OT6', 'f.txt', 'legacy_no_fingerprint') && Array.isArray(readSession(own, 'OT6').files), JSON.stringify(t6.map(r => r.stdout)));

      // T7 Windows 경로 표기 — 같은 checkout 을 대소문자 · 구분자 · 끝 구분자만 다르게 써도 같은 root 로 본다(오탐 0)
      const alt = process.platform === 'win32' ? own.replace(/\//g, '\\').toUpperCase() + '\\' : own + '/';
      edit(alt, 'OT7', path.join(alt, 'g.txt'), 'mine g\n');
      h0 = head(own); const t7 = twice(own, 'OT7');
      R.check('[own/T7] 경로 표기만 다른 같은 checkout 의 자기 변경은 정상대로 대신 커밋한다',
        isAllow(t7[1]) && head(own) !== h0 && git(own, 'log', '-1', '--name-only', '--format=') === 'g.txt', JSON.stringify(t7.map(r => r.stdout)));

      // T8 정상 자기 변경 — 한 번 막고(이유에 그 파일) · 이어 간 턴 뒤에도 남으면 그 파일만 대신 커밋 · 다른 미커밋은 그대로
      edit(own, 'OT8', path.join(own, 'h.txt'), 'mine h\n');
      write(path.join(own, 'other8.tmp'), 'not mine\n');           // 남의 미추적 파일 — 앞 시험 결과와 무관하게 이것만 본다
      h0 = head(own); const t8 = twice(own, 'OT8');
      const s8 = readSession(own, 'OT8');
      R.check('[own/T8] 정상 자기 변경은 지금 정책 그대로(1회 막음 → stop-fallback 커밋 · 그 파일만)',
        t8[0].json && t8[0].json.decision === 'block' && /`h\.txt`/.test(t8[0].json.reason) && isAllow(t8[1]) && head(own) !== h0
        && git(own, 'log', '-1', '--name-only', '--format=') === 'h.txt' && s8 && s8.last_commit && s8.last_commit.by === 'stop-fallback'
        && /^\?\? other8\.tmp$/m.test(status(own)), JSON.stringify([t8.map(r => r.stdout), s8]));

      // T9 거부 뒤 두 번째 Stop — 내 파일(i.txt)과 외부가 바뀐 파일(j.txt)이 섞였을 때 i.txt 만
      edit(own, 'OT9', path.join(own, 'i.txt'), 'mine i\n');
      edit(own, 'OT9', path.join(own, 'j.txt'), 'mine j\n');
      write(path.join(own, 'j.txt'), 'mine j\nother j\n');
      h0 = head(own); const t9 = twice(own, 'OT9');
      R.check('[own/T9] 모델이 커밋하지 않고 다시 끝나면 확인된 i.txt 만 대신 커밋 · j.txt 는 남기고 사유 external_change',
        t9[0].json && t9[0].json.decision === 'block' && /`i\.txt`/.test(t9[0].json.reason) && isAllow(t9[1]) && head(own) !== h0
        && git(own, 'log', '-1', '--name-only', '--format=') === 'i.txt' && /j\.txt/.test(status(own)) && skipped('OT9', 'j.txt', 'external_change'), JSON.stringify(t9.map(r => r.stdout)));

      // ── SessionEnd 도 같은 대신 커밋 경로(uncommittedOf → commitFiles)다 — Stop 보호를 우회하지 못하게 ──
      const oend = (cwd, sid) => hook('session-end', { hook_event_name: 'SessionEnd', session_id: sid, cwd, reason: 'prompt_input_exit' });
      const endSkipped = (sid, file, reason) => ((readSession(own, sid) || {}).end_skipped || []).some(x => x && x.path === file && x.reason === reason);
      // S1 checkout 이동 — 레인 1 에 내 미커밋 x.txt · 메인 x.txt 는 남의 변경 · 메인에서 세션이 끝남
      edit(owt, 'OS1', path.join(owt, 'x.txt'), 'lane x\n');
      write(path.join(own, 'x.txt'), 'other x\n');
      h0 = head(own); const s1 = oend(own, 'OS1');
      R.check('[own/S1] SessionEnd 도 다른 checkout 의 같은 상대 경로를 커밋하지 않는다 · 사유 root_mismatch · 기록은 남긴다',
        isAllow(s1) && head(own) === h0 && text(path.join(own, 'x.txt')) === 'other x\n' && endSkipped('OS1', 'x.txt', 'root_mismatch') && (readSession(own, 'OS1').files || []).includes('x.txt'), JSON.stringify(readSession(own, 'OS1')));
      // S2 옛 문자열 원장
      write(path.join(own, 'n1.txt'), 'legacy n1\n');
      write(sessionFile(own, 'OS2'), JSON.stringify({ session_id: 'OS2', runtime: 'claude', files: ['n1.txt'], updated_at: new Date().toISOString() }));
      h0 = head(own); const s2 = oend(own, 'OS2');
      R.check('[own/S2] SessionEnd 는 옛 문자열 원장 항목을 커밋하지 않는다 · 사유 legacy_no_fingerprint',
        isAllow(s2) && head(own) === h0 && /^\?\? n1\.txt$/m.test(status(own)) && endSkipped('OS2', 'n1.txt', 'legacy_no_fingerprint'), JSON.stringify(readSession(own, 'OS2')));
      // S3 마지막 기록 뒤 외부 변경
      edit(own, 'OS3', path.join(own, 'k1.txt'), 'mine k1\n');
      write(path.join(own, 'k1.txt'), 'mine k1\nother k1\n');
      h0 = head(own); const s3 = oend(own, 'OS3');
      R.check('[own/S3] SessionEnd 는 마지막 기록 뒤 바뀐 파일을 커밋하지 않는다 · 사유 external_change',
        isAllow(s3) && head(own) === h0 && /^\?\? k1\.txt$/m.test(status(own)) && endSkipped('OS3', 'k1.txt', 'external_change'), JSON.stringify(readSession(own, 'OS3')));
      // S4 정상 자기 변경 — 그 파일만 커밋 · 남이 스테이징해 둔 stg.txt 는 index 에 그대로 · 깨끗하면 files 비움(지금 정책)
      write(path.join(own, 'stg.txt'), 'staged by someone\n'); git(own, 'add', 'stg.txt');
      edit(own, 'OS4', path.join(own, 'k2.txt'), 'mine k2\n');
      h0 = head(own); const s4 = oend(own, 'OS4');
      R.check('[own/S4] SessionEnd 정상 자기 변경은 그 파일만 커밋 · 남의 스테이징(stg.txt) index 보존 · files 비움',
        isAllow(s4) && head(own) !== h0 && git(own, 'show', '--name-only', '--format=', 'HEAD') === 'k2.txt' && /^A  stg\.txt$/m.test(status(own))
        && (readSession(own, 'OS4').files || []).length === 0 && (readSession(own, 'OS4').last_commit || {}).by === 'session-end', status(own) + ' | ' + JSON.stringify(readSession(own, 'OS4')));

      // ── Codex Stop(막지 않고 훅이 바로 커밋) — 정상은 그대로 · 불명확하면 커밋 0 ──
      const cedit = (cwd, sid, rel, body) => {             // Codex apply_patch: 쓰기 전(PreToolUse) · 쓰기 · 쓰기 뒤(PostToolUse)
        const patch = `*** Begin Patch\n*** Add File: ${rel}\n+${body}\n*** End Patch`;
        hook('board', { hook_event_name: 'PreToolUse', session_id: sid, turn_id: 't', cwd, tool_name: 'apply_patch', tool_input: { command: patch } }, ['--codex']);
        write(path.join(cwd, rel), body + '\n');
        hook('track', { hook_event_name: 'PostToolUse', session_id: sid, turn_id: 't', cwd, tool_name: 'apply_patch', tool_input: { command: patch } }, ['--codex']);
      };
      const cstop = (cwd, sid) => hook('stop', { hook_event_name: 'Stop', session_id: sid, turn_id: 't', cwd, stop_hook_active: false, last_assistant_message: 'done' }, ['--codex']);
      // C1 정상 — 그 파일만 · 남의 스테이징 보존
      cedit(own, 'codex-own-c1', 'cx1.txt', 'mine cx1');
      h0 = head(own); const c1 = cstop(own, 'codex-own-c1');
      R.check('[own/C1] Codex Stop 정상 자기 변경은 막지 않고 그 파일만 커밋 · stg.txt 스테이징 그대로',
        isAllow(c1) && head(own) !== h0 && git(own, 'show', '--name-only', '--format=', 'HEAD') === 'cx1.txt' && /^A  stg\.txt$/m.test(status(own)), status(own));
      // C2 쓰기 전 기록 없음(PostToolUse 만) — 첫 쓰기 전 상태를 모른다
      write(path.join(own, 'cx2.txt'), 'unknown cx2\n');
      hook('track', { hook_event_name: 'PostToolUse', session_id: 'codex-own-c2', turn_id: 't', cwd: own, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: cx2.txt\n+unknown cx2\n*** End Patch' } }, ['--codex']);
      h0 = head(own); const c2 = cstop(own, 'codex-own-c2');
      R.check('[own/C2] Codex Stop 은 쓰기 전 기록이 없는 파일을 커밋하지 않는다(불명확 → 커밋 0 · 사유 기록)',
        isAllow(c2) && head(own) === h0 && /^\?\? cx2\.txt$/m.test(status(own)) && ((readSession(own, 'codex-own-c2') || {}).stop_skipped || []).some(x => x && x.path === 'cx2.txt'), JSON.stringify(readSession(own, 'codex-own-c2')));
      // C3 checkout 이동 — 레인 1 에서 쓰고 메인에서 멈춤 · 메인 같은 경로는 남의 미추적 파일
      cedit(owt, 'codex-own-c3', 'cx3.txt', 'lane cx3');
      write(path.join(own, 'cx3.txt'), 'other cx3\n');
      h0 = head(own); const c3 = cstop(own, 'codex-own-c3');
      R.check('[own/C3] Codex Stop 도 다른 checkout 의 같은 상대 경로를 커밋하지 않는다 · 사유 root_mismatch',
        isAllow(c3) && head(own) === h0 && text(path.join(own, 'cx3.txt')) === 'other cx3\n' && skipped('codex-own-c3', 'cx3.txt', 'root_mismatch'), JSON.stringify(readSession(own, 'codex-own-c3')));

      // M1 같은 파일에 남의 staged(B1) + unstaged(B2) 가 있는데 세션이 그 파일을 고쳤다 — Stop 2회 · SessionEnd · Codex Stop 어느 자동 경로도
      //   HEAD · index blob(git ls-files -s) · 작업 파일 바이트를 바꾸지 않는다(add 뒤 커밋 거절로 index 만 바뀌는 것도 잡는다)
      const snap = rel => [head(own), git(own, 'ls-files', '-s', '--', rel), fs.readFileSync(path.join(own, rel)).toString('base64')].join('|');
      for (const [n, rel, run] of [
        ['stop', 'm1.txt', sid => twice(own, sid)],
        ['end', 'm2.txt', sid => [oend(own, sid)]],
        ['codex', 'm3.txt', sid => [cstop(own, sid)]],
      ]) {
        write(path.join(own, rel), 'B1\n'); git(own, 'add', '--', rel); write(path.join(own, rel), 'B1\nB2\n');
        const sid = `OM1-${n}`;
        if (n === 'codex') { const sid2 = `codex-om1-${n}`; cedit(own, sid2, rel, 'B1\nB2\nmine'); const before = snap(rel); const out = run(sid2);
          R.check(`[own/M1] ${n}: 남의 staged+unstaged 위 내 편집 — 전후 HEAD · index blob · 파일 바이트 같음 · 대신 커밋 0`, out.every(isAllow) && snap(rel) === before, before + ' ≠ ' + snap(rel)); continue; }
        edit(own, sid, path.join(own, rel), 'B1\nB2\nmine\n');
        const before = snap(rel); const out = run(sid);
        R.check(`[own/M1] ${n}: 남의 staged+unstaged 위 내 편집 — 전후 HEAD · index blob · 파일 바이트 같음 · 대신 커밋 0`, out[out.length - 1] && isAllow(out[out.length - 1]) && snap(rel) === before, before + ' ≠ ' + snap(rel));
      }
      // X1 쓴 뒤 작업 파일은 그대로인데 남이 index 만 바꿈(git add) — 대신 커밋하면 그 index 를 덮는다 → 커밋 0 · 사유 index_changed
      edit(own, 'OX1', path.join(own, 'ix.txt'), 'mine ix\n');
      git(own, 'add', '--', 'ix.txt');
      { const before = snap('ix.txt'); const x1 = twice(own, 'OX1');
        R.check('[own/X1] 쓴 뒤 남이 index 만 바꾼 파일은 대신 커밋하지 않는다 · 전후 HEAD · index blob · 파일 바이트 같음 · 사유 index_changed',
          isAllow(x1[1]) && snap('ix.txt') === before && skipped('OX1', 'ix.txt', 'index_changed'), before + ' ≠ ' + snap('ix.txt') + ' | ' + JSON.stringify(readSession(own, 'OX1'))); }
      // X2 쓴 뒤 남이 index 만 바꿈 → 같은 세션이 그 파일을 다시 씀 — 두 번째 Post 의 index 로 남의 변경을 씻어 내지 않는다 · 사유 index_changed
      edit(own, 'OX2', path.join(own, 'ix2.txt'), 'mine ix2\n');
      git(own, 'add', '--', 'ix2.txt');
      edit(own, 'OX2', path.join(own, 'ix2.txt'), 'mine ix2\nmore\n');
      { const before = snap('ix2.txt'); const x2 = twice(own, 'OX2');
        R.check('[own/X2] index 만 바뀐 뒤 같은 세션이 다시 써도 대신 커밋하지 않는다 · 전후 HEAD · index blob · 파일 바이트 같음 · 사유 index_changed',
          isAllow(x2[1]) && snap('ix2.txt') === before && skipped('OX2', 'ix2.txt', 'index_changed'), before + ' ≠ ' + snap('ix2.txt') + ' | ' + JSON.stringify(readSession(own, 'OX2'))); }
      // P 앞선 정상 쓰기(Pre → Post) 뒤 Pre 없이 Post 만 온 쓰기(누락 · 실패) — 옛 Pre 로 소유를 인정하지 않는다 · 사유 pre_unknown
      const postOnly = (cwd, sid, file, body, codex) => { write(file, body); if (codex) hook('track', { hook_event_name: 'PostToolUse', session_id: sid, turn_id: 't', cwd, tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${path.relative(cwd, file).split(path.sep).join('/')}\n*** End Patch` } }, ['--codex']); else claudeWrite(cwd, sid, file); };
      for (const [n, rel, run, sid] of [['stop', 'p1.txt', s => twice(own, s), 'OP1'], ['end', 'p2.txt', s => [oend(own, s)], 'OP2'], ['codex', 'p3.txt', s => [cstop(own, s)], 'codex-op3']]) {
        if (n === 'codex') cedit(own, sid, rel, 'first'); else edit(own, sid, path.join(own, rel), 'first\n');
        postOnly(own, sid, path.join(own, rel), 'first\nsecond\n', n === 'codex');
        const before = snap(rel); const out = run(sid);
        const sk = ((readSession(own, sid) || {})[n === 'end' ? 'end_skipped' : 'stop_skipped'] || []).some(x => x && x.path === rel && x.reason === 'pre_unknown');
        R.check(`[own/P] ${n}: 앞선 정상 쓰기 뒤 Pre 없는 Post — 대신 커밋 0 · 전후 HEAD · index · 바이트 같음 · 사유 pre_unknown`, isAllow(out[out.length - 1]) && snap(rel) === before && sk, before + ' ≠ ' + snap(rel) + ' | ' + JSON.stringify(readSession(own, sid)));
      }
      // P4 같은 세션의 연속 정상 쓰기(Pre → Post 두 번)는 그대로 대신 커밋
      edit(own, 'OP4', path.join(own, 'p4.txt'), 'one\n'); edit(own, 'OP4', path.join(own, 'p4.txt'), 'one\ntwo\n');
      { const h4 = head(own); const p4 = twice(own, 'OP4');
        R.check('[own/P4] 같은 세션 연속 Pre → Post 편집은 정상 정책대로 그 파일만 대신 커밋', isAllow(p4[1]) && head(own) !== h4 && git(own, 'log', '-1', '--name-only', '--format=') === 'p4.txt', JSON.stringify(p4.map(r => r.stdout))); }
      // B1 깨끗한 Pre → 쓰기 실패(Post 없음) → 남이 그 파일을 고침 → 이 세션이 다시 Pre → 쓰기 → Post — 옛 clean 증거로 남의 WIP 를 세탁하지 않는다 · 사유 post_unknown
      hook('board', { hook_event_name: 'PreToolUse', session_id: 'OB1', cwd: own, prompt_id: 'p', tool_name: 'Write', tool_input: { file_path: path.join(own, 'q1.txt'), content: 'x' } });
      write(path.join(own, 'q1.txt'), 'other q1\n');
      edit(own, 'OB1', path.join(own, 'q1.txt'), 'other q1\nmine q1\n');
      { const before = snap('q1.txt'); const b1 = twice(own, 'OB1');
        R.check('[own/B1] 짝 Post 없는 앞 Pre 뒤 남의 변경 위에 쓴 파일은 대신 커밋하지 않는다 · 전후 HEAD · index · 바이트 같음 · 사유 post_unknown',
          isAllow(b1[1]) && snap('q1.txt') === before && skipped('OB1', 'q1.txt', 'post_unknown'), before + ' ≠ ' + snap('q1.txt') + ' | ' + JSON.stringify(readSession(own, 'OB1'))); }
      if (agentsWas === undefined) delete ENV.HARNESS_AGENTS_JSON; else ENV.HARNESS_AGENTS_JSON = agentsWas;
    }

    R.check('[격리] 가짜 HOME 에 .claude · .codex 가 생기지 않았다', !fs.existsSync(path.join(home, '.claude')) && !fs.existsSync(path.join(home, '.codex')));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

function isAll(r) { return r.status === 0 && r.stdout.trim() === ''; }

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
      ['git update-ref refs/heads/main HEAD~1', 'Bash'], ['git branch -f main HEAD~1', 'Bash'], ['git branch --force main v1', 'Bash'], ['git branch -M main', 'Bash'],
      ['git checkout -B main HEAD~1', 'Bash'], ['git switch -C main', 'Bash'], ['git switch --force-create main', 'Bash'],
      ['git reset --soft HEAD~1', 'Bash'], ['git reset --mixed HEAD~1', 'Bash'], ['git reset HEAD~1', 'PowerShell'], ['git reset --keep HEAD^', 'Bash'],
      ['git rm -rf .', 'Bash'], ['git rm -r :/', 'Bash'],
      ['rm -rf .git/objects', 'Bash'], ['rm -rf .git/harness', 'Bash'], ['rm -rf ./.git/refs/heads', 'Bash'], ['Remove-Item -Recurse -Force .git\\objects\\pack', 'PowerShell'],
    ];
    for (const [c, t] of m10Block) { const r = pre(c, t); R.check(`[guard/M10] 막는다(${t}): ${c}`, isDeny(r), JSON.stringify(r).slice(0, 300)); }
    const m10Allow = [
      ['git stash list', 'Bash'], ['git stash show stash@{0}', 'PowerShell'], ['git reset', 'Bash'], ['git reset HEAD', 'Bash'], ['git reset --soft HEAD', 'Bash'],
      ['git reset -- src/a.js', 'Bash'], ['git reset src/a.js', 'Bash'], ['git reset HEAD~1 -- src/a.js', 'Bash'], ['git rm -r --cached .', 'Bash'], ['git rm src/a.js', 'Bash'],
      ['git rm -r -n .', 'Bash'], ['git branch -m old new', 'Bash'], ['git commit -m "amend later"', 'Bash'], ['git checkout -b fresh', 'Bash'], ['rm -f .git/index.lock', 'Bash'],
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

    R.check('[guard] 쓰기 도구·MCP 는 보지 않는다', isAllow(hook('guard', { hook_event_name: 'PreToolUse', session_id: 's', cwd: repo, tool_name: 'Write', tool_input: { file_path: 'x', content: 'git push' } })));

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
    R.check('[track] 깨진 입력 → exit 0', hook('track', '[[[', [], tr).status === 0);

    // ── stop (Claude) ─────────────────────────────────────────────────
    const st = mkRepo('stop', { 'a.js': 'a\n', 'b.js': 'b\n' });
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
    }
    write(path.join(st, 'a.js'), 'AA\n');
    R.check('[stop] 새 턴(stop_hook_active false)이면 다시 한 번 막는다', (stop('SA', false).json || {}).decision === 'block');
    git(st, 'add', 'a.js'); git(st, '-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-q', '-m', 'a', '--', 'a.js');
    R.check('[stop] 자기 파일이 커밋됐으면 통과(b.js 는 여전히 미커밋이어도)', isAllow(stop('SA', false)) && /b\.js/.test(status(st)));
    R.check('[stop] 기록 없는 세션은 통과', isAllow(stop('NOPE', false)));

    write(path.join(st, 'c.js'), 'c\n'); write(path.join(st, '.env'), 'K=1\n');
    claudeWrite(st, 'SS', path.join(st, 'c.js')); claudeWrite(st, 'SS', path.join(st, '.env'));
    const bs = stop('SS', false);
    R.check('[stop] 비밀 파일은 커밋 대상에서 빼고 이유에 따로 경고한다', bs.json && bs.json.decision === 'block' && /`c\.js` —/.test(bs.json.reason) && /비밀 파일로 보이는 `\.env`/.test(bs.json.reason), bs.json && bs.json.reason);
    git(st, 'add', 'c.js'); git(st, '-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-q', '-m', 'c', '--', 'c.js');
    R.check('[stop] 비밀 파일만 남았으면 막지 않는다', isAllow(stop('SS', false)));

    // ── stop (Codex) — 훅이 직접 그 파일만 커밋한다 ────────────────────
    const cr = mkRepo('codex', { 'lib/x.js': 'x\n', 'other.js': 'o\n' });
    const cpatch = '*** Begin Patch\n*** Add File: c1.js\n+c\n*** Update File: lib/x.js\n*** Add File: .env.local\n+S=1\n*** End Patch';
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

    write(path.join(cr, 'c1.js'), 'c2\n');
    const lock = path.join(cr, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const pending = hookAsync('stop', { hook_event_name: 'Stop', session_id: 'codex-sess-1234', turn_id: 't3', cwd: cr, stop_hook_active: false }, ['--codex']);
    await new Promise(r => setTimeout(r, 600));
    fs.unlinkSync(lock);
    const lr = await pending;
    R.check('[stop/codex] index.lock 이 잡혀 있으면 기다렸다가 커밋한다', lr.status === 0 && git(cr, 'log', '-1', '--format=%s') === 'wip(codex codexses): update c1.js' && !/c1\.js/.test(status(cr)), git(cr, 'log', '-1', '--format=%s') + ' / ' + status(cr));

    // ── session-end ──────────────────────────────────────────────────
    const se = mkRepo('send', { 'd.js': 'd\n', 'e.js': 'e\n', 'f.js': 'f\n' });
    write(path.join(se, 'd.js'), 'D\n'); write(path.join(se, 'e.js'), 'E\n');
    claudeWrite(se, 'dddd1111-2222', path.join(se, 'd.js'));
    claudeWrite(se, 'eeee', path.join(se, 'e.js'));
    const end = (sid, args) => hook('session-end', { hook_event_name: 'SessionEnd', session_id: sid, cwd: se, reason: 'prompt_input_exit' }, args);
    const e1 = end('dddd1111-2222');
    R.check('[session-end] exit 0 · 출력 없음', isAllow(e1), JSON.stringify(e1));
    R.check('[session-end] 남은 자기 파일을 그것만 커밋: wip(session <sid8>): auto-commit at session end',
      git(se, 'log', '-1', '--format=%s') === 'wip(session dddd1111): auto-commit at session end' && git(se, 'show', '--name-only', '--format=', 'HEAD') === 'd.js', git(se, 'log', '-1', '--format=%s'));
    R.check('[session-end] 다른 세션의 e.js 는 미커밋 그대로 · 그 세션 기록도 그대로', /^ M e\.js$/m.test(status(se)) && readSession(se, 'eeee') !== null);
    R.check('[session-end] 깨끗하게 끝난 세션의 기록은 지운다', readSession(se, 'dddd1111-2222') === null);
    write(path.join(se, 'f.js'), 'F\n'); write(path.join(se, 'id_rsa'), 'KEY\n');
    claudeWrite(se, 'ffff', path.join(se, 'f.js')); claudeWrite(se, 'ffff', path.join(se, 'id_rsa'));
    end('ffff', ['--codex']);
    const fs1 = readSession(se, 'ffff');
    R.check('[session-end] 비밀 파일은 커밋하지 않고 기록을 남긴다(f.js 만 커밋)',
      git(se, 'show', '--name-only', '--format=', 'HEAD') === 'f.js' && /^\?\? id_rsa$/m.test(status(se)) && fs1 && fs1.ended_at && fs1.secrets_left.includes('id_rsa'), JSON.stringify(fs1));
    R.check('[session-end] 기록 없는 세션 · 깨진 입력 → exit 0', isAllow(end('none')) && hook('session-end', 'nope', [], se).status === 0);

    // ── 리뷰 수정: _common · policy ─────────────────────────────────
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
    write(path.join(hk, 'h.js'), 'H\n');
    claudeWrite(hk, 'hkhkhkhk', path.join(hk, 'h.js'));
    const hkHead = git(hk, 'rev-parse', 'HEAD');
    hook('session-end', { hook_event_name: 'SessionEnd', session_id: 'hkhkhkhk', cwd: hk, reason: 'exit' });
    R.check('[L11] pre-commit 훅이 실패하고 commit.gpgsign=true 여도 session-end 커밋이 된다(--no-verify · -c commit.gpgsign=false)',
      git(hk, 'rev-parse', 'HEAD') !== hkHead && git(hk, 'show', '--name-only', '--format=', 'HEAD') === 'h.js', status(hk) + ' | ' + JSON.stringify(readSession(hk, 'hkhkhkhk')));
    write(path.join(hk, 'h.js'), 'H2\n');
    hook('track', { hook_event_name: 'PostToolUse', session_id: 'cxcxcxcx', turn_id: 't', cwd: hk, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: h.js\n*** End Patch' } }, ['--codex']);
    const hkHead2 = git(hk, 'rev-parse', 'HEAD');
    hook('stop', { hook_event_name: 'Stop', session_id: 'cxcxcxcx', turn_id: 't', cwd: hk, stop_hook_active: false }, ['--codex']);
    R.check('[L11] Codex stop 커밋도 같다', git(hk, 'rev-parse', 'HEAD') !== hkHead2, status(hk));

    // [M8] 워커 권한 — 셸(임의 실행기)은 어떤 경로로 들어와도 허용하지 않는다.
    const policy = require(path.join(HOOKS, '..', 'lib', 'policy.js'));
    const allow = policy.claudeSettings(['node', 'bash', 'sh', 'pwsh', 'powershell', 'cmd', 'env', 'bash.exe', 'zsh', 'npm']).permissions.allow;
    R.check('[M8/policy] claudeSettings 는 bash · sh · cmd · powershell · pwsh · env 를 허용에 넣지 않는다', !allow.some(x => /\((bash|sh|zsh|cmd|powershell|pwsh|env)(\.exe)?:/i.test(x)) && allow.includes('Bash(node:*)') && allow.includes('Bash(npm:*)'), JSON.stringify(allow));
    R.check('[M8/policy] allowFor 도 셸 검사(bash x.sh · sh -c …)에서 셸을 넣지 않는다', JSON.stringify(policy.allowFor([['bash', 'x.sh'], 'sh -c "npm test"', ['cmd', '/c', 'x'], ['node', 't.js']], null)) === '["node"]');
    R.check('[M8/policy] NEVER_ALLOW · isNeverAllowed 를 내보낸다(checks.js 가 같은 목록을 쓸 수 있게)', Array.isArray(policy.NEVER_ALLOW) && ['bash', 'sh', 'cmd', 'powershell', 'pwsh', 'env'].every(x => policy.NEVER_ALLOW.includes(x)) && typeof policy.isNeverAllowed === 'function' && policy.isNeverAllowed('Bash.EXE') && !policy.isNeverAllowed('node'));

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
    R.check('[lang] 저장소 밖 · 깨진 입력은 조용히 통과', isAllow(hook('lang', { hook_event_name: 'Stop', session_id: 'x', cwd: base, last_assistant_message: EN })) && isAllow(hook('lang', 'not json')) && fs.existsSync(path.join(hookTmp, 'harness', 'hook-errors.log')));

    // ── [2026-10-16 사용자 지시 · 실측] 작업자 명령을 허용 목록으로 막지 않는다(open) — 대신 guard 가 작업자 모드(--worker)에서
    //    자기 worktree 밖의 삭제를 막는다(실측: open 설정에서 저장소 밖 폴더 rm -rf 가 통과했다). 대화형 모드는 그대로. ──
    {
      const wrepo = mkRepo('guard-worker', { 'a.txt': 'a\n', 'build/out.txt': 'x\n' });
      const outside = path.join(base, 'outside-of-worktree');
      fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, 'k.txt'), 'k');
      const wpre = (command, tool, args) => hook('guard', { hook_event_name: 'PreToolUse', session_id: 'w1', cwd: wrepo, tool_name: tool || 'Bash', tool_input: { command } }, args || ['--worker'], wrepo);
      const blockedOut = [[`rm -rf "${outside.replace(/\\/g, '/')}"`, 'Bash'], [`rm "${path.join(outside, 'k.txt').replace(/\\/g, '/')}"`, 'Bash'], [`Remove-Item -Recurse -Force "${outside}"`, 'PowerShell'], [`rm -rf ../outside-of-worktree`, 'Bash']];
      const res = blockedOut.map(([c, t]) => [c, isDeny(wpre(c, t))]);
      R.check('[guard/worker] 작업자 모드: worktree 밖 삭제(재귀 · 단일 파일 · PowerShell)를 막는다', res.every(x => x[1]), JSON.stringify(res));
      R.check('[guard/worker] 작업자 모드: worktree 안 삭제 · 일반 명령은 통과', isAllow(wpre('rm -rf build')) && isAllow(wpre('rm a.txt')) && isAllow(wpre('node -v | head -1')) && isAllow(wpre('for i in 1 2; do echo $i; done')));
      R.check('[guard/worker] 대화형 모드(인자 없음)는 예전 그대로 — 저장소 밖 일반 폴더 삭제는 막지 않는다', isAllow(wpre(`rm -rf "${outside.replace(/\\/g, '/')}"`, 'Bash', [])));
    }
    // ── [2026-10-17 적대적 검증] 작업자 모드 guard 우회 16가지 — 실제 worktree(메인 저장소 안)에서 ──
    //    ① cd 로 메인 저장소에 들어가면 경계를 메인으로 다시 잡았다 ② 삭제를 명령 이름으로만 봤다(find -delete · mv · robocopy · 리다이렉션 ·
    //    Set-Content · node/python 한 줄) ③ 풀 수 없는 변수는 마지막 조각이 구체적이면 통과 ④ docker 데몬 전체를 바꾸는 명령
    {
      const mainR = mkRepo('guard-adv-main', { 'src/a.js': 'a\n' });
      const wtA = path.join(mainR, '.harness-worktrees', 't-20261017-000000-abcd');
      git(mainR, 'worktree', 'add', '-q', '-b', 'harness/t-20261017-000000-abcd', wtA);
      const userData = path.join(base, 'user-data-adv'); fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(path.join(userData, 'k.txt'), 'k');
      const U = userData.replace(/\\/g, '/'), Uw = userData, MR = mainR.replace(/\\/g, '/'), MRw = mainR;
      const G = require(path.join(HOOKS, 'guard.js'));
      // 임시 폴더는 따로 둔다 — 이 테스트의 저장소 · 사용자 폴더가 시스템 임시 폴더 안에 있어 "임시 폴더 예외" 가 모두 통과시키지 않게(실제와 같게)
      const advTmp = path.join(base, 'adv-tmp'); fs.mkdirSync(advTmp, { recursive: true });
      const dec = (cmd, tool) => { const keep = ['TEMP', 'TMP', 'TMPDIR'].map(k => [k, process.env[k]]); for (const [k] of keep) process.env[k] = advTmp; try { return G.decide({ tool_name: tool, tool_input: { command: cmd }, cwd: wtA }, 'claude', { worker: true }); } finally { for (const [k, v] of keep) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
      const mustBlockW = [[`cd "${MR}" && rm -rf src`, 'Bash'], ['cd .. && cd .. && rm -rf src', 'Bash'], [`pushd "${MR}"; rm -rf src`, 'Bash'],
        [`Set-Location "${MRw}"; Remove-Item -Recurse src`, 'PowerShell'], [`find "${U}" -delete`, 'Bash'], [`find "${U}" -type f -exec rm {} +`, 'Bash'],
        [`mv "${U}" ./trash`, 'Bash'], [`Move-Item "${Uw}" .\\trash`, 'PowerShell'], [`node -e "require('fs').rmSync('${U}',{recursive:true})"`, 'Bash'],
        [`python -c "import shutil; shutil.rmtree('${U}')"`, 'Bash'], ['rm -rf "$TMP/../user-data"', 'Bash'], ['rm -rf "$OUT_DIR"', 'Bash'],
        [`robocopy empty "${Uw}" /MIR`, 'PowerShell'], [`echo x > "${U}/k.txt"`, 'Bash'], [`echo x>>${U}/k.txt`, 'Bash'], [`Set-Content -Path "${Uw}\\k.txt" -Value x`, 'PowerShell'],
        ['docker rm -f $(docker ps -aq)', 'Bash'], ['docker system prune -af', 'Bash'], ['docker compose -p myapp down -v', 'Bash'], [`cd $SOMEWHERE && rm -rf data`, 'Bash']];
      const blockedW = mustBlockW.map(([c, t]) => [c.replace(base.replace(/\\/g, '/'), '<T>').replace(base, '<T>'), !!dec(c, t)]);
      R.check('[guard/worker-adv] 작업자 모드: 우회 20가지(cd 후 삭제 · find · mv · robocopy · 리다이렉션 · Set-Content · 한 줄 코드 · 변수 경로 · docker 전역)를 막는다', blockedW.every(x => x[1]), JSON.stringify(blockedW.filter(x => !x[1])));
      const mustPassW = [['rm -rf build', 'Bash'], ['cd src && rm -f a.js', 'Bash'], ['find . -name "*.tmp" -delete', 'Bash'], ['mv a.js b.js', 'Bash'], ['echo x > out.log', 'Bash'],
        ['npm test 2>&1 | tail -20', 'Bash'], ['dotnet build 2>&1 > build.log', 'Bash'], ['Set-Content -Path .\\out.txt -Value x', 'PowerShell'], ['docker compose up -d', 'Bash'], ['docker compose down -v', 'Bash'],
        [`echo x > "${advTmp.replace(/\\/g, '/')}/scratch.txt"`, 'Bash'], ['rm -rf "$PWD/build"', 'Bash'], ['node -e "console.log(1)"', 'Bash'], ['cat a.js > /dev/null', 'Bash']];
      const passedW = mustPassW.map(([c, t]) => [c, !dec(c, t)]);
      R.check('[guard/worker-adv] 작업자 모드: worktree 안 · 임시 폴더 · 이 작업의 compose 는 그대로 통과', passedW.every(x => x[1]), JSON.stringify(passedW.filter(x => !x[1]).map(x => [x[0], String(dec(x[0], 'Bash')).slice(0, 80)])));
      // [2026-10-21 사용 분석 · 거부 재생] ① 따옴표 안의 > 를 리디렉션으로 오인(grep 검색어) ② 지시문대로 이 작업 접두어로 만든 컨테이너를 지우는 것까지 막음
      const keepEnv = ['COMPOSE_PROJECT_NAME', 'HARNESS_DATA_NS'].map(k => [k, process.env[k]]);
      process.env.COMPOSE_PROJECT_NAME = 'harness-t-20261017-000000-abcd'; process.env.HARNESS_DATA_NS = 'h_t_20261017_000000_abcd';
      try {
        const passQ = [['grep -n "x" a.js | grep -i "raw\\|string>\\|JToken"', 'Bash'], ['grep -rn "TargetType\\b.*=>\\|\\"사람\\"" --include=*.cs .', 'Bash'], ["grep -E '<[a-z]+>' a.js", 'Bash'],
          ['Select-String -Path a.js -Pattern "a->b"', 'PowerShell'], ['docker rm -f harness-t-20261017-000000-abcd-pg', 'Bash'], ['docker rm -f "$env:COMPOSE_PROJECT_NAME-pg"', 'PowerShell'],
          ['docker rm -f -v "$HARNESS_DATA_NS-pg"', 'Bash'], ['docker stop -t 5 ${COMPOSE_PROJECT_NAME}-redis', 'Bash'], ['docker volume rm h_t_20261017_000000_abcd_data', 'Bash']];
        const blockQ = [[`bash -c "echo x > ${U}/k.txt"`, 'Bash'], [`echo "a">${U}/k.txt`, 'Bash'], [`eval "echo hi > ${U}/k.txt"`, 'Bash'], [`cmd /c "echo x > ${Uw}\\k.txt"`, 'PowerShell'],
          ['docker rm -f other-users-db', 'Bash'], ['docker rm -f harness-t-20261017-000000-abcd-pg other-users-db', 'Bash'], ['docker container prune -f', 'Bash'], ['docker stop $(docker ps -q)', 'Bash'], ['docker kill sso-server', 'Bash']];
        const badQ = [...passQ.filter(([c, t]) => dec(c, t)).map(([c]) => `막힘(오탐): ${c}`), ...blockQ.filter(([c, t]) => !dec(c, t)).map(([c]) => `통과(구멍): ${c.replace(base, '<T>')}`)];
        R.check('[guard/worker-q] 따옴표 안 > · < 는 데이터(grep 검색어) · 이 작업 접두어 컨테이너 정리는 통과 — 중첩 셸의 리디렉션 · 남의 컨테이너 · 전역 정리는 그대로 막힘', !badQ.length, JSON.stringify(badQ));
      } finally { for (const [k, v] of keepEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
      // [2026-10-19 적대적 재평가 · 현장 66건] 정당한 명령을 막았다 — 같은 명령에서 정한 변수 · $env:TEMP · Git Bash /tmp · worktree 안 하위 저장소 · docker 읽기
      const W2 = wtA.replace(/\\/g, '/');
      fs.mkdirSync(path.join(wtA, 'nested'), { recursive: true }); git(path.join(wtA, 'nested'), 'init', '-q');
      const decAt = (cmd, tool, cwd) => { const keep = ['TEMP', 'TMP', 'TMPDIR'].map(k => [k, process.env[k]]); for (const [k] of keep) process.env[k] = advTmp; try { return G.decide({ tool_name: tool, tool_input: { command: cmd }, cwd: cwd || wtA }, 'claude', { worker: true }); } finally { for (const [k, v] of keep) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
      const fp = [[`W=${W2}/sub; mkdir -p $W && rm -rf "$W/old"`, 'Bash'], [`$root = "${wtA}\\obj\\h3d"; New-Item -ItemType Directory -Force "$root\\x" | Out-Null`, 'PowerShell'],
        [`$wt='${wtA}'; Remove-Item -Recurse -Force "$wt\\bin"`, 'PowerShell'], ['dotnet test x.sln 2>&1 | Out-File -Encoding utf8 "$env:TEMP\\t.log"', 'PowerShell'],
        // Git Bash 의 /tmp(= 사용자 임시 폴더)는 Windows 에서만 — POSIX 의 /tmp 는 실제 경로라 임시 폴더를 따로 돌린 이 테스트에서는 밖이다
        ...(process.platform === 'win32' ? [['dotnet test x.sln > /tmp/t.log 2>&1', 'Bash'], ['rm -rf /tmp/basechk && mkdir /tmp/basechk', 'Bash']] : []),
        ['docker images --format x', 'Bash'], ['docker network ls', 'Bash'], ['docker ps -a', 'Bash'], ['docker volume ls', 'Bash']];
      const fpRes = fp.map(([c, t]) => [c.slice(0, 70), !decAt(c, t)]);
      const nested = !decAt('rm -rf ../build && rm -f ../a.txt', 'Bash', path.join(wtA, 'nested'));
      R.check('[guard/worker-fp] 정당한 명령은 막지 않는다: 같은 명령의 변수 · $env:TEMP · /tmp · worktree 안 하위 저장소 · docker 읽기',
        fpRes.every(x => x[1]) && nested, JSON.stringify({ blocked: fpRes.filter(x => !x[1]).map(x => x[0]), nested }));
      const stillBlock = [[`W=${U}; rm -rf "$W"`, 'Bash'], [`export W=${U}; rm -rf "$W"`, 'Bash'], [`W=${U}; cd $W && rm -rf build`, 'Bash'],
        ['rm -rf /tmp/../c/x', 'Bash'], ['docker network rm x', 'Bash'], ['docker container prune -f', 'Bash'], ['docker image rm a', 'Bash']];
      // 2차(현장 재현에서 남은 것): 반복 변수 · $(pwd) · (Resolve-Path .).Path · Join-Path · 하네스가 준 compose 이름 · 한 줄 코드 속 URL 경로
      const fp2 = [['for d in out-a out-b; do mkdir -p $d && cp -r src $d/; done', 'Bash'], ['for f in logs/m-*.log; do mv $f ${f%.log}-run1.log; done', 'Bash'],
        ["foreach ($d in 'A.B','C.D') { robocopy \"src\\$d\" \"out\\$d\" *.cs /E }", 'PowerShell'], ['W=$(pwd); mkdir -p "$W/out" && cp a.txt "$W/out/a.txt"', 'Bash'],
        ["$dst=(Resolve-Path .).Path + '\\copy'; New-Item -ItemType Directory -Force $dst | Out-Null; New-Item -ItemType Directory -Force \"$((Resolve-Path .).Path)\\copy2\" | Out-Null", 'PowerShell'],
        ["$dst = Join-Path $PWD '.gis'; robocopy src \"$dst\\x\" /E", 'PowerShell'], ['$root = "$PWD\\obj\\h3d"; New-Item -ItemType Directory -Force "$root\\pristine" | Out-Null', 'PowerShell'],
        ['docker compose -p "$COMPOSE_PROJECT_NAME" -f sim/compose.yaml config --quiet', 'Bash'],
        [`python -c "import json; out = {'s': get('/api/ha/status')}; open('out.json', 'w').write(json.dumps(out))"`, 'Bash']];
      const fp2Res = fp2.map(([c, t]) => [c.slice(0, 70), !decAt(c, t), String(decAt(c, t) || '').slice(-60)]);
      R.check('[guard/worker-fp] 2차: 반복 변수 · $(pwd) · Join-Path · 하네스의 compose 이름 · 한 줄 코드 속 URL 은 막지 않는다', fp2Res.every(x => x[1]), JSON.stringify(fp2Res.filter(x => !x[1])));
      const stillBlock2 = [[`for d in ok ${U}; do rm -rf $d; done`, 'Bash'], [`for d in a b; do cp x ${U}/$d; done`, 'Bash'], ['docker compose -p other up -d', 'Bash'],
        [`$dst = Join-Path "${Uw}" 'x'; Remove-Item -Recurse -Force $dst`, 'PowerShell'], [`$dst = "${Uw}" + '\\x'; New-Item -ItemType Directory -Force $dst`, 'PowerShell'], [`python -c "open('${U}/k.txt', 'w').write('x')"`, 'Bash']];
      R.check('[guard/worker-fp] 2차: 반복 값 하나라도 밖이면 · 다른 compose 이름 · Join-Path 로 만든 밖 경로 · 한 줄 코드의 밖 쓰기는 막는다', stillBlock2.every(([c, t]) => !!decAt(c, t)), JSON.stringify(stillBlock2.map(([c, t]) => [c.slice(0, 50), !!decAt(c, t)])));
      // 3차: open 모드는 git -C · stash · config 를 권한 deny 대신 guard 가 거른다 — 읽기는 통과, 쓰기는 막는다
      const gitRead = [[`git -C "${U}" status --short`, 'Bash'], [`git -C ${U} log --oneline -3`, 'PowerShell'], ['git stash list', 'Bash'], ['git stash show -p stash@{0}', 'Bash'],
        ['git config --get core.autocrlf', 'Bash'], ['git config core.autocrlf', 'Bash'], ['git config --list', 'PowerShell'], [`git -C "${U}" archive -o out/a.tar HEAD`, 'Bash'], [`git -C "${U}" apply --check x.patch`, 'Bash'], [`git -C "${U}" branch --show-current`, 'PowerShell'], [`git -C "${U}" remote -v`, 'Bash']];
      const gitWrite = [[`git -C "${U}" checkout -- .`, 'Bash'], [`git -C "${U}" commit -m x`, 'Bash'], [`git --git-dir="${U}/.git" reset --hard`, 'Bash'], ['git stash', 'Bash'], ['git stash pop', 'Bash'],
        ['git config user.name x', 'Bash'], ['git config --unset core.x', 'Bash'], [`git -C "${U}" archive -o "${U}/a.tar" HEAD`, 'Bash'], [`git -C "${U}" apply x.patch`, 'Bash'], [`git -C . push`, 'Bash'], [`git -C "${U}" branch -D old`, 'Bash'], [`git -C "${U}" branch newb`, 'Bash'], [`git -C "${U}" remote add o x`, 'Bash'], [`git -C "${U}" tag v1`, 'Bash']];
      const gr = gitRead.map(([c, t]) => [c.slice(0, 60), !decAt(c, t)]), gw = gitWrite.map(([c, t]) => [c.slice(0, 60), !!decAt(c, t)]);
      R.check('[guard/worker-git] git -C · stash · config: 읽기(status · log · archive · stash list · config --get)는 통과', gr.every(x => x[1]), JSON.stringify(gr.filter(x => !x[1])));
      R.check('[guard/worker-git] git -C · --git-dir · stash · config: 쓰기(checkout · commit · reset · stash · config 설정 · 밖으로 archive · apply · push)는 막는다', gw.every(x => x[1]), JSON.stringify(gw.filter(x => !x[1])));
      // Monitor 도구(open 에서 허용) — 권한의 git deny 가 붙지 않으므로 guard 가 git 을 읽기만 통과시킨다
      const mon = { pass: ['until grep -q "exit=" out.log; do sleep 2; done', 'git status --short'].map(c => !decAt(c, 'Monitor')),
        block: ['git commit -am x', 'git add -A', 'git push', `rm -rf "${U}"`, 'git checkout main'].map(c => !!decAt(c, 'Monitor')) };
      R.check('[guard/worker-monitor] Monitor: 기다리기 · git 읽기는 통과, git 쓰기 · worktree 밖 삭제는 막는다', mon.pass.every(Boolean) && mon.block.every(Boolean), JSON.stringify(mon));
      // [PRD R3] 쓰기 소유권 — HARNESS_OWNS 가 있으면 worktree 안이라도 그 밖은 쓰기 · 삭제 · 이동을 막는다(셸 · Edit/Write 도구 모두)
      const keepOwns = process.env.HARNESS_OWNS;
      process.env.HARNESS_OWNS = JSON.stringify(['src/billing/**', 'tests/billing/test_x.py', 'docs']);
      const W3 = wtA.replace(/\\/g, '/');
      const tool = (name, file) => { const keep = ['TEMP', 'TMP', 'TMPDIR'].map(k => [k, process.env[k]]); for (const [k] of keep) process.env[k] = advTmp; try { return G.decide({ tool_name: name, tool_input: { file_path: file }, cwd: wtA }, 'claude', { worker: true }); } finally { for (const [k, v] of keep) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
      const ownPass = [decAt('echo x > src/billing/a.py', 'Bash'), decAt('rm -f src/billing/old.py', 'Bash'), decAt('mv src/billing/a.py src/billing/b.py', 'Bash'),
        decAt(`echo x > "${advTmp.replace(/\\/g, '/')}/run.log"`, 'Bash'), tool('Edit', `${W3}/src/billing/new.py`), tool('Write', `${W3}/docs/guide/readme.md`),
        tool('Write', `${W3}/.harness/t-20261020-000000-aaaa/PLAN.md`), tool('Write', `${W3}/tests/billing/test_x.py`), decAt('Set-Content -Path .\\src\\billing\\c.py -Value x', 'PowerShell')];
      const ownBlock = [decAt('echo x > src/other/a.py', 'Bash'), decAt('rm -rf src', 'Bash'), decAt('mv src/billing/a.py src/shared/a.py', 'Bash'), decAt('rm -rf .', 'Bash'),
        tool('Edit', `${W3}/src/shared/util.py`), tool('Write', `${W3}/tests/billing/test_y.py`), tool('MultiEdit', `${W3}/docsx/a.md`), decAt('Set-Content -Path .\\src\\shared\\c.py -Value x', 'PowerShell')];
      // [2026-10-25 사용 분석] git 이 무시하는 산출물(build/)은 소유 경로 밖이어도 지우고 만든다 · 추적되는 소스는 그대로 막는다
      const exclude = path.join(require('node:child_process').spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: wtA, encoding: 'utf8' }).stdout.trim().replace(/^(?![A-Za-z]:|\/)/, `${wtA}/`), 'info', 'exclude');
      const exclude0 = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null;
      fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.writeFileSync(exclude, `${exclude0 || ''}\nbuild/\n`);
      const ignPass = [decAt('Remove-Item -Recurse -Force build/check', 'PowerShell'), decAt('rm -rf build/sc && mkdir -p build/sc', 'Bash'), tool('Write', `${W3}/build/e2e/run.ps1`)];
      const ignBlock = [decAt('rm -rf src/shared', 'Bash'), decAt('Remove-Item -Recurse -Force src', 'PowerShell')];
      if (exclude0 === null) fs.rmSync(exclude, { force: true }); else fs.writeFileSync(exclude, exclude0);
      if (keepOwns === undefined) delete process.env.HARNESS_OWNS; else process.env.HARNESS_OWNS = keepOwns;
      R.check('[guard/worker-owns] git 이 무시하는 산출물(build/)은 소유 경로 밖이어도 지우고 만든다 · 추적 소스(src)는 막는다', ignPass.every(x => !x) && ignBlock.every(x => x && /소유/.test(x)), JSON.stringify({ p: ignPass.map(x => x && String(x).slice(-70)), b: ignBlock.map(x => !!x) }));
      R.check('[guard/worker-owns] 소유 경로 안 · 하네스 기록 · 임시 폴더는 쓴다(셸 · Edit/Write · PowerShell · 폴더 접두 · 정확한 파일)', ownPass.every(x => !x), JSON.stringify(ownPass.map(x => x && String(x).slice(-80))));
      R.check('[guard/worker-owns] 소유 경로 밖(다른 폴더 · 상위 폴더 삭제 · 밖으로 이동 · worktree 전체 · 이름만 비슷한 폴더)은 막고 이유에 소유 경로를 적는다', ownBlock.every(x => x && /소유/.test(x)), JSON.stringify(ownBlock.map(x => x && String(x).slice(-60))));
      const noOwns = [tool('Edit', `${W3}/src/anything.py`), tool('Write', `${U}/k.txt`)];
      R.check('[guard/worker-owns] 소유 경로가 없으면 worktree 안은 그대로 쓰고 · Edit/Write 도 worktree 밖은 막는다 · 대화형(작업자 아님)은 Edit 를 보지 않는다',
        !noOwns[0] && !!noOwns[1] && !G.decide({ tool_name: 'Write', tool_input: { file_path: `${U}/k.txt` }, cwd: wtA }, 'claude', {}), JSON.stringify(noOwns));
      const gm = (g, p) => G.globRe(g).test(p);
      R.check('[guard/worker-owns] glob: ** 는 아무 깊이(0 포함) · * 는 한 단계 · 글자만이면 그 파일이나 폴더 아래', gm('src/**', 'src/a/b.py') && gm('src/**/x.py', 'src/x.py') && gm('src/**/x.py', 'src/a/b/x.py') && gm('src/*.py', 'src/a.py') && !gm('src/*.py', 'src/a/b.py') && gm('docs', 'docs/a/b.md') && !gm('docs', 'docsx/a.md') && !gm('tests/billing/test_x.py', 'tests/billing/test_y.py'));
      R.check('[guard/worker-fp] 변수를 풀어도 worktree 밖이면 막는다 · docker 의 rm/prune 은 막는다', stillBlock.every(([c, t]) => !!decAt(c, t)), JSON.stringify(stillBlock.map(([c, t]) => [c.slice(0, 50), !!decAt(c, t)])));
    }

    R.check('[격리] 가짜 HOME 에 .claude · .codex 가 생기지 않았다', !fs.existsSync(path.join(home, '.claude')) && !fs.existsSync(path.join(home, '.codex')));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();

function isAll(r) { return r.status === 0 && r.stdout.trim() === ''; }

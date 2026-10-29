'use strict';
// 버그 보고 — 하네스 자체의 결함을 가린(sanitized) 이슈 초안으로. 기본은 미리 채운 이슈 링크 — 사람이 보고 제출한다.
//   [2026-10-13 사용자 지시] 하네스를 쓰는 사람에게 버그가 생기면 dev.harness 저장소에 이슈가 올라오게.
//   공개 저장소다 — 작업 목표 · 프로젝트 경로 · 코드 · 사용자 이름이 새면 안 된다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const B = require('../../harness/lib/bugreport');
const R = makeReporter('버그 보고 — 기록 · 가림 · 묶음 · 이슈 링크');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-bug-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
// 예기치 못한 예외를 일부러 낸다 — 작업 기록은 멀쩡하고(status done) 그 작업의 로그 파일 자리에 폴더가 있으면 cancel 이 로그를 쓰다 EISDIR 로 실패한다.
//   [v7 Light] 예전엔 go 에 없는 작업자 모듈(HARNESS_RUNNER_MODULE)을 줬다 — go 가 빠져 cancel 로 바꿨다. 다시 부를 때마다 함정을 새로 놓는다(같은 서명).
const TID = 't-20261001-000000-abcd';
const trap = r => {
  const T = path.join(r, '.git', 'harness', 'tasks', TID);
  fs.mkdirSync(path.join(T, 'log.jsonl'), { recursive: true });
  fs.writeFileSync(path.join(T, 'task.json'), JSON.stringify({ id: TID, status: 'done' })); fs.rmSync(path.join(T, 'task.json.bak'), { force: true });
  return ['cancel', TID, '--root', r];
};
function repo(name) {
  const d = path.join(base, name); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(d, 'README.md'), '# r\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'i'); return d;
}

(async () => {
  try {
    const user = os.userInfo().username, host = os.hostname();
    const secretPath = process.platform === 'win32' ? 'E:\\고객자료\\현장자료\\ClientProject\\src\\Secret.cs' : '/home/someone/고객자료/ClientProject/src/Secret.cs';
    const harnessFrame = process.platform === 'win32' ? 'C:\\Users\\x\\proj\\harness\\lib\\git.js:184:3' : '/home/x/proj/harness/lib/git.js:184:3';
    const raw = `Error: git commit failed (128): fatal: pathspec '${secretPath}' did not match — ${user}@${host} · mail me@corp.example\n    at commitAll (${harnessFrame})\n    at Object.<anonymous> (${secretPath}:3:1)\n    at node:internal/main/run_main_module:33:47`;
    const s = B.sanitize(raw);
    R.check('[BR-01] 가림: 사용자 경로 · 따옴표 안 · 사용자 이름 · 호스트 · 메일이 없다 — 하네스 파일 경로(harness/lib/git.js)는 남는다',
      !s.includes('ClientProject') && !s.includes('고객자료') && !s.includes('Secret.cs') && !s.includes(user) && !s.includes(host) && !s.includes('corp.example') && /harness\/lib\/git\.js:184/.test(s), s);

    // 기록 · 묶음: 같은 결함이 다른 경로에서 두 번 → 하나 · count 2
    const r1 = repo('r1');
    const mk = p => Object.assign(new Error(`git commit failed (128): fatal: pathspec '${p}' did not match`), { code: 'GIT_FAILED', stack: `Error: git commit failed\n    at commitAll (${harnessFrame})\n    at accept (${harnessFrame.replace('git.js', 'integrate.js')})` });
    B.record(r1, 'task', mk('A/secret1.cs'));
    B.record(r1, 'task', mk('B/other2.cs'));
    const ents = B.collect(r1);
    R.check('[BR-02] 같은 결함(경로만 다름)은 서명 하나로 묶인다 · count 2', ents.length === 1 && ents[0].count === 2 && /^[0-9a-f]{12}$/.test(ents[0].sig), JSON.stringify(ents));

    // 훅 오류 로그도 모은다
    const hdir = path.join(r1, '.git', 'harness'); fs.mkdirSync(hdir, { recursive: true });
    fs.appendFileSync(path.join(hdir, 'hook-errors.log'), JSON.stringify({ at: new Date().toISOString(), hook: 'track', pid: 1, error: `Error: session lock timeout: ${secretPath}.lock\n    at acquireLock (${harnessFrame.replace('lib\\git.js', 'hooks\\_common.js').replace('lib/git.js', 'hooks/_common.js')})` }) + '\n');
    const ents2 = B.collect(r1);
    R.check('[BR-03] hook-errors.log 의 훅 내부 오류도 모은다(가린 채)', ents2.length === 2 && ents2.some(e => e.kind === 'hook:track' && !JSON.stringify(e).includes('ClientProject')), JSON.stringify(ents2).slice(0, 400));

    // 초안 · 링크
    const d = B.draft(ents2[0], { repo: 'ghlee0786/dev.harness', version: '5.x' });
    R.check('[BR-04] 초안: 제목에 서명 · 본문에 판 · OS · Node · 단계 · 링크는 dev.harness 의 issues/new · 길이 상한',
      d.title.includes(ents2[0].sig) && /Node/.test(d.body) && /OS/.test(d.body) && d.url.startsWith('https://github.com/ghlee0786/dev.harness/issues/new?') && d.url.length <= 7500 && !d.body.includes('ClientProject'), d.url.slice(0, 200));
    R.check('[BR-05] 이미 같은 서명의 이슈가 있으면 새 이슈 대신 그 이슈(재발 댓글)로 안내', B.draft(ents2[0], { repo: 'o/r', existing: { html_url: 'https://github.com/o/r/issues/7', number: 7 } }).url === 'https://github.com/o/r/issues/7');

    // CLI: 예기치 못한 예외 → 기록 · "하네스 버그로 보입니다" 안내
    const r2 = repo('r2');
    const c1 = spawnSync(process.execPath, [CLI, ...trap(r2)], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    R.check('[BR-06] CLI 의 예기치 못한 예외 → 결함 기록 · 출력에 report-bug 안내 · exit 1', c1.status === 1 && /report-bug/.test(c1.stdout + c1.stderr) && B.collect(r2).length === 1 && B.collect(r2)[0].code === 'EISDIR', `${c1.status} ${c1.stdout.slice(-300)} ${c1.stderr.slice(-300)}`);
    // 사용자 실수(USAGE)는 결함이 아니다
    const u1 = spawnSync(process.execPath, [CLI, 'accept', '--root', r2], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const u2 = spawnSync(process.execPath, [CLI, 'cancel', '../../x', '--root', r2], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    R.check('[BR-07] 사용자 실수(USAGE — id 없음 · 잘못된 id)는 exit 2 · 기록하지 않는다', u1.status === 2 && u2.status === 2 && B.collect(r2).length === 1 && B.collect(r2)[0].count === 1, `${u1.status} ${u2.status} ${JSON.stringify(B.collect(r2).map(e => [e.code, e.count]))}`);

    // report-bug: 목록 · 링크 · 보냄 표시 · 재발
    const env = { ...process.env, HARNESS_BUG_OFFLINE: '1' };
    const c2 = spawnSync(process.execPath, [CLI, 'report-bug', '--root', r2], { encoding: 'utf8', windowsHide: true, timeout: 60000, env });
    R.check('[BR-08] report-bug: 가린 초안과 이슈 링크를 보여 준다(열지 않음)', c2.status === 0 && /issues\/new\?/.test(c2.stdout) && !c2.stdout.includes(base), c2.stdout.slice(0, 500));
    const sig = B.collect(r2)[0].sig;
    spawnSync(process.execPath, [CLI, 'report-bug', '--root', r2, '--sent', sig], { encoding: 'utf8', windowsHide: true, timeout: 60000, env });
    const c3 = spawnSync(process.execPath, [CLI, 'report-bug', '--root', r2], { encoding: 'utf8', windowsHide: true, timeout: 60000, env });
    R.check('[BR-09] 보냄 표시한 결함은 다시 나오지 않는다', /보고할 하네스 결함이 없다/.test(c3.stdout), c3.stdout.slice(0, 300));
    spawnSync(process.execPath, [CLI, ...trap(r2)], { encoding: 'utf8', windowsHide: true, timeout: 60000, env });
    const c4 = spawnSync(process.execPath, [CLI, 'report-bug', '--root', r2], { encoding: 'utf8', windowsHide: true, timeout: 60000, env });
    R.check('[BR-10] 보낸 뒤 다시 생기면 "재발" 로 다시 보인다', /재발/.test(c4.stdout), c4.stdout.slice(0, 300));

    // ── 자동 발행 — 가짜 GitHub API(이 PC 안) ──
    const http = require('node:http');
    const reqs = []; let openIssue = null;
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
        const body = b ? JSON.parse(b) : null; reqs.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && req.url.startsWith('/search/issues')) return res.end(JSON.stringify({ items: openIssue && decodeURIComponent(req.url).includes(openIssue.sig) ? [openIssue] : [] }));
        if (req.method === 'POST' && /\/issues$/.test(req.url)) { res.statusCode = 201; openIssue = { number: 11, html_url: 'https://github.com/o/r/issues/11', sig: (body.title.match(/\[([0-9a-f]{12})\]$/) || [])[1] }; return res.end(JSON.stringify({ html_url: openIssue.html_url, number: 11 })); }
        if (req.method === 'POST' && /\/comments$/.test(req.url)) { res.statusCode = 201; return res.end('{}'); }
        res.statusCode = 404; res.end('{}');
      });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const apiEnv = { ...process.env, HARNESS_BUG_REPORT: 'on', HARNESS_GITHUB_API: `http://127.0.0.1:${srv.address().port}`, HARNESS_GITHUB_TOKEN: 'fake-token', HARNESS_GITHUB_TOKEN_ONLY_ENV: '1', HARNESS_BUG_REPO: 'o/r' };
    const cliA = (args, env) => new Promise(res => { const c = require('node:child_process').spawn(process.execPath, [CLI, ...args], { env, windowsHide: true }); let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; }); c.on('close', code => res({ code, out })); });
    const r3 = repo('secret-plant-project');
    await cliA(trap(r3), apiEnv);
    const created = reqs.filter(q => q.method === 'POST' && /\/issues$/.test(q.url));
    R.check('[BR-11] 켜져 있고 로그인이 있으면 결함이 생긴 그 실행에서 이슈가 자동으로 올라간다(토큰 · 라벨 auto-report · 가린 본문)',
      created.length === 1 && created[0].auth === 'Bearer fake-token' && created[0].body.labels.includes('auto-report') && !JSON.stringify(created[0].body).includes(base), JSON.stringify(reqs).slice(0, 500));
    await cliA(trap(r3), apiEnv);
    R.check('[BR-12] 같은 결함이 재발하면 새 이슈 대신 열린 이슈에 댓글', reqs.filter(q => q.method === 'POST' && /\/issues$/.test(q.url)).length === 1 && reqs.some(q => /\/issues\/11\/comments$/.test(q.url)), JSON.stringify(reqs.map(q => `${q.method} ${q.url}`)));
    const c13 = await cliA(['report', '--root', r3, '--kind', 'improve', '--title', 'secret-plant-project 에서 accept 보고가 너무 길다', '--body', `C:\\work\\secret-plant-project\\src\\a.cs 를 고칠 때 보고가 40줄이었다`], apiEnv);
    const imp = reqs.filter(q => q.method === 'POST' && /\/issues$/.test(q.url)).pop();
    R.check('[BR-13] 작업자 · 세션의 건의(improve) — 자동으로 올라가고 프로젝트 이름 · 경로는 가린다', /이슈를 올렸다/.test(c13.out) && imp.body.labels.includes('improve') && !JSON.stringify(imp.body).includes('secret-plant-project') && !JSON.stringify(imp.body).includes('a.cs'), JSON.stringify(imp && imp.body).slice(0, 400));
    const before = reqs.length;
    const r4 = repo('r4');
    await cliA(trap(r4), { ...process.env, HARNESS_GITHUB_API: apiEnv.HARNESS_GITHUB_API, HARNESS_GITHUB_TOKEN: 'fake', HARNESS_GITHUB_TOKEN_ONLY_ENV: '1', HARNESS_BUG_REPORT: '' });
    R.check('[BR-14] 원본 저장소(설치 사본이 아님)에서는 기본으로 꺼져 있다 — 테스트 · 개발이 실제 이슈를 올리지 않는다(결함은 기록된다)', reqs.length === before && B.collect(r4).length === 1);
    const c15 = await cliA(['report', '--root', r4], { ...apiEnv, HARNESS_GITHUB_TOKEN: '' });
    R.check('[BR-15] 로그인이 없으면 쌓아 두고 링크로 안내', /GitHub 로그인이 없다/.test(c15.out) && /issues\/new\?/.test(c15.out) && reqs.length === before, c15.out.slice(0, 300));
    const r5 = repo('r5'); fs.writeFileSync(path.join(r5, 'AGENTS.md'), '```yaml\nbug_report: off\n```\n');
    await cliA(trap(r5), apiEnv);
    R.check('[BR-16] 프로젝트 블록 bug_report: off 면 올리지 않는다(결함은 기록된다)', reqs.length === before && B.collect(r5).length === 1);
    srv.close();
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

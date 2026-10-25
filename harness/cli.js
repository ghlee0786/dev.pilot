#!/usr/bin/env node
'use strict';
// 하네스 v5 CLI. 작업 1 = worktree 1 = 브랜치 1 = 세션 1. 사용자 브랜치는 accept 전까지 움직이지 않는다.
//   go/resume/accept/cancel/restore 의 마지막 줄은 기계용 `HARNESS_RESULT {json}`.
//   exit 0 은 done · accepted · cancelled · restored 일 때만. 사용법 오류는 2.
const fs = require('node:fs'), path = require('node:path');

const USAGE = `Pilot — 모델이 조종하고, 하네스는 계기판(검사 기록)과 안전장치(guard · 격리 · 정리)만 맡는다. 설치 폴더 · 명령은 harness/ 그대로.
usage:
  node harness/cli.js go (--goal-file <path> | - | "<goal>") [--check "<cmd>"]... [--runtime claude|codex] [--model M] [--effort E]
                     [--budget-usd N] [--token-budget N] [--wall-min N] [--max-continuations N] [--base <branch>] [--root <repo>] [--init] [--doc <path>]... [--attach <file>]... [--owns <glob>]...
      --goal-file <path>: the goal verbatim from a UTF-8 file · "-": the goal from stdin (no shell quoting of the request)
      --init: create a git repository at --root if there is none (otherwise refused)
      --mode thin|full: thin = the worker plans, tests and records by itself; the harness keeps only the guard, the worktree, cleanup and one run of the checks at the end, recorded for the reviewer (never sent back; worse than before = failed) (default: thin) · full = the old way: baseline before the task, lint and quality send-back, repeated send-backs on failure — or "mode: full" in the project yaml
      --eager-baseline: measure the checks on the base commit before the first turn (default: only when the checks fail afterwards — or "baseline: eager" in the project yaml) · --fresh-baseline: ignore the cached baseline
      --doc <path>: a managed document (docs/prds · docs/coordinations · docs/designs) the worker reads as the specification (repeatable)
      --owns <glob>: the only paths this task may change (repeatable, e.g. --owns "src/billing/**" --owns "tests/billing/**") — the guard blocks writes elsewhere so parallel tasks do not collide
      --attach <file>: give the worker a file with the goal — image · video (frames + transcript) · audio (transcript) · PDF · document (repeatable)
      --allow "<rule>": also let the unattended worker run this, e.g. --allow "Bash(docker build:*)" (repeatable; added to the project
                        block's worker_allow; Tool one of Bash|PowerShell|Read|Edit|Write|WebFetch; git writes · shells · Bash(*) are refused; no effect on Codex)
  node harness/cli.js resume <id> [--allow "<rule>"]... [--budget-usd N] [--token-budget N] [--wall-min N] [--max-continuations N] [--model M] [--effort E] [--fresh-session] [--mode thin|full]
      caps are totals for the whole task (not additions): pass the new total, e.g. --budget-usd 40 after $20 was spent
      a blocked task resumes in the same session: its BLOCKED.md is kept as BLOCKED.<n>.md and the worker is told what you allowed
      --note "<text>" | --note-file <path>: also hand the worker these additional instructions (a done task with new notes can be resumed)
  node harness/cli.js note <id> ("<text>" | --file <path>)   (additional instructions: a running task gets them at its next turn; a stopped or done task when resumed)
      go · resume always run the task in a process detached from this shell and wait for it here — if this shell ends (agent shells have
      time limits), the task keeps going: node harness/cli.js wait <id> prints its report
      --detach (go · resume): return the id at once instead of waiting · --foreground: run in this process (the old way)
  node harness/cli.js wait <id> [--timeout-min N]   (waits until the task is no longer running, then prints its report · exit 3 if still running at the limit)
  node harness/cli.js status [--json]
  node harness/cli.js metrics [--roots "<저장소>;<저장소>…"] [--since YYYY-MM-DD] [--jsonl <out>] [--md <out>] [--json]   (작업 수치 — 비용 · 효율 · 계획 · 시험 · 찌꺼기 · 품질)
  node harness/cli.js insights [--roots "<저장소>;<저장소>…"] [--since YYYY-MM-DD] [--json] [--post]   (사용 분석 — 하네스가 일을 방해한 패턴 · --post 는 가린 개선 이슈로)
  node harness/cli.js profile [--build [--roots "<저장소>;<저장소>…"] [--since YYYY-MM-DD]] [--json]   (사용자 판단 패턴 — 갈림길에서 작업자가 따른다)
  node harness/cli.js accept <id> [--into <branch>] [--force] [--budget-usd N]   (only after the user accepts the result; --force for tasks not 'done')
  node harness/cli.js cancel <id> [--skip-checks]
  node harness/cli.js restore <id> [--skip-checks]
  node harness/cli.js check <id>   (thin 작업의 미룬 검사를 지금 돌려 기록 — 합치지 않는다 · accept 가 그 결과를 쓴다)
  node harness/cli.js gc [--json]
  node harness/cli.js stop <id>                 (the way to stop a running task: ends its process tree, commits work in progress, status interrupted)
  node harness/cli.js push [<remote>] [<branch>] | push [<remote>] --tag <name> [--dry-run]   (only after the user explicitly asks; fast-forward only, never force, never harness/* branches)
  node harness/cli.js cleanup-legacy [--salvage] [--apply] [--json]   (leftovers of earlier harness versions; removes only what loses nothing — --salvage first keeps dirty/unmerged work at tags harness/salvage/* and copies files outside git; dry run unless --apply)
  node harness/cli.js install [--target <repo>] [--track-docs] | uninstall [--target <repo>]
      --track-docs: add a managed .gitignore block so docs/prds · docs/coordinations · docs/designs · docs/README.md are tracked by git
                    (default: .gitignore is left alone and the install report only says whether they are ignored)
  node harness/cli.js doc new <prd|coordination|design> "<title>" [--with <project>] [--direction outgoing|incoming] [--from-file <md>] [--json]
  node harness/cli.js doc list [kind] [--status draft|active|done|superseded] [--json]
  node harness/cli.js doc status <path> <draft|active|done|superseded> [--by <path>]   (superseded needs --by)
  node harness/cli.js doc index | doc check [--json] | doc history <path> [--json] | doc restore <path> <version>
  node harness/cli.js doc adopt <path> [--status draft|active|done] [--with <project>] [--direction outgoing|incoming]   (bring an existing doc under management)
      documents are created only when the user asks; nothing is generated automatically
  node harness/cli.js factory "<request>" | --request-file <path> | - [--jobs N] [--budget-usd N] [--card-budget-usd N] [--max-cards N] [--test-agents N] [--waves N] [--verify] [--check "<cmd>"]... [--mode thin|full] [--base <branch>] [--detach|--foreground]
      split the request into cards (planner agent) · run the cards as parallel tasks with owned paths · merge them one at a time into harness/factory/<id> · then testers (charters) test the merged result, defects reproduced by another agent become fix cards
  node harness/cli.js factory status [<id>] | factory wait <id> | factory stop <id> | factory accept <id>   (accept merges into your branch — only after the user says so)
  node harness/cli.js help
defaults: runtime claude · model opus · budget $20 · wall 120 min · max continuations 8 (with --runtime codex and no --model: Codex's own default model)`;

const VALUE = new Set(['--check', '--runtime', '--model', '--effort', '--budget-usd', '--token-budget', '--wall-min', '--max-continuations', '--root', '--into', '--base', '--target', '--check-timeout-min', '--goal-file',
  '--jobs', '--test-agents', '--waves', '--max-cards', '--card-budget-usd', '--request-file', '--owns', '--doc', '--with', '--direction', '--from-file', '--status', '--by', '--allow', '--attach', '--sent', '--repo', '--kind', '--title', '--body', '--body-file', '--roots', '--since', '--jsonl', '--md', '--tag', '--timeout-min', '--file', '--note', '--note-file', '--transcripts', '--mode']);
const FLAGS = new Set(['--no-verify', '--auto', '--open', '--json', '--help', '-h', '--uninstall', '--dry-run', '--force', '--init', '--skip-checks', '--fresh-baseline', '--apply', '--salvage', '--track-docs', '--detach', '--foreground', '--fresh-session', '--build', '--eager-baseline', '--verify', '--post']);

function parse(argv) {
  const o = { _: [], checks: [], docs: [], allow: [], attach: [], owns: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) { o[a.replace(/^-+/, '')] = true; continue; }
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    const key = eq ? eq[1] : a;
    if (VALUE.has(key)) {
      let v;
      if (eq) v = eq[2]; else { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); v = argv[++i]; }
      if (key === '--check') o.checks.push(v); else if (key === '--owns') o.owns.push(v); else if (key === '--doc') o.docs.push(v); else if (key === '--allow') o.allow.push(v); else if (key === '--attach') o.attach.push(v); else o[key.slice(2)] = v;
      continue;
    }
    if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    o._.push(a);
  }
  const num = (k, min, int) => {
    if (o[k] == null) return undefined;
    const v = Number(o[k]);
    if (!Number.isFinite(v) || !(v > min)) throw new Error(`--${k} must be a number > ${min}`);
    return int ? Math.floor(v) : v;
  };
  if (o.runtime && !['claude', 'codex'].includes(o.runtime)) throw new Error('--runtime must be claude or codex');
  return { ...o, budgetUsd: num('budget-usd', 0), tokenBudget: num('token-budget', 0, true), wallMin: num('wall-min', 0),
    maxContinuations: num('max-continuations', -1, true), checkTimeoutMs: o['check-timeout-min'] != null ? num('check-timeout-min', 0) * 60000 : undefined, freshBaseline: !!o['fresh-baseline'], eagerBaseline: !!o['eager-baseline'] };
}

const OK = new Set(['done', 'accepted', 'cancelled', 'restored', 'checked']);
function resultLine(r) {
  const keep = ['id', 'status', 'reason', 'refused', 'branch', 'commit', 'base_branch', 'checks', 'cost_usd', 'unknown_cost_calls', 'tokens', 'continuations', 'wall_ms', 'files_changed',
    'tests_modified', 'checks_modified', 'secrets_excluded', 'commit_skipped', 'outside_git', 'worktree', 'merge_commit', 'revert_commit', 'task_status', 'docs'];
  const o = {};
  for (const k of keep) if (r[k] !== undefined) o[k] = r[k];
  return `HARNESS_RESULT ${JSON.stringify(o)}`;
}

async function main(argv, io) {
  const out = (io && io.out) || (s => process.stdout.write(s + '\n'));
  const err = (io && io.err) || (s => process.stderr.write(s + '\n'));
  let o;
  try { o = parse(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  const [cmd, ...rest] = o._;
  if (!cmd || cmd === 'help' || o.help || o.h) { out(USAGE); return cmd || o.help || o.h ? 0 : 2; }
  const root = o.root ? path.resolve(o.root) : process.cwd();
  const common = { root, log: err, run: io && io.run, checkTimeoutMs: o.checkTimeoutMs, freshBaseline: o.freshBaseline, eagerBaseline: o.eagerBaseline, mode: o.mode };
  // 자동 갱신 확인(설치된 사본 · 하루 한 번 · 별도 프로세스) — 갱신 · 설치 명령 자신은 빼고. 실패는 조용히.
  if (!['install', 'uninstall', 'update', 'version'].includes(cmd)) { try { require('./lib/autoupdate').maybe(root); } catch { /* 하네스를 멈추지 않는다 */ } }

  if (cmd === 'install' || cmd === 'uninstall') {
    let I;
    try { I = require('./lib/install'); }
    catch (e) { if (e.code === 'MODULE_NOT_FOUND' && /lib[\\/]install/.test(e.message)) { err('harness/lib/install.js is missing — install is not available in this copy'); return 1; } throw e; }
    const fn = cmd === 'uninstall' || o.uninstall ? I.uninstall : I.install;
    if (typeof fn !== 'function') { err(`harness/lib/install.js does not export ${cmd}`); return 1; }
    const r = await fn({ target: o.target ? path.resolve(o.target) : root, source: path.resolve(__dirname, '..'), dryRun: !!o['dry-run'], force: !!o.force, trackDocs: !!o['track-docs'], log: out });
    if (r && typeof r === 'object' && r.report) out(r.report);
    return r && r.ok === false ? 1 : 0;
  }
  if (cmd === 'factory') return factoryCommand(rest, o, root, out, err, io, argv);
  if (cmd === 'doc') return docCommand(rest, o, root, out, err);
  if (cmd === 'push') {
    const Pu = require('./lib/push');
    try {
      const r = Pu.push({ root, remote: rest[0], branch: rest[1], tag: o.tag, dryRun: !!o['dry-run'] });
      out(o.json ? JSON.stringify(r, null, 2) : Pu.format(r));
      return r.ok ? 0 : 1;
    } catch (e) { err(`pilot push: ${e.message}`); return e.code === 'USAGE' ? 2 : 1; }
  }
  if (cmd === 'report' || cmd === 'report-bug') {
    // 하네스 보고 — 동작 이상(bug) · 의도와 다른 행동(intent) · 더 나은 방향(improve). 내용은 하네스 동작만 · 가려서.
    //   report --kind <bug|intent|improve> --title "<한 줄>" [--body "<내용>" | --body-file <파일>] → 기록하고 자동으로 올린다(켜져 있고 로그인이 있으면).
    //   report(인자 없음) → 쌓인 것을 올리고, 못 올린 것은 가린 초안과 이슈 링크로 보여 준다. --open: 링크를 브라우저로 · --sent <서명>: 보냄 표시.
    const Bg = require('./lib/bugreport');
    try {
      if (o.sent) { Bg.markSent(root, o.sent, (Bg.collect(root, { all: true }).find(e => e.sig === o.sent) || {}).count); out(`보냄으로 표시: ${o.sent}`); return 0; }
      if (o.title) {
        const body = o['body-file'] ? fs.readFileSync(path.resolve(o['body-file']), 'utf8') : (o.body || '');
        const e = Bg.note(root, o.kind || 'bug', o.title, body);
        out(`기록했다: [${e.kind}] ${e.message} (서명 ${e.sig})`);
      }
      const a = await Bg.autoReport(root);
      for (const p of a.posted) out(`${p.action === 'comment' ? '재발 댓글을 달았다' : '이슈를 올렸다'}: ${p.url}`);
      if (a.skipped === 'no-auth') out('자동으로 올리지 못했다 — 이 PC 에 GitHub 로그인이 없다(한 번만: `gh auth login` 또는 환경 변수 HARNESS_GITHUB_TOKEN). 아래 링크로 올릴 수 있다.');
      if (a.skipped === 'disabled' && o.title) out('자동 발행이 꺼져 있다(원본 저장소이거나 bug_report: off · HARNESS_BUG_REPORT=off) — 아래 링크로 올릴 수 있다.');
      const list = Bg.collect(root);
      if (!list.length) { out('보고할 하네스 결함이 없다.'); return 0; }
      const repo = o.repo || process.env.HARNESS_BUG_REPO || Bg.DEFAULT_REPO;
      for (const e of list) {
        const d = Bg.draft(e, { repo, existing: await Bg.findExisting(e.sig, repo) });
        out([`── ${e.recurred ? '재발 · ' : ''}${d.title}`, d.existing ? `이미 같은 이슈가 있다(#${d.existing.number}) — 재발을 댓글로 알려 주세요: ${d.url}` : `이슈 링크(열어서 내용을 확인하고 제출): ${d.url}`, '', d.body, ''].join('\n'));
        if (o.open) Bg.openUrl(d.url);
      }
      out(`보낸 뒤: node harness/cli.js report-bug --sent <서명>  (다시 묻지 않는다 · 재발하면 다시 보인다)`);
      return 0;
    } catch (e) { err(`pilot report-bug: ${e.message}`); return 1; }
  }
  if (cmd === 'update' || cmd === 'version') {
    // 배포된 최신 릴리스로 갈아 끼운다(--dry-run 은 비교만) · version 은 지금 판만.
    const U = require('./lib/update');
    if (cmd === 'version') { out(`pilot ${U.currentVersion()}`); return 0; }
    try {
      const r = await U.update({ root, check: !!o['dry-run'], repo: o.repo, auto: !!o.auto }); out(r.report);
      // 자동 갱신(하루 한 번 · 백그라운드) 뒤 사용 분석 — 7일에 한 번 · 갱신이 막 깐 새 판의 모듈로(이 프로세스는 옛 판일 수 있다) · 실패는 조용히
      if (o.auto) { try { const I = require(path.join(root, 'harness', 'lib', 'insights.js')); const a = await I.auto(root); if (a && a.noted && a.noted.length) out(`사용 분석: 발견 ${a.noted.join(', ')} · 올림 ${(a.posted || []).length}건`); } catch { /* 옛 판 · 분석 실패는 갱신과 무관 */ } }
      return r.ok ? 0 : 1;
    }
    catch (e) { err(`pilot update: ${e.message}`); return 1; }
  }
  if (cmd === 'stop') {
    const St = require('./lib/stop');
    try {
      if (!rest[0]) throw Object.assign(new Error('stop needs a task id'), { code: 'USAGE' });
      const r = await St.stop({ root, id: rest[0] });
      out(o.json ? JSON.stringify(r, null, 2) : St.format(r));
      return r.ok ? 0 : 1;
    } catch (e) { err(`pilot stop: ${e.message}`); return e.code === 'USAGE' ? 2 : 1; }
  }
  if (cmd === 'cleanup-legacy') {
    const Lg = require('./lib/legacy');
    try {
      const r = Lg.cleanup({ root, apply: !!o.apply, salvage: !!o.salvage });
      out(o.json ? JSON.stringify(r, null, 2) : Lg.format(r));
      return r.ok ? 0 : 1;
    } catch (e) { err(`pilot cleanup-legacy: ${e.message}`); return 1; }
  }
  // metrics — 작업 기록(지난 작업 포함)에서 수치를 계산해 프로젝트별로 비교한다. --roots 로 여러 저장소를 한 번에(이 PC 안에서만 읽는다).
  if (cmd === 'metrics') {
    const Mt = require('./lib/metrics');
    try {
      const roots = o.roots ? String(o.roots).split(';').map(x => x.trim()).filter(Boolean) : [root];
      const cols = roots.map(r => Mt.collect(path.resolve(r), { since: o.since }));
      if (o.jsonl) fs.writeFileSync(path.resolve(o.jsonl), cols.flatMap(c => [...c.tasks.map(t => JSON.stringify({ kind: 'task', ...t })), ...c.factories.map(x => JSON.stringify({ kind: 'factory', ...x }))]).join('\n') + '\n');
      const md = Mt.toMarkdown(cols);
      if (o.md) fs.writeFileSync(path.resolve(o.md), md);
      out(o.json ? JSON.stringify(cols.map(Mt.summarize), null, 2) : md);
      return 0;
    } catch (e) { err(`pilot metrics: ${e.message}`); return 1; }
  }
  // profile — 사용자 판단 패턴. --build 는 이 PC 의 대화 기록 · 하네스 작업에서 다시 만들어 ~/.harness/profile.json 에 둔다(밖으로 보내지 않는다).
  //   저장된 패턴은 작업 지시의 "갈림길" 규칙에 붙는다 — 작업자가 묻지 않고 이 사용자처럼 고른다.
  if (cmd === 'profile') {
    const Pf = require('./lib/profile');
    try {
      let p;
      if (o.build) {
        const roots = o.roots ? String(o.roots).split(';').map(x => x.trim()).filter(Boolean).map(r => path.resolve(r)) : [root];
        p = Pf.build({ roots, since: o.since, transcripts: o.transcripts });
        const file = Pf.save(p);
        if (!o.json) out(`저장: ${file}`);
      } else {
        p = Pf.load();
        if (!p) { out('판단 패턴이 아직 없습니다 — node harness/cli.js profile --build [--roots "<저장소>;<저장소>…"]'); return 0; }
      }
      out(o.json ? JSON.stringify({ sources: p.sources, tasks: p.tasks, rules: p.rules }, null, 2) : Pf.format(p));
      return 0;
    } catch (e) { err(`pilot profile: ${e.message}`); return 1; }
  }
  // insights — 작업 기록(task.json · log.jsonl)에서 하네스가 일을 방해한 패턴을 찾는다(수치와 분류만). --post 면 가린 개선 이슈로 올린다(bug_report 설정을 따른다).
  if (cmd === 'insights') {
    const I = require('./lib/insights');
    try {
      const roots = o.roots ? String(o.roots).split(';').map(x => x.trim()).filter(Boolean).map(r => path.resolve(r)) : [root];
      const all = roots.map(r => ({ r, a: I.analyze(r, { since: o.since }) }));
      if (o.json) out(JSON.stringify(all.map(x => ({ root: path.basename(x.r), ...x.a, root_path: undefined })), null, 2));
      else for (const x of all) out(`## ${path.basename(x.r)}
${I.format(x.a)}`);
      if (o.post) for (const x of all) { const noted = I.noteFindings(x.r, x.a); const p = await require('./lib/bugreport').autoReport(x.r).catch(() => ({ posted: [] })); out(`${path.basename(x.r)}: 적음 ${noted.length} · 올림 ${(p.posted || []).length}${p.skipped ? ` (${p.skipped})` : ''}`); }
      return 0;
    } catch (e) { err(`pilot insights: ${e.message}`); return 1; }
  }
  if (cmd === 'status' || cmd === 'gc') {
    const St = require('./lib/status');
    try {
      const r = cmd === 'status' ? St.status(common) : St.gc(common);
      out(o.json ? JSON.stringify(r, null, 2) : (cmd === 'status' ? St.formatStatus(r) : St.formatGc(r)));
      return 0;
    } catch (e) { err(`pilot ${cmd}: ${e.message}`); return 1; }
  }

  if (cmd === 'wait') return waitFor(rest[0], o, root, out, err);
  // note <id> ("<지시>" | --file <파일>) — 작업에 사용자 추가 지시를 넣는다. 도는 작업은 다음 턴에, 멈춘 · 끝난 작업은 resume 때 전달된다.
  if (cmd === 'note') {
    const S = require('./lib/state'), L = require('./lib/loop');
    try {
      const id = rest[0];
      if (!S.validId(id)) throw Object.assign(new Error('note needs a task id'), { code: 'USAGE' });
      const text = o.file != null ? fs.readFileSync(path.resolve(o.file), 'utf8') : rest.slice(1).join(' ');
      const main = S.mainRoot(root), t = S.readTask(main, id);
      if (t && ['accepted', 'cancelled', 'restored'].includes(t.status)) throw Object.assign(new Error(`task ${id} is ${t.status} — send the new instructions as a new task (go)`), { code: 'USAGE' });
      L.addNote(main, id, text);
      const live = t && t.status === 'running' && t.owner && S.ownerAlive(t.owner);
      out(live ? `pilot ${id} — 추가 지시를 쌓았다 · 다음 턴에 작업자에게 전달된다(끝나려던 참이면 그것을 반영하는 턴을 한 번 더 돈다)`
        : `pilot ${id} — 추가 지시를 쌓았다 · 작업이 ${t ? t.status : '?'} 이라 이어 갈 때 전달된다: node harness/cli.js resume ${id}`);
      return 0;
    } catch (e) { err(`pilot note: ${e.message}${e.code === 'USAGE' ? `\n${USAGE}` : ''}`); return e.code === 'USAGE' ? 2 : 1; }
  }
  // [2026-10-16 실측] 갱신 전에 시작한 세션은 옛 안내대로 go 를 셸 안에서 돌려 셸의 시간 상한에 작업이 함께 죽었다 — 안내에 기대지 않는다:
  //   go · resume 은 늘 분리된 프로세스에서 돌고(detach), 부른 쪽은 끝날 때까지 기다려 보고를 낸다. 그 프로세스 자신은 이 표시로 안다(손자에게 물려주지 않는다).
  //   이 프로세스에서 도는 경우: 이미 분리된 프로세스 · 테스트가 러너를 주입함(io.run) · --foreground · 저장소가 아직 없음(go --init).
  const detachedChild = process.env.HARNESS_DETACHED_CHILD === '1';
  delete process.env.HARNESS_DETACHED_CHILD;
  const canDetach = () => {
    if (detachedChild || (io && io.run) || o.foreground) return false;
    try { require('./lib/state').mainRoot(root); return true; } catch { return false; }
  };

  // task id 는 진입점에서 형식을 강제한다(L5) — `resume ..\..\x` 같은 경로가 상태 디렉터리 밖을 가리키지 않게.
  const needId = () => {
    const id = rest[0];
    if (!id) throw Object.assign(new Error(`${cmd} needs a task id`), { code: 'USAGE' });
    if (!require('./lib/state').validId(id)) throw Object.assign(new Error(`invalid task id: ${JSON.stringify(id).slice(0, 80)} (expected t-yyyymmdd-HHMMss-xxxx)`), { code: 'USAGE' });
    return id;
  };
  const caps = { budgetUsd: o.budgetUsd, tokenBudget: o.tokenBudget, wallMin: o.wallMin, maxContinuations: o.maxContinuations, model: o.model, effort: o.effort };
  let r;
  try {
    if (cmd === 'go') {
      // 목표 원문(L6): --goal-file <path> · `go -`(stdin) · 인자. 셸을 거친 인자는 따옴표·$()·백틱이 망가뜨릴 수 있다 — 스킬은 파일을 쓴다.
      // \uBD84\uB9AC\uB41C \uD504\uB85C\uC138\uC2A4\uB294 \uBD80\uBAA8\uAC00 \uAC80\uC99D\uD574 \uD30C\uC77C\uB85C \uB118\uAE34 \uBAA9\uD45C\uB97C \uC4F4\uB2E4(stdin \uC774 \uC5C6\uB2E4).
      const handedGoal = detachedChild ? process.env.HARNESS_GOAL_FILE : null;
      delete process.env.HARNESS_GOAL_FILE;
      let goal;
      if (handedGoal) {
        try { goal = fs.readFileSync(handedGoal, 'utf8'); } catch (e) { err(`cannot read the goal: ${e.message}`); return 2; }
      } else {
        const fromStdin = rest.length === 1 && rest[0] === '-';
        const sources = [o['goal-file'] != null, fromStdin, !fromStdin && rest.length > 0].filter(Boolean).length;
        if (sources > 1) { err(`go takes the goal from one place: --goal-file, "-" (stdin) or the arguments\n${USAGE}`); return 2; }
        try {
          if (o['goal-file'] != null) goal = fs.readFileSync(path.resolve(o['goal-file']), 'utf8');
          else if (fromStdin) goal = (io && typeof io.stdin === 'string') ? io.stdin : fs.readFileSync(0, 'utf8');
          else goal = rest.join(' ');
        } catch (e) { err(`cannot read the goal: ${e.message}`); return 2; }
      }
      goal = String(goal).replace(/^\uFEFF/, '').trim();
      if (!goal) { err(`go needs a goal\n${USAGE}`); return 2; }
      if (canDetach()) return detach(cmd, argv, require('./lib/state').newId(), goal, root, out, err, !o.detach);
      if (o.detach && !detachedChild && !(io && io.run)) { err('--detach needs an existing git repository \u2014 run go --init once without --detach'); return 2; }
      // --doc 경로는 부른 곳(cwd) 기준 — 루프는 저장소 상대로 바꿔 기록한다.
      // --detach 가 띄운 프로세스는 부모가 정한 id 를 쓴다(부모가 그 id 로 시작을 확인한다). 손자 프로세스에 물려주지 않는다.
      const S = require('./lib/state'), presetId = S.validId(process.env.HARNESS_TASK_ID) ? process.env.HARNESS_TASK_ID : undefined;
      delete process.env.HARNESS_TASK_ID;
      r = await require('./lib/loop').go({ ...common, ...caps, id: presetId, goal, checks: o.checks, runtime: o.runtime, base: o.base, init: !!o.init, docs: o.docs.map(p => path.resolve(p)), allow: o.allow, attach: o.attach.map(p => path.resolve(p)), owns: o.owns });
    } else if (cmd === 'resume') {
      const id = needId();
      // resume --note "<지시>" | --note-file <파일> — 이어 가며 전달할 추가 지시(분리된 프로세스를 띄우기 전에 쌓는다).
      if (!detachedChild && (o.note != null || o['note-file'] != null)) {
        const S = require('./lib/state');
        require('./lib/loop').addNote(S.mainRoot(root), id, o['note-file'] != null ? fs.readFileSync(path.resolve(o['note-file']), 'utf8') : o.note);
      }
      if (canDetach()) return detach(cmd, argv, id, null, root, out, err, !o.detach);
      r = await require('./lib/loop').resume({ ...common, ...caps, id, allow: o.allow, freshSession: !!o['fresh-session'] });
    }
    else if (cmd === 'accept') r = await require('./lib/integrate').accept({ ...common, id: needId(), into: o.into, budgetUsd: o.budgetUsd, force: !!o.force });
    else if (cmd === 'cancel') r = await require('./lib/integrate').cancel({ ...common, id: needId(), skipChecks: !!o['skip-checks'] });
    else if (cmd === 'restore') r = await require('./lib/integrate').restore({ ...common, id: needId(), skipChecks: !!o['skip-checks'] });
    else if (cmd === 'check') r = await require('./lib/integrate').check({ ...common, id: needId() });
    else { err(`unknown command: ${cmd}\n${USAGE}`); return 2; }
  } catch (e) {
    if (e.code === 'USAGE') { err(`${e.message}\n${USAGE}`); return 2; }
    // 예기치 못한 예외 = 하네스 결함일 수 있다 — 가려서 기록하고 보고 방법을 알린다(없는 작업 · 잠금 같은 운영 오류는 빼고).
    const bug = !['UNKNOWN_TASK', 'LOCK_HELD'].includes(e.code) && require('./lib/bugreport').record(root, 'cli', e);
    r = { id: rest[0] || null, status: 'error', reason: `${e.code ? e.code + ': ' : ''}${e.message}`, report: `pilot error: ${e.stack || e.message}${bug ? `\n하네스 결함으로 보입니다(서명 ${bug.sig}) — 내용을 확인하고 보고하려면: node harness/cli.js report-bug` : ''}` };
  }
  // 쌓인 하네스 보고를 자동으로 올린다(설치된 사본 · 로그인이 있을 때만 · 실패는 조용히).
  try { const a = await require('./lib/bugreport').autoReport(root); for (const p of a.posted) err(`[pilot] 하네스 보고를 올렸다: ${p.url}`); } catch { /* 보고가 작업을 멈추지 않는다 */ }
  out(r.report || `pilot ${r.id} — ${r.status}${r.reason ? ': ' + r.reason : ''}`);
  out(resultLine(r));
  return !r.refused && OK.has(r.status) ? 0 : 1;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// go · resume — 작업을 이 셸과 분리된 프로세스로 띄우고, 그 프로세스가 작업을 잡은 것을 확인한다.
//   waitAfter(기본): 끝날 때까지 기다려 보고를 낸다 — 이 프로세스가 죽어도(셸의 시간 상한) 작업은 계속되고 wait <id> 로 다시 받는다.
//   --detach: 잡은 것만 확인하고 id 를 바로 돌려준다.
//   [2026-10-02 · 2026-10-15 실측] 세션이 go 를 백그라운드 셸로 띄우면 셸의 시간 상한(Claude Code 30분)에 작업이 함께 죽어
//   running · 주인 없음으로 남았다(그 뒤 resume · 남은 worktree 문제로 번졌다). 출력은 <git-common-dir>/harness/detached/<id>.log.
async function detach(cmd, argv, id, goal, root, out, err, waitAfter) {
  const S = require('./lib/state');
  const main = S.mainRoot(root);
  const dir = path.join(S.paths(main).harnessDir, 'detached');
  fs.mkdirSync(dir, { recursive: true });
  const args = argv.filter(a => a !== '--detach');
  const env = { ...process.env, HARNESS_DETACHED_CHILD: '1' };
  if (cmd === 'go') {
    // 목표는 부모가 검증한 그대로 파일로 넘긴다(분리된 프로세스에는 stdin 이 없다 · 인자의 목표는 무시된다).
    env.HARNESS_TASK_ID = id;
    env.HARNESS_GOAL_FILE = path.join(dir, `${id}.goal.txt`);
    fs.writeFileSync(env.HARNESS_GOAL_FILE, goal);
  }
  const logFile = path.join(dir, `${id}.log`);
  const fd = fs.openSync(logFile, 'a');
  const { spawn } = require('node:child_process');
  const c = spawn(process.execPath, [__filename, ...args], { cwd: process.cwd(), env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  let exited = null;
  c.on('exit', code => { exited = code; });
  c.unref();
  // 그 프로세스가 작업을 잡을 때까지(running · 주인 = 그 pid) — 먼저 끝나면(사용법 오류 · 거부 · 아주 짧은 작업) 그 출력을 그대로 전한다.
  for (const until = Date.now() + 120000; Date.now() < until;) {
    const t = S.readTask(main, id);
    if (t && t.status === 'running' && t.owner && t.owner.pid === c.pid) {
      if (waitAfter) {
        err(`[pilot] ${id} — 분리된 프로세스(pid ${c.pid})에서 실행 중 — 이 셸이 끝나도 작업은 계속된다(다시 받기: node harness/cli.js wait ${id} · 로그 ${logFile})`);
        return waitFor(id, {}, root, out, err, logFile);
      }
      out(`pilot ${id} — 분리된 프로세스(pid ${c.pid})에서 실행 중 · 로그 ${logFile}\n  끝날 때까지 기다려 보고 받기: node harness/cli.js wait ${id} · 멈추기: node harness/cli.js stop ${id}`);
      out(resultLine({ id, status: 'running' }));
      return 0;
    }
    if (exited !== null) {
      let log = ''; try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* 없음 */ }
      (exited === 0 ? out : err)(log.trim() || `pilot ${id} — the detached process exited (${exited}) before starting the task`);   // 사용법 오류 · 거부는 stderr 로(그 자리에서 돌 때처럼)
      return exited === 0 ? 0 : (exited || 1);
    }
    await sleep(200);
  }
  err(`pilot ${id} — the detached process (pid ${c.pid}) has not started the task after 2 minutes; see ${logFile}`);
  return 1;
}

// wait <id> — 작업이 끝날 때까지(running 이 아니게 될 때까지) 기다렸다가 보고를 낸다. 이 명령이 죽어도 작업은 계속된다.
async function waitFor(id, o, root, out, err, logFile) {
  const S = require('./lib/state'), L = require('./lib/loop');
  if (!S.validId(id)) { err(`wait needs a task id\n${USAGE}`); return 2; }
  const main = S.mainRoot(root);
  const limitMin = o['timeout-min'] != null ? Number(o['timeout-min']) : Infinity;
  const until = Date.now() + (Number.isFinite(limitMin) && limitMin >= 0 ? limitMin * 60000 : Infinity);
  // 분리된 프로세스의 진행 줄([pilot] …)을 그대로 흘려 보낸다 — 셸 안에서 돌던 때처럼 진행이 보이게. 끝난 줄까지만 읽는다.
  let pos = 0;
  const pump = () => {
    if (!logFile) return;
    try {
      const b = fs.readFileSync(logFile), nl = b.lastIndexOf(0x0a);
      if (nl < pos) return;
      // 진행 줄 머리: [pilot](v6.1~) · [harness](그 전 판이 띄운 작업)
      for (const l of b.slice(pos, nl + 1).toString('utf8').split(/\r?\n/)) if (l.startsWith('[pilot]') || l.startsWith('[harness]')) err(l);
      pos = nl + 1;
    } catch { /* 로그가 아직 없다 */ }
  };
  for (;;) {
    pump();
    const t = S.readTask(main, id);
    if (!t) { err(`unknown task: ${id}`); return 1; }
    if (!(t.status === 'running' && t.owner && S.ownerAlive(t.owner))) {
      if (t.status === 'running') {
        out(`pilot ${id} — running · OWNER DEAD: the process running it is gone. Continue it: node harness/cli.js resume ${id} --detach`);
        out(resultLine({ ...L.result(t), status: 'running', reason: 'owner dead' }));
        return 1;
      }
      const r = L.result(t);
      out(L.report(t, S.taskPaths(main, id)));
      out(resultLine(r));
      return OK.has(t.status) ? 0 : 1;
    }
    if (Date.now() >= until) {
      out(`pilot ${id} — still running · wait again: node harness/cli.js wait ${id}`);
      out(resultLine({ id, status: 'running' }));
      return 3;
    }
    await sleep(2000);
  }
}

// doc <sub> — 관리 문서(prd · coordination · design). 사용자가 요청할 때만 만든다. 사용법 오류 2 · 그 밖의 실패 1 · check 문제 1.
function docCommand(rest, o, root, out, err) {
  const D = require('./lib/docs');
  const [sub, ...args] = rest;
  // 경로 인자: 부른 곳 기준으로 있으면 그것, 아니면 저장소 루트 기준(docRel 이 푼다).
  const p = x => (x != null && fs.existsSync(path.resolve(x)) ? path.resolve(x) : x);
  const json = x => out(JSON.stringify(x, null, 2));
  try {
    if (sub === 'new') {
      const [kind, ...title] = args;
      if (!kind) throw Object.assign(new Error('doc new needs a kind and a title'), { code: 'USAGE' });
      const r = D.newDoc({ root, kind, title: title.join(' '), with: o.with, direction: o.direction, fromFile: o['from-file'] });
      if (o.json) json(r);
      else {
        out(`만들었다: ${r.path}`);
        out(r.tracking === 'git' ? '  git 이 추적한다 — 커밋은 직접 한다.' : r.tracking === 'ignored' ? `  git 이 무시하는 경로다 — 로컬 전용(바꿀 때마다 이전 판이 ${D.historyRoot(require('./lib/state').mainRoot(root))} 에 남는다).` : '  아직 git 에 없다(추적 안 됨) — 필요하면 직접 add · commit 한다.');
        if (r.index_changed) out(`  색인 갱신: ${D.INDEX_REL}`);
      }
      return 0;
    }
    if (sub === 'list') {
      const rows = D.list(root, { kind: args[0], status: o.status });
      out(o.json ? JSON.stringify(rows, null, 2) : D.formatList(rows));
      return 0;
    }
    if (sub === 'status') {
      if (args.length !== 2) throw Object.assign(new Error('doc status needs <path> <status>'), { code: 'USAGE' });
      const r = D.setStatus({ root, path: p(args[0]), status: args[1], by: o.by != null ? p(o.by) : undefined });
      if (o.json) json(r); else out(`${r.path}: ${r.from || '?'} → ${r.to}${r.by ? ` (대체: ${r.by})` : ''}${r.index_changed ? ` · 색인 갱신: ${D.INDEX_REL}` : ''}`);
      return 0;
    }
    if (sub === 'adopt') {
      if (args.length !== 1) throw Object.assign(new Error('doc adopt needs <path>'), { code: 'USAGE' });
      const r = D.adopt({ root, path: p(args[0]), status: o.status, with: o.with, direction: o.direction });
      if (o.json) json(r); else out(`관리에 넣었다: ${r.path} (${r.kind} · ${r.status} · ${r.title})${r.index_changed ? ` · 색인 갱신: ${D.INDEX_REL}` : ''}`);
      return 0;
    }
    if (sub === 'index') {
      const r = D.writeIndex(root);
      if (o.json) json(r); else out(r.changed ? `색인 갱신: ${r.path}` : `색인 그대로: ${r.path}`);
      return 0;
    }
    if (sub === 'check') {
      const r = D.check(root);
      out(o.json ? JSON.stringify(r, null, 2) : D.formatCheck(r));
      return r.ok ? 0 : 1;
    }
    if (sub === 'history') {
      if (args.length !== 1) throw Object.assign(new Error('doc history needs <path>'), { code: 'USAGE' });
      const r = D.history(root, p(args[0]));
      if (o.json) json(r);
      else out(r.length ? r.map(v => `${v.version}  ${v.bytes}B  ${v.at}`).join('\n') : '이력 없음');
      return 0;
    }
    if (sub === 'restore') {
      if (args.length !== 2) throw Object.assign(new Error('doc restore needs <path> <version>'), { code: 'USAGE' });
      const r = D.restore(root, p(args[0]), args[1]);
      if (o.json) json(r); else out(`복원: ${r.path} ← ${r.restored}${r.saved ? ` (바꾸기 전 판은 ${r.saved} 로 보관)` : ''}`);
      return 0;
    }
    err(`unknown doc command: ${sub || '(none)'}\n${USAGE}`);
    return 2;
  } catch (e) {
    if (e.code === 'USAGE') { err(`${e.message}\n${USAGE}`); return 2; }
    err(`pilot doc ${sub}: ${e.message}`);
    return 1;
  }
}

module.exports = { main, parse, USAGE };

if (require.main === module) {
  // 할 일을 마쳤는데 남은 핸들(작업자가 띄운 하위 프로세스의 파이프 · 타이머)이 프로세스를 붙들면 끝나지 않는다 — 출력이 다 나갈 시간을 두고 끝낸다.
  //   [2026-10-20 실측 · 평가] 분리된 go 가 작업이 done 으로 끝나고 24분 넘게 살아 worktree 파일을 붙들었다(작업공간 삭제 실패).
  const exitSoon = () => setTimeout(() => process.exit(process.exitCode), 3000).unref();
  main(process.argv.slice(2)).then(code => { process.exitCode = code; exitSoon(); }, e => { process.stderr.write((e && e.stack || String(e)) + '\n'); process.exitCode = 1; exitSoon(); });
}

// factory — 공장 총괄(PRD R4). 시작은 go 처럼 분리된 프로세스에서(셸의 시간 상한에 함께 죽지 않게) · 부른 쪽은 끝날 때까지 기다린다(--detach 면 바로).
async function factoryCommand(rest, o, root, out, err, io, argv) {
  const F = require('./lib/factory'), S = require('./lib/state');
  let main; try { main = S.mainRoot(root); } catch (e) { err(e.message); return 1; }
  const sub = rest[0];
  const needFid = id => { if (!F.FID_RE.test(String(id || ''))) throw Object.assign(new Error(`expected a factory run id f-yyyymmdd-HHMMss-xxxx, got ${JSON.stringify(id)}`), { code: 'USAGE' }); return id; };
  try {
    if (sub === 'status') { const r = rest[1] ? F.readRun(main, needFid(rest[1])) : null; out(rest[1] ? (r ? F.report(main, r) : `unknown factory run: ${rest[1]}`) : F.status(main)); return 0; }
    if (sub === 'stop') { const r = F.requestStop(main, needFid(rest[1])); out(`pilot factory ${r.id} — ${r.status}: ${r.reason}`); return 0; }
    if (sub === 'accept') { const r = F.accept({ root: main, fid: needFid(rest[1]) }); out(r.report); return r.refused ? 1 : 0; }
    if (sub === 'wait') return factoryWait(main, needFid(rest[1]), o, out, err, null);
  } catch (e) { if (e.code === 'USAGE') { err(`${e.message}\n${USAGE}`); return 2; } err(e.message); return 1; }
  const child = process.env.HARNESS_DETACHED_CHILD === '1' && F.FID_RE.test(process.env.HARNESS_FACTORY_ID || '');
  // [자동 이슈 #44 #45] go 와 같이 --goal-file · "-"(stdin) 도 받는다 — 전에는 --goal-file 을 버리고 "-" 를 요청 본문으로 써서 빈 회차를 띄웠다.
  let request;
  const srcFile = o['request-file'] != null ? o['request-file'] : o['goal-file'], fromStdin = rest.length === 1 && rest[0] === '-';
  if (!child && [srcFile != null, fromStdin, !fromStdin && rest.length > 0].filter(Boolean).length > 1) { err(`factory takes the request from one place: --request-file (--goal-file), "-" (stdin) or the arguments\n${USAGE}`); return 2; }
  try {
    if (child) request = fs.readFileSync(process.env.HARNESS_FACTORY_REQUEST, 'utf8');
    else if (srcFile != null) request = fs.readFileSync(path.resolve(srcFile), 'utf8');
    else if (fromStdin) request = (io && typeof io.stdin === 'string') ? io.stdin : fs.readFileSync(0, 'utf8');
    else request = rest.join(' ');
  } catch (e) { err(`cannot read the request: ${e.message}`); return 2; }
  request = String(request || '').replace(/^\uFEFF/, '').trim();
  if (!request) { err(`factory needs a request\n${USAGE}`); return 2; }
  const opts = { root: main, request, jobs: o.jobs != null ? Number(o.jobs) : undefined, budgetUsd: o['budget-usd'] != null ? Number(o['budget-usd']) : undefined,
    cardBudgetUsd: o['card-budget-usd'] != null ? Number(o['card-budget-usd']) : undefined, maxCards: o['max-cards'] != null ? Number(o['max-cards']) : undefined,
    base: o.base, model: o.model, runtime: o.runtime, mode: o.mode, checks: o.checks.length ? o.checks : undefined, run: io && io.run, log: m => err(m),
    verify: !!o.verify && !o['no-verify'], testAgents: o['test-agents'] != null ? Number(o['test-agents']) : undefined, waves: o.waves != null ? Number(o.waves) : undefined };
  for (const k of ['jobs', 'budgetUsd', 'cardBudgetUsd', 'maxCards']) if (opts[k] != null && !(opts[k] > 0)) { err(`--${k} must be a number > 0`); return 2; }
  if (child || (io && io.run) || o.foreground) {
    const fid = child ? process.env.HARNESS_FACTORY_ID : undefined;
    delete process.env.HARNESS_DETACHED_CHILD; delete process.env.HARNESS_FACTORY_ID; delete process.env.HARNESS_FACTORY_REQUEST;
    let r; try { r = await F.start({ ...opts, fid }); } catch (e) { err(e.message); return e.code === 'USAGE' ? 2 : 1; }
    out(r.report); out(resultLine(r));
    return ['done', 'partial'].includes(r.status) ? 0 : 1;
  }
  // 분리 실행
  const fid = require('./lib/state').newId().replace(/^t-/, 'f-'), dir = path.join(S.paths(main).harnessDir, 'factory');
  fs.mkdirSync(dir, { recursive: true });
  const reqFile = path.join(dir, `${fid}.request.txt`), logFile = path.join(dir, `${fid}.log`);
  fs.writeFileSync(reqFile, request);
  const fd = fs.openSync(logFile, 'a');
  const { spawn } = require('node:child_process');
  const c = spawn(process.execPath, [__filename, ...argv.filter(a => a !== '--detach')], { cwd: process.cwd(), env: { ...process.env, HARNESS_DETACHED_CHILD: '1', HARNESS_FACTORY_ID: fid, HARNESS_FACTORY_REQUEST: reqFile }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  let exited = null; c.on('exit', code => { exited = code; }); c.unref();
  for (const until = Date.now() + 120000; Date.now() < until;) {
    const r = F.readRun(main, fid);
    if (r && r.owner && r.owner.pid === c.pid) {
      if (o.detach) { out(`pilot factory ${fid} — 분리된 프로세스(pid ${c.pid})에서 실행 중 · 로그 ${logFile}\n  기다려 보고 받기: node harness/cli.js factory wait ${fid} · 멈추기: node harness/cli.js factory stop ${fid}`); return 0; }
      err(`[pilot] factory ${fid} — 분리된 프로세스(pid ${c.pid})에서 실행 중 — 이 셸이 끝나도 계속된다(다시 받기: node harness/cli.js factory wait ${fid})`);
      return factoryWait(main, fid, o, out, err, logFile);
    }
    if (exited !== null) { let log = ''; try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* 없음 */ } (exited === 0 ? out : err)(log.trim() || `pilot factory ${fid} — exited (${exited}) before starting`); return exited || 1; }
    await sleep(200);
  }
  err(`pilot factory ${fid} — the detached process (pid ${c.pid}) has not started after 2 minutes; see ${logFile}`);
  return 1;
}
async function factoryWait(main, fid, o, out, err, logFile) {
  const F = require('./lib/factory'), S = require('./lib/state');
  logFile = logFile || path.join(S.paths(main).harnessDir, 'factory', `${fid}.log`);
  const limitMin = o['timeout-min'] != null ? Number(o['timeout-min']) : Infinity, until = Date.now() + (Number.isFinite(limitMin) ? limitMin * 60000 : Infinity);
  let pos = 0;
  for (;;) {
    try { const b = fs.readFileSync(logFile), nl = b.lastIndexOf(0x0a); if (nl >= pos) { for (const l of b.slice(pos, nl + 1).toString('utf8').split(/\r?\n/)) if (l.startsWith('[pilot]') || l.startsWith('[harness]')) err(l); pos = nl + 1; } } catch { /* 아직 없음 */ }
    const r = F.readRun(main, fid);
    if (!r) { err(`unknown factory run: ${fid}`); return 1; }
    if (r.status !== 'running' || !S.ownerAlive(r.owner)) {
      if (r.status === 'running') { out(`pilot factory ${fid} — running · OWNER DEAD`); return 1; }
      out(F.report(main, r)); out(resultLine({ id: fid, status: r.status, reason: r.reason }));
      return ['done', 'partial', 'accepted'].includes(r.status) ? 0 : 1;
    }
    if (Date.now() >= until) { out(`pilot factory ${fid} — still running · wait again: node harness/cli.js factory wait ${fid}`); return 3; }
    await sleep(2000);
  }
}

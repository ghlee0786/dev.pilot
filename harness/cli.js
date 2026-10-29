#!/usr/bin/env node
'use strict';
// Pilot CLI (v7 — Light). 하네스는 맨 모델 + git + 격리 · 병합 + 세션 간 조율 + 안전 가드레일만 맡는다 — 일은 모델과 Claude Code · Codex 가 한다.
//   레인(start) 1 = worktree 1 = 브랜치 1. 사용자 브랜치는 accept · batch accept 전까지 움직이지 않는다.
//   start · accept · cancel · restore · check · batch 의 마지막 줄은 기계용 `HARNESS_RESULT {json}`. 사용법 오류는 2.
const fs = require('node:fs'), path = require('node:path');

const USAGE = `Pilot — 코드는 모델이 쓰고, 하네스는 여러 세션이 한 저장소를 함께 쓸 때의 안전(guard) · 격리(레인) · 합치기(검사 한 번) · 정리만 맡는다. 설치 폴더 · 명령은 harness/ 그대로.
usage:
  node harness/cli.js start ("<short goal>" | --goal-file <path> | -) [--base <branch>] [--from <id>] [--check "<cmd>"]... [--check-timeout-min <n>] [--root <repo>] [--json]
      a lane: a worktree + branch harness/<id> (+ a port block) to work in — open a session in that folder and commit as you go; the checks run once at accept
      the goal: a short one as a quoted argument; long text or text with quotes · $ · backticks in a file (--goal-file) — the shell rewrites them
      --from <id>: continue that task from its branch instead of starting over
  node harness/cli.js status [--json]   (lanes · tasks · live sessions · overlapping files · uncommitted changes by owner)
  node harness/cli.js accept <id> [--into <branch>] [--force] [--check-timeout-min <n>]   (task ids only · only after the user says so — runs the checks once and refuses only what got worse)
  node harness/cli.js batch [<id>...] [--all] [--branch <name>]... [--into <branch>] [--check "<cmd>"]... [--force] [--json]   (lanes a live session still works in are skipped unless --force · merge finished work — lanes or any branch, e.g. a background session's — into harness/batch/<bid> and run the checks once — your branch is untouched)
  node harness/cli.js batch accept <bid> [--force] | batch status [<bid>] | batch drop <bid> [--force]   (batch accept merges into your branch — only after the user says so)
  node harness/cli.js check <id> [--force]   (run the checks now and record them — merges nothing)
  node harness/cli.js cancel <id> [--skip-checks] [--force] | restore <id> [--skip-checks]   (revert a merge · bring it back)
      check · cancel refuse while a live session works inside that lane's worktree — --force only after the user says so
  node harness/cli.js push [<remote>] [<branch>] | push [<remote>] --tag <name> [--dry-run]   (only after the user explicitly asks; fast-forward only, never force, never harness/* branches)
  node harness/cli.js gc [--json]   (remove finished work: worktrees · processes · containers · temp folders · ports — only the harness's own)
  node harness/cli.js toolkit [--json]   (skills · MCP · plugins that fit this repository: present · missing · to watch — read only)
  node harness/cli.js report --kind <bug|intent|improve> --title "<one line>" [--body "<text>" | --body-file <path>] [--repo <owner/name>] | report-bug [--open] [--sent <sig>]
  node harness/cli.js install [--target <repo>] [--dry-run] [--force] [--migrate] | uninstall [--target <repo>] | update [--dry-run] [--migrate] [--repo <owner/name>] | version
      install · update refuse while the harness is working (a live owner · task records or lane sessions active in the last 20 min · a checks/merge/task lock)
      and while unfinished v6 tasks remain — --migrate writes how to continue each one (start --from <id> · claude --resume) and then installs
  node harness/cli.js help
unattended work: a Claude Code background session in its own worktree (claude --bg -w <name> "<goal>"), then batch --branch <its branch> → batch accept <bid>
  — the harness no longer runs its own worker (go · factory were removed in v7)`;

// [2026-10-29 감사] --owns 는 v7 에서 아무것도 막지 않았다(기록만) — 강제하던 guard 작업자 모드와 함께 뺐다.
const VALUE = new Set(['--check', '--base', '--from', '--branch', '--into', '--root', '--target', '--goal-file', '--tag', '--check-timeout-min', '--kind', '--title', '--body', '--body-file', '--sent', '--repo']);
const FLAGS = new Set(['--json', '--help', '-h', '--uninstall', '--dry-run', '--force', '--skip-checks', '--all', '--open', '--auto', '--migrate']);
// v7 에서 뺀 명령 — 부르면 무엇으로 바뀌었는지 알린다(옛 안내를 따르는 세션이 있다)
const REMOVED = { go: 'start "<goal>" (a lane you work in) · unattended: claude --bg -w <name> "<goal>" then batch --branch <branch>', resume: 'start --from <id>', wait: 'status', note: 'start --from <id>', stop: 'claude agents (stop the session)',
  factory: 'several lanes (start) + batch', metrics: null, insights: null, profile: null, doc: null, 'cleanup-legacy': 'gc' };

function parse(argv) {
  const o = { _: [], checks: [], branches: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) { o[a.replace(/^-+/, '')] = true; continue; }
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    const key = eq ? eq[1] : a;
    if (VALUE.has(key)) {
      let v;
      if (eq) v = eq[2]; else { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); v = argv[++i]; }
      if (key === '--check') o.checks.push(v); else if (key === '--branch') o.branches.push(v); else o[key.slice(2)] = v;
      continue;
    }
    if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    o._.push(a);
  }
  let checkTimeoutMs;
  if (o['check-timeout-min'] != null) { const v = Number(o['check-timeout-min']); if (!(v > 0)) throw new Error('--check-timeout-min must be a number > 0'); checkTimeoutMs = v * 60000; }
  return { ...o, checkTimeoutMs };
}

const OK = new Set(['done', 'open', 'accepted', 'cancelled', 'restored', 'checked']);
function resultLine(r) {
  const keep = ['id', 'status', 'reason', 'refused', 'mode', 'branch', 'commit', 'base_branch', 'checks', 'cost_usd', 'outside_git', 'worktree', 'merge_commit', 'revert_commit', 'task_status',
    'ports', 'continues', 'related', 'verdict', 'target', 'members', 'failed_tests'];
  const o = {};
  for (const k of keep) if (r[k] !== undefined) o[k] = r[k];
  return `HARNESS_RESULT ${JSON.stringify(o)}`;
}

// 하네스 결함 보고 — [2026-10-29 사용자 요청] "버그 · 이슈는 자동으로 GitHub 에" 를 모든 명령에서. 예기치 못한 예외만 기록한다(운영 오류는 결함이 아니다).
//   예전엔 accept · cancel · restore · check 만 기록 · 발행했다 — start · batch · status · gc · toolkit 의 예외는 출력만 하고 사라졌다.
const OPERATIONAL = new Set(['USAGE', 'UNKNOWN_TASK', 'LOCK_HELD', 'NOT_A_REPO', 'NOT_WORKTREE_ROOT', 'PORTS_EXHAUSTED']);
function recordBug(root, e) {
  if (!e || OPERATIONAL.has(e.code)) return null;
  try { return require('./lib/bugreport').record(root, 'cli', e); } catch { return null; }
}
const bugHint = bug => (bug ? `\n하네스 결함으로 보입니다(서명 ${bug.sig}) — 내용을 확인하고 보고하려면: node harness/cli.js report-bug` : '');
// 끝에 쌓인 보고(기록된 결함 · hook-errors.log)를 올린다 — 설치된 사본 · 로그인이 있을 때만 · 실패는 조용히.
const NO_POST = new Set(['install', 'uninstall', 'update', 'version', 'report', 'report-bug']);
async function autoPost(root, err) {
  try { const a = await require('./lib/bugreport').autoReport(root); for (const p of a.posted) err(`[pilot] 하네스 보고를 올렸다: ${p.url}`); } catch { /* 보고가 작업을 멈추지 않는다 */ }
}

async function main(argv, io) {
  const out = (io && io.out) || (s => process.stdout.write(s + '\n'));
  const err = (io && io.err) || (s => process.stderr.write(s + '\n'));
  let o;
  try { o = parse(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  const [cmd, ...rest] = o._;
  if (!cmd || cmd === 'help' || o.help || o.h) { out(USAGE); return cmd || o.help || o.h ? 0 : 2; }
  if (Object.prototype.hasOwnProperty.call(REMOVED, cmd)) { err(`pilot ${cmd}: removed in v7 (Light)${REMOVED[cmd] ? ` — use ${REMOVED[cmd]}` : ''}\n${USAGE}`); return 2; }
  const root = o.root ? path.resolve(o.root) : process.cwd();
  // 자동 갱신 확인(설치된 사본 · 하루 한 번 · 별도 프로세스) — 갱신 · 설치 명령 자신은 빼고. 실패는 조용히.
  if (!['install', 'uninstall', 'update', 'version'].includes(cmd)) { try { require('./lib/autoupdate').maybe(root); } catch { /* 하네스를 멈추지 않는다 */ } }
  const code = await dispatch(cmd, rest, o, root, out, err, io);
  if (!NO_POST.has(cmd)) await autoPost(root, err);
  return code;
}

async function dispatch(cmd, rest, o, root, out, err, io) {
  const common = { root, log: err, checkTimeoutMs: o.checkTimeoutMs };
  if (cmd === 'install' || cmd === 'uninstall') {
    let I;
    try { I = require('./lib/install'); }
    catch (e) { if (e.code === 'MODULE_NOT_FOUND' && /lib[\\/]install/.test(e.message)) { err('harness/lib/install.js is missing — install is not available in this copy'); return 1; } throw e; }
    const fn = cmd === 'uninstall' || o.uninstall ? I.uninstall : I.install;
    const r = await fn({ target: o.target ? path.resolve(o.target) : root, source: path.resolve(__dirname, '..'), dryRun: !!o['dry-run'], force: !!o.force, migrate: !!o.migrate, log: out });
    if (r && typeof r === 'object' && r.report) out(r.report);
    return r && r.ok === false ? 1 : 0;
  }
  if (cmd === 'start' || cmd === 'batch') return lightCommand(cmd, rest, o, root, out, err, io);
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
      const r = await U.update({ root, check: !!o['dry-run'], repo: o.repo, auto: !!o.auto, migrate: !!o.migrate }); out(r.report);
      return r.ok ? 0 : 1;
    }
    catch (e) { err(`pilot update: ${e.message}`); return 1; }
  }
  // toolkit — 이 저장소 스택에 맞는 스킬 · MCP · 플러그인 점검(설치된 것 · 없는 것 · 주의할 것). 읽기만 한다.
  if (cmd === 'toolkit') {
    try { const T = require('./lib/toolkit'), r = T.check({ root }); out(o.json ? JSON.stringify(r, null, 2) : T.format(r)); return 0; }
    catch (e) { err(`pilot toolkit: ${e.message}${bugHint(recordBug(root, e))}`); return 1; }
  }
  if (cmd === 'status' || cmd === 'gc') {
    const St = require('./lib/status');
    try {
      const r = cmd === 'status' ? St.status(common) : St.gc(common);
      out(o.json ? JSON.stringify(r, null, 2) : (cmd === 'status' ? St.formatStatus(r) : St.formatGc(r)));
      return 0;
    } catch (e) { err(`pilot ${cmd}: ${e.message}${bugHint(recordBug(root, e))}`); return 1; }
  }

  // task id 는 진입점에서 형식을 강제한다(L5) — `accept ..\..\x` 같은 경로가 상태 디렉터리 밖을 가리키지 않게.
  const needId = () => {
    const id = rest[0];
    if (!id) throw Object.assign(new Error(`${cmd} needs a task id`), { code: 'USAGE' });
    if (!require('./lib/state').validId(id)) throw Object.assign(new Error(`invalid task id: ${JSON.stringify(id).slice(0, 80)} (expected t-yyyymmdd-HHMMss-xxxx)`), { code: 'USAGE' });
    return id;
  };
  let r;
  try {
    if (cmd === 'accept') r = await require('./lib/integrate').accept({ ...common, id: needId(), into: o.into, force: !!o.force });
    // [2026-10-29] cancel · check 는 레인 worktree 안에서 산 세션이 일하는 중이면 거부한다 — --force 로만 넘는다(integrate 가 판단)
    else if (cmd === 'cancel') r = await require('./lib/integrate').cancel({ ...common, id: needId(), skipChecks: !!o['skip-checks'], force: !!o.force });
    else if (cmd === 'restore') r = await require('./lib/integrate').restore({ ...common, id: needId(), skipChecks: !!o['skip-checks'] });
    else if (cmd === 'check') r = await require('./lib/integrate').check({ ...common, id: needId(), force: !!o.force });
    else { err(`unknown command: ${cmd}\n${USAGE}`); return 2; }
  } catch (e) {
    if (e.code === 'USAGE') { err(`${e.message}\n${USAGE}`); return 2; }
    // 예기치 못한 예외 = 하네스 결함일 수 있다 — 가려서 기록하고 보고 방법을 알린다(없는 작업 · 잠금 같은 운영 오류는 빼고).
    const bug = recordBug(root, e);
    r = { id: rest[0] || null, status: 'error', reason: `${e.code ? e.code + ': ' : ''}${e.message}`, report: `pilot error: ${e.stack || e.message}${bugHint(bug)}` };
  }
  // 쌓인 하네스 보고는 main 이 끝에 올린다(autoPost)
  out(r.report || `pilot ${r.id} — ${r.status}${r.reason ? ': ' + r.reason : ''}`);
  out(resultLine(r));
  return !r.refused && OK.has(r.status) ? 0 : 1;
}

async function lightCommand(cmd, rest, o, root, out, err, io) {
  const show = r => { out(o.json ? JSON.stringify({ ...r, report: undefined }, null, 2) : r.report); if (!o.json) out(resultLine(r)); };
  try {
    if (cmd === 'start') {
      // 목표 원문: --goal-file <path> · "-"(stdin) · 인자 — go 와 같다
      const fromStdin = rest.length === 1 && rest[0] === '-';
      if ([o['goal-file'] != null, fromStdin, !fromStdin && rest.length > 0].filter(Boolean).length > 1) throw Object.assign(new Error('start takes the goal from one place: --goal-file, "-" (stdin) or the arguments'), { code: 'USAGE' });
      let goal;
      try {
        if (o['goal-file'] != null) goal = fs.readFileSync(path.resolve(o['goal-file']), 'utf8');
        else if (fromStdin) goal = (io && typeof io.stdin === 'string') ? io.stdin : fs.readFileSync(0, 'utf8');
        else goal = rest.join(' ');
      } catch (e) { err(`cannot read the goal: ${e.message}`); return 2; }
      const r = require('./lib/lane').start({ root, goal, base: o.base, from: o.from, checks: o.checks, checkTimeoutMs: o.checkTimeoutMs, log: err });
      show(r);
      return r.status === 'open' ? 0 : 1;
    }
    const B = require('./lib/batch'), sub = rest[0];
    let r;
    if (sub === 'accept') r = await B.accept({ root, bid: rest[1], force: !!o.force });
    else if (sub === 'drop') r = B.drop({ root, bid: rest[1], force: !!o.force });
    else if (sub === 'status') { const s = B.status({ root, bid: rest[1] }); out(o.json ? JSON.stringify(s.batches, null, 2) : s.report); return 0; }
    // [2026-10-29] 산 세션이 일하는 레인은 묶지 않는다(batch 가 판단) — --force 로만 넘는다
    else r = await B.create({ root, ids: rest, all: !!o.all, branches: o.branches, into: o.into, checks: o.checks, checkTimeoutMs: o.checkTimeoutMs, force: !!o.force, log: err });
    show(r);
    if (r.refused) return 1;
    if (sub === 'accept' || sub === 'drop') return 0;
    return ['pass', 'not-worse'].includes(r.verdict) ? 0 : 1;
  } catch (e) {
    if (e.code === 'USAGE') { err(`${e.message}\n${USAGE}`); return 2; }
    err(`pilot ${cmd}: ${e.code ? e.code + ': ' : ''}${e.message}${bugHint(recordBug(root, e))}`);
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

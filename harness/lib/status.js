'use strict';
// v5 status · gc — 작업 목록(주인 생존) · 겹침(두 작업이 같은 파일을 바꿈) · 메인 체크아웃의 미커밋 변경을 주인별로.
//   주인 없는 변경은 목록만 보인다 — 지우거나 커밋하지 않는다.
const fs = require('node:fs'), path = require('node:path');
const S = require('./state'), G = require('./git');

const FINAL = new Set(['accepted', 'cancelled']);
// 끝나지 않은 v6 작업 — 주인이 죽었어도 이어 갈 작업이다(start --from). install.js 의 V6_OPEN 과 같다.
const V6_OPEN = new Set(['running', 'interrupted', 'capped', 'stalled', 'blocked', 'failed', 'error']);
const norm = f => { const p = String(f).replace(/\\/g, '/').replace(/^\.\//, ''); return S.IS_WIN ? p.toLowerCase() : p; };

// 작업이 일하는 worktree — 옆 경로(task.worktree_alt · <id>-2)로 옮겼으면 그곳
const wtOf = t => t.worktree_alt || t.worktree;
function taskFiles(root, t, has) {
  const files = new Set();
  if (t.base_commit && t.branch && (has ? has(t.branch) : G.branchExists(root, t.branch))) for (const f of G.diffNames(root, t.base_commit, t.branch)) files.add(f);
  const wt = wtOf(t);
  if (wt && fs.existsSync(wt)) for (const e of G.dirtyFiles(wt)) files.add(e.path);
  return [...files].filter(f => !f.startsWith('.harness/'));
}
// 브랜치 있음 — refs/heads/harness/ 를 한 번에 읽는다. [2026-10-29 감사] 끝난 작업마다 git 을 띄워 작업 200개에 7.5초가 걸렸다.
function branchSet(root) {
  const r = G.git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/harness/'], { allowFail: true });
  const set = new Set(r.ok ? r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : []);
  return b => !!b && (set.has(b) || (!/^harness\//.test(b) && G.branchExists(root, b)));
}
// 끝난(accepted · cancelled) 작업은 최근 것만 보인다 — 작업 기록은 지우지 않으므로 그대로 두면 끝없이 늘어난다.
const FINISHED_SHOW = 10;

function status(o) {
  const root = S.mainRoot((o && o.root) || process.cwd());
  const now = Date.now();
  const has = branchSet(root);
  const all = S.listTasks(root);
  const finished = all.filter(t => FINAL.has(t.status)).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const shownFinished = new Set(finished.slice(0, FINISHED_SHOW).map(t => t.id));
  const tasks = all.filter(t => !FINAL.has(t.status) || shownFinished.has(t.id)).map(t => {
    const running = t.status === 'running';
    const alive = running && S.ownerAlive(t.owner);
    const files = FINAL.has(t.status) ? [] : taskFiles(root, t, has);
    const hb = t.owner && t.owner.heartbeat_at ? Date.parse(t.owner.heartbeat_at) : null;
    return { id: t.id, status: t.status, mode: t.mode || null, reason: t.reason || '', goal: String(t.goal || '').split(/\r?\n/)[0].slice(0, 100), runtime: t.runtime,
      owner: t.owner ? { pid: t.owner.pid, host: t.owner.host, alive, heartbeat_at: t.owner.heartbeat_at || null, heartbeat_age_s: hb ? Math.round((now - hb) / 1000) : null } : null,
      stale: running && !alive, branch: t.branch, branch_exists: has(t.branch), base_branch: t.base_branch,
      files_changed: files.length, files, cost_usd: t.spent ? t.spent.cost_usd : 0, worktree: wtOf(t) && fs.existsSync(wtOf(t)) ? wtOf(t) : null,
      merge_commit: t.merge_commit || null, updated_at: t.updated_at };
  });
  // 겹침: 끝나지 않은(병합·취소 전) 작업들이 같은 파일을 바꿈.
  const byFile = new Map();
  for (const t of tasks) {
    if (FINAL.has(t.status) || !t.branch_exists) continue;
    for (const f of t.files) { const k = norm(f); if (!byFile.has(k)) byFile.set(k, { file: f, tasks: [] }); byFile.get(k).tasks.push(t.id); }
  }
  const overlaps = [...byFile.values()].filter(x => x.tasks.length > 1).sort((a, b) => a.file.localeCompare(b.file));
  // 메인 체크아웃의 미커밋 변경 → 세션별 · 주인 없음.
  const main = G.mainWorktree(root);
  const dirty = G.dirtyFiles(main).map(e => e.path).filter(f => !f.startsWith('.harness-worktrees/'));
  // 다른 worktree(가벼운 길)에서 일하는 세션의 파일은 그 worktree 의 상대 경로다 — 메인 체크아웃의 같은 이름 파일을 그 세션 것으로 잡지 않는다.
  const Ch = require('../hooks/_common');
  const where = new Map(Ch.listSessions(S.paths(root).commonDir).map(s => [String(s.session_id), s.root || null]));
  const sessions = S.readSessions(root).filter(s => { const r = where.get(String(s.session_id)); return !r || Ch.samePath(r, main); });
  const bySession = [], owned = new Set();
  for (const s of sessions) {
    const mine = new Set(s.files.map(norm));
    const files = dirty.filter(f => mine.has(norm(f)));
    if (!files.length) continue;
    files.forEach(f => owned.add(f));
    bySession.push({ session_id: s.session_id, runtime: s.runtime, updated_at: s.updated_at, files });
  }
  const unowned = dirty.filter(f => !owned.has(f));
  // 출력 언어 — 저장소 블록 reply_language(부른 체크아웃 · 메인), 없으면 지정 없음(영어). [2026-10-13] 결과가 영어로 나온다는 보고.
  let language = null; try { const K = require('./checks'); language = K.yamlString(main, 'reply_language') || K.yamlString(root, 'reply_language'); } catch { /* 블록 없음 */ }
  // 비용은 v7 이전 무인 작업자가 기록한 것뿐이다 — 레인(light)에는 모델 비용을 쓰는 하네스 프로세스가 없다(늘 $0.00 이던 줄을 뺀다).
  const cost_total = Math.round(tasks.reduce((a, t) => a + (t.mode === 'light' ? 0 : Number(t.cost_usd) || 0), 0) * 100) / 100;
  return { root, checkout: main, branch: G.currentBranch(main), language, cost_total, tasks: tasks.map(({ files, ...t }) => t), finished_hidden: finished.length - shownFinished.size,
    v6: v6Tasks(root, all), broken: S.listBrokenTasks(root), overlaps, uncommitted: { by_session: bySession, unowned },
    board: board(root, tasks, now) };
}

// v6 무인 작업(mode thin · full · 없음)으로 끝나지 않은 것 — 이어 가는 명령(레인으로 받기 · 작업자의 대화 그대로 이어 가기).
//   [2026-10-29 사용자 요구] 사용자는 작업자의 대화를 잃으면 안 된다 — start --from <id> 가 그 worktree 를 그대로 레인으로 받는다.
function v6Tasks(root, all) {
  const Ln = require('./lane');
  return all.filter(t => t.mode !== 'light' && !FINAL.has(t.status) && !(t.status === 'running' && S.ownerAlive(t.owner))).map(t => {
    const wt = S.taskPathsFor(root, t).wt, has = fs.existsSync(wt);
    return { id: t.id, status: t.status, mode: t.mode || null, goal: String(t.goal || '').split(/\r?\n/)[0].slice(0, 100), worktree: has ? wt : null, resume: has ? Ln.resumeInfo(t, wt) : null };
  });
}
function v6Lines(s, ko) {
  const v = s.v6 || [], L = [];
  if (!v.length) return L;
  L.push(ko ? `v6 작업 — 이어 가기 (${v.length}):` : `v6 tasks — continue (${v.length}):`);
  for (const t of v.slice(0, V6_SHOW)) {
    L.push(`  ${t.id}  ${t.status}${t.mode ? ` (${t.mode})` : ''} — ${t.goal}`);
    L.push(`    node harness/cli.js start --from ${t.id} "<${ko ? '목표' : 'goal'}>"   ${t.worktree ? (ko ? '(그 worktree 를 그대로 레인으로 받는다)' : '(adopts its worktree as a lane, in place)') : (ko ? '(worktree 가 없다 — 그 브랜치에서 새 레인)' : '(no worktree — a new lane from its branch)')}`);
    if (t.resume && t.resume.command) {
      L.push(`    ${t.resume.command}   ${ko ? '(작업자의 대화를 그대로 이어 간다)' : "(continues the worker's conversation)"}`);
      const moved = require('./lane').movedNote(t.resume, t.worktree, ko);
      if (moved) L.push(`    ${moved}`);
    }
    else if (t.worktree) L.push(`    cd "${t.worktree}"   ${ko ? '(대화 기록을 찾지 못했다)' : '(no conversation transcript found)'}`);
  }
  if (v.length > V6_SHOW) L.push(ko ? `  … ${v.length - V6_SHOW}개 더(status --json 의 v6)` : `  … ${v.length - V6_SHOW} more (v6 in status --json)`);
  return L;
}
const V6_SHOW = 20;

// 게시판 — 대화형 세션(세션 파일 그대로: root · branch · goal · last_seen · ended_at)과 가벼운 길(mode light).
//   산 세션의 첫 근거는 플랫폼 목록(`claude agents --json` · _common.platformAgents · 30초 캐시) — 이름(예: proj-34) · busy/idle.
//   state: busy|idle(목록에 있음) · live|quiet(목록 없음 · Codex — last_seen 30분 안/밖) · ended(SessionEnd) · gone(목록에 없는데 SessionEnd 도 없음 — 꺼졌다).
//   ended · gone 은 1시간 뒤 숨긴다. quiet 는 하루 뒤 숨긴다.
const ENDED_SHOW_MS = 3600 * 1000, LIVE_MS = 30 * 60 * 1000, SILENT_HIDE_MS = 24 * 3600 * 1000;
function board(root, tasks, now) {
  let Ch = null, raw = [];
  try { Ch = require('../hooks/_common'); raw = Ch.listSessions(S.paths(root).commonDir); } catch { raw = []; }
  const cand = raw.filter(s => Date.parse(s.last_seen || '') || Date.parse(s.ended_at || ''));   // 게시판 이전의 기록(파일 목록만)은 미커밋 분류에만 쓴다
  // 보일 만한 Claude 세션이 있을 때만 플랫폼에 묻는다
  let agents = null;
  if (Ch && cand.some(s => (s.runtime || 'claude') === 'claude' && !(Date.parse(s.ended_at || '') && now - Date.parse(s.ended_at) > ENDED_SHOW_MS))) {
    try { agents = Ch.platformAgents(S.paths(root).commonDir); } catch { agents = null; }
  }
  const sessions = [];
  // 예전 판이 거르지 않고 저장한 첫 요청(토큰 · 비밀번호)이 남아 있을 수 있다 — 보일 때도 가린다
  let mask = x => x; try { mask = require('../hooks/board').maskSecrets || mask; } catch { /* 없는 판 */ }
  for (const s of cand) {
    const seen = Date.parse(s.last_seen || ''), ended = Date.parse(s.ended_at || '');
    const a = Ch.agentOf(s, agents), byPlatform = Array.isArray(agents) && (s.runtime || 'claude') === 'claude';
    const state = a ? (a.status === 'busy' || a.status === 'idle' ? a.status : 'live') : ended ? 'ended' : byPlatform ? 'gone' : seen && now - seen <= LIVE_MS ? 'live' : 'quiet';
    if (state === 'ended' && now - ended > ENDED_SHOW_MS) continue;
    if (state === 'gone' && (!seen || now - seen > ENDED_SHOW_MS)) continue;
    if (state === 'quiet' && (!seen || now - seen > SILENT_HIDE_MS)) continue;
    sessions.push({ session_id: s.session_id, sid8: String(s.session_id).replace(/[^A-Za-z0-9]/g, '').slice(0, 8), runtime: s.runtime || null, root: s.root || null, branch: s.branch || null,
      goal: mask(String(s.goal || '')).split(/\r?\n/)[0].slice(0, 100), last_seen: s.last_seen || null, age_s: seen ? Math.round((now - seen) / 1000) : null, ended_at: s.ended_at || null,
      live: !!a || state === 'live', state, name: a ? a.name : null, pid: a ? a.pid : null });
  }
  sessions.sort((a, b) => (b.live - a.live) || ((a.age_s == null ? Infinity : a.age_s) - (b.age_s == null ? Infinity : b.age_s)));
  const lanes = tasks.filter(t => t.mode === 'light' && !FINAL.has(t.status)).map(t => ({ id: t.id, status: t.status, branch: t.branch, worktree: t.worktree || S.taskPaths(root, t.id).wt, goal: t.goal }));
  return { liveness: Array.isArray(agents) ? 'platform' : 'last_seen', sessions, lanes };
}
const ageText = (s, ko) => s == null ? '?' : s < 90 ? (ko ? `${s}초` : `${s}s`) : s < 5400 ? (ko ? `${Math.round(s / 60)}분` : `${Math.round(s / 60)}m`) : (ko ? `${Math.round(s / 3600)}시간` : `${Math.round(s / 3600)}h`);
function boardLines(s, ko) {
  const b = s.board || { sessions: [], lanes: [] }, L = [];
  if (b.sessions.length) {
    L.push(ko ? `세션 (${b.sessions.length}):` : `sessions (${b.sessions.length}):`);
    const WORD = ko ? { live: '활동 중', quiet: '조용함', ended: '끝남', gone: '사라짐(플랫폼 목록에 없음)' } : { gone: 'gone (not in the platform list)' };
    for (const x of b.sessions) {
      const st = x.state || (x.ended_at ? 'ended' : x.live ? 'live' : 'quiet');
      L.push(`  ${x.sid8}${x.name ? ` ${x.name}` : ''}${x.runtime ? ` (${x.runtime})` : ''} ${WORD[st] || st} · ${ko ? '마지막' : 'seen'} ${ageText(x.age_s, ko)}${ko ? ' 전' : ' ago'} · ${x.root || '?'} · ${x.branch || (ko ? '분리된 HEAD' : 'detached')}${x.goal ? ` — ${x.goal}` : ''}`);
    }
  }
  if (b.lanes.length) {
    L.push(ko ? `가벼운 길 (${b.lanes.length}):` : `light lanes (${b.lanes.length}):`);
    for (const x of b.lanes) L.push(`  ${x.id}  ${x.status} · ${x.worktree} · ${x.branch || `harness/${x.id}`}${x.goal ? ` — ${x.goal}` : ''}`);
  }
  return L;
}

// 레인에는 비용이 없다 — v7 이전 무인 작업이 기록한 비용(0 보다 클 때)만 보인다
const costText = t => (t.mode !== 'light' && Number(t.cost_usd) > 0 ? ` · $${Number(t.cost_usd).toFixed(2)}` : '');
function formatStatusKo(s) {
  const L = [`저장소: ${s.root} (${s.branch || 'detached HEAD'})`];
  if (!s.tasks.length) L.push('작업: 없음');
  else {
    L.push(`작업 (${s.tasks.length}):`);
    for (const t of s.tasks) {
      // [2026-10-25] 주인이 죽은 running 은 상태 칸부터 DEAD — 무엇이 실제로 도는지 한눈에.
      const dead = t.status === 'running' && !(t.owner && t.owner.alive);
      const own = t.status === 'running' ? (dead ? ` (running · 주인 프로세스${t.owner ? ` pid ${t.owner.pid}` : ''} 없음${t.owner && t.owner.heartbeat_age_s != null ? ` · 마지막 신호 ${t.owner.heartbeat_age_s}초 전` : ''}) — 아무것도 돌지 않는다 · start --from ${t.id} 로 이어 가거나 cancel 하세요` : ` · 실행 중 pid ${t.owner.pid}(신호 ${t.owner.heartbeat_age_s}초 전)`) : '';
      L.push(`  ${t.id}  ${dead ? 'DEAD' : t.status}${own} · ${t.branch}${t.branch_exists ? '' : ' (없음)'} · 파일 ${t.files_changed}개${costText(t)} — ${t.goal}`);
    }
    if (s.finished_hidden) L.push(`  … 끝난(accepted · cancelled) 작업 ${s.finished_hidden}개는 줄였다(최근 ${FINISHED_SHOW}개만 보인다)`);
    if (s.cost_total > 0) L.push(`누적 비용(v7 이전 무인 작업): $${Number(s.cost_total).toFixed(2)}`);
  }
  L.push(...v6Lines(s, true));
  L.push(...boardLines(s, true));
  for (const b of s.broken || []) L.push(`  ${b.id}  손상 — task.json 을 읽을 수 없다(${b.task_file}) · 기록: ${b.log} — ${b.goal}`);
  if (s.overlaps.length) {
    L.push('겹침(열린 작업 둘 이상이 같은 파일을 바꿨다 — 두 번째를 들일 때 충돌한다):');
    for (const o of s.overlaps) L.push(`  ! ${o.file} — ${o.tasks.join(', ')}`);
  }
  const u = s.uncommitted;
  if (!u.by_session.length && !u.unowned.length) L.push(`${s.checkout} 의 미커밋 변경: 없음`);
  else {
    L.push(`${s.checkout} 의 미커밋 변경:`);
    for (const x of u.by_session) L.push(`  세션 ${String(x.session_id).slice(0, 8)}${x.runtime ? ` (${x.runtime})` : ''}: ${x.files.join(', ')}`);
    if (u.unowned.length) L.push(`  주인을 모름(보여 주기만 — 하네스는 커밋하거나 지우지 않는다): ${u.unowned.join(', ')}`);
  }
  return L.join('\n');
}
function formatStatus(s) {
  if (s.language === 'Korean') return formatStatusKo(s);
  const L = [`repository: ${s.root} (on ${s.branch || 'detached HEAD'})`];
  if (!s.tasks.length) L.push('tasks: none');
  else {
    L.push(`tasks (${s.tasks.length}):`);
    for (const t of s.tasks) {
      const dead = t.status === 'running' && !(t.owner && t.owner.alive);
      const own = t.status === 'running' ? (dead ? ` (running · OWNER DEAD: ${t.owner ? `pid ${t.owner.pid} is gone` : 'no owner recorded'}${t.owner && t.owner.heartbeat_age_s != null ? `, last heartbeat ${t.owner.heartbeat_age_s}s ago` : ''}) — nothing is running it; continue it with start --from ${t.id} or cancel it` : ` · owner pid ${t.owner.pid} alive (heartbeat ${t.owner.heartbeat_age_s}s ago)`) : '';
      L.push(`  ${t.id}  ${dead ? 'DEAD' : t.status}${own} · ${t.branch}${t.branch_exists ? '' : ' (gone)'} · ${t.files_changed} files${costText(t)} — ${t.goal}`);
    }
    if (s.finished_hidden) L.push(`  … ${s.finished_hidden} more finished (accepted · cancelled) tasks not shown (the latest ${FINISHED_SHOW} are)`);
    if (s.cost_total > 0) L.push(`spent by pre-v7 unattended tasks: $${Number(s.cost_total).toFixed(2)}`);
  }
  L.push(...v6Lines(s, false));
  L.push(...boardLines(s, false));
  for (const b of s.broken || []) L.push(`  ${b.id}  BROKEN — task.json cannot be read (${b.task_file}) · its log: ${b.log} — ${b.goal}`);
  if (s.overlaps.length) {
    L.push('overlaps (the same file changed by more than one open task — integrating the second will conflict):');
    for (const o of s.overlaps) L.push(`  ! ${o.file} — ${o.tasks.join(', ')}`);
  }
  const u = s.uncommitted;
  if (!u.by_session.length && !u.unowned.length) L.push(`uncommitted changes in ${s.checkout}: none`);
  else {
    L.push(`uncommitted changes in ${s.checkout}:`);
    for (const x of u.by_session) L.push(`  session ${String(x.session_id).slice(0, 8)}${x.runtime ? ` (${x.runtime})` : ''}: ${x.files.join(', ')}`);
    if (u.unowned.length) L.push(`  no known owner (listed only; the harness never commits or deletes them): ${u.unowned.join(', ')}`);
  }
  return L.join('\n');
}

// ── git 밖 변경 ────────────────────────────────────────────────────────
// worktree 의 무시된(gitignore) 파일 중 .worktreeinclude 복사분(복사 때와 같은 내용)이 아닌 것 — worktree 를 지우면 함께 사라지고
// git 으로 되살릴 수 없다. include: task.worktree_include([{path, sha1}]); 목록에 없는 경로는 메인 체크아웃의 같은 파일과 비교한다.
const EXPAND_MAX = 2000;
function listFiles(wt, rel, acc) {
  let ents = []; try { ents = fs.readdirSync(path.join(wt, rel), { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (acc.length > EXPAND_MAX) return acc;
    const r = rel ? `${rel.replace(/\/$/, '')}/${e.name}` : e.name;
    if (e.isDirectory()) listFiles(wt, r, acc); else acc.push(r);
  }
  return acc;
}
function ignoredChanged(root, wt, include) {
  const inc = new Map((include || []).map(x => [norm(x.path), x.sha1]));
  let rootInc = null;
  const copyOnly = rel => {
    const h = G.sha1(path.join(wt, rel));
    if (!h) return false;
    if (inc.has(norm(rel))) return inc.get(norm(rel)) === h;
    if (!rootInc) rootInc = new Set(G.worktreeIncludeFiles(root).map(norm));
    return rootInc.has(norm(rel)) && G.sha1(path.join(root, rel)) === h;
  };
  // 1차 목록은 git.js 의 ignoredChanges(복사 기록과 같은 내용이면 뺌)가 있으면 그것 — 여기서는 폴더를 펼치고
  //   기록이 없는 worktree(임시 revert · 손으로 만든 것)를 위해 메인 체크아웃의 같은 파일과 한 번 더 비교한다.
  const cand = typeof G.ignoredChanges === 'function' ? G.ignoredChanges(wt, include || [])
    : G.statusEntries(wt, { ignored: true }).filter(e => e.code === '!!').map(e => e.path);
  const out = [];
  for (const p of cand) {
    if (!p.endsWith('/')) { if (!copyOnly(p)) out.push(p); continue; }
    const files = listFiles(wt, p, []);
    if (files.length > EXPAND_MAX) { out.push(p); continue; }   // 너무 크다 — 폴더째 "바뀜" 으로 본다
    for (const f of files) if (!copyOnly(f)) out.push(f);
  }
  return out;
}
const ignoredWhy = files => `ignored files changed (outside git; removing the worktree would delete them): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` … (+${files.length - 10})` : ''} — copy what you need, then remove it with git worktree remove --force`;

// 작업 worktree 를 지워도 되면 지우고 {ok:true}, 아니면 {ok:false, why}. 무시된 파일이 바뀌었으면 남긴다.
function removeIfSafe(root, wt, include) {
  const ign = fs.existsSync(wt) ? ignoredChanged(root, wt, include) : [];
  if (ign.length) return { ok: false, why: ignoredWhy(ign), ignored: ign };
  const rm = G.removeWorktree(root, wt);
  return rm.ok ? { ok: true } : { ok: false, why: rm.error };
}

const ID_PREFIX_RE = /^(t-\d{8}-\d{6}-[0-9a-f]{4})-/;
// gc: 끝난 작업의 깨끗한 worktree 제거 · 더러운 것 · git 밖 파일이 바뀐 것 · 통합 중인 것(산 잠금)은 남김 · 죽은 잠금 해제 · git worktree prune.
function gc(o) {
  const root = S.mainRoot((o && o.root) || process.cwd());
  const P = S.paths(root);
  const removed = [], kept = [];
  const known = new Set();
  const lockHeldWhy = name => `lock ${name} is held by a live owner (an accept/cancel/restore/check is in progress) — skipped`;
  const released = [];
  let Rs = null; try { Rs = require('./resources'); } catch { /* 없는 판 */ }
  for (const t of S.listTasks(root)) {
    // 작업이 쓰는 자리 — 원래 자리와 옆 경로(task.worktree_alt). [2026-10-29 감사] 옆 경로에서 일하는 열린 레인을 "작업에 속하지 않는 worktree" 로 지웠다.
    const tp = S.taskPathsFor(root, t), orig = S.taskPaths(root, t.id).wt;
    known.add(norm(tp.wt)); known.add(norm(orig));
    // 열린 레인은 사람(세션)이 일하는 중이다 — 주인 프로세스가 없어도 치우지 않는다(accept · batch · cancel 이 끝낸다). [2026-10-29 v7 시험 정리에서 발견]
    if (t.mode === 'light' && t.status === 'open') {
      for (const w of [...new Set([tp.wt, orig])]) if (fs.existsSync(w)) kept.push({ id: t.id, worktree: w, why: 'open lane — someone works in it (accept · batch · cancel ends it)' });
      continue;
    }
    // [2026-10-29 설치 전 점검] 끝나지 않은 v6 작업의 worktree 는 작업자 대화(claude --resume)가 이어 갈 자리다 — 깨끗해도 지우지 않고 자원도 회수하지 않는다.
    if (t.mode !== 'light' && V6_OPEN.has(t.status)) {
      for (const w of [...new Set([tp.wt, orig])]) if (fs.existsSync(w)) kept.push({ id: t.id, worktree: w, why: `unfinished v6 task (${t.status}) — continue it with start --from ${t.id} or cancel it` });
      continue;
    }
    // 끝난 작업의 포트 구역 — 남은 worktree 에서 연 세션이 다시 잡았을 수 있다(예전 판) · 회수 시각과 상관없이 푼다
    if (FINAL.has(t.status) && Rs && typeof Rs.freePorts === 'function') { try { Rs.freePorts(root, t.id); } catch { /* 다음 잡기가 끝난 작업으로 보고 푼다 */ } }
    // [PRD R1] 끝난 작업의 git 밖 자원(볼륨 · 이미지 · 임시 폴더 · 프로젝트 정리 명령)을 한 번 회수한다. 산 주인이 있는 작업 · 잠긴 작업은 건너뛴다.
    if (!(t.status === 'running' && S.ownerAlive(t.owner)) && !(t.resources && t.resources.release_at) && !S.lockLive(root, `task-${t.id}`)) {
      try {
        const r = require('./resources').release(root, t);
        S.writeTask(root, t);
        if (Object.keys(r.docker.removed).length || r.residue.length || r.cleanup || (r.tmp && r.tmp.removed)) released.push({ id: t.id, docker: r.docker.removed, tmp_removed: !!(r.tmp && r.tmp.removed), cleanup: r.cleanup && r.cleanup.ok, residue: r.residue });
      } catch { /* 회수 실패는 다음 gc 에서 다시 */ }
    }
    const wts = [...new Set([tp.wt, orig])].filter(w => fs.existsSync(w));
    if (!wts.length) continue;
    if (t.status === 'running' && S.ownerAlive(t.owner)) { for (const w of wts) kept.push({ id: t.id, worktree: w, why: 'task is running' }); continue; }
    // 지우는 동안 task-<id> 잠금을 잡는다 — 잡을 수 없으면(산 주인) 통합이 이 worktree 를 쓰는 중이다.
    let h = null;
    try { h = S.acquire(root, `task-${t.id}`); }
    catch (e) { if (e.code !== 'LOCK_HELD') throw e; for (const w of wts) kept.push({ id: t.id, worktree: w, why: lockHeldWhy(`task-${t.id}`) }); continue; }
    try {
      for (const w of wts) {
        // 등록이 사라진 남은 폴더(잠긴 파일 때문에 git 이 파일만 남겼다) — 다시 치워 본다. [2026-10-16 자동 이슈 #16]
        if (!G.worktreeRegistered(root, w)) {
          const why = G.clearWorktreeSlot(root, w, t.branch, 0, G.slotOpts(root, t.id, tp.dir));
          if (!why) removed.push({ id: t.id, worktree: w }); else kept.push({ id: t.id, worktree: w, why });
          continue;
        }
        const r = removeIfSafe(root, w, t.worktree_include);
        if (r.ok) removed.push({ id: t.id, worktree: w }); else kept.push({ id: t.id, worktree: w, why: r.why, ...(r.ignored ? { ignored_changed: r.ignored } : {}) });
      }
    } finally { h.release(); }
  }
  // 작업에 속하지 않는 하네스 worktree(중단된 임시 revert 등): 등록돼 있고 깨끗하면 제거.
  //   임시 revert worktree(<id>-cancel-* · <id>-restore-*)는 merge 잠금 아래에서만 쓰인다 — gc 도 merge 잠금을 잡고 지운다.
  let extra = []; try { extra = fs.readdirSync(P.worktreesDir); } catch { /* 없음 */ }
  extra = extra.filter(name => !known.has(norm(path.join(P.worktreesDir, name))));
  // worktree_links 의 링크(.harness-worktrees/<이름> → 메인의 형제 폴더)는 worktree 가 아니다 — 보지도 보고하지도 않는다.
  extra = extra.filter(name => { try { return !fs.lstatSync(path.join(P.worktreesDir, name)).isSymbolicLink(); } catch { return false; } });
  // 묶음(batch) 작업 폴더 <bid> · 대상 끝 기준선 폴더 <bid>-base — [2026-10-29 감사] gc 가 batch 를 몰라 검사 중인 묶음의 등록을 지우고
  //   ready 묶음의 폴더도 지웠다. 만드는 중(batch-<bid> 잠금이 산)이거나 ready 면 남긴다 · 끝난(accepted · dropped · empty · error) 것은 치운다.
  const BATCH_DIR_RE = /^(b-\d{8}-\d{6}-[0-9a-f]{4})(-base)?$/;
  const batchDirs = extra.filter(n => BATCH_DIR_RE.test(n));
  extra = extra.filter(n => !BATCH_DIR_RE.test(n));
  if (batchDirs.length) {
    const Bt = require('./batch');
    for (const name of batchDirs) {
      const [, bid, isBase] = BATCH_DIR_RE.exec(name), wt = path.join(P.worktreesDir, name);
      if (S.lockLive(root, `batch-${bid}`)) { kept.push({ id: null, worktree: wt, why: `batch ${bid} is being built or changed (lock batch-${bid} is held) — skipped` }); continue; }
      const rec = Bt.readBatch(root, bid);
      if (!isBase && rec && rec.status === 'ready') { kept.push({ id: null, worktree: wt, why: `batch ${bid} is ready — batch accept or batch drop ends it` }); continue; }
      const r = Bt.removeBatchWorktree(root, { worktree: wt }, false);
      if (r.ok) removed.push({ id: null, worktree: wt }); else kept.push({ id: null, worktree: wt, why: r.why });
    }
  }
  let mh = null, mergeHeld = false;
  if (extra.length) {
    try { mh = S.acquire(root, 'merge'); } catch (e) { if (e.code !== 'LOCK_HELD') throw e; mergeHeld = true; }
  }
  try {
    for (const name of extra) {
      const wt = path.join(P.worktreesDir, name);
      if (!G.worktreeRegistered(root, wt)) {
        // 옆 경로(<id>-2 …)에 남은 폴더 — 그 작업이 돌고 있지 않으면 같은 방법으로 치운다(#16). 작업에 속하지 않으면 그대로 둔다.
        const m = ID_PREFIX_RE.exec(name), t = m && S.readTask(root, m[1]);
        if (t && /^\d+$/.test(name.slice(m[1].length + 1)) && !(t.status === 'running' && S.ownerAlive(t.owner)) && !(t.mode !== 'light' && V6_OPEN.has(t.status)) && !S.lockLive(root, `task-${t.id}`)) {
          const why = G.clearWorktreeSlot(root, wt, t.branch, 0, G.slotOpts(root, t.id, S.taskPaths(root, t.id).dir));
          if (!why) removed.push({ id: t.id, worktree: wt }); else kept.push({ id: t.id, worktree: wt, why });
          continue;
        }
        kept.push({ id: null, worktree: wt, why: 'not a registered worktree (left alone)' }); continue;
      }
      if (mergeHeld) { kept.push({ id: null, worktree: wt, why: lockHeldWhy('merge') }); continue; }
      const m = ID_PREFIX_RE.exec(name);
      if (m && S.lockLive(root, `task-${m[1]}`)) { kept.push({ id: null, worktree: wt, why: lockHeldWhy(`task-${m[1]}`) }); continue; }
      const r = removeIfSafe(root, wt, null);
      if (r.ok) removed.push({ id: null, worktree: wt }); else kept.push({ id: null, worktree: wt, why: r.why, ...(r.ignored ? { ignored_changed: r.ignored } : {}) });
    }
  } finally { if (mh) mh.release(); }
  const locks = S.removeDeadLocks(root);
  G.git(root, ['worktree', 'prune'], { allowFail: true });
  return { root, removed, kept, released, locks_removed: locks };
}
function formatGc(g) {
  return [`gc: ${g.root}`, `removed worktrees: ${g.removed.length ? g.removed.map(x => x.id || x.worktree).join(', ') : 'none'}`,
    ...g.kept.map(k => `kept ${k.id || k.worktree}: ${k.why}`),
    ...(g.released || []).map(r => `released ${r.id}: ${[r.tmp_removed ? 'temp folder' : '', ...Object.entries(r.docker || {}).map(([k, v]) => `${v} docker ${k}`), r.cleanup != null ? `cleanup_command ${r.cleanup ? 'ok' : 'FAILED'}` : ''].filter(Boolean).join(' · ') || 'nothing'}${r.residue.length ? ` — LEFT: ${r.residue.join(', ')}` : ''}`),
    `dead locks released: ${g.locks_removed.length ? g.locks_removed.join(', ') : 'none'}`].join('\n');
}

module.exports = { status, formatStatus, gc, formatGc, taskFiles, ignoredChanged, ignoredWhy, removeIfSafe };

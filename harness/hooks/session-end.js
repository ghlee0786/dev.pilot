#!/usr/bin/env node
'use strict';
// hooks/session-end.js — SessionEnd(Claude · Codex 둘 다 이 이벤트가 있다): 안전망.
//   이 세션이 기록한 파일 중 아직 미커밋인 것을 그 파일만 자동 커밋한다: `wip(session <sid8>): auto-commit at session end`.
//   다른 세션·사람의 변경은 절대 커밋하지 않는다. 비밀 파일은 커밋하지 않고 세션 파일에 남긴다.
//   세션 파일에는 ended_at 을 적는다 — 게시판(board · status)이 끝난 세션을 산 세션으로 보지 않게.
//   남은 것이 없으면 files 를 비운다(주인 없는 변경 분류는 status 가 한다 — 커밋된 파일을 이 세션 것으로 잡지 않게). 남았으면 그대로 둔다.
//   끝난 지 하루가 지난 빈 세션 파일은 여기서 치운다.
//   시간 예산이 짧다(Claude 기본 1.5초 — 설치기가 timeout 을 늘린다 · Codex 최대 3초). 커밋 한 번이면 충분하다.
const fs = require('node:fs');
const C = require('./_common');

const PRUNE_MS = 24 * 3600 * 1000;

// 끝난 지 오래된(PRUNE_MS) 빈 세션 파일 — 남은 파일 · 비밀 · 커밋 오류가 있는 기록은 사람이 볼 때까지 둔다.
function pruneEnded(common, sid) {
  const now = Date.now();
  for (const s of C.listSessions(common)) {
    if (s.session_id === String(sid) || !s.ended_at || s.files.length || s.secrets_left || s.commit_error) continue;
    const at = Date.parse(s.ended_at);
    if (!at || now - at < PRUNE_MS) continue;
    try { fs.unlinkSync(C.sessionPath(common, s.session_id)); } catch { /* 이미 없다 */ }
  }
}

function main() {
  let input = null;
  try {
    const r = C.readStdinJson();
    if (!r.input) { if (r.error !== 'empty stdin') C.logError('session-end', r.error); return; }
    input = r.input;
    const sid = input.session_id;
    if (!sid) return;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const info = C.repoInfo(cwd);
    if (!info || C.harnessOwned(info)) return;            // 가벼운 길의 worktree 는 사람이 모는 세션 — 커밋한다
    const sess = C.loadSession(info.common, sid);
    if (!sess) return;
    const runtime = C.detectRuntime(input);
    const files = Array.isArray(sess.files) ? sess.files : [];
    const { mine, secrets } = files.length ? C.uncommittedOf(info.root, files) : { mine: [], secrets: [] };
    const now = new Date().toISOString();
    let res = { ok: true, sha: null };
    if (mine.length) {
      res = C.commitFiles(info.root, mine, `wip(session ${C.sid8(sid)}): auto-commit at session end`);
      if (!res.ok) C.logError('session-end', new Error(res.error), cwd);
    }
    C.updateSession(info.common, sid, runtime, s => {
      s.ended_at = now;
      s.end_reason = input.reason || null;
      if (res.ok && !secrets.length) s.files = [];           // 깨끗하게 끝났다 — 파일 기록을 비운다
      if (res.sha) s.last_commit = { sha: res.sha, files: mine, at: now, by: 'session-end' };
      if (!res.ok) s.commit_error = { error: res.error, files: mine, at: now };
      if (secrets.length) s.secrets_left = secrets;
      return s;
    });
    try { pruneEnded(info.common, sid); } catch (e) { C.logError('session-end', e, cwd); }
  } catch (e) {
    C.logError('session-end', e, input && input.cwd);
  }
}

if (require.main === module) { main(); process.exitCode = 0; }
module.exports = { pruneEnded, PRUNE_MS };

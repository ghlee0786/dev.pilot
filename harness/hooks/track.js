#!/usr/bin/env node
'use strict';
// hooks/track.js — PostToolUse(쓰기 도구): 이 세션이 고친 파일을 세션 파일에 더한다(설계 §6 · §7).
//   Claude: Write · Edit · MultiEdit(tool_input.file_path) · NotebookEdit(tool_input.notebook_path)
//   Codex : apply_patch — 패치 전문이 tool_input.command 에 온다(Codex 조사 §4). `*** Add/Update/Delete File:` · `*** Move to:` 머리줄을 읽는다.
//   파일 시스템 MCP: write_file · edit_file · create_file(tool_input.path) · move_file(tool_input.destination).
//   저장소 밖 · .git · .harness-worktrees/ 아래 경로는 버린다. 하네스 작업 worktree 안의 세션은 기록하지 않는다(git 은 하네스 몫) — 가벼운 길은 예외.
//   출력 없음. 오류는 열어 두고 hook-errors.log 에 남긴다.
const C = require('./_common');

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm;

function pathsOf(input) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const out = [];
  // destination: 파일 시스템 MCP 의 move_file(옮겨 간 곳). source(옮기기 전 자리)는 기록하지 않는다.
  for (const k of ['file_path', 'notebook_path', 'path', 'destination']) if (typeof ti[k] === 'string') out.push(ti[k]);
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (e && typeof e.file_path === 'string') out.push(e.file_path);
  // apply_patch: 문자열 필드 어디든 패치 본문이 있으면 머리줄을 읽는다(command · patch · input).
  for (const k of ['command', 'patch', 'input']) {
    let v = ti[k];
    if (Array.isArray(v)) v = v.join('\n');
    if (typeof v === 'string' && v.includes('*** ')) { let m; PATCH_HEADER.lastIndex = 0; while ((m = PATCH_HEADER.exec(v))) out.push(m[1]); }
  }
  if (typeof input.tool_input === 'string' && input.tool_input.includes('*** ')) {
    let m; PATCH_HEADER.lastIndex = 0; while ((m = PATCH_HEADER.exec(input.tool_input))) out.push(m[1]);
  }
  return out;
}

function main() {
  let input = null;
  try {
    const r = C.readStdinJson();
    if (!r.input) { if (r.error !== 'empty stdin') C.logError('track', r.error); return; }
    input = r.input;
    const sid = input.session_id;
    if (!sid) return;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const info = C.repoInfo(cwd);
    if (!info || C.harnessOwned(info)) return;            // 가벼운 길의 worktree 는 사람이 모는 세션이다 — 기록한다
    const rels = [...new Set(pathsOf(input).map(p => C.repoRel(info.root, cwd, p)).filter(Boolean))];
    if (!rels.length) return;
    const runtime = C.detectRuntime(input);
    C.updateSession(info.common, sid, runtime, s => {
      const have = new Set(s.files.map(f => C.IS_WIN ? f.toLowerCase() : f));
      for (const rel of rels) {
        const k = C.IS_WIN ? rel.toLowerCase() : rel;
        if (!have.has(k)) { s.files.push(rel); have.add(k); }
      }
      return s;
    });
  } catch (e) {
    C.logError('track', e, input && input.cwd);
  }
}

if (require.main === module) { main(); process.exitCode = 0; }
module.exports = { pathsOf };

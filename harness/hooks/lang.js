#!/usr/bin/env node
'use strict';
// hooks/lang.js — 대화형 세션의 응답 언어를 지킨다(Claude · Codex 공용).
//   [2026-10-13 사용자 보고] 한국어로 묻는데 답(보고 · 요약)이 가끔 영어로 나왔다. "한국어로" 규칙은 AGENTS.md · 메모리에 있었지만
//   지시문은 대화가 길어질수록 놓친다 — 규칙을 매 턴 상기시키고(UserPromptSubmit), 그래도 영어로 끝나면 한 번 되돌린다(Stop).
//   UserPromptSubmit: 사용자의 글에 한글이 있으면 세션에 user_lang=ko 를 적고, 이번 턴의 문맥에 언어 규칙을 사실로 덧붙인다.
//   Stop: user_lang=ko 인데 마지막 답이 거의 영어면(코드 · 경로 · 링크를 빼고 셈) {"decision":"block"} 으로 한국어로 다시 쓰게 한다.
//         이미 훅 때문에 이어 가는 턴(stop_hook_active)이면 막지 않는다 — 한 턴에 한 번뿐.
//   내부 오류는 열어 둔다(허용) — 대신 hook-errors.log 에 남긴다.
const C = require('./_common');

const HANGUL = /[가-힣ㄱ-ㆎ]/g;
// 셀 때 빼는 것: 코드 블록 · 인라인 코드 · 링크 · 경로 · 식별자처럼 생긴 토큰
function prose(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.\-]+){2,}/g, ' ')
    .replace(/\b[\w-]+\.(?:js|ts|py|cs|md|json|ya?ml|txt|png|mp4)\b/gi, ' ')
    .replace(/\b[a-z]+[A-Z_][A-Za-z0-9_]*\b/g, ' ');
}
const count = (s, re) => (String(s).match(re) || []).length;
function isKorean(text) { const p = prose(text); return count(p, HANGUL) >= 2 && count(p, HANGUL) * 2 >= count(p, /[A-Za-z]/g) * 0.2; }
// 거의 영어인 답: 라틴 글자 120자 이상이고 한글이 라틴의 10% 미만.
function mostlyEnglish(text) { const p = prose(text), lat = count(p, /[A-Za-z]/g), han = count(p, HANGUL); return lat >= 120 && han < lat * 0.1; }

const CONTEXT = '사용자는 한국어로 쓰고 있다. 이 저장소의 규칙(AGENTS.md "### 언어")에 따라 이번 턴의 대답 · 진행 보고 · 요약 · 결과 보고는 처음부터 끝까지 한국어로 쓴다(식별자 · 명령 · 경로 · 원문 인용은 그대로).';
const REASON = '마지막 답이 영어로 쓰였습니다. 사용자는 한국어로 묻고 있고 이 저장소의 규칙(AGENTS.md "### 언어")은 한국어입니다. 같은 내용을 한국어로 다시 써서 답하세요 — 식별자 · 명령 · 경로 · 숫자는 그대로 두고, 내용을 줄이거나 바꾸지 마세요.';

function decide(input, runtime) {
  const ev = String(input.hook_event_name || '');
  const sid = input.session_id;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const info = C.repoInfo(cwd);
  if (ev === 'UserPromptSubmit') {
    // 자동 갱신 확인 — 대화형 세션은 하네스 명령을 거의 부르지 않으므로 사용자가 말할 때도 본다(하루 한 번 · 별도 프로세스).
    if (info) { try { require('../lib/autoupdate').maybe(info.root); } catch { /* 훅을 멈추지 않는다 */ } }
    const ko = isKorean(input.prompt);
    // [#93] 세션 기록 잠금을 못 잡아도(부하 · 다른 훅이 쥠) 이번 턴의 언어 규칙은 싣는다 — 기록 실패는 남기기만 한다.
    if (info && sid) {
      try { C.updateSession(info.common, sid, runtime, s => { s.user_lang = ko ? 'ko' : (s.user_lang || null); return s; }); }
      catch (e) { C.logError('lang', e, cwd); }
    }
    return ko ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: CONTEXT } } : null;
  }
  if (ev === 'Stop') {
    if (input.stop_hook_active) return null;
    if (!info || !sid) return null;
    const sess = C.loadSession(info.common, sid);
    if (!sess || sess.user_lang !== 'ko') return null;
    return mostlyEnglish(input.last_assistant_message) ? { decision: 'block', reason: REASON } : null;
  }
  return null;
}

function main() {
  let input = null;
  try {
    const r = C.readStdinJson();
    if (!r.input) { if (r.error !== 'empty stdin') C.logError('lang', r.error); return; }
    input = r.input;
    const out = decide(input, C.detectRuntime(input));
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  } catch (e) { C.logError('lang', e, input && input.cwd); }
}

if (require.main === module) { main(); process.exitCode = 0; }
module.exports = { decide, isKorean, mostlyEnglish, prose };

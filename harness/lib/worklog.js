'use strict';
// 작업 장부 — 이 저장소에서 이미 한 일 · 하고 있는 일 · 버린 일을 찾아, 새 작업이 처음부터 다시 하지 않고 그 뒤로 이어 가게 한다.
//   [2026-10-20 PRD R2 · 사용자 원칙 "시킨 일을 중복하지 않고, 준 맥락을 바탕으로 확인 · 검증해 그 뒤로 발전해 나간다"]
//   언어 무관: 문장 부호 · 공백을 하나로 접은 뒤 글자 3-gram 코사인 유사도 — 한국어 · 영어 · 코드 이름이 섞인 목표에도 같은 방식.
//   판정이 아니라 맥락이다: 하네스는 막지 않는다 — 작업자에게 이전 작업을 알려 확인 · 이어 가게 하고, 보고에 남긴다.
const S = require('./state');

const SAME = 0.82, RELATED = 0.3, MAX_RELATED = 4, MAX_CHARS = 3500;

const norm = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
function grams(s) {
  const t = norm(s).replace(/ /g, '_'), m = new Map();
  if (t && t.length < 3) m.set(t, 1);
  for (let i = 0; i + 3 <= t.length; i++) { const g = t.slice(i, i + 3); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
function similarity(a, b) {
  const x = grams(a), y = grams(b);
  let dot = 0, nx = 0, ny = 0;
  for (const [k, v] of x) { nx += v * v; const w = y.get(k); if (w) dot += v * w; }
  for (const v of y.values()) ny += v * v;
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}

// 작업의 "무엇을 하라고 했나" — 목표
function intentOf(root, t) { return String((t && t.goal) || ''); }

// → [{ id, score, status, kind: 'same' | 'related' }] (점수 높은 순, 최대 MAX_RELATED)
function related(root, task) {
  const out = [];
  for (const t of S.listTasks(root)) {
    if (!t || t.id === task.id) continue;
    // 같은 공장 실행의 형제 카드는 이전 작업이 아니다(공통 맥락을 나눠 가져 비슷해 보인다 — 서로의 일은 계약 · 소유 경로가 나눈다)
    if (t.factory && task.factory && t.factory.run === task.factory.run) continue;
    const score = similarity(task.goal, intentOf(root, t));
    if (score >= RELATED) out.push({ id: t.id, score: Math.round(score * 100) / 100, status: t.status, kind: score >= SAME ? 'same' : 'related' });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_RELATED);
}




module.exports = { related, similarity, SAME, RELATED };

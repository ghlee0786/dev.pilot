'use strict';
// 품질 규칙(하네스 내장 린트) — 작업이 새로 더한 줄에서 AI 가 흔히 남기는 군더더기를 종류별로 찾는다.
//   [2026-10-17 사용자 지시] 린트를 세분화해 정책으로: 중복(dup.js) 말고도 쓰이지 않는 새 정의 · 디버그 흔적 · 남긴 할 일 · 주석 처리된 코드 ·
//   검사 억누르기 · 테스트 약화 · 하드코딩(개인 경로 · 비밀 모양) · 형식만 바뀐 파일.
//   정책: 기존 코드의 옛 흔적은 보지 않는다(새로 더한 줄만). 루프가 걸린 것을 모아 작업자에게 한 번만 돌려보내고, 남으면 막지 않고 보고한다.
//   끄기: 프로젝트 블록 quality: off(전부) · quality_off: ["debug", …](규칙별).
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const G = require('./git'), D = require('./dup');

const RULES = ['unused', 'debug', 'todo', 'commented', 'suppress', 'test-weaken', 'hardcoded', 'format-only', 'repo-lint'];
const CONF_EXT = /\.(csproj|vbproj|fsproj|props|targets|json|ya?ml|toml|ini|cfg|config|xml|xaml)$/i;
// 언어별 패턴(디버그 흔적 · 테스트 약화 · 안 쓰는 정의 · 주석)은 언어 팩(langs.js)에 — 여기는 언어와 무관한 것만(PRD R5)
const Langs = require('./langs');
const TODO = /(\/\/|#|\/\*|\*|--|<!--)\s*.*\b(TODO|FIXME|XXX|HACK)\b/;
const SUPPRESS = /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*noqa\b|#\s*type:\s*ignore|pylint:\s*disable|#\s*nosec\b|#pragma\s+warning\s+disable|SuppressMessage|NOSONAR|@SuppressWarnings|rubocop:disable|<NoWarn>|TreatWarningsAsErrors>\s*false|\/\/\s*nolint\b|#!?\[allow\(|\bNOLINT(NEXTLINE)?\b|#pragma\s+(GCC|clang)\s+diagnostic\s+ignored/i;
const HARD_PATH = /\b[A-Za-z]:(\\\\|\\|\/)Users(\\\\|\\|\/)[^\\/\s"'`]+|\/home\/[a-z_][\w.-]*\/|\/Users\/[A-Za-z][\w.-]*\//;
const SECRET = /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bxox[baprs]-[A-Za-z0-9-]{10,}/;
const CODEY = /(\w+\s*\(.*\)\s*;?\s*$|[;{}]\s*$|^\s*(return|if|for|while|const|let|var|def|class|import|from|await|throw)\b|\w\s*[+\-*/]?=\s*\S)/;
const NOT_UNUSED = /^(main|Main|__\w+__|setUp|tearDown|setup|teardown|constructor|render|default)$|^(test|Test)/;
// [2026-10-19 현장 오탐] 데코레이터 · 어트리뷰트(@router.get · [HttpGet] · @Get())가 붙은 정의는 프레임워크가 이름 없이 부른다.
//   여러 줄 데코레이터(@router.get(\n "/x",\n))도 — 정의 위로, 같은 들여쓰기의 @ · [ 줄이 나오면 붙은 것. 빈 줄 · 같은 들여쓰기의 다른 문장에서 멈춘다.
function decorated(lines, n) {
  const ind = s => /^\s*/.exec(s)[0].length, me = ind(lines[n - 1]);
  for (let i = n - 2; i >= 0 && i >= n - 12; i--) {
    const s = lines[i]; if (!s.trim()) return false;
    const t = s.trim();
    if (ind(s) > me || /^[)\]}]/.test(t)) continue;
    if (ind(s) === me && /^(@|\[)/.test(t)) return true;
    return false;
  }
  return false;
}
// 억누르기에 사유를 달았다: eslint 의 `-- 사유` · `— 사유` · 뒤따르는 주석 · SuppressMessage 의 Justification
const REASON = /(\s[—–]\s*|\s--\s+|\s#\s*|\s\/\/\s*|Justification\s*=\s*")[^\s—–#/-]/;
const reasoned = t => { const m = SUPPRESS.exec(t); return !!m && REASON.test(t.slice(m.index + m[0].length)); };
const MAX_BYTES = 512 * 1024;

const rel = f => f.replace(/\\/g, '/');
function readLines(abs) { try { const st = fs.statSync(abs); if (!st.isFile() || st.size > MAX_BYTES) return null; const b = fs.readFileSync(abs); if (b.includes(0)) return null; return b.toString('utf8').split(/\r?\n/); } catch { return null; } }

// → [{ rule, file, line, text }] — o: { off: [규칙 이름] }
function find(wt, base, o) {
  const off = new Set((o && o.off) || []);
  const on = r => !off.has(r);
  const untracked = new Set(G.statusEntries(wt).filter(e => e.code === '??').map(e => rel(e.path)));
  const modified = new Set(G.diffNames(wt, base, null, ['--diff-filter=M']).map(rel));
  const own = D.harnessCopy(wt);
  const changed = [...new Set([...G.diffNames(wt, base, null, ['--diff-filter=AM']).map(rel), ...untracked])]
    .filter(f => !D.SKIP.test(f) && !/^\.harness\//.test(f) && !own(f) && fs.existsSync(path.join(wt, f)) && (D.CODE_EXT.test(f) || CONF_EXT.test(f)));
  const out = [], defs = [], amap = D.addedMap(wt, base);
  for (const f of changed) {
    const lines = readLines(path.join(wt, f)); if (!lines) continue;
    const added = untracked.has(f) ? new Set(lines.map((_, i) => i + 1)) : (amap.get(f) || new Set());
    const isTest = D.TEST.test(f), isCode = D.CODE_EXT.test(f);
    let run = [];
    const flushRun = () => { if (run.length >= 3 && on('commented')) out.push({ rule: 'commented', file: f, line: run[0], text: lines[run[0] - 1].trim().slice(0, 120) }); run = []; };
    for (let n = 1; n <= lines.length; n++) {
      const t = lines[n - 1];
      if (!added.has(n)) { flushRun(); continue; }
      const hit = (rule, text) => { if (on(rule)) out.push({ rule, file: f, line: n, text: (text || t.trim()).slice(0, 120) }); };
      if (!isTest && SUPPRESS.test(t) && !reasoned(t)) hit('suppress');   // 테스트의 억누르기(# noqa: E402 · @ts-expect-error)는 대개 의도다
      if (isTest) { if (Langs.WEAKEN.test(t)) hit('test-weaken'); continue; }
      if (!isCode) continue;
      if (Langs.debugFor(f).some(re => re.test(t))) hit('debug');
      if (TODO.test(t)) hit('todo');
      if (HARD_PATH.test(t) || SECRET.test(t)) hit('hardcoded', t.trim().replace(SECRET, m => `${m.slice(0, 6)}…`));
      const c = Langs.commentOf(f, t);
      if (c != null && CODEY.test(c) && !/<\/?\w+[^>]*>/.test(c) && !TODO.test(t) && !SUPPRESS.test(t)) run.push(n); else flushRun();
      if (on('unused')) for (const re of Langs.defsFor(f)) { const m = re.exec(t); if (m && !NOT_UNUSED.test(m[1]) && !/\boverride\b/.test(t) && !decorated(lines, n)) { defs.push({ file: f, line: n, name: m[1], text: t }); break; } }
    }
    flushRun();
  }
  // 쓰이지 않는 새 정의: 저장소의 텍스트 파일 어디에도(정의한 줄 말고) 이름이 나오지 않는다 — XAML · 설정의 참조도 센다
  //   git grep(색인 · 여러 스레드)으로 찾는다 — [2026-10-17 실측] 파일을 모두 읽어 줄마다 훑으니 큰 .NET 저장소에서 30초가 걸렸다.
  //   이름 전부를 한 번의 git grep 으로(이름마다 따로 돌리니 큰 저장소에서 수십 초) — 그 결과 줄에서 이름별로 가른다.
  const ds = defs.slice(0, 40);
  if (ds.length) {
    const r = G.git(wt, ['grep', '-n', '-w', '-F', '-I', '--untracked', ...ds.flatMap(d => ['-e', d.name]), '--', '.', ':(exclude).harness'], { allowFail: true });
    const hits = r.out.split(/\r?\n/).filter(Boolean).map(rel);
    for (const d of ds) {
      const word = new RegExp(`(^|[^\\w$])${d.name.replace(/\$/g, '\\$')}(?![\\w$])`);
      const used = hits.some(l => { const m = /^(.*?):(\d+):(.*)$/.exec(l); return m && !(m[1] === d.file && Number(m[2]) === d.line) && word.test(m[3]); });
      if (!used) out.push({ rule: 'unused', file: d.file, line: d.line, text: d.name });
    }
  }
  // 형식만 바뀐 파일: 공백 · 빈 줄을 빼면 바뀐 것이 없다(범위 밖 재정렬)
  if (on('format-only')) {
    // --numstat 두 번(전체 · 공백 무시)으로 — 파일마다 git 을 띄우지 않는다. 공백을 무시하면 바뀐 줄이 0 인 수정 파일.
    const stat = extra => { const m = new Map(); for (const l of G.git(wt, ['-c', 'core.quotepath=off', 'diff', '--numstat', '--no-renames', ...extra, base], { allowFail: true }).out.split(/\r?\n/)) { const p = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l); if (p) m.set(rel(p[3]), p[1] === '-' ? -1 : Number(p[1]) + Number(p[2])); } return m; };
    const all = stat([]), ws = stat(['-w', '--ignore-blank-lines']);
    for (const f of modified) {
      if (D.SKIP.test(f) || /^\.harness\//.test(f) || own(f) || !(all.get(f) > 0)) continue;
      if (!(ws.get(f) > 0)) out.push({ rule: 'format-only', file: f, line: 0, text: '공백 · 들여쓰기만 바뀌었다' });
    }
  }
  // 저장소 린트: 저장소가 설정한 린터로 새로 생긴 위반(repolint.js) — 작업 전 내용은 git show 그대로(끝 줄바꿈을 지우지 않게)
  if (on('repo-lint')) {
    const baseText = f => { const r = spawnSync('git', ['show', `${base}:${f}`], { cwd: wt, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }); return r.status === 0 ? r.stdout : null; };
    try { out.push(...require('./repolint').find(wt, changed.filter(f => D.CODE_EXT.test(f)), amap, baseText, o && o.repoLint)); } catch { /* 린터 실패는 품질 검사를 막지 않는다 */ }
  }
  return out.slice(0, 40);
}

// 규칙 이름 → 사람이 읽는 이름(보고 · 지시)
const LABEL_KO = { dup: '중복', unused: '쓰이지 않는 새 정의', debug: '디버그 흔적', todo: '남긴 할 일', commented: '주석 처리된 코드', suppress: '검사 억누르기', 'test-weaken': '테스트 약화', hardcoded: '하드코딩(개인 경로 · 비밀)', 'format-only': '형식만 바뀐 파일', 'repo-lint': '저장소 린트의 새 위반' };
const LABEL_EN = { dup: 'duplicate code', unused: 'new definitions nothing uses', debug: 'debug leftovers', todo: 'TODO/FIXME left behind', commented: 'commented-out code', suppress: 'lint/type checks suppressed', 'test-weaken': 'tests weakened (skip/only/always-true)', hardcoded: 'hard-coded personal paths or secrets', 'format-only': 'files with only whitespace/indentation changes', 'repo-lint': 'new violations of the repository\'s own linter' };

module.exports = { find, RULES, LABEL_KO, LABEL_EN };

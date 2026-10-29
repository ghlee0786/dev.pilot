---
name: harness
description: Pilot(하네스) — 여러 세션이 한 저장소에서 일할 때 겹치지 않게 자기 레인(worktree · 브랜치, `node harness/cli.js start`)을 만들고, 끝난 작업을 받아들이기(accept) · 묶어 합치기(batch) · 취소(cancel) · 되살리기(restore) · 현황(status) · 정리(gc)로 다룬다.
---

# Pilot(harness) — 레인 · 병합 · 현황 길잡이

## 만들거나 고쳐 달라는 요청
- 한두 줄 수정 · 질문 · 조사, 그리고 같은 체크아웃에서 다른 세션이 일하지 않을 때의 작업은 **그 자리에서** 하고 고친 파일만 커밋한다(`git commit -m "…" -- <파일>`).
- 다른 세션이 같은 체크아웃에서 일하거나(board 훅이 알린다), 여러 세션이 도는 중에 여러 파일에 걸친 일을 하면 **레인**을 만든다:
  1. 요청 원문을 임시 파일에 쓰고(셸 명령줄에 넣지 않는다 — 따옴표 · `$(…)` · 백틱이 바뀐다) `node harness/cli.js start --goal-file "<파일>"`.
  2. 나온 worktree 경로와 여는 법(`cd "<폴더>" ; claude` 또는 VS Code)을 사용자에게 전한다 — 그 폴더의 세션이 일하고 진행하며 커밋한다.
  3. 비슷한 작업이 이미 있다고 나오면 처음부터 다시 하지 말고 `start --from <id> --goal-file "<파일>"`(그 브랜치에서 이어 간다).
- 사람 없이 맡길 일은 Claude Code 백그라운드 세션(`claude --bg "<요청>"`) — 끝나면 그 브랜치를 accept 한다. 백그라운드 세션도 push 하지 않는다.
- 일에 맞는 스킬 · MCP 가 이 세션에 있으면 먼저 쓴다 · 없는 것은 `node harness/cli.js toolkit` 으로 보고 사용자에게 제안만 한다.

## 받아들이기 · 묶어 합치기 · 취소 · 되살리기
- 사용자가 결과를 받아들인다고 **명시적으로** 말했을 때만: `node harness/cli.js accept <id>` — 저장소 검사를 한 번 돌려 작업 전보다 나빠졌을 때만 거절한다. 충돌이 나면 그 레인에 병합이 남는다 — 그 레인에서 표식을 풀고 커밋한 뒤 다시 accept.
- 끝난 작업이 여럿이면: `node harness/cli.js batch <id> <id> …`(검사 한 번 · 사용자 브랜치는 그대로) → 사용자가 말한 뒤 `batch accept <bid>`.
- 미리 검사만: `node harness/cli.js check <id>`. 취소(revert): `cancel <id>` · 되살리기: `restore <id>`.
- 사용자가 push 를 **명시적으로** 요청하면: `node harness/cli.js push [<remote>] [<branch>]` — 빨리감기만, 강제 없음.
- 보고(맨 위의 요약 · 다음 줄과 영어 세부 줄)는 사용자의 언어로 빠짐없이 옮긴다(명령 · 경로 · 숫자 · 브랜치 이름은 원문 그대로).

## 현황 · 정리
- `node harness/cli.js status` — 레인 · 작업 · 산 세션(claude agents) · 겹치는 파일 · 주인 없는 미커밋 변경.
- 끝난 작업의 worktree · 프로세스 · 컨테이너 · 임시 폴더 · 포트 정리: `node harness/cli.js gc`(하네스가 만든 것만).

## 하네스 보고 (자동)
- 하네스가 오류로 멈추거나 의도와 다르게 행동하거나 더 나은 방향이 보이면 묻지 말고 `node harness/cli.js report --kind <bug|intent|improve> --title "…" --body "…"` — 하네스 동작만 쓰고 프로젝트 코드 · 이름 · 경로는 쓰지 않는다. 사용자가 하네스에 대한 건의를 말하면 그것도 이렇게 올린다(`--kind improve`).

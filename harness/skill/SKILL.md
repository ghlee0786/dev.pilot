---
name: harness
description: Pilot(하네스) — 여러 세션이 한 저장소에서 일할 때 겹치지 않게 자기 레인(worktree · 브랜치, `node harness/cli.js start`)을 만들고, 끝난 작업을 받아들이기(accept) · 묶어 합치기(batch) · 취소(cancel) · 되살리기(restore) · 현황(status) · 정리(gc)로 다룬다.
---

# Pilot(harness) — 레인 · 병합 · 현황 길잡이

## 만들거나 고쳐 달라는 요청
- 프로젝트가 Herdr를 주 세션 관리자로 정했으면 선택한 실행 방식(TUI 또는 Core)의 운영 계약을 따른다. TUI 방식은 총괄과 작업자가 실제 Herdr pane에서 `herdr agent`로 배정 · 대기 · 결과 회수를 한다. Orca는 화면 · 작업공간, Pilot은 Git · worktree · 안전 규칙을 맡는다. 이 계약은 아래 `claude --bg` 직접 시작 지시보다 우선한다. 기존 `sessionId`와 레인을 이어 쓰고 같은 작업을 두 관리자가 중복 시작하거나 동시에 지시하지 않는다. 모델 · effort는 프로젝트 운영 스킬을 따른다.
- 한두 줄 수정 · 질문 · 조사, 그리고 같은 체크아웃에서 다른 세션이 일하지 않을 때의 작업은 **그 자리에서** 하고 고친 파일만 커밋한다(`git commit -m "…" -- <파일>`).
- 다른 세션이 같은 체크아웃에서 일하거나(board 훅이 알린다), 여러 세션이 도는 중에 여러 파일에 걸친 일을 하면 **레인**을 만든다:
  1. 짧은 요청은 따옴표 인자로 `node harness/cli.js start "<짧은 요청>"`. 요청이 길거나 따옴표 · `$` · 백틱이 들었으면 임시 파일에 써서 `node harness/cli.js start --goal-file "<파일>"`(셸이 원문을 바꾼다).
  2. 나온 worktree 경로와 여는 법(`cd "<폴더>" ; claude` 또는 VS Code)을 사용자에게 전한다 — 그 폴더의 세션이 일하고 진행하며 커밋한다.
  3. 비슷한 작업이 이미 있다고 나오면 처음부터 다시 하지 말고 `start --from <id>`(그 브랜치에서 이어 간다 · 목표는 1 과 같은 방법으로).
- 사람 없이 맡길 일은 자기 worktree 의 Claude Code 백그라운드 세션(`claude --bg -w <이름> "<요청>"`) — 끝나면 그 브랜치를 `node harness/cli.js batch --branch <브랜치>` 로 묶어 검사하고, 사용자가 말한 뒤 `batch accept <bid>`(accept 는 작업 id 만 받는다). 백그라운드 세션도 push 하지 않는다.
- 시험이 실패하면 원인을 근거로 판정해 고친 뒤 다시 시험한다 — 다른 원인은 따로 세고, 같은 원인은 원인마다 3회까지(3회째 실패하면 멈추고 근거 · 고친 내용 · 재시험 결과를 보고 · 4회째 없음). 원인이 확인된 실패는 모두 기록하고, 고치지 않은 반복 · 기록 지우기 · 초기화 · 기록에서 빼기 · 이름 바꾸기로 피하지 않는다. `rerun_failed` 설정 · 자동 재실행 동작은 바꾸지 않으며, 그것이 고치지 않은 반복을 허락하지 않는다.
- 일에 맞는 스킬 · MCP 가 이 세션에 있으면 먼저 쓴다 · 없는 것은 `node harness/cli.js toolkit` 으로 보고 사용자에게 제안만 한다.

## 받아들이기 · 묶어 합치기 · 취소 · 되살리기
- 사용자가 결과를 받아들인다고 **명시적으로** 말했을 때만: `node harness/cli.js accept <id>` — 저장소 검사를 한 번 돌려 작업 전보다 나빠졌을 때만 거절한다. 충돌이 나면 그 레인에 병합이 남는다 — 그 레인에서 표식을 풀고 커밋한 뒤 다시 accept.
- 끝난 작업이 여럿이면: `node harness/cli.js batch <id> <id> …`(검사 한 번 · 사용자 브랜치는 그대로) → 사용자가 말한 뒤 `batch accept <bid>`.
- 이번에 합치지 않고 다음 클로징에 실을 레인은 `node harness/cli.js ready <id> --note "<메모>"` 로 표시한다(그 끝을 적는다 · `status` 에 다음 batch 후보로 보인다) — 묶을 때 `batch --ready`(표시 뒤 커밋이 있으면 건너뛰니 다시 표시) · 지우기 `ready <id> --clear`.
- 미리 검사만: `node harness/cli.js check <id>`. 취소(revert): `cancel <id>` · 되살리기: `restore <id>`.
- 사용자가 push 를 **명시적으로** 요청하면: `node harness/cli.js push [<remote>] [<branch>]` — 빨리감기만, 강제 없음. 올리기 전에 `push --dry-run` 으로 쓰기 권한 · 계정을 확인할 수 있다(아무것도 보내지 않는다 · 실패면 원격 · 자격 증명 도우미 · 계정을 보여 준다 · 창을 띄우지 않는다).
- 보고(맨 위의 요약 · 다음 줄과 영어 세부 줄)는 사용자의 언어로 빠짐없이 옮긴다(명령 · 경로 · 숫자 · 브랜치 이름은 원문 그대로).

## 현황 · 정리
- Herdr의 `live` · `idle` · `done`은 세션 상태이며 검사 성공이나 작업 완료의 증거가 아니다. 결과 · 종료 코드와 프로젝트의 완료 조건을 확인한다.
- `node harness/cli.js status` — 레인 · 작업 · 산 세션(claude agents) · 겹치는 파일 · 주인 없는 미커밋 변경 · 검사 줄(지금 쥔 이 · 기다리는 차례).
- 하네스 밖 무거운 명령(전체 빌드 · 이미지 빌드)은 검사 줄에 세워 돌린다: `node harness/cli.js slot [--label <이름>] [--timeout-min <n>] -- <명령>` — 차례가 오면 출력을 그대로 보이며 돌리고 끝나면 놓는다(종료 코드는 그 명령의 것 · 상한을 넘으면 124). 같은 PC 의 다른 저장소와 함께 줄을 서려면 프로젝트 블록에 `serial_checks: machine`.
- 끝난 작업의 worktree · 프로세스 · 컨테이너 · 임시 폴더 · 포트 정리: `node harness/cli.js gc`(하네스가 만든 것만).

## 하네스 보고 (자동)
- 이슈 발행은 공개 저장소로 나가는 쓰기지만 사용자가 자동 발행에 미리 동의했기 때문에 묻지 않는다(끄기: 프로젝트 블록 `bug_report: off`). 하네스가 오류로 멈추거나 의도와 다르게 행동하거나 더 나은 방향이 보이면 `node harness/cli.js report --kind <bug|intent|improve> --title "…" --body "…"` — 하네스 동작만 쓰고 프로젝트 코드 · 이름 · 경로는 쓰지 않는다. 사용자가 하네스에 대한 건의를 말하면 그것도 이렇게 올린다(`--kind improve`).

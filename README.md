# Pilot (dev.pilot)

> 코드는 모델이 쓰고, 하네스는 여러 세션이 한 저장소를 함께 쓸 때 플랫폼이 보장하지 않는 것만 맡는다. 예전 이름 dev.harness — 설치 폴더 `harness/` 와 명령 `node harness/cli.js` 는 그대로다.

Claude Code · Codex 용 개발 하네스. **v7 — Light**: 맨 모델 + git + 격리 · 병합 + 세션 간 조율 + 안전 가드레일, 그리고 병합 때 검사 한 번 · 뒷정리. 그 밖의 것(무인 작업자 루프 · 작업 분할 공장 · 품질 규칙 · 지시문)은 뺐다.

왜 뺐나 — 같은 과제 짝 비교(60쌍)에서 무인 루프는 정확도 이득 없이(85% 대 83%) 시간 ×1.24 · 토큰 ×1.39 였고, 큰 C++ 저장소에서는 카드마다 도는 전체 검사와 "되돌리고 처음부터 다시" 가 처리량을 막았다(작업 64개 · 병합 2건 — 끝난 브랜치를 묶어 검사를 한 번 돌리자 32분에 통과). Anthropic · OpenAI 의 공식 지침도 같은 쪽이다: 단일 에이전트 먼저 · 짧은 AGENTS.md(지도) · 반드시 지킬 것만 결정적으로(훅) · 완료 판정은 테스트 · 병합은 사람이 승인 · 플랫폼이 하는 것은 다시 만들지 않는다.

- 의존성 0 · Node ≥ 20 · CommonJS · Windows · Linux · macOS
- 사용자 브랜치는 받아들일(accept) 때까지 그대로 · 되돌리기는 git(revert) — reset · 강제 push · stash 없음
- 합치기는 저장소에 원래 있는 테스트의 종료 코드로만 판정한다(작업 전보다 나빠지면 거절). 모델이 모델을 판정하지 않는다
- 사람이 읽는 출력은 사용자의 언어로

## 무엇을 맡고, 무엇을 플랫폼에 맡기나

| 축 | 플랫폼(Claude Code · Codex)이 이미 함 — 다시 만들지 않는다 | Pilot 이 맡는다(플랫폼에 없다) |
|---|---|---|
| 맨 모델 | 에이전트 루프 · 계획 · 컨텍스트 압축 · 서브에이전트 · 백그라운드 세션(`claude --bg`) | 40줄 이하의 AGENTS 블록(지도)만 |
| git | 백그라운드 세션의 커밋 | 세션마다 **자기가 고친 파일만** 커밋(다른 세션의 미커밋 변경 보호) · 빨리감기 push 만 |
| 격리 · 병합 | `claude -w` · 백그라운드 세션의 worktree · 서브에이전트 격리 · 자기 worktree 정리 | **레인**(`start` — 원하는 기준 브랜치 · 앞 작업 브랜치에서 이어 가기 · 포트 구역) · **병합 문**(`accept` · `batch` — 플랫폼은 병합하지 않는다) |
| 조율 · 통신 | `claude agents --json`(산 세션) · 세션 간 메시지(`SendMessage` · 끝나면 알림) | **현황 한 화면**(`status`) · 같은 폴더 세션 경고 · 다른 세션이 커밋하지 않은 파일을 고치려 하면 묻기(board 훅) |
| 안전 | 샌드박스(native Windows 는 없음) · auto mode 분류기(확률적) | **guard 훅** — 셸 · PowerShell · MCP 의 파괴적 git · 비밀 파일 커밋 · 위험한 재귀 삭제를 결정적으로 막는다 |
| (필수) 병합 판정 | — | 병합 때 저장소 검사 **한 번** · 실패한 것만 한 번 더(흔들리는 시험) · 시간 초과는 "판정 불가" · 실패한 시험 이름 · 검사 줄(사용자 accept 가 앞) |
| (필수) 정리 | 자기가 만든 worktree | 하네스가 만든 worktree · 프로세스 · 컨테이너 · 임시 폴더 · 포트만(고유 표식으로 고른다) |

## 설치 · 갱신

```bash
git clone https://github.com/ghlee0786/dev.pilot
node dev.pilot/harness/cli.js install --root <내 저장소>
```

`<내 저장소>` 에 `harness/` 사본 · `AGENTS.md` 관리 블록 · `CLAUDE.md` 의 `@AGENTS.md` · Claude Code / Codex 훅 · `harness` 스킬이 들어간다.
**자동 갱신** — 하네스를 쓰는 시점에 하루 한 번 최신 릴리스를 확인해 백그라운드로 설치한다. 새 판에서 빠진 하네스 파일은 지운다(설치 기록에 하네스가 깐 것으로 적힌 것만). 손으로는 `node harness/cli.js update`(`--dry-run` 은 비교만) · 걷어 내기는 `uninstall`.

## 명령

말로 시키면 모델이 부른다 — 직접 칠 필요는 없다. 사용자가 할 일은 병합 · push 를 허락하는 것뿐이다.

| 명령 | 하는 일 |
|---|---|
| `start "<요청>"` | **레인** — 자기 worktree · 브랜치(`harness/<id>`) · 포트 구역. 그 폴더에서 세션을 열어 일하고 진행하며 커밋한다. `--from <id>` 는 앞 작업의 브랜치에서 이어 간다 · `--base <브랜치>` · 비슷한 작업이 있으면 알린다 |
| `status` | 레인 · 작업 · 산 세션(플랫폼 목록 · busy/idle) · 주인이 죽은 작업(DEAD) · 겹치는 파일 · 주인 없는 미커밋 변경 |
| `accept <id>` | 사용자 브랜치로 병합(사용자가 말한 뒤) — 검사 한 번 · 나빠졌을 때만 거절 · 커밋 안 된 대량 삭제는 커밋하지 않고 멈춤 · 검사가 다시 쓴 산출물은 되돌림 · 검사 뒤 문서만 들어오면 재검사 생략. 충돌은 그 레인에 병합을 남겨 두고 알린다(그 레인에서 풀고 다시 accept) |
| `batch <id>... \| --all \| --branch <이름>` · `batch accept <bid>` | 끝난 작업 · 브랜치를 `harness/batch/<bid>` 에 묶고(충돌하는 것은 건너뜀) 검사를 **한 번만** · `batch accept` 가 병합(사용자가 말한 뒤) · `batch status\|drop` |
| `check <id>` | 검사를 지금 돌려 기록(병합하지 않음) |
| `cancel <id>` · `restore <id>` | 병합 되돌리기(revert) · 되살리기 |
| `push [<remote>] [<branch>]` · `push --tag <이름>` | 빨리감기 push · 릴리스 태그(사용자가 명시한 뒤 · 강제 없음) |
| `gc` | 끝난 작업 정리 — 하네스가 만든 것만 |
| `toolkit` | 이 저장소 스택(C++ · Qt · .NET · Python · 웹 …)에 맞는 스킬 · MCP · 플러그인 중 있는 것 · 없는 것(이유 · 설치 방법) · 주의할 것(보관된 MCP 서버 등). 읽기만 한다 · 세션 시작 때 하루 한 번 한 줄로도 |
| `report --kind <bug\|intent\|improve> …` | 하네스 보고(아래) |
| `install` · `uninstall` · `update` · `version` | 설치 · 걷어 내기 · 갱신 · 판 |

사람 없이 맡길 일은 Claude Code 백그라운드 세션(`claude --bg "<요청>"`)으로 하고 끝나면 그 브랜치를 `accept` 한다. v6 의 `go` · `factory` · `resume` · `note` · `wait` · `stop` · `doc` · `metrics` · `insights` · `profile` 은 v7 에서 빠졌다(부르면 대신 쓸 것을 알려 준다). v6 에서 만든 작업은 그대로 `accept` · `cancel` 할 수 있다.

## 자동으로 도는 것(훅)

| 훅 | 하는 일 |
|---|---|
| guard(PreToolUse · 셸 · PowerShell · MCP) | `git push` · `reset --hard` · `clean -f` · `checkout -- .` · `rebase` · 직접 `merge` · `pull` · `stash` · `commit --amend` · 별칭 · `node -e`/`python -c` 로 감싼 git 쓰기 · MCP 의 git · GitHub 쓰기 도구 · 비밀 파일 add/commit · 루트 · 홈 · `.git` 재귀 삭제를 막는다. 훅이 실패하면 막는다 |
| track · stop · session-end | 세션이 고친 파일을 기록하고 그 파일만 커밋한다(다른 세션의 것은 건드리지 않는다) |
| board(세션 시작 · 요청 · 쓰기 전) | 같은 폴더의 다른 세션 · 비슷한 작업 알림 · 다른 세션이 커밋하지 않은 파일 쓰기 전 확인 · 레인 세션에 작업 환경(포트 · 임시 폴더 · 이름) · 하루 한 번 도구 점검 한 줄 |
| lang | 응답 언어 상기 |

## 프로젝트 설정

`AGENTS.md`(또는 `CLAUDE.md`)의 yaml 블록:

```yaml
test_command: "npm test"                 # 병합 판정 — 없으면 package.json · pytest · *.sln · ctest … 을 찾는다
lint_command: "npx eslint {files}"       # 두 번째 판정 — {files} 는 바뀐 파일
check_timeout_min: 20                    # 검사 상한(기본 15분)
rerun_failed: on                         # 실패한 검사 한 번 더(off 로 끈다)
serial_checks: on                        # 검사를 저장소 단위로 줄 세운다(기본 on · off 로 끈다)
port_range: "20000-39999"                # 레인마다의 포트 구역 범위 · port_block: 20
worktree_links: ["../SiblingRepo"]       # 저장소 밖 형제 폴더를 참조하는 빌드
outside_git_ok: ["data/*.db"]            # worktree 를 붙잡지 않는 런타임 부산물
cleanup_command: "python scripts/drop_test_data.py"   # 작업을 치울 때 git 밖 시험 데이터 정리(HARNESS_DATA_NS · HARNESS_TASK_ID 를 받는다)
reply_language: "Korean"                 # 출력 언어
bug_report: on                           # 하네스 보고 자동 발행(off 로 끈다)
auto_update: on                          # 최신 릴리스 자동 갱신(off 로 끈다)
```

## 하네스 보고 — 자동 이슈

하네스가 오류로 멈추거나, 의도와 다르게 행동하거나, 더 나은 방향이 보이면 이 저장소에 이슈가 **자동으로** 올라간다(세션에 건의를 말하면 `report --kind improve` 로 올린다).

- **하네스 동작만** 올라간다 — 프로젝트 코드 · 이름 · 경로 · 작업 내용은 넣지 않고, 남은 경로 · 사용자 · 호스트 · 메일 · 프로젝트 이름은 자동으로 가린다. 기준은 [CONTRIBUTING.md](CONTRIBUTING.md).
- 인증은 그 PC 의 GitHub 로그인(`HARNESS_GITHUB_TOKEN` · `GH_TOKEN` · `gh auth login` · git 자격 증명 관리자). 없으면 쌓아 두고 `report` 가 미리 채운 이슈 링크를 보여 준다.
- 같은 결함은 서명으로 묶여 재발 댓글이 된다 · 하루 새 이슈 5건 상한 · 설치된 사본에서만 켜진다 · `bug_report: off` 로 끈다.

## CI/CD

| 워크플로 | 언제 | 하는 일 |
|---|---|---|
| `ci.yml` | push · PR | Windows · Ubuntu · macOS × Node 20 · 22 에서 `node tests/run.js` |
| `release.yml` | `v*` 태그 | 3개 OS 테스트 → `harness/VERSION` 기록 → `harness-<판>.tar.gz` · `.zip` · `SHA256SUMS` 를 GitHub Release 로 |
| `issue-triage.yml` | 이슈 열림 | `[auto]` 이슈에 `auto-report` · 종류 라벨 |
| `self-hosted.yml` | 수동 실행 | 자체 러너에서 같은 테스트 |

## 검증

| 항목 | 결과 |
|---|---|
| 단위 테스트(모델 호출 없음 · 임시 저장소) | CI 에서 Windows · Ubuntu · macOS × Node 20 · 22 |
| 무인 루프 vs 맨 모델 + git · 세션 관리(Sol · 30과제 × 2 · 사전 등록) | 짝 60: 숨은 검사 통과 85% 대 83%(차이 없음) · 시간 1.24배 · 토큰 1.39배 — v7 에서 무인 루프를 뺀 근거 |
| 큰 C++ 저장소(하루 · 작업 64개) | 카드마다 전체 검사 · 직렬 잠금 · "되돌리고 다시" 로 병합 2건 · 끝난 브랜치를 묶어 검사 한 번 → 32분 · 1,187 통과 / 0 실패 — `batch` 의 근거 |
| 현장 결함 → 자동 이슈 → 수정 | 재현 테스트를 먼저 만들고 고쳐 닫는다 |

v7 자체는 아직 현장 실측이 없다 — 레인 · 묶음 병합 · 세션 현황의 효과는 써 보며 이 표에 더한다.

## 개발

```bash
node tests/run.js                      # 전체(모델 호출 없음 · 각 테스트는 자기 임시 디렉터리에서)
node tests/unit/test_v5_lane.js        # 하나만
```

고치기 전에 그 결함으로 빨개지는 테스트를 먼저 만든다. 자세한 기여 기준은 [CONTRIBUTING.md](CONTRIBUTING.md).

## 라이선스

[MIT](LICENSE)

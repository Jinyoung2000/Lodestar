# Lodestar 기능 참고 (한국어)

> 작성자가 개발하면서 쓴 기능 참고 문서를 그대로 옮긴 것이다. 영어 개요는 저장소 루트의 [README.md](../README.md) 에 있다. 본문이 가리키는 `docs/ACCEPTANCE-*.md`, `docs/TEST_PLAN.md`, `.verify/` 같은 검증 기록은 공개 저장소에 들어 있지 않고, 일부 문장(예: 끝의 "아직 없는 것")은 지금 코드보다 오래됐을 수 있다. 코드와 다르면 코드가 맞다.

(레포와 npm 패키지 이름은 `agent-nav`, 앱 표시 이름은 Lodestar. 번들 id, `~/.agent-nav`, `AGENT_NAV_*` 환경변수, 앱 데이터 폴더는 옛 이름 그대로다.)

Claude Code 세션을 프로젝트별, worktree 별로 여러 개 돌리면서 VS Code 에이전트 창처럼 보고 조작하는 로컬 앱. 대화, 변경 diff(덩어리별 유지와 되돌리기), LSP 코드 탐색, 터미널, git 동기화가 한 창에 있다.

- 제목줄(VS Code 식): 신호등 옆 사이드바 토글, 뒤로/앞으로, 가운데 Command Center(폴더와 브랜치, 새 세션 화면은 `New Session` 접두, 누르면 세션 검색 ⌃⌥R, 옆 아이콘은 파일 열기 ⌘P와 세션 폴더를 VS Code 창으로 열기), 오른쪽에 git 동기화(ahead/behind), fetch, 패널 토글 셋(사이드바, 아래, 오른쪽). 빈 곳은 창 끌기 영역이고 브라우저 탭에서도 같은 줄이 보인다
- 왼쪽 사이드바: New Session(키캡 ⌘ N), Board, Inbox, 설정과 상태, 워크스페이스 추가, Sessions(필터 메뉴, 검색, 더보기). 세션 행은 두 줄(상태 아이콘, 제목, 폴더 또는 worktree 아이콘, 변경량 +N -M, 상대 시간)이고 진행 중은 `Working...`, 승인 대기는 `Input needed` 와 행 안 `Allow` 카드, 안 읽음은 파란 점이다. 행 hover 의 pin(고정)과 check(완료), 우클릭 메뉴(이름 바꾸기 F2, 안 읽음, 완료 ⌘Backspace, 링크 복사). 묶음은 폴더 없는 세션 `Chats`(처음에는 접혀 있다가 퀵 챗이 생기면 펼쳐진다. ⌘K ⌘N 퀵 챗, 또는 새 세션 화면의 폴더 알약에서 `Chat` 선택. `~/.agent-nav/chats/<세션 id>` 빈 폴더에서 돌고 git, 파일, 변경이 없다), 세션이 있는 폴더(이름순, 세션이 하나도 없는 폴더는 머리를 그리지 않는다), 접힌 `Pinned` 와 `Done` 이고 필터 메뉴의 Ordering, Grouping(Time 또는 Workspace), Show(Recent 는 묶음당 5개 뒤 `+N more`, 펼치면 `Show less`), Show Done, Reset Filters 는 `localStorage` 에 남는다. 갈래(fork) 세션은 "Forked: 원래 제목" 으로 원 세션 아래에 twistie 와 안내선으로 붙는다
- 가운데: 세션 격자. 사용자 메시지는 오른쪽 말풍선, 도구 호출은 "N단계 완료, Xs" 로 접힘(펼치면 한 줄 요약, 단계가 하나면 묶음 없이 그 한 줄만, 경과 시간에는 승인 대기가 들어가지 않는다), 답은 본문. 입력창 위에 변경 요약 칩(`N Files +a -b`, 변경이 없으면 숨김)과 PR 칩, 입력창 안의 도구줄에 첨부, 모델(버전까지, 마지막 턴에서 실제로 쓰인 모델), effort, 보내기와 중단, 입력창 밑에 권한 모드 줄. 응답 중에도 입력창이 열려 있고 세션 동안 CLI 프로세스를 하나 유지한다(유휴 30분 뒤 닫고 다음 메시지가 resume. 프로세스가 사는 동안 작업 폴더를 1초 간격으로 확인해 지워지면 진행 중인 턴을 중단하고 `workingDirectoryFailed` 오류로 바꾼다. 폴더가 다시 생기면 다음 전송은 평소처럼 이어진다). 새 세션 화면은 가운데에 폴더 알약, 입력창, 아래 줄에 권한 모드와 위치(Branch 또는 New Worktree)이고, 모델과 effort 는 마지막으로 고른 값을 이어받는다(고른 적이 없으면 VS Code 값. Settings 에 `last used` 로 보이고 Reset 으로 지운다). 오른쪽 패널의 첫 탭은 Files 이고 고른 폴더의 트리를 보인다
- 오른쪽: Changes 탭(머리의 메뉴로 Branch, Uncommitted, Session, Last Turn 범위를 고른다. 기본 폭 300px 에서는 파일 행 목록, 칩이나 행을 누르면 580px 로 넓어져 파일별 테두리 카드(머리에 닫기 X, 경로 복사, `...` 메뉴의 Keep All 과 Undo All, Viewed), 숨은 줄 접기, 덩어리별 유지/되돌리기(diff 안 덩어리에 마우스를 올리면), 바뀐 파일 목록 열, Checks. 처음 범위는 VS Code 처럼 Branch 이고 갈래만 Session), Files 탭(작업 폴더 전체 트리), 탭줄 `+`(Search 메뉴), 파일/diff 탭(LSP 에디터). Last Turn 은 턴이 시작될 때 바뀌어 있던 파일 내용을 `~/.agent-nav/lastturn/` 에 저장해 두고 비교한다(마지막 턴 하나만)
- Source Control 탭(오른쪽 패널의 세 번째 고정 탭, ⌃⇧G): 지금 칸 세션의 작업 폴더 저장소(세션이 없으면 새 세션 화면에서 고른 폴더, 그것도 없으면 마지막으로 연 작업 폴더)의 스테이징과 커밋 화면. 커밋 메시지 입력(⌘Enter 로 커밋, 반짝이 단추는 스테이지된 diff 로 메시지 초안을 만들고 모델은 Quick Ask 모델), Commit 단추와 옵션(Commit & Push, Commit & Sync, Commit (Amend), Undo Last Commit), Merge Changes, Staged Changes, Changes 묶음(목록과 트리 전환, 행 hover 의 Open File, Open Changes, Discard, Stage, 묶음 머리의 Stage All, Unstage All, Discard All), 아래에 Worktrees(등록한 저장소의 `git worktree list`, 누르면 그 worktree 로 새 세션 화면)와 Graph(최근 커밋 50개, 누르면 파일 목록과 diff). 버리기는 앱 안 확인을 거치고 새 파일은 휴지통으로 옮긴다. 커밋 훅이 실패하면 출력 전문을 보이고 `Commit Without Hooks` 는 그 단추를 눌렀을 때만 `--no-verify` 로 다시 한다. 서버는 `server/scm.ts`, 화면은 `web/SourceControl.tsx`. 확인은 `docs/ACCEPTANCE-scm.md`
- diff 줄 피드백(VS Code 에이전트 창의 Add Feedback): 변경 패널 diff(inline, split 의 현재 칸), diff 탭, 에디터 탭에서 줄 번호 위 `+` 를 누르거나 글자를 끌어 고르면 선택 끝 줄 아래에 `Add Feedback` 상자가 뜬다. Enter 로 쌓고(줄 옆 accent 줄, 오른쪽 위젯, 변경 행의 수, 입력창 위 칩), ⌥Enter 는 추가하고 바로 보낸다. 쌓인 것은 입력창의 보내기나 패널 머리의 `Submit Feedback (N)` 으로 한 메시지로 간다. 말풍선에는 글과 칩(`파일:줄`, 누르면 그 위치)만 보이고 모델에는 경로, 줄 범위, 선택한 코드, diff 조각이 간다. 응답 중에는 큐 규칙을 따르고, 쌓인 것은 `~/.agent-nav/diff-feedback/` 에 남는다. 확인은 `docs/ACCEPTANCE-diff-feedback.md`
- 데스크톱 앱 알림: 창이 포커스를 잃었을 때만 응답 완료(`Session finished.`)와 승인 요청(`Allow` 버튼)을 macOS 알림으로 알린다. 알림을 누르면 그 세션이 열리고, Settings 의 Notifications 에서 둘을 따로 끈다
- 오른쪽 패널의 파일 편집(에디터 탭): 파일 탭은 읽기 전용이 아니라 편집하고 저장한다. ⌘S 로 저장하고(저장 안 한 변경은 탭에 점, 닫으려 하면 Save, Don't Save, Cancel 확인), 저장은 작업 폴더 안 경로만 받고 읽은 뒤 에이전트가 같은 파일을 바꿨으면 덮어쓰지 않고 VS Code 의 저장 충돌 알림과 같은 문구의 안내줄(Compare, Overwrite)을 띄운다. 저장하면 LSP 에 변경과 didSave 를 보내 진단, 자동완성, 시그니처 도움말, 정의 이동이 편집 내용 기준으로 맞고, 변경 패널도 바로 갱신된다. 이름 없는 새 탭(탭줄 `+` 의 New Untitled Text File, 팔레트)은 ⌘S 때 경로를 묻는다. 포맷은 사용자의 VS Code 설정을 읽기만 해서 고른다: 언어별 `[typescriptreact]` 의 `editor.defaultFormatter` 가 이기고 그다음 최상위 값이며, 작업 폴더의 `.vscode/settings.json` 이 사용자 `settings.json` 위에 얹힌다. Settings 의 Formatter by language 에서 언어마다 따로 고를 수 있고(고르지 않으면 VS Code 값, 출처 표시) 그 값이 앞선다. 도구는 VS Code 확장이 찾는 순서대로 찾는다: Oxc 확장은 `oxc.path.oxfmt`, vite-plus, 작업 폴더와 하위 패키지의 `node_modules/.bin`, 상위 폴더 모듈, npm, pnpm, bun 전역, PATH 순이고, Prettier 확장은 파일 폴더에서 위로 `node_modules/prettier` 를 찾고 없으면 확장에 번들된 prettier 를 쓰며(`prettier.prettierPath`, `prettier.ignorePath`, `prettier.requireConfig` 반영), ESLint 확장은 `eslint.format.enable` 이 켜져 있을 때 JS 와 TS 만 `eslint --fix-dry-run` 으로 포맷한다. 설정한 포맷터를 못 쓰면 다른 것으로 몰래 바꿔 포맷하지 않고, VS Code 와 같은 문장(`Extension 'Oxc' is configured as formatter but it cannot format 'TypeScript'-files` 등)의 알림에 `Format with ...`(이번 한 번만)와 `Configure Default Formatter`(Settings 의 해당 구역)를 달아 알린다. 저장 때 포맷(Format On Save)에서 포맷터가 없으면 저장은 그대로 하고 알림만 띄운다. 알림은 창 오른쪽 아래에 쌓이고 입력창 위로 비켜 선다. 도구가 실패하면 내용은 그대로 둔다. 자세한 확인은 `docs/ACCEPTANCE-format.md`. Settings 의 Format On Save(고른 값이 없으면 VS Code 의 `editor.formatOnSave`, 없으면 끔)가 켜져 있으면 저장 때 포맷한다
- 오른쪽 패널의 탭과 그룹: 파일, diff, Browser, Search 탭은 VS Code 처럼 끌어서 순서를 바꾼다(끄는 동안 놓일 탭의 왼쪽에 흰 2px 선과 탭 모양 이름표, 그룹 본문에 놓을 곳은 테두리 없는 회색 채움, 변경과 파일 탭은 고정이라 `web/tabOrder.ts` 의 filesIndex 규칙대로 그 앞뒤 구역만 오간다). 순서와 그룹 배치는 창을 다시 읽어도(⌘R, 피드백 반영) 이어진다. 에디터 영역은 VS Code 에디터 그룹처럼 좌우, 상하로 나뉜다: 탭 우클릭의 Split Right 와 Split & Move(Up, Down, Left, Right), 탭줄 오른쪽의 분할 단추(⌥ 를 누르고 누르면 아래), 탭을 다른 그룹의 탭줄이나 본문에 끌어놓기(가장자리에 놓으면 그 방향에 새 그룹), 그룹 사이 경계 끌어 크기 조절(더블클릭은 같은 크기), 비게 된 그룹은 닫힘. 그룹마다 자기 활성 탭이 있고 정의 이동은 지금 활성 그룹에서 연다. 같은 파일을 두 그룹에 열지는 않는다(탭을 옮긴다). 다른 그룹에 이미 열려 있는 파일은 그 탭을 보인다. 탭 우클릭 메뉴는 VS Code 의 항목과 순서(Close, Close Others, Close to the Right, Close Saved, Close All, Copy Path, Copy Relative Path, Copy Breadcrumbs Path, Add File to Chat, Reveal in Explorer View, Split Right, Split & Move)를 따르고 이 앱에 대응이 없는 항목(Reopen Editor With..., Keep Open, Pin, 새 창으로 옮기기, Find File References)은 뺐다. Files 탭의 펼침과 고른 행은 탭을 바꿔도 남는다
- Files 탭 머리줄의 New File..., New Folder...(우클릭 메뉴, 팔레트의 File: New File... 도 같다)은 고른 폴더 아래에 인라인 이름 입력을 열고 Enter 로 만든다(Esc 취소, 이미 있는 이름은 입력 아래에 오류). 만든 파일은 바로 에디터 탭으로 열리고 변경 패널에 Added 로 보인다. 빈 폴더도 트리에 보인다
- 아래: Output(데몬 로그) | Terminal(세션 cwd 의 진짜 셸, 추가/나란히/닫기)
- 곁다리 대화(`/btw`): 메인 세션의 대화를 그대로 알고 답하는 사이드 챗. 메인 기록은 바뀌지 않는다
- 모양은 `design-system/` 의 디자인 시스템(토큰, 치수, 컴포넌트 규칙)을 따른다. 다크가 기본이고 설정에서 라이트와 시스템을 고를 수 있다
- 패널 경계(사이드바와 대화, 대화와 오른쪽 패널, 본문과 아래 패널)는 VS Code 처럼 끌어서 크기를 바꾼다. 4px 잡기 영역, hover 와 끄는 동안 accent 선, 더블클릭은 기본 크기. 사이드바 200~400px, 오른쪽 패널 300px 이상(대화 칸은 한 열이면 300px, 여러 열이면 360px 이상), 아래 패널 120px 이상. 사이드바와 아래 패널 크기는 `localStorage` 의 `agent-nav:layout` 에 남아 다시 열어도 유지된다. 오른쪽 패널 폭은 세션마다 이 실행 동안만 기억하고(칩으로 넓힌 580px 도 그 세션에만), 새 세션 화면과 퀵 챗은 늘 300px 로 시작한다

모든 모델 호출은 `~/.local/bin/claude` 를 Agent SDK 로 띄워서 한다. API 키를 쓰지 않고 키체인 로그인(Claude 구독)을 그대로 쓰므로, 터미널 Claude Code 와 같은 MCP 서버(Slack, Notion, claude.ai 커넥터), 스킬, 훅, 허용 목록을 받는다.

## 실행

전제: Claude Code CLI 가 `~/.local/bin/claude` 에 있고 `claude auth login` 이 되어 있다. 다른 경로면 `AGENT_NAV_CLAUDE` 로 지정한다. 터미널 패널은 `@lydell/node-pty` 의 prebuilt 바이너리를 쓴다 (Node 와 Electron 둘 다에서 로드됨, 별도 빌드 없음).

```bash
npm install
npm run build        # 웹(dist/)과 Electron 번들(dist-electron/)
npm run app          # Electron 창 (데몬을 함께 띄운다)
npm run icon         # build/icon.svg 에서 build/icon.icns, icon.png, public/favicon.svg 를 다시 만든다 (--preview 는 .verify/screens/icon-*.png)
npm run dist         # release/mac-arm64/Lodestar.app (서명 없음)
```

`AGENT_NAV_INACTIVE=1` 로 띄우면 창을 앞으로 가져오지 않는다(`showInactive`). 검증 창구(`AGENT_NAV_E2E_PORT`)가 켜져 있을 때도 같다.

브라우저로 쓰려면 데몬만 띄우고 `http://127.0.0.1:7788` 을 연다. 포트는 `AGENT_NAV_PORT`. 설치된 앱이 7788 을 들고 있으면 먼저 끈다 (`osascript -e 'quit app "Lodestar"'`).

```bash
npm start
```

Claude Code 세션 안에서 띄울 때는 상속된 세션 변수를 빼고, 로그는 파이프 말고 파일로 보낸다 (파이프를 읽지 않으면 데몬이 EPIPE 로 멈춘다).

```bash
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SSE_PORT npm start > /tmp/agent-nav.log 2>&1 &
```

## Pull Requests

사이드바 `Pull Requests` 구역(접힘 기본)이 워크스페이스의 GitHub 원격(fork 면 upstream 도)에서 `Waiting For My Review`, `Assigned To Me`, `Created By Me`, `All Open` 을 저장소별로 보인다. 행을 누르면 가운데에 PR 화면이 열린다: Overview(설명, 리뷰어, 라벨, 체크, 타임라인)와 Files Changed(파일별 +/-, Viewed, inline 또는 split diff, 줄 번호를 눌러 끌면 줄 코멘트와 ```suggestion). 코멘트는 `Add single comment` 으로 바로 올리거나 `Start a review` 로 대기 리뷰에 쌓고, 머리의 `Review` 에서 Comment, Approve, Request Changes 로 제출한다. `Checkout` 은 PR 브랜치를 worktree 로 열고 그 폴더로 새 세션 입력창을 연다. 변경 패널 오른쪽 열의 Checks 는 지금 세션 브랜치의 PR 과 체크 상태를 보인다.

- 데이터는 `gh` CLI(이미 로그인된 것)로만 읽고 쓴다. 토큰을 읽거나 저장하지 않는다. gh 가 없거나 로그인 안 됐으면 구역에 안내가 뜬다.
- GitHub 에 쓰는 동작은 화면의 버튼을 눌렀을 때만 가고, 데몬은 `confirmed: true` 가 없는 `pr.*` 쓰기 요청을 거절한다. 자동 갱신(구역 `...` 메뉴, 기본 5분)은 읽기만 한다.
- 시험은 `test/fixtures/pr/bin/gh`(가짜 gh, 인자를 `$FAKE_GH_LOG` 에 남김)를 PATH 앞에 두고 한다. 실제 저장소를 읽는 시험은 `test/fixtures/pr/guard-gh/gh`(읽기만 통과) 뒤에서 한다. 자세한 확인 결과는 `docs/ACCEPTANCE-pr.md`.

## 칸반 보드

사이드바 "Board"(⇧⌘K)를 누르면 가운데 영역이 칸반 보드로 바뀐다(세션 칸은 숨겨 둘 뿐이라 돌아오면 그대로). 외부 서비스와 동기화하지 않는 로컬 보드다.

- 기본 열 Backlog, Todo, In Progress, Review, Done. 열 메뉴에서 이름 바꾸기, 좌우 이동, 삭제(카드는 앞 열 끝으로), 오른쪽 끝에서 열 추가
- 카드는 제목, 마크다운 설명, 텍스트 라벨, 워크스페이스, 연결된 세션(상태 점), 링크(http, https)를 가진다. 눌러서 열면 오른쪽 패널 "Card" 탭에서 편집한다
- 끌어서 열 이동과 순서 바꾸기는 포인터로, 키보드는 카드에 포커스를 두고 ⌥←→↑↓. 상단 검색(제목, 설명, 라벨)과 워크스페이스 필터
- Start Session(또는 Start in Worktree)은 카드의 워크스페이스에서 새 세션 입력창을 열고 제목과 설명을 초안으로 채운다. 보내는 순간 세션이 카드에 연결된다. 세션 행 메뉴 "Add to Board"는 세션으로 카드를 만들고, 대화 칸 머리의 칩은 그 카드를 연다
- 자동 이동(Settings 의 Board, 기본 켬): 연결된 세션이 턴을 시작하면 Backlog 와 Todo 의 카드를 In Progress 로, 턴이 변경 파일이 남은 채 끝나면 In Progress 의 카드를 Review 로 옮긴다. 열은 이름이 아니라 역할(role)로 찾아서 이름을 바꿔도 규칙이 유지되고, 그 열을 지우면 규칙이 건너뛴다. Done 은 사람만 옮긴다
- 저장은 `~/.agent-nav/board.json`(임시 파일에 쓴 뒤 rename). 다른 입력(예: Slack)에서 카드를 만들 때는 RPC `board.createCard({ title, body, links, workspaceId? })`

## Automations (예약 작업)

사이드바 "Automations"(Slack 아래, Notes 위)는 정해 둔 프롬프트를 일정에 맞춰 세션으로 돌리는 작업 목록이다. 명령 팔레트 "Automations: Open", "Automations: New Automation" 으로도 연다. 웹훅 트리거는 없다(데몬은 127.0.0.1 만 듣는다).

- 일정은 세 가지: Interval(5분에서 1440분 간격), Daily(시각과 요일, 기본 월~금), Once(정한 날짜와 시각에 한 번, 돈 뒤 스스로 꺼짐). 시각은 이 Mac 의 현지 시간이다
- 실행할 곳은 New session(폴더를 고르고, 원하면 실행마다 새 worktree 를 `automation/<제목>-<날짜-시각>-<4자리>` 브랜치로 만든다. Base branch 를 비우면 기본 브랜치) 또는 Existing session(그 세션에 프롬프트를 보낸다). 새 세션은 작업에 정한 모델, Effort, 권한 모드로 시작하고, 그 권한 모드보다 더 자동으로 승인하지 않는다. 세션은 평소처럼 CLI 에 로그인한 계정으로 돈다
- 목록은 답이 필요한 작업(Needs input, Failed)이 위다. 행마다 상태(Running, Needs input, Failed, Paused, Next run in ...), 마지막 실행과 Open session, Run now, 켜고 끄는 스위치가 있다. 실패한 작업은 마지막 오류를 한 줄로 보인다. 행을 누르면 오른쪽에 프롬프트, 일정, 세션, 모델 요약과 Run history(시각, Scheduled, Catch-up, Manual, 결과, 세션 열기)가 나온다. 편집과 새로 만들기는 화면 위에 뜨는 대화상자, 삭제는 상세 머리줄 더보기 메뉴에서 확인을 거친다
- 사이드바 Automations 항목의 숫자는 답을 기다리는 작업 수다. 자동화가 시작한 세션 행 둘째 줄 끝에 시계 표시가 붙고, 누르면 그 자동화가 열린다(세션 메뉴 "Open automation" 도 같다)
- 실행 결과는 세션 상태를 따른다. 턴이 정상으로 끝나면 Succeeded, 오류로 끝나면 Failed(마지막 오류 문구), 승인 카드가 뜨면 Needs input 이다. 세션이 지워지거나 2분 안에 시작하지 않거나 Lodestar 가 도중에 꺼지면 Failed 로 남는다
- 세션 안의 에이전트는 `lodestar automation` 으로 같은 작업을 만들고 다룬다: `list`, `show`, `create --every N | --daily HH:MM [--days mon,wed] | --once "YYYY-MM-DD HH:MM"`(대상은 기본으로 지금 폴더가 든 워크스페이스의 새 세션, `--workspace`, `--worktree [--base]`, `--session <ref>` 로 바꾼다. `--title`, `--model`, `--effort`, `--permission`, `--paused`), `run`, `pause`, `resume`, `delete`. 권한 모드를 안 주면 새 세션 기본값을 쓴다. 자동화 기능이 없는 이전 앱에 붙으면 업데이트하라고 알리고 멈춘다
- 스케줄러는 60초마다 돈다. 앱이 꺼져 있던 동안 놓친 회차는 켜진 뒤 한 번만 Catch-up 으로 돈다. 같은 작업의 이전 실행이 아직 돌거나 답을 기다리면 이번 회차는 Skipped(이유 함께)로 남고, 대상 세션이 바쁠 때도 같다. 동시에 도는 실행은 기본 2개(`automationConcurrency`, 1~10)이고 넘치면 다음 틱까지 기다린다. Run now 는 일정과 상관없이 바로 돈다
- 테스트와 E2E 인스턴스(`AGENT_NAV_INACTIVE=1`, `AGENT_NAV_E2E_PORT`, `AGENT_NAV_NO_MENTIONS=1`)에서는 자동으로 돌지 않는다. 수동 확인 때는 `AGENT_NAV_AUTOMATIONS_AUTO=1` 로 켠다
- 저장은 `~/.agent-nav/automations.json`(임시 파일에 쓴 뒤 rename). 실행 기록은 작업마다 최근 50개를 남기고, 목록과 상세는 최근 10개를 보인다. RPC `automations.list`, `create`, `update`, `delete`, `setEnabled`, `runNow`, `runs`, 이벤트 `automations`

## Mate (상시 에이전트)

사이드바 New Session 아래의 "Mate" 는 끝나지 않는 대화 하나로 사는 에이전트다. 사용자의 세션들을 지켜보다가 결정이 필요한 일을 먼저 말해 주고, 시키면 세션에 답을 보내거나 새 세션을 시작한다. OpenAI Dots, Claude Duet, Meta Muse 와 같은 부류이고, 지켜보는 범위는 Lodestar 의 세션이다. 명령 팔레트 "Mate: Open" 으로도 연다.

- 화면은 둘로 나뉜다. 왼쪽은 대화(가운데 위에 아이콘, 이름, 상태 줄. 그 아래 말풍선과 카드, 맨 아래 입력칸), 오른쪽은 Mate 가 지켜보는 것의 탭 넷이다: Tracking(Follow-ups 장부), Reminders(Mate 가 건 리마인드와 미뤄 둔 결정), Activity(체크인 기록: 언제, 왜, 말을 했는지), Notes(메모 파일을 그 자리에서 고치고 저장). 화면 폭이 720px 보다 좁으면 대화만 남는다
- 대화 안의 카드: 체크인에서 알린 결정은 Mate 의 말 아래에 결정 카드로 붙는다(세션 제목, 기다린 시간, 질문, 선택지 단추). 선택지를 누르면 "Send "5회" to <세션>?" 확인이 뜨고 Send 가 그 세션에 메시지로 보낸다(Mate 를 거치지 않는다). Later 는 미루고 Not needed 는 장부에서 뺀다. 미뤄 둔 결정은 카드로 나오지 않는다. Mate 가 행동하려 할 때는 승인 카드(Allow, Skip)가 뜬다
- Mate 는 Lodestar 세션 하나다(`assistant: true`, 작업 폴더 `~/.agent-nav/assistant`, 워크스페이스 없음). 세션 목록, 아침 리뷰, 자동 완료 처리, Follow-ups 추적에서는 빠진다. 처음 모델은 sonnet 이고, 머리줄 더보기의 Open as a session 으로 보통 세션 칸에서 열어 모델과 권한 모드를 바꾼다. 지우면 1분 안에 새로 생긴다(대화는 새로 시작)
- 체크인: Lodestar 가 Mate 에게 보내는 자동 메시지다. 대화에는 "Check-in, 9:30 AM" 한 줄로 보인다. 깨우는 때는 넷이다. 세션이 답에서 결정을 묻고 멈춘 것이 새로 잡혔을 때(10분에 한 번으로 묶는다), 열린 결정의 리마인드 기한이 됐을 때, Mate 가 스스로 건 리마인드가 됐을 때, 하루 한 번 아침 브리핑(Board 의 Review time, 추적 중인 일이 있을 때만). 머리줄의 새로 고침 단추는 지금 상황을 묻는 체크인을 바로 보낸다. 스스로 깨는 것은 하루 30번까지다
- 체크인에서 말할 것이 없으면 Mate 는 NOTHING 만 답하고, Lodestar 는 그 체크인과 답을 대화에서 지운다. 안 읽음 표시도 붙지 않고 Activity 에 "Nothing to report" 로만 남는다. 말할 것이 있으면 대화에 쓰고, 창이 뒤에 있으면 macOS 알림(제목 Mate, 본문은 첫머리)으로 알린다
- 도구(`lodestar_work` 서버). 묻지 않고 실행: `list_work`(장부를 세션 id 와 함께), `read_session`(한 세션의 마지막 메시지와 대기 중인 카드), `set_reminder`, `list_reminders`, `cancel_reminder`, `snooze_decision`, `dismiss_decision`, `rename_session`, `pin_session`. 매번 승인 카드: `send_to_session`(그 세션에 사용자가 친 것처럼 보낸다), `start_session`(워크스페이스에 새 세션), `mark_done`, `answer_question`(세션의 질문 카드에 답한다), `respond_to_approval`(세션이 기다리는 도구 호출을 허용하거나 거절한다. 카드에 그 도구 호출이 보인다), `stop_session`(도는 턴을 멈춘다). Mate 의 작업 폴더 안 파일 쓰기는 묻지 않고, 그 밖의 도구(Bash 등)는 보통 세션처럼 묻는다
- 메모: 작업 폴더의 `CLAUDE.md` 가 Mate 의 장기 기억이다. 시작할 때마다 읽히고, 사용자가 추적 방식을 말하면 Mate 가 적는다
- 사이드바 항목 오른쪽 끝: 열린 결정이 있으면 그 수, 없고 안 읽은 말이 있으면 점
- Mate 가 켜져 있으면 열린 결정의 리마인드는 따로 알림을 내지 않고 Mate 가 대화에서 전한다. 꺼져 있으면 Follow-ups 가 직접 알림을 낸다
- 폰: 세션 목록 맨 위에 Mate 줄(아이콘, 상태, 열린 결정 수 또는 안 읽음 점)이 있고 누르면 Mate 화면이 열린다. 위에 아이콘과 이름과 상태, 그 아래 탭 셋: Chat(말풍선, 결정 카드, 승인 카드, 입력칸), Tracking(장부, Looks finished 는 Mark done), Reminders. 폰에서는 메모를 고치지 않는다. Mate 는 보통 세션 목록에 섞이지 않고, 세션 링크로 열어도 Mate 화면으로 간다
- 폰 알림: 안드로이드는 기존 세션 알림 서비스(Settings 의 알림 스위치)가 Mate 의 말과 세션의 승인 대기를 알린다. 조용한 체크인은 알리지 않는다. iOS 용으로는 데몬에 Expo 푸시 발송 경로가 있다(`mobile.registerPush` 로 기기 토큰을 받은 기기에만, Mate 가 먼저 말했을 때와 세션이 승인, 질문, 계획 확인을 기다리기 시작했을 때 제목과 본문을 `exp.host` 로 보낸다). 앱 쪽 토큰 등록은 아직 없어서 지금은 아무것도 보내지 않는다
- Settings 의 Mate: 켜고 끄기(끄면 사이드바 항목이 사라지고 스스로 깨지 않는다), 아침 브리핑, 세션 추적, 리마인드, 추적 모델
- 테스트와 E2E 인스턴스에서는 Mate 세션을 만들지 않고 스스로 깨지 않는다. 수동 확인 때는 `AGENT_NAV_ASSISTANT_AUTO=1`. 푸시는 그런 인스턴스에서 보내지 않고, `AGENT_NAV_PUSH_URL` 을 주면 그 주소로만 보낸다
- 저장은 `~/.agent-nav/assistant.json`(리마인드, 이미 전한 결정, 체크인 기록 40개). RPC `assistant.get`, `checkIn`, `cancelReminder`, `readNotes`, `writeNotes`, 이벤트 `assistant`. 폰에는 `followUps.get`, `snooze`, `dismiss`, `keepOpen`, `assistant.get`, `checkIn`, `cancelReminder` 와 두 이벤트를 연다

## Follow-ups (진행 중인 일과 미룬 결정)

Follow-ups 는 데몬이 세션들을 스스로 살펴서 만든 목록이고 Mate 가 일하는 장부다. 사용자가 적는 것은 없다. Mate 화면 오른쪽의 Tracking 탭에 보인다.

- 세 구역이다. Needs a decision(세션이 사용자의 결정을 기다리는 일), In progress(지금 도는 세션과 최근 일주일 안에 멈춘 세션), Looks finished(끝난 것 같은 세션)
- 결정은 두 길로 찾는다. 승인 카드, AskUserQuestion 질문, 확인을 기다리는 계획은 타임라인에서 바로 읽는다(모델을 부르지 않는다). 턴이 끝난 세션은 마지막 답이 사용자에게 고르거나 확인해 달라고 묻고 끝났는지를 모델이 읽는다(Asked in reply). 모델은 세션마다 decision, paused, finished 중 하나와 한 문장을 돌려주고, 그 문장이 행에 보인다. 사용자가 쓰는 언어로 쓴다
- 모델은 턴이 끝나고 2분이 지난 세션만, 마지막 확인 뒤로 바뀐 세션만 읽는다. 한 번에 8개까지 묶고 1분 틱마다 두 묶음까지, 하루 60번까지 부른다. 일주일 넘게 조용한 세션은 읽지 않는다. Check now 는 기다리지 않고 지금 읽는다(한 번에 다섯 묶음까지). 모델은 Settings 의 Follow-ups 에서 고르고 기본은 haiku 다. 도구가 없는 일회성 CLI 세션(`persistSession: false`)이라 대화 기록이 남지 않는다
- 결정 행에서 바로 답한다. Asked in reply 행은 선택지 칩을 누르면 답장 칸에 채워지고 Send 가 그 세션에 메시지로 보낸다(`agents.send`). 승인, 질문, 계획 행은 Open session 으로 그 세션의 카드에서 답한다. 사용자가 그 세션에 메시지를 보내거나 카드에 답하면 행은 스스로 사라진다
- 리마인드: 결정이 열린 채로 1시간이 지나면 macOS 알림(창에 포커스가 있으면 앱 안 토스트)으로 다시 알리고, 그 뒤 4시간, 다음 날 아침, 2일 뒤 아침, 7일 뒤 아침에 한 번씩 더 알린 다음 멈춘다. 21시부터 아침(Board 의 Review time, 기본 09:30)까지는 보내지 않고 아침으로 미룬다. 같은 틱에 기한이 된 결정이 여럿이면 알림 한 장으로 합친다. Remind me 는 In 2 hours, Tomorrow morning, Next week 로 미루고, Not needed 는 그 결정을 목록에서 뺀다(같은 답에 대해 다시 올리지 않는다)
- Looks finished 행의 Mark done 은 세션을 완료로 표시하고, Not finished 는 In progress 로 돌려보낸다
- 평일 3일 동안 조용한 세션을 완료로 넘기는 자동 정리는 리마인드가 남아 있는 결정이 있는 세션을 건너뛴다. 마지막 리마인드까지 답이 없으면 그 세션도 자동 정리 대상으로 돌아간다
- 피드백 세션, 자동화가 시작한 세션, 완료로 표시한 세션은 목록에 넣지 않는다
- Settings 의 Follow-ups: 켜고 끄기(끄면 사이드바 항목과 명령이 사라지고 세션을 읽지 않으며 모델도 부르지 않는다), 리마인드 켜고 끄기, 모델
- 테스트와 E2E 인스턴스(`AGENT_NAV_INACTIVE=1`, `AGENT_NAV_E2E_PORT`, `AGENT_NAV_NO_MENTIONS=1`)에서는 모델을 스스로 부르지 않는다. 수동 확인 때는 `AGENT_NAV_FOLLOWUPS_AUTO=1` 로 켠다
- 저장은 `~/.agent-nav/followups.json`(임시 파일에 쓴 뒤 rename). RPC `followUps.get`, `check`, `snooze`, `wake`, `dismiss`, `keepOpen`, 이벤트 `followUps`

## Slack Inbox

사이드바 "Inbox"(⇧⌘L)는 사용자에게 온 Slack 멘션, DM, 참여한 스레드의 새 답글을 한 목록에 보인다. 읽기 전용이고 Slack 으로는 아무것도 보내지 않는다(메시지, 리액션, 읽음 표시 모두).

- 가져오기는 데몬이 Agent SDK 로 띄우는 일회성 CLI 세션(haiku)이 한다. Slack 토큰을 따로 받지 않고, `~/.claude.json` 의 `mcpServers.slack` 설정을 그대로 쓰며 인증은 CLI 가 키체인에서 읽는다. 세션은 이 서버만 연결하고, 내장 도구는 없고, 읽기 도구 3개(`slack_search_public_and_private`, `slack_read_thread`, `slack_read_user_profile`)만 허용한다. 쓰기 도구 13개는 `disallowedTools` 로 막고 PreToolUse 훅으로 한 번 더 막으며, 세션 init 의 도구 목록에 쓰기 이름이 보이면 가져오기를 중단한다
- 데몬은 모델의 말이 아니라 도구 결과(tool_result)를 파싱한다 (`server/inboxParse.ts`). 형식과 확인 내용은 `docs/ACCEPTANCE-v6-slack.md`
- 범위는 멘션, DM, 스레드 답글. 처음은 최근 24시간, 이후는 마지막으로 가져오기 시작한 시각부터(5분 겹쳐 읽고 `채널:ts` 로 중복 제거). 주기는 Settings 의 Slack Inbox(끔, 5, 10, 30분, 기본 10분)와 Inbox 의 새로 고침 버튼. 앱이 떠 있는 동안만 돈다
- 목록은 보낸 사람, 채널, 첫 줄, 시각, 종류. 항목을 열면 오른쪽 Slack 탭에 본문, 스레드("Load thread" 를 누를 때만 읽음), https 링크와 slack:// 링크(복사 버튼), Start Session(입력창 초안만 채움), Add to Board(v5 `board.createCard`), 읽음과 보관. slack:// 링크는 워크스페이스 ID(T...)가 있어야 만들어지는데 Slack 결과에 없어서 Settings 에서 직접 넣는다
- 저장은 `~/.agent-nav/inbox.json`(최대 500개, 넘으면 보관, 읽음, 안 읽음 순으로 오래된 것부터 지움). 메시지 내용은 이 파일에만 있고 로그에는 개수와 오류만 남는다. 가져오기 세션은 `persistSession: false` 라 CLI 대화 기록도 남지 않는다

## 단축키

| 키 | 동작 |
| --- | --- |
| ⌘N | 활성 워크스페이스에 새 세션 ("현재 폴더" 또는 "새 worktree") |
| ⌘K | 통합 검색(All 탭으로 열림). 세션, 파일, 작업 폴더, PR, 보드 카드, 멘션을 유형 탭(←→)으로 찾고, 입력이 비면 Recent 와 Actions. ↵ 열기, ⌥↵ 보조 동작, `/` 유형 필터, Tab 은 입력한 글로 새 세션 작성. 바로 이어서 ⌘\, ⌘N, ⌘W, ⌘방향키를 누르면 검색창이 닫히고 ⌘K 계열 chord 가 실행된다. 에디터에 포커스가 있으면 검색창 없이 chord 만 기다린다. 글자와 방향키 chord(⌘K W, ⌘K ←)는 ⌘K ⌘K 로 검색창을 닫은 뒤 이어서 누른다 |
| ⌃⌥R | 통합 검색을 Sessions 탭으로 열어 세션 전환. ⌥Enter 는 새 칸에 |
| ⇧⌘M | 모델 선택. ⌥Enter 는 기본값으로 저장 |
| ⇧⌘I | effort 를 지원하는 단계 안에서 한 단계씩 순환(Low, Medium, High, Extra High, Max). 칩을 눌러 연 목록에서는 ⌥Enter 가 기본값으로 저장 |
| ⌥H | 지금 파일(선택이 있으면 선택 영역과 줄 범위)을 입력창에 첨부 |
| ⌘I | 선택한 코드에 빠른 질문 (세션 목록에 안 남음) |
| `/btw 질문`, ⇧⌘B | 곁다리 대화 열기 (메인 턴 실행 중에도) |
| ⌥Enter (새 세션 화면) | 지금 화면은 그대로 두고 새 세션을 뒤에서 시작 |
| Enter, ⌥Enter (응답 중인 세션) | 응답 중에 보내면 큐에 쌓이고(`QUEUED`, 턴이 정상으로 끝나면 이어서 나감, 중단하면 큐는 그대로), ⌥Enter 는 지금 진행 중인 턴에 끼어든다(모델이 받을 때까지 큐 위에 `STEERING` 으로 기다리다가, 모델이 받는 순간 대화에 말풍선으로 들어간다). 기본 동작은 VS Code `chat.requestQueuing.defaultAction` 을 따르고 없으면 queue, 값이 steer 면 둘이 뒤바뀐다 |
| ⌘/ | 첨부 선택창(Sessions..., Changes, Files). 입력창과 에디터에서는 반응하지 않는다(에디터에서는 줄 주석 토글). 입력창에서 `/` 는 명령과 스킬, `@` 는 파일 |
| ⌃C | 진행 중인 응답 중단 (터미널 안에서는 셸로 감) |
| ⌘W | 에디터 탭 닫기. 세션은 닫히지 않는다 |
| ⌘\ | 활성 칸 오른쪽에 새 열을 만들고 빈 새 세션 화면을 연다(⌘K ⌘\ 는 아래 행). 기존 세션을 나란히 여는 것은 세션 행 ⌥클릭과 세션 검색 ⌥Enter. 에디터(코드)에 포커스가 있으면 같은 키가 에디터 분할이다: ⌘\ 는 Split Editor Right, ⌘K ⌘\ 는 Split Editor Down, ⌘K ⌘←/→ 는 이전, 다음 에디터 그룹에 포커스 |
| ⌃⌘←, ⌃⌘→ | VS Code 의 `sessions.moveChatToPreviousGroup`, `moveChatToNextGroup`. 활성 채팅을 이전, 다음 칸으로 옮기고(끝에서 반대쪽 끝으로 이어지고 칸이 하나면 아무 일도 없다) 포커스가 따라간다. 이 앱의 칸은 채팅 하나라 이웃 칸과 자리를 맞바꾼다 |
| ⌃⌘←, ⌃⌘→ (에디터 포커스) | VS Code 의 Move Editor into Previous, Next Group. 활성 탭을 그 방향 그룹으로 옮기고 없으면 새 그룹을 만들며, 옮긴 에디터에 포커스가 그대로라 같은 키를 이어서 누를 수 있다. ⌃⌘↑, ⌃⌘↓ 는 VS Code 에 키가 없어 이 앱도 키 없이 팔레트의 Move Chat to Group Above, Below 와 Move Editor into Group Above, Below 로만 둔다 |
| ⌘S | 활성 파일 탭 저장(이름 없는 탭은 경로를 묻는다) |
| ⇧⌥F, ⌘K ⌘F | 에디터에서 Format Document, Format Selection(명령 팔레트와 같다) |
| ⇧⌘L | 가운데 영역을 Slack Inbox 와 세션 격자 사이에서 바꾼다. 에디터에서는 같은 글 전부 선택 |
| ⇧⌘K | 가운데 영역을 칸반 보드와 세션 격자 사이에서 바꾼다. 에디터에서는 줄 삭제 |
| ⌃⌥L | 배치 전환(View: Toggle Editor Layout). Chat 중심은 대화 격자가 가운데고 에디터가 오른쪽 패널, Editor 중심은 에디터 그룹이 가운데 전체이고 활성 세션이 오른쪽 아래 떠 있는 창이다. 제목줄 오른쪽 패널 토글 옆 아이콘도 같다. 시작 배치는 Settings 의 Default Layout, Remember last layout 을 켜면 마지막 배치로 시작한다. 세션마다 배치(모드, 떠 있는 창, 사이드바, 오른쪽과 아래 패널)를 기억해 그 세션으로 돌아오면 되살리고(Settings 의 Remember layout per session, 기본 켜짐), 재시작 뒤에는 처음 보이는 세션의 기억이 Default Layout 보다 앞선다 |
| ⌃⇧G | View: Show Source Control. 오른쪽 패널의 Source Control 탭을 연다. 커밋 입력에서 ⌘Enter 는 커밋 |
| ⌃⌘I | Agents: Focus Active Session. Editor 중심에서는 떠 있는 창 입력창과 활성 에디터 그룹 사이를 오간다(접혀 있으면 펼친다) |
| ⌃⌘J | 떠 있는 창을 알약으로 접고 펴기(알약은 상태를 보이고 승인 대기면 Allow 를 바로 누른다) |
| ⌘B, ⌘J, ⌥⌘B | 사이드바, 아래 패널(Output, Terminal), 오른쪽 패널 토글. 제목줄 오른쪽 아이콘과 같다. ⌘J 로 터미널 보기를 열 때 터미널이 없으면 하나 만들고(세션의 cwd, 없으면 활성 워크스페이스, 없으면 홈) 입력 포커스를 둔다. 닫으면 숨기기만 해서 셸과 출력이 그대로다 |
| ⌘=, ⇧⌘=, ⌘-, ⌘0(⌘NumPad0) | 창 전체 확대, 축소, 초기화(앱 창만, VS Code 의 Zoom In, Out, Reset). 한 단계 1.2배, -8 에서 8 까지, 다음 실행에도 유지(`~/.agent-nav/window-zoom.json`). Browser 탭에 포커스가 있으면 같은 키가 페이지 확대 |
| ⌥⌘↑, ⌥⌘↓ | 대화 칸에서 이전, 다음 내 말풍선으로 이동. 에디터에서는 커서 추가 |
| ⌥⌘F | 피드백 요소 선택 모드. 에디터에서는 찾기와 바꾸기 |
| ⌘P, ⇧⌘O, ⌘T | 파일 열기, 지금 파일 안 심볼로 이동, 워크스페이스 심볼 검색 |
| ⌘클릭, F12, ⇧F12, ⌃-, ⌃⇧- | 정의 이동, 참조, 뒤로, 앞으로 |
| Esc | 팔레트, 빠른 질문, 곁다리, 참조 패널 닫기 |

포커스가 글을 고치는 자리(에디터, 대화 입력창, 터미널, 입력칸)에 있으면 그 자리의 기본 편집 키(⌘←→↑↓, ⇧⌘←→↑↓, ⌥←→, ⌘A, ⌘Z 등)가 앱 단축키보다 먼저다. 같은 키를 앱도 쓰면 VS Code 의 when 조건처럼 포커스로 나눈다(⌥⌘↑↓, ⇧⌘K, ⇧⌘L, ⌥⌘F, ⌘/ 는 에디터에서 에디터 키). 키별 점검 결과는 `docs/ACCEPTANCE-keys.md`.

터미널의 줄 편집 키: ⌘←→ 줄 처음, 끝, ⌥←→ 낱말 이동, ⌘⌫ 줄 지우기, ⌥⌫ 낱말 지우기, ⇧Enter 줄바꿈(Esc Enter), 선택이 없는 ⌘C 는 ⌃Y(작성자의 VS Code `keybindings.json` 대로).

⌘W, ⌘N, ⇧⌘B, ⌘J 는 브라우저 탭에서는 브라우저가 먼저 가져가므로 Electron 창(앱 메뉴)에서만 동작한다. 나머지는 둘 다 된다.

## worktree 세션

"New Session" 에서 "새 worktree" 를 고르고 브랜치 이름과 기준 브랜치(기본값은 원격 기본 브랜치)를 적으면 `git worktree add -b <branch> <repo>.worktrees/<branch> <base>` 로 만든다 (브랜치의 슬래시는 폴더가 된다). 세션의 cwd 는 그 worktree 이고, 모노레포 하위 폴더에서 시작했으면 worktree 안의 같은 하위 경로다. 브랜치가 하나도 없는 레포(커밋 0개)에서는 이 선택지가 꺼진다. 기준으로 쓸 브랜치가 하나라도 있으면 HEAD 가 없어도 된다.

변경 패널의 "Branch Changes" 는 기준 브랜치와의 merge-base 대비이고, worktree 가 아닌 세션은 세션 시작 시점의 HEAD 대비("Session Changes")다. 세션을 지울 때 worktree 도 지울지 묻고, 변경이 남아 있으면 지우지 않는다. "세션만" 을 고르면 worktree 는 디스크에 그대로 남고 앱 목록에서만 사라진다. `--force` 는 쓰지 않는다. 브랜치는 머지된 경우에만 `-d` 로 지운다. 커밋이 없는 레포는 변경 패널에 "기준 커밋 없음" 으로 비워 둔다.

## 피드백으로 Lodestar 고치기

제목줄의 피드백 버튼(⌥⌘F)으로 요소 선택 모드를 켜고, 고칠 요소를 클릭한 뒤 한 줄을 보내면 agent-nav 소스를 별도 worktree(`<repo>.worktrees/feedback-<id>`)에서 고치는 세션이 사이드바 맨 위 "agent-nav improvements" 에 열린다. 요소 정보와 스크린샷은 `~/.agent-nav/feedback/<id>/` 에만 저장한다. 턴이 끝나면 데몬이 worktree 안에서 `tsc`, `npm test`, `npm run build` 를 돌리고 통과한 변경만 본 작업 폴더로 옮겨 창을 다시 읽는다. 알림의 Revert 가 그 피드백이 바꾼 파일만 되돌린다. `server/` 를 바꾸는 피드백은 재시작을 묻고, 진행 중인 턴이 있으면 끝날 때까지 기다린다. 커밋은 하지 않는다. 설정 `feedbackModel`(기본 sonnet)이 개선 세션의 모델이고, 소스 폴더는 `AGENT_NAV_SRC`(기본은 이 레포). 자세한 구조와 한계는 `docs/ACCEPTANCE-v4.md`.

## 곁다리 대화와 갈래

`/btw 질문` 을 입력창에 치면 메인 세션을 SDK 의 `forkSession` 으로 갈라 그 대화 기록을 들고 가는 사이드 챗이 열린다. 메인 턴이 스트리밍 중이어도 갈라진다 (메인 jsonl 은 바뀌지 않는다, `.verify/spike/fork.ts`). 도구 없이 짧게 답하고 모델을 고를 수 있다. "세션으로 남기기" 를 누르면 사이드바에 "Forked: 원래 제목" 으로 붙는다. 세션 행의 메뉴 "여기서 갈래" 와 메시지의 갈래 아이콘은 같은 방식으로 정식 갈래 세션을 만든다 (첫 턴에서 CLI 가 원 세션을 그 지점까지 갈라 새 session id 를 받고, 지점까지의 파일 체크포인트와 메시지 uuid 가 그대로 따라온다. 첫 턴 전에는 원 세션의 체크포인트로 Start Over 와 Restore Checkpoint 가 파일까지 되돌린다).

## 변경 패널과 되돌리기

파일별 unified diff 는 `@codemirror/merge` 로 그리고, 바뀌지 않은 구간은 "N hidden lines" 로 접힌다. 덩어리의 "유지"는 그 덩어리만큼 기준을 앞으로 옮기고(데몬의 `changes/` 기록), "되돌리기"는 파일을 그 덩어리만큼 기준으로 되돌려 디스크에 쓴다. 되돌리기 쓰기는 그 세션의 변경 집합(기준 커밋 대비)에 있는 파일만 받고, 기준 커밋이 없는 레포(커밋 0개)에서는 유지 기록이 있는 파일만 받는다.

## git 동기화

제목줄의 "Sync Changes N↑ N↓" 는 마지막 fetch 기준 ahead/behind 다. 옆의 새로고침이 `git fetch` 고, 버튼을 누르면 확인 뒤 behind 는 `pull --ff-only`, ahead 는 `push` 를 실행한다. 강제 push 와 자동 실행은 없다. PR 칩과 Checks 는 GitHub 원격일 때 `gh pr list` 로 읽는다.

## 설정

`~/.agent-nav/settings.json`. "설정과 상태" 패널에서 바꾼다.

| 키 | 뜻 |
| --- | --- |
| `defaultPermissionMode` | 새 세션의 권한 모드. 사용자 settings.json 의 `defaultMode` 보다 이 값이 이긴다 |
| `defaultModel`, `defaultEffort` | 새 세션의 모델과 effort (팔레트에서 ⌥Enter) |
| `quickModel` | 빠른 질문과 곁다리 대화의 기본 모델 |
| `theme` | `dark`(기본), `light`, `system`. 페이지의 `<html data-theme>` 와 Electron 창 바탕색이 따라간다 |

## 구성

| 경로 | 역할 |
| --- | --- |
| `server/index.ts` | HTTP(빌드된 웹 서빙) + WebSocket `/ws/rpc`, `/ws/lsp`, `/ws/pty`. Host, Origin, 토큰 검사. 메타(모델, MCP, 계정) 수집, 데몬 로그 링 버퍼 |
| `server/agents.ts` | `query()` 로 턴 실행, `resume` 과 `forkSession`, worktree 생성과 삭제, `canUseTool` 을 권한 카드로 |
| `server/git.ts` | status, numstat, 기준 커밋의 원본, ahead/behind, fetch/push/pull, worktree add/remove, gh PR |
| `server/feedback.ts` | 피드백 개선 세션: worktree 복사, 도구 권한, 검사, 반영, 되돌리기, 재시작 |
| `server/side.ts` | `/btw` 곁다리 대화 (forkSession, 도구 없음) |
| `server/quick.ts` | 빠른 질문 (`tools: ["Read"]`) |
| `server/pty.ts` | 터미널. 세션 cwd 에서 `$SHELL -l` |
| `server/meta.ts` | 프롬프트를 보내지 않는 CLI 프로세스로 모델 목록과 MCP 상태를 받는다 |
| `server/lsp.ts` | WebSocket 하나당 `typescript-language-server` 하나 |
| `electron/main.ts` | 데몬을 utility process 로 띄우고 창을 연다. 메뉴 단축키는 `agent-nav:command` 이벤트로 페이지에 전달. `AGENT_NAV_E2E_PORT` 로 검증용 창구 |
| `web/` | React + CodeMirror 6. `App.tsx` 배치와 단축키, `AgentView.tsx` 대화와 입력창, `ChangesPanel.tsx`, `DiffView.tsx`, `Terminal.tsx`, `SideChat.tsx`, `Editor.tsx`, `QuickAsk.tsx`, `store.ts` |
| `web/ui/` | shadcn/ui 식 컴포넌트(Radix + Tailwind): `button`, `select`, `dropdown-menu`, `dialog`, `checkbox`. 아이콘은 `web/icons.tsx` 의 codicon 뿐 |
| `web/tokens.css`, `web/tailwind.css`, `web/fonts.css` | 토큰 변수(생성 파일), Tailwind 테마(토큰만 가리킴), codicon 글꼴과 Geist 선언 |
| `scripts/build-tokens.mjs`, `scripts/lint-tokens.mjs` | `design-system/tokens.json` → `web/tokens.css` 생성, 토큰을 거치지 않은 값 검사 |
| `test/security.test.ts` | 접근 검사, 경로 탈출, 쓰기 정책, pty, worktree 브랜치 이름 검증 (`npm test`. 자기 데몬을 임시 홈과 빈 포트로 띄우고 끝나면 끈다, `test/testDaemon.ts`) |
| `docs/TEST_PLAN.md`, `docs/ACCEPTANCE-v3.md` | 검증 케이스와 증거 (v1, v2 는 `ACCEPTANCE.md`, `ACCEPTANCE-v2.md`) |

## 디자인 시스템

색, 간격, 높이, 반경, 글자 스타일의 단일 원본은 `design-system/tokens.json` 이다. 원칙과 컴포넌트별 치수는 `design-system/README.md` 와 `components/*/README.md` 에 있다.

- `npm run tokens` 가 `tokens.json` 에서 `web/tokens.css` 를 만든다(다크는 `:root`, 라이트는 `[data-theme="light"]`, shadcn 변수 포함). `build` 와 `dev` 앞에 자동으로 돈다
- `web/tailwind.css` 의 `@theme` 는 간격 여덟 단계, 글자 일곱 단계, 반경 넷, 토큰 색만 두고 Tailwind 기본 단계는 지운다. `p-5` 나 `mt-10` 같은 클래스는 없다
- `web/styles.css` 는 레이아웃과 의미 있는 클래스만 갖고 값은 전부 `var(--…)` 이다. 토큰에 없는 치수는 `lint-tokens: allow <이유>` 주석을 달고, `docs/ACCEPTANCE-v3.md` 의 "디자인 시스템 변경 제안" 에 적어 둔다
- `npm run lint:tokens`(`npm test` 에 포함) 가 `web/` 의 CSS 와 TSX 에서 raw px(1px 테두리 제외), hex 와 rgb 색, 시스템에 없는 Tailwind 간격 클래스와 임의값 클래스를 찾으면 실패한다
- 글꼴은 VS Code 와 같은 시스템 글꼴이다(`-apple-system, system-ui` 와 코드용 `SF Mono, Monaco, Menlo`). Geist 선언은 `web/fonts.css` 에 남아 있지만 쓰지 않는다
- 아이콘은 `@vscode/codicons` 의 글꼴(`codicon.ttf`)을 번들해서 쓴다. 런타임에 외부를 부르지 않는다. 라이선스: 아이콘과 글꼴은 CC BY 4.0, 패키지 코드는 MIT(Copyright Microsoft Corporation). 패키지 `LICENSE` 는 `node_modules/@vscode/codicons/LICENSE` 에 있다
- CodeMirror 테마(`web/Editor.tsx` 의 `editorTheme`, `editorHighlight`)도 `syntax-*`, `diff-*`, `surface-*`, `fg-*` 토큰만 쓴다. 터미널(xterm)은 CSS 변수를 못 받아 토큰의 계산값을 읽고, 테마가 바뀌면 다시 읽는다

## 보안

localhost WebSocket 은 다른 사이트의 페이지에서도 연결할 수 있어서, 데몬은 세 가지를 모두 확인한다.

1. Host 헤더가 `127.0.0.1:<port>` 또는 `localhost:<port>` (DNS rebinding 방지)
2. Origin 이 데몬 자신 또는 Vite dev 서버
3. 쿼리의 `token` 이 `~/.agent-nav/token` 과 일치. 토큰은 데몬이 `index.html` 에 넣어 준다

파일 읽기는 워크스페이스 안(정의 이동을 위해 상위 `node_modules` 는 허용), 쓰기는 세션 cwd 안의 변경 파일만. 터미널과 push/pull, worktree 삭제는 사용자 조작으로만 열린다. 에이전트 출력은 DOMPurify 로 정제한다. 자식 CLI 에는 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 을 절대 넘기지 않는다.

## 알아둘 동작

- 세션은 `settingSources: ["user", "project", "local"]` 로 돌아서 `~/.claude/settings.json` 의 허용 목록과 훅이 그대로 적용된다.
- 백그라운드 서브에이전트가 끝나면 CLI 가 사용자 메시지 없이 턴을 더 연다. 타임라인에 "백그라운드 작업 끝남" 과 이어진 답이 붙고, 끝나면 상태가 대기로 돌아간다.
- 로그인이 풀리면 오류 행에 `~/.local/bin/claude auth login` 안내가 붙는다.
- tsserver 가 큰 프로젝트를 불러오는 동안은 정의 이동이 같은 파일의 import 줄로 가고 hover 가 짧다. 에디터 헤더가 "LSP" 로 바뀌면 정상.
- 에이전트가 diff 가 열린 파일을 또 고치면 diff 뷰를 통째로 다시 만든다(본문만 바꿔 넣으면 접힌 줄이 다시 안 접힌다). 기준은 그대로다.

## 아직 없는 것

에디터 편집과 저장, Claude 외 provider, TypeScript 외 언어 서버, 코드 서명, 모바일 접속.

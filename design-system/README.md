# agent-nav

agent-nav 는 Claude Code 세션 여러 개와 코드 탐색을 한 창에 두는 데스크톱 도구다. 화면은 VS Code 에이전트 창처럼 조용하고 촘촘해야 한다. 이 문서의 값만 쓰면 어느 화면을 열어도 간격, 글자, 색이 같은 규칙으로 맞는다.

## 원칙

1. **값은 토큰에서만.** 간격, 크기, 반경, 색, 글자는 `tokens.json` 의 이름으로만 쓴다. `padding: 10px` 처럼 토큰에 없는 숫자가 보이면 버그다.
2. **강조색은 하나.** 파란 `accent` 는 주요 버튼, 포커스, 활성 탭, 실행 중 표시에만 쓴다. 초록과 빨강(`success`, `danger`, `diff-*`)은 상태와 diff 전용이다.
3. **경계는 선으로, 그림자는 떠 있는 층만.** 패널끼리는 `border-subtle` 1px 로 나눈다. `shadow-overlay` 는 메뉴, 팔레트, 툴팁, 빠른 질문 창에만.
4. **글자는 적게.** 빈 화면 안내문, 단축키 나열, 설명 문단을 두지 않는다. 아이콘과 짧은 라벨, 툴팁으로 대신한다.
5. **장식 없음.** 그라데이션, 왼쪽 색 테두리 카드, 이모지, 배지 남발, 큰 반경(8px 초과) 금지.

## 레이아웃 치수

| 영역 | 값 |
| --- | --- |
| 제목줄 높이 | `size-titlebar` 35px. 신호등 버튼 영역 78px 비우고 시작 |
| 사이드바 폭 | `size-sidebar` 280px (200 ~ 400 조절) |
| 패널 헤더(탭 줄, Changes 헤더, 아래 패널 탭) | `size-pane-header` 35px, 좌우 `space-3` |
| 세션 행, 팔레트 항목, 메뉴 항목 | `size-row-lg` 28px, 좌우 `space-2` |
| 트리 행(바뀐 파일, 파일 탐색) | `size-row` 22px, 들여쓰기 `space-2` 단위 |
| 버튼, 입력 | `size-control` 28px, 작은 것 `size-control-sm` 24px |
| 새 세션 화면의 입력창 | 최대 `size-chat` 800px, 좌우 `space-4`. 입력창 편집기는 `size-composer-editor-new` 52px |
| 세션 안의 대화 열, 입력창 컨테이너 | 최대 `size-chat-session` 796px, 좌우 `space-8`(VS Code) |
| 대화 칸 머리, 오른쪽 패널 탭줄 | `size-chat-header` 32px, `size-tabs-header` 33px(다른 패널 머리는 `size-pane-header` 35px) |
| 사이드바 두 줄 세션 행 | `size-session-row` 56px(내용 54px + 아래 2px) |
| 사이드바 그룹 머리 | `size-section-row` 26px |
| 입력창 편집기, 도구줄 | `size-composer-editor` 64px, `size-composer-tools` 22px |
| 오른쪽 패널 좁은 상태, 넓은 상태 | `size-panel-narrow` 300px, `size-panel-wide` 580px(diff 300 + 목록 `size-changes-list` 280). 세션마다 이 실행 동안만 기억 |
| 메뉴 폭(VS Code 측정) | 필터 `size-menu-filter` 247, 더보기 `size-menu-more` 207, 행 우클릭과 대화 머리 `size-menu-session` 275, 대화 우클릭 `size-menu-chat` 194, 범위 `size-menu-scope` 266, 위치 `size-menu-place` 293, 브랜치 `size-menu-branch` 265 |
| 확인 창 | `size-dialog` 450px, 반경 `radius-lg`. 검색창 `size-quickpick-width` 602px, 반경 `radius-xl` 12px |

## 간격 규칙

간격은 4px 격자 위 여덟 단계뿐이다. 어디에 무엇을 쓸지도 정해 둔다.

| 관계 | 토큰 |
| --- | --- |
| 컨트롤 안: 아이콘과 라벨 | `space-1` 4px |
| 칩, 작은 버튼 좌우 패딩 | `space-1_5` 6px |
| 행 좌우 패딩, 칩 사이 | `space-2` 8px |
| 패널 헤더 좌우, 대화 블록 사이 | `space-3` 12px |
| 대화 열, 입력창 패딩 | `space-4` 16px |
| 턴과 턴 사이 | `space-6` 24px |
| 빈 패널 위쪽 | `space-8` 32px |

형제 요소 간격은 margin 대신 flex 나 grid 의 `gap` 으로 준다.

## 글자

UI 는 VS Code 와 같은 시스템 글꼴(`--font-sans` = `-apple-system, system-ui`), 코드는 `--font-mono` = `SF Mono, Monaco, Menlo, Courier`. 한글도 시스템 글꼴이다. Geist 선언은 `web/fonts.css` 에 남겨 두되 쓰지 않는다. 크기는 10, 11, 12, 13, 14, 16 단계뿐이다.

- `ui` 13px 가 기본. 사이드바, 탭, 칩은 `ui-sm` 12px
- 대화 영역은 VS Code compact 밀도 스타일을 쓴다: 사용자 말풍선, 응답 본문, 단계 줄은 `chat` 13px/19.5px, 단계 세부는 `tool-detail` 12px, 사용자 메시지 시각은 `micro` 10px, 입력창은 `input` 13px/18.2px
- 사이드바는 세션 제목 `session-title` 13px/17px, 상세줄 `session-detail` 11px/15px, 그룹 머리와 `Sessions` 머리 `section-label` 12px/26px/600
- `body` 14px 는 대화 밖(설정 화면 등)의 본문용으로 남긴다. 응답 본문은 `chat` 이다
- 굵기는 400 과 600 둘. 제목도 600 을 넘지 않는다
- 코드와 diff 는 `code` 12.5px, 경로 헤더는 `code-sm` 12px, 대화 속 인라인 코드 칩은 `code-inline` 11px/19.5px(패딩 2px 4px, 반경 `radius-sm`)

## 색 쓰는 법

| 자리 | 토큰 |
| --- | --- |
| 제목줄, 사이드바 바탕 | `chrome-bg`(다크 `#1f1f1f`, 라이트 `#f8f8f8`) |
| 대화 칸, 아래 패널 바탕 | `pane-bg`(다크 `#181818`, 라이트 `#ffffff`) |
| 오른쪽 패널(변경, 파일, 에디터, diff) 바탕 | `aux-bg`(다크 `#1f1f1f`, 라이트 `#ffffff`) |
| 입력창, 메뉴, 팔레트 | `surface-overlay` + `border` |
| 행 hover / 선택 | `surface-hover` / `surface-selected` |
| 본문 / 보조 / 3차 글자 | `fg` / `fg-muted` / `fg-subtle` |
| 대화 속 파일 링크 | `accent-text` |
| 코드 바탕, 기본 글자, 줄 번호, 선택 영역 | `editor-bg`, `editor-fg`, `editor-line-number`, `editor-selection` (VS Code Dark Modern, Light Modern 값) |
| 코드 구문 색 | `syntax-*` (키워드, 함수, 타입, 문자열, 변수 등 20개, 각 usage 에 VS Code scope 출처) |
| 괄호 쌍 색 | `editor-bracket-1` ~ `editor-bracket-3`, 짝 없는 괄호 `editor-bracket-unexpected` |
| diff 줄 배경, 바뀐 글자 | `diff-add-bg`, `diff-del-bg`, `diff-add-gutter`, `diff-del-gutter` (VS Code `diffEditor.*Background`) |
| 사용자 말풍선 / hover | `chat-user-bg` / `chat-user-bg-hover` |
| 입력창 컨테이너 바탕, 테두리 | `input-bg`, `input-border` |
| 선택된 세션 행 바탕, 글자 | `row-selected`, `row-selected-fg` |
| 인라인 코드 칩 바탕, 글자 | `inline-code-bg`, `inline-code-fg` |
| 세션 행, 응답 아래, 변경 칩의 `+N` / `-N` | `diff-count-add` / `diff-count-del` |
| 변경 패널 파일 행의 `+N`, `A` / `-N` | `git-added` / `git-deleted` |
| 안 읽음 점 | `unread` |
| 진행 스피너(실행 중, 입력 필요) | `status-spinner-running`, `status-spinner-waiting` |
| 실행 중 점 | `running` |
| 권한 대기, Bypass 표시 | `warning` |

### 색 스타일(WebStorm)

밝기(`data-theme`)와 별개로 `settings.themeStyle`(`lodestar` 기본, `webstorm`)이 `<html data-style="webstorm">` 로 팔레트를 고른다. `tokens.json` 의 색 토큰은 값이 다른 경우에만 `webstorm-dark`, `webstorm-light` 키를 더 갖고, 없으면 기본 값을 쓴다. 생성기는 `[data-style="webstorm"]:not([data-theme="light"])` 와 `[data-style="webstorm"][data-theme="light"]` 블록을 낸다(둘 다 0,2,0 이라 기본 라이트 블록을 순서와 상관없이 이기고 서로 새지 않는다). 값은 `scripts/import-webstorm-theme.mjs <JetBrains 원본 폴더>` 가 넣고, 토큰별 출처와 대비는 [webstorm-theme.md](webstorm-theme.md) 에 있다. 새 색 토큰을 추가할 때 WebStorm 값이 필요하면 그 스크립트의 `MAPPING` 에 한 줄 더하고 다시 돌린다.

## 아이콘

VS Code 와 같은 codicon 하나만 쓴다(`@vscode/codicons` 0.0.46-44, 글꼴 CC BY 4.0, 코드 MIT). `web/icons.tsx` 의 이름 있는 컴포넌트(`<Plus />`, `<FolderCompact size={12} />`)나 `<Codicon name="..." />` 로 쓴다. 기본 16px(`size-icon`), 사이드바 행 안의 작은 아이콘은 12px(`size-icon-sm`). 색은 글자와 같은 토큰(`fg-muted`, 활성일 때 `fg`). 아이콘만 있는 버튼은 `size-control-sm` 24px 정사각형(`.icon-button`), `aria-label` 필수.

패키지에 없는 VS Code 전용 모양은 가장 가까운 글리프로 대신한다: `agent-sidebar-toggle-open` 은 `layout-sidebar-left`, `agent-secondary-sidebar-toggle-open` 은 `layout-sidebar-right`, `tree-item-expanded` 는 `chevron-down`, `chat-model-provider-claude` 는 `claude`, `toolbar-more` 는 `more`.

## 포커스, hover, 선택, 움직임

| 자리 | 규칙 |
| --- | --- |
| 키보드 포커스 | `focus-border` 1px 선을 요소 안쪽에(`outline-offset: -1px`). 전역 `:where(...)` 규칙이라 자기 규칙이 있는 컴포넌트가 우선한다 |
| 입력창 포커스 | 컨테이너 테두리가 `focus-border` |
| 아이콘 버튼 hover | `surface-hover` 배경, 반경 `radius-sm`(`.icon-button`) |
| 목록 행 | hover `surface-hover`, 선택 `row-selected` 바탕에 `row-selected-fg` 글자(`.list-row` + `data-selected` 또는 `data-active`) |
| 점 스피너 | `<DotSpinner state="running" or "waiting" />`. 가로 2 x 세로 3 격자의 점 여섯 개, 한 바퀴 1.82초(VS Code 와 같다), 색은 `status-spinner-running`, `status-spinner-waiting` |
| shimmer | `.shimmer-text`. 1.6초 주기 |
| 진행 막대 | `.progress-line`(부모에 `position: relative`, `overflow: hidden`). 응답 중 입력창 위쪽 테두리 |
| Compact View | `web/compactView.ts` 의 `useCompactView()`. `<html data-compact-view>` 가 켜지면 `.session-row` 가 `size-session-row-compact` 28px 한 줄이 되고 `[data-session-detail]` 가 사라진다 |

모든 움직임은 `prefers-reduced-motion: reduce` 에서 멈춘다.

## shadcn/ui 로 옮기기

구현은 shadcn/ui(Radix + Tailwind)를 쓴다. shadcn 테마 변수를 아래처럼 이 토큰에 연결하면 shadcn 컴포넌트가 그대로 이 시스템을 따른다.

| shadcn 변수 | 이 시스템 |
| --- | --- |
| `--background` | `surface-raised` |
| `--foreground` | `fg` |
| `--card`, `--popover` | `surface-overlay` |
| `--card-foreground`, `--popover-foreground` | `fg` |
| `--primary` / `--primary-foreground` | `accent` / `accent-fg` |
| `--secondary`, `--accent` | `surface-hover` |
| `--secondary-foreground`, `--accent-foreground` | `fg-strong` |
| `--muted` / `--muted-foreground` | `surface-base` / `fg-muted` |
| `--border`, `--input` | `border` |
| `--ring` | `accent` |
| `--destructive` | `danger` |
| `--radius` | `radius-md` |

Tailwind 의 `spacing` 은 이 시스템의 여덟 단계로 덮어써서, 다른 값이 클래스로 나오지 않게 한다(`p-2` = 8px, `p-3` = 12px, `p-4` = 16px 처럼 기본값과 숫자가 같도록 4px 격자를 유지하되 목록에 없는 단계는 지운다).

## 컴포넌트

아래 컴포넌트 카드가 각 화면 조각의 치수와 상태를 보여 준다: 제목줄(TitleBar), 세션 목록(SessionList), 단계 묶음(StepGroup), 입력창(Composer), diff 파일(DiffFile), 버튼(Button).

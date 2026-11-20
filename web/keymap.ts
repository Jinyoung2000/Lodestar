import type { KeymapPreset } from "../shared/protocol";

// 단축키 표와 chord(두 단계 키) 상태 기계. DOM 을 건드리지 않아서 Electron 메인(electron/main.ts)과 단위 시험이 그대로 가져다 쓴다.
// 키는 글자가 아니라 물리 키(KeyboardEvent.code)로 적는다. 한글 입력 중이거나 ₩ 처럼 글자가 다른 배열에서도 같은 키로 읽힌다.
// 표기: 수정키를 Ctrl, Alt, Shift, Meta 순서로 "+" 로 잇고 마지막에 code. 예: "Shift+Meta+KeyI", "Ctrl+Alt+KeyR".

// focusLayout 은 Editor 중심 배치(포커스 모드)일 때, focusNotEditor 는 그중 에디터 밖일 때다. 같은 키가 Chat 중심에서는 다른 뜻이라 배치로 가른다(⌘B, ⌥⌘B).
// notEditorOrComposer 는 글을 고치는 두 영역(코드 에디터, 대화 입력창)이 아닐 때다. electron 은 앱(Electron) 창일 때만이다(웹 접속에서는 브라우저 자기 키가 먼저다).
// editorArea 는 포커스가 에디터 그룹 영역(`.editor-area`: 탭줄, 본문, 비어 있는 그룹) 안에 있을 때다. `.cm-editor` 라도 이 영역 밖이면(메모 편집기, 승인 카드의 diff) 아니다: editor 는 CodeMirror 어디서든 참이다.
export type When = "terminal" | "notTerminal" | "notEditor" | "editor" | "editorArea" | "editorGroupKeys" | "notComposer" | "notEditorOrComposer" | "electron" | "browserTab" | "searchTab" | "chat" | "approval" | "focusLayout" | "focusNotEditor";

// 두 번째 키가 있으면 chord. 예: ["Meta+KeyK", "Meta+Backslash"] 는 ⌘K 를 누르고 이어서 ⌘\.
export type Binding = { keys: [string] | [string, string]; command: string; when?: When };

// inBrowser 는 오른쪽 패널의 활성 탭이 Browser 탭일 때다.
// inSearch 는 활성 탭이 Search 탭이거나 포커스가 사이드바 Search 뷰 안에 있을 때다.
// inBrowser 는 활성 탭이 Browser 탭이고 포커스가 그 탭 안(주소창이나 페이지)에 있을 때다. inElectron 은 앱(Electron) 창일 때다.
// inSearchOverlay 는 통합 검색창(⌘K)이 떠 있을 때다. 이때 chord 두 번째 키는 수정키(⌘, ⌃, ⌥)가 붙은 것만 chord 로 읽고, 글자와 방향키는 검색창 입력으로 넘긴다.
export type KeyContext = { inTerminal: boolean; inEditor: boolean; inEditorArea?: boolean; inComposer?: boolean; inBrowser?: boolean; inSearch?: boolean; inElectron?: boolean; inSearchOverlay?: boolean; inChat?: boolean; approvalPending?: boolean; inFocusLayout?: boolean; hiddenCommands?: ReadonlySet<string> };

export type KeyInput = { code?: string; key?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

export const CHORD_TIMEOUT_MS = 1500;

const K = "Meta+KeyK";

export const BINDINGS: Binding[] = [
  // B7: 파일 저장과 에디터 키. 에디터(.cm-editor)에 포커스가 있을 때만 듣는 키는 같은 키를 쓰는 대화 칸 키(⌘\, ⌘K ⌘\, ⌘K ⌘←→)보다 앞에 둔다: 같은 키면 먼저 맞는 줄이 이긴다.
  { keys: ["Meta+KeyS"], command: "save" },
  { keys: ["Alt+Shift+KeyF"], command: "formatDocument", when: "editor" },
  { keys: [K, "Meta+KeyF"], command: "formatSelection", when: "editor" },
  { keys: ["Alt+KeyZ"], command: "editor:toggleWordWrap", when: "editor" },
  // Quick Fix... (hover 상자의 같은 이름 단추). 커서 자리의 진단과 리팩터링 제안 목록(web/quickFix.ts)
  { keys: ["Meta+Period"], command: "quickFix", when: "editor" },
  // Auto Fix... (editor.action.autoFix): 선호하는 quickfix 가 하나면 바로 적용한다(web/quickFix.ts). 전구 툴팁의 힌트가 이 키다.
  { keys: ["Alt+Meta+Period"], command: "editor:autoFix", when: "editor" },
  // 경로 줄(breadcrumbs)에 포커스: ⇧⌘; 마지막 조각에 포커스, ⇧⌘. 그 조각의 형제 목록까지 연다(web/breadcrumbCommands.ts)
  { keys: ["Shift+Meta+Semicolon"], command: "editor:breadcrumbsFocus", when: "editor" },
  { keys: ["Shift+Meta+Period"], command: "editor:breadcrumbsFocusAndSelect", when: "editor" },
  // 다음, 이전 문제(진단)로 이동. hover 의 View Problem 단추도 같은 이동이다
  { keys: ["Alt+F8"], command: "nextProblem", when: "editor" },
  { keys: ["Alt+Shift+F8"], command: "prevProblem", when: "editor" },
  { keys: ["F8"], command: "nextProblem", when: "editor" },
  { keys: ["Shift+F8"], command: "prevProblem", when: "editor" },
  { keys: ["Meta+Backslash"], command: "splitEditorRight", when: "editorArea" },
  { keys: [K, "Meta+Backslash"], command: "splitEditorDown", when: "editorArea" },
  { keys: [K, "Meta+ArrowLeft"], command: "focusLeftEditorGroup", when: "editorArea" },
  { keys: [K, "Meta+ArrowRight"], command: "focusRightEditorGroup", when: "editorArea" },
  { keys: [K, "Meta+ArrowUp"], command: "focusAboveEditorGroup", when: "editorArea" },
  { keys: [K, "Meta+ArrowDown"], command: "focusBelowEditorGroup", when: "editorArea" },
  { keys: [K, "ArrowLeft"], command: "moveEditorGroupLeft", when: "editorArea" },
  { keys: [K, "ArrowRight"], command: "moveEditorGroupRight", when: "editorArea" },
  { keys: [K, "ArrowUp"], command: "moveEditorGroupUp", when: "editorArea" },
  { keys: [K, "ArrowDown"], command: "moveEditorGroupDown", when: "editorArea" },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): Binding => ({ keys: [`Meta+Digit${n}`], command: `focusEditorGroup:${n - 1}`, when: "editorGroupKeys" })),
  { keys: ["Ctrl+Meta+ArrowLeft"], command: "moveEditorToPreviousGroup", when: "editorArea" },
  { keys: ["Ctrl+Meta+ArrowRight"], command: "moveEditorToNextGroup", when: "editorArea" },
  { keys: ["Ctrl+Meta+Digit1"], command: "moveEditorToFirstGroup", when: "editorArea" },
  { keys: ["Ctrl+Meta+Digit9"], command: "moveEditorToLastGroup", when: "editorArea" },
  // 탭 이동(맥 기본 키): ⌥⌘←→ 이전, 다음 에디터(그룹을 넘어서), ⌘K ⌥⌘←→ 그룹 안, ⌘K ⇧⌘←→ 탭 자리 옮기기, ⌃1~9 n 번째 탭, ⌃0 마지막 탭
  // ⌥⌘←→ 는 포커스가 대화에 있어도 에디터 탭을 옮긴다(세션 이동은 ⌘[ ⌘], ⌃- 와 팔레트).
  { keys: ["Alt+Meta+ArrowLeft"], command: "previousEditor" },
  { keys: ["Alt+Meta+ArrowRight"], command: "nextEditor" },
  { keys: ["Shift+Meta+BracketLeft"], command: "previousEditor" },
  { keys: ["Shift+Meta+BracketRight"], command: "nextEditor" },
  { keys: [K, "Alt+Meta+ArrowLeft"], command: "previousEditorInGroup", when: "editorArea" },
  { keys: [K, "Alt+Meta+ArrowRight"], command: "nextEditorInGroup", when: "editorArea" },
  { keys: [K, "Shift+Meta+ArrowLeft"], command: "moveEditorLeftInGroup", when: "editorArea" },
  { keys: [K, "Shift+Meta+ArrowRight"], command: "moveEditorRightInGroup", when: "editorArea" },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): Binding => ({ keys: [`Ctrl+Digit${n}`], command: `openEditorAtIndex:${n - 1}`, when: "editorArea" })),
  { keys: ["Ctrl+Digit0"], command: "lastEditorInGroup", when: "editorArea" },
  // ⌃Tab 은 Ctrl 을 누르고 있는 동안 최근에 쓴 탭을 돈다(web/tabSwitcher.ts)
  { keys: ["Ctrl+Tab"], command: "cycleRecentEditor", when: "editorArea" },
  { keys: ["Ctrl+Shift+Tab"], command: "cycleRecentEditorBack", when: "editorArea" },
  // CTRLTAB: 에디터 밖(대화, 사이드바, Board, Notes, 터미널)의 ⌃Tab, ⌃⇧Tab 은 macOS ⌘Tab 처럼 최근 세션 전환 창을 연다(web/sessionSwitcher.ts). 에디터 그룹 안에서는 위의 탭 전환이 먼저다(메모 편집기는 에디터 그룹이 아니라 세션 전환 창이 뜬다).
  // ⌃ 만 쓴 키라 INTERCEPT_STROKES 에 들지 않고, ⌃ 를 떼는 keyup 도 페이지가 그대로 받는다. 칸 사이 이동(focusPaneNext, focusPanePrev)은 팔레트 명령으로 남는다.
  { keys: ["Ctrl+Tab"], command: "sessionSwitcher" },
  { keys: ["Ctrl+Shift+Tab"], command: "sessionSwitcherBack" },
  // 닫기: ⌘K W 그룹의 모든 탭, ⌘K U 저장된 탭, ⌥⌘T 다른 탭, ⌘K ⌘W 모든 에디터, ⌘K ⇧⌘W 모든 그룹. 세션 칸 키(⌘K W, ⌘K ⌘W)보다 앞이다.
  { keys: [K, "KeyW"], command: "closeEditorsInGroup", when: "editorArea" },
  { keys: [K, "KeyU"], command: "closeUnmodifiedEditors", when: "editorArea" },
  { keys: ["Alt+Meta+KeyT"], command: "closeOtherEditors", when: "editorArea" },
  { keys: [K, "Meta+KeyW"], command: "closeAllEditors", when: "editorArea" },
  { keys: [K, "Shift+Meta+KeyW"], command: "closeAllGroups", when: "editorArea" },
  // 탭 고정: ⌘K Enter Keep Open(미리보기 해제), ⌘K ⇧Enter Pin/Unpin(붙박이)
  { keys: [K, "Enter"], command: "keepEditor", when: "editorArea" },
  { keys: [K, "Shift+Enter"], command: "pinEditor", when: "editorArea" },
  { keys: [K, "Meta+KeyM"], command: "toggleMaximizeEditorGroup", when: "editorArea" },
  { keys: ["Alt+Meta+Digit0"], command: "flipEditorGroupLayout", when: "editorArea" },
  { keys: ["Shift+Meta+KeyT"], command: "reopenClosedEditor", when: "editorArea" },
  { keys: [K, "F12"], command: "revealDefinitionAside", when: "editor" },
  // 칸 분할과 이동
  { keys: ["Meta+Backslash"], command: "split" },
  { keys: [K, "Meta+Backslash"], command: "splitDown" },
  { keys: ["Ctrl+Meta+ArrowLeft"], command: "movePanePrev" },
  { keys: ["Ctrl+Meta+ArrowRight"], command: "movePaneNext" },
  { keys: [K, "Meta+ArrowLeft"], command: "focusPaneLeft" },
  { keys: [K, "Meta+ArrowRight"], command: "focusPaneRight" },
  { keys: [K, "Meta+ArrowUp"], command: "focusPaneUp" },
  { keys: [K, "Meta+ArrowDown"], command: "focusPaneDown" },
  { keys: [K, "ArrowLeft"], command: "focusPaneLeft" },
  { keys: [K, "ArrowRight"], command: "focusPaneRight" },
  { keys: [K, "ArrowUp"], command: "focusPaneUp" },
  { keys: [K, "ArrowDown"], command: "focusPaneDown" },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): Binding => ({ keys: [`Meta+Digit${n}`], command: `focusPaneIndex:${n - 1}` })),
  { keys: ["Meta+Digit9"], command: "focusPaneIndex:last" },
  // 닫기와 다시 열기
  { keys: ["Meta+KeyW"], command: "close" },
  { keys: [K, "KeyW"], command: "closeAllChats" },
  { keys: [K, "Meta+KeyW"], command: "closeAllSessions" },
  { keys: ["Shift+Meta+KeyT"], command: "reopenClosed" },
  // 세션 이동
  { keys: ["Ctrl+Minus"], command: "sessionBack", when: "notEditor" },
  { keys: ["Ctrl+Shift+Minus"], command: "sessionForward", when: "notEditor" },
  { keys: ["Meta+BracketLeft"], command: "sessionBack", when: "notEditor" },
  { keys: ["Meta+BracketRight"], command: "sessionForward", when: "notEditor" },
  { keys: ["Alt+Meta+ArrowUp"], command: "promptPrev", when: "notEditor" },
  { keys: ["Alt+Meta+ArrowDown"], command: "promptNext", when: "notEditor" },
  { keys: ["Shift+Meta+KeyA"], command: "focusApproval" },
  { keys: ["Meta+Enter"], command: "acceptTool", when: "approval" },
  { keys: ["Alt+Meta+Enter"], command: "skipTool", when: "approval" },
  { keys: ["Meta+Slash"], command: "attachMenu", when: "notEditorOrComposer" },
  { keys: ["Alt+KeyH"], command: "attach" },
  { keys: ["Shift+Meta+KeyI"], command: "cycleEffort" },
  { keys: ["Shift+Meta+KeyM"], command: "models" },
  { keys: ["Ctrl+KeyC"], command: "interrupt", when: "notTerminal" },
  // 새 세션
  { keys: ["Meta+KeyN"], command: "newSession" },
  { keys: [K, "Meta+KeyN"], command: "quickChat" },
  { keys: ["Shift+Meta+KeyN"], command: "newWindow", when: "electron" },
  { keys: ["Shift+Meta+KeyW"], command: "closeWindow", when: "electron" },
  { keys: ["Ctrl+Alt+KeyR"], command: "sessions" },
  { keys: [K], command: "terminalClear", when: "terminal" },
  { keys: [K], command: "search", when: "notEditor" },
  // B6: 명령 팔레트
  { keys: ["Shift+Meta+KeyP"], command: "commandPalette" },
  { keys: [K, "Meta+KeyS"], command: "keyboardShortcuts" },
  { keys: ["Meta+KeyR"], command: "browserReload", when: "browserTab" },
  // Developer: Reload Window. Electron 메뉴 가속키(⌘R)와 같은 키라 메인이 가로채 페이지의 확인 절차를 거치게 한다.
  { keys: ["Meta+KeyR"], command: "reloadWindow" },
  // 이미 있던 키
  { keys: ["Meta+KeyP"], command: "quickOpen" },
  { keys: ["Shift+Meta+KeyF"], command: "findInFiles" },
  { keys: ["Shift+Meta+KeyH"], command: "replaceInFiles" },
  { keys: ["F4"], command: "focusNextSearchResult" },
  { keys: ["Shift+F4"], command: "focusPreviousSearchResult" },
  { keys: ["Shift+Meta+KeyO"], command: "gotoSymbol" },
  // 줄로 이동
  { keys: ["Ctrl+KeyG"], command: "gotoLine", when: "editorArea" },
  { keys: ["Meta+KeyI"], command: "terminalAsk", when: "terminal" },
  { keys: ["Meta+KeyI"], command: "quickAsk" },
  { keys: ["Shift+Meta+KeyB"], command: "btw" },
  { keys: ["Shift+Meta+KeyK"], command: "board", when: "notEditor" },
  { keys: ["Shift+Meta+KeyL"], command: "inbox", when: "notEditor" },
  { keys: ["Alt+Meta+KeyF"], command: "feedback", when: "notEditor" },
  { keys: ["Alt+Meta+KeyN"], command: "notes", when: "notEditor" },
  { keys: ["Shift+Meta+KeyX"], command: "feedback" },
  { keys: ["Meta+Comma"], command: "openSettings" },
  { keys: ["Meta+KeyL"], command: "focusChatInput" },
  { keys: ["Meta+KeyB"], command: "toggleFocusSide", when: "focusLayout" },
  { keys: ["Alt+Meta+KeyB"], command: "toggleFocusChat", when: "focusLayout" },
  { keys: ["Meta+KeyB"], command: "toggleSidebar" },
  { keys: ["Meta+KeyJ"], command: "toggleBottom" },
  { keys: ["Alt+Meta+KeyB"], command: "toggleRight" },
  { keys: ["Ctrl+Shift+KeyG"], command: "sourceControl" },
  { keys: ["Shift+Meta+KeyG"], command: "sourceControl", when: "focusNotEditor" },
  { keys: ["Shift+Meta+KeyE"], command: "showFiles" },
  { keys: ["Ctrl+Shift+KeyM"], command: "toggleTabFocusMode" },
  { keys: ["Ctrl+Alt+KeyL"], command: "toggleLayout" },
  { keys: ["Ctrl+Meta+KeyJ"], command: "toggleFloat" },
  { keys: ["Ctrl+Meta+KeyI"], command: "focusSession" },
  { keys: ["Alt+Meta+BracketLeft"], command: "editor:fold", when: "editor" },
  { keys: ["Alt+Meta+BracketRight"], command: "editor:unfold", when: "editor" },
  { keys: [K, "Meta+Digit0"], command: "editor:foldAll", when: "editor" },
  { keys: [K, "Meta+KeyJ"], command: "editor:unfoldAll", when: "editor" },
  { keys: [K, "Meta+KeyL"], command: "editor:toggleFold", when: "editor" },
  { keys: [K, "Shift+Meta+KeyL"], command: "editor:toggleFoldRecursively", when: "editor" },
  { keys: [K, "Meta+BracketLeft"], command: "editor:foldRecursively", when: "editor" },
  { keys: [K, "Meta+BracketRight"], command: "editor:unfoldRecursively", when: "editor" },
  ...[1, 2, 3, 4, 5, 6, 7].map((level): Binding => ({ keys: [K, `Meta+Digit${level}`], command: `editor:foldLevel${level}`, when: "editor" })),
  { keys: [K, "Meta+Slash"], command: "editor:foldAllBlockComments", when: "editor" },
  { keys: [K, "Meta+Digit8"], command: "editor:foldAllMarkerRegions", when: "editor" },
  { keys: [K, "Meta+Digit9"], command: "editor:unfoldAllMarkerRegions", when: "editor" },
  { keys: [K, "Meta+Minus"], command: "editor:foldAllExcept", when: "editor" },
  { keys: [K, "Meta+Equal"], command: "editor:unfoldAllExcept", when: "editor" },
  { keys: ["Ctrl+KeyJ"], command: "editor:joinLines", when: "editor" },
  { keys: [K, "Meta+KeyC"], command: "editor:addCommentLine", when: "editor" },
  { keys: [K, "Meta+KeyU"], command: "editor:removeCommentLine", when: "editor" },
  { keys: [K, "Meta+KeyX"], command: "editor:trimTrailingWhitespace", when: "editor" },
  { keys: ["Ctrl+Shift+Meta+ArrowRight"], command: "editor:smartSelectExpand", when: "editor" },
  { keys: ["Ctrl+Shift+ArrowRight"], command: "editor:smartSelectExpand", when: "editor" },
  { keys: ["Ctrl+Shift+Meta+ArrowLeft"], command: "editor:smartSelectShrink", when: "editor" },
  { keys: ["Ctrl+Shift+ArrowLeft"], command: "editor:smartSelectShrink", when: "editor" },
  { keys: ["Shift+Meta+KeyL"], command: "editor:selectHighlights", when: "editor" },
  { keys: ["Meta+F2"], command: "editor:changeAll", when: "editor" },
  { keys: [K, "Meta+KeyD"], command: "editor:moveSelectionToNextFindMatch", when: "editor" },
  { keys: ["Alt+Shift+KeyI"], command: "editor:insertCursorAtEndOfEachLineSelected", when: "editor" },
  { keys: [K, "Meta+KeyI"], command: "editor:showHover", when: "editor" },
  { keys: ["Alt+Shift+Meta+ArrowLeft"], command: "editor:columnSelectLeft", when: "editor" },
  { keys: ["Alt+Shift+Meta+ArrowRight"], command: "editor:columnSelectRight", when: "editor" },
  { keys: ["Alt+Shift+Meta+ArrowUp"], command: "editor:columnSelectUp", when: "editor" },
  { keys: ["Alt+Shift+Meta+ArrowDown"], command: "editor:columnSelectDown", when: "editor" },
  { keys: ["Alt+Shift+Meta+PageUp"], command: "editor:columnSelectPageUp", when: "editor" },
  { keys: ["Alt+Shift+Meta+PageDown"], command: "editor:columnSelectPageDown", when: "editor" },
  { keys: ["Ctrl+Alt+ArrowLeft"], command: "editor:cursorWordPartLeft", when: "editor" },
  { keys: ["Ctrl+Alt+Shift+ArrowLeft"], command: "editor:cursorWordPartLeftSelect", when: "editor" },
  { keys: ["Ctrl+Alt+ArrowRight"], command: "editor:cursorWordPartRight", when: "editor" },
  { keys: ["Ctrl+Alt+Shift+ArrowRight"], command: "editor:cursorWordPartRightSelect", when: "editor" },
  { keys: ["Ctrl+Alt+Backspace"], command: "editor:deleteWordPartLeft", when: "editor" },
  { keys: ["Ctrl+Alt+Delete"], command: "editor:deleteWordPartRight", when: "editor" },
  { keys: ["Alt+Meta+Backspace"], command: "editor:removeBrackets", when: "editor" },
  { keys: [K, "Meta+KeyB"], command: "editor:setSelectionAnchor", when: "editor" },
  { keys: [K, "Meta+KeyK"], command: "editor:selectFromAnchorToCursor", when: "editor" },
  { keys: ["Escape"], command: "escape" },
  { keys: ["Meta+KeyT"], command: "openBrowser", when: "browserTab" },
  { keys: ["Meta+KeyT"], command: "symbols" },
  { keys: ["Meta+Equal"], command: "browserZoomIn", when: "browserTab" },
  { keys: ["Meta+Minus"], command: "browserZoomOut", when: "browserTab" },
  { keys: ["Meta+Numpad0"], command: "browserZoomReset", when: "browserTab" },
  { keys: ["Meta+KeyF"], command: "browserFind", when: "browserTab" },
  // Q2: 대화 칸에 포커스가 있을 때의 ⌘F 는 대화 안 찾기. 에디터의 ⌘F 는 에디터 찾기가 먼저 받는다.
  { keys: ["Meta+KeyF"], command: "chatFind", when: "chat" },
  { keys: ["Meta+KeyY"], command: "browserHistory", when: "browserTab" },
  { keys: ["Meta+KeyD"], command: "browserFavorite", when: "browserTab" },
  { keys: ["Shift+Meta+KeyC"], command: "addElement", when: "browserTab" },
  { keys: ["Alt+Meta+KeyC"], command: "commentElements", when: "browserTab" },
  { keys: ["Alt+Meta+KeyL"], command: "searchDetails", when: "searchTab" },
  { keys: ["Meta+Equal"], command: "zoomIn", when: "electron" },
  { keys: ["Shift+Meta+Equal"], command: "zoomIn", when: "electron" },
  { keys: ["Meta+NumpadAdd"], command: "zoomIn", when: "electron" },
  { keys: ["Meta+Minus"], command: "zoomOut", when: "electron" },
  { keys: ["Shift+Meta+Minus"], command: "zoomOut", when: "electron" },
  { keys: ["Meta+NumpadSubtract"], command: "zoomOut", when: "electron" },
  { keys: ["Meta+Numpad0"], command: "zoomReset", when: "electron" },
  { keys: ["Meta+Digit0"], command: "zoomReset", when: "electron" },
];

const ed = (keys: string, command: string): Binding => ({ keys: [keys], command, when: "editor" });
const anywhere = (keys: string, command: string): Binding => ({ keys: [keys], command });

export const WEBSTORM_BINDINGS: Binding[] = [
  // 편집
  ed("Meta+KeyD", "editor:duplicateSelection"),
  ed("Meta+Backspace", "editor:deleteLines"),
  ed("Alt+Meta+Slash", "editor:blockComment"),
  ed("Alt+ArrowUp", "editor:smartSelectExpand"),
  ed("Alt+ArrowDown", "editor:smartSelectShrink"),
  ed("Alt+Shift+ArrowUp", "editor:moveLinesUp"),
  ed("Alt+Shift+ArrowDown", "editor:moveLinesDown"),
  ed("Alt+Enter", "quickFix"),
  ed("Alt+Meta+KeyL", "formatDocument"),
  ed("Ctrl+Shift+KeyJ", "editor:joinLines"),
  ed("Shift+Enter", "editor:insertLineAfter"),
  ed("Alt+Meta+Enter", "editor:insertLineBefore"),
  // 접기
  ed("Meta+Period", "editor:toggleFold"),
  ed("Meta+Equal", "editor:unfold"),
  ed("Meta+Minus", "editor:fold"),
  ed("Alt+Meta+Equal", "editor:unfoldRecursively"),
  ed("Alt+Meta+Minus", "editor:foldRecursively"),
  ed("Shift+Meta+Equal", "editor:unfoldAll"),
  ed("Shift+Meta+Minus", "editor:foldAll"),
  ed("Meta+NumpadAdd", "editor:unfold"),
  ed("Meta+NumpadSubtract", "editor:fold"),
  // 선택과 찾기
  ed("Ctrl+KeyG", "editor:addSelectionToNextFindMatch"),
  ed("Ctrl+Meta+KeyG", "editor:selectHighlights"),
  ed("Meta+KeyR", "editor:startFindReplace"),
  // 이동(LSP)
  ed("Meta+KeyB", "editor:goToDeclaration"),
  ed("Alt+Meta+KeyB", "editor:goToImplementation"),
  ed("Meta+KeyY", "editor:peekDefinition"),
  ed("Ctrl+Shift+KeyB", "editor:goToTypeDefinition"),
  ed("Alt+F7", "editor:findReferences"),
  ed("Alt+Meta+F7", "editor:peekReferences"),
  ed("Shift+F6", "editor:rename"),
  ed("F2", "nextProblem"),
  ed("Shift+F2", "prevProblem"),
  // 정보
  ed("Meta+KeyP", "editor:triggerParameterHints"),
  ed("Ctrl+KeyJ", "editor:showHover"),
  ed("F1", "editor:showHover"),
  ed("Ctrl+KeyM", "editor:jumpToBracket"),
  ed("Ctrl+Alt+ArrowDown", "editor:wordHighlightNext"),
  ed("Ctrl+Alt+ArrowUp", "editor:wordHighlightPrev"),
  // 뒤로, 앞으로
  ed("Meta+BracketLeft", "editor:navigateBack"),
  ed("Alt+Meta+ArrowLeft", "editor:navigateBack"),
  ed("Meta+BracketRight", "editor:navigateForward"),
  ed("Alt+Meta+ArrowRight", "editor:navigateForward"),
  // 줄과 심볼로 이동, 액션 찾기. ⇧⌘A 는 에디터 밖에서 아래 BINDINGS 의 승인 카드 키로 남는다.
  ed("Meta+KeyL", "gotoLine"),
  ed("Meta+F12", "gotoSymbol"),
  ed("Shift+Meta+KeyA", "commandPalette"),
  // 어디서나
  anywhere("Shift+Meta+KeyO", "quickOpen"),
  anywhere("Meta+KeyE", "quickOpen"),
  anywhere("Meta+KeyO", "symbols"),
  anywhere("Alt+Meta+KeyO", "symbols"),
  anywhere("Shift+Meta+KeyR", "replaceInFiles"),
  anywhere("Alt+F12", "toggleBottom"),
];

// 위 줄이 뜻을 가져가는 BINDINGS 의 줄. 같은 키를 두 곳이 쓰면 안 되는 것(중복)과, 에디터 밖에서도 WebStorm 뜻이 되어야 하는 것(⇧⌘O)이다.
export const WEBSTORM_DROPS: readonly { command: string; keys: readonly string[] }[] = [
  { command: "gotoSymbol", keys: ["Shift+Meta+KeyO"] },
  { command: "quickFix", keys: ["Meta+Period"] },
  { command: "gotoLine", keys: ["Ctrl+KeyG"] },
  { command: "previousEditor", keys: ["Alt+Meta+ArrowLeft"] },
  { command: "nextEditor", keys: ["Alt+Meta+ArrowRight"] },
  // WebStorm 의 ⌃J 는 Quick Documentation 이라 Join Lines 는 ⌃⇧J 로만 남긴다.
  { command: "editor:joinLines", keys: ["Ctrl+KeyJ"] },
];

const presetCache = new Map<KeymapPreset, Binding[]>();

// 프리셋의 전체 표. 같은 인자면 같은 배열을 돌려준다(키마다 stepKey 가 부른다).
export function bindingsFor(preset: KeymapPreset): Binding[] {
  if (preset !== "webstorm") return BINDINGS;
  let list = presetCache.get(preset);
  if (!list) {
    const dropped = (b: Binding) => WEBSTORM_DROPS.some((d) => d.command === b.command && d.keys.join(" ") === b.keys.join(" "));
    list = [...WEBSTORM_BINDINGS, ...BINDINGS.filter((b) => !dropped(b))];
    presetCache.set(preset, list);
  }
  return list;
}

// 지금 쓰는 프리셋. 화면이 설정을 받을 때마다 web/main.tsx 가 넣는다. DOM 과 store 에 기대지 않아 이 모듈은 메인 프로세스와 시험이 그대로 쓴다.
let activePreset: KeymapPreset = "vscode";

export function setKeymapPreset(preset: KeymapPreset) {
  activePreset = preset;
}

export function activeKeymapPreset(): KeymapPreset {
  return activePreset;
}

export function activeBindings(): Binding[] {
  return bindingsFor(activePreset);
}

// code 가 비어 오는 합성 입력(검증 창구의 sendInputEvent)을 위해 key 로 code 를 되짚는다.
const CODE_BY_KEY: Record<string, string> = { "\\": "Backslash", "-": "Minus", "=": "Equal", "+": "Equal", "/": "Slash", "left": "ArrowLeft", "right": "ArrowRight", "up": "ArrowUp", "down": "ArrowDown", "esc": "Escape", "escape": "Escape" };

function codeOf(input: KeyInput): string | null {
  if (input.code) return input.code;
  const key = input.key;
  if (!key) return null;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key.startsWith("Arrow")) return key;
  return CODE_BY_KEY[key.toLowerCase()] ?? key;
}

const MODIFIER_CODES = /^(Meta|Shift|Alt|Control|CapsLock|OS)(Left|Right)?$/;

// 수정키만 눌린 입력은 null. chord 도중 ⌘ 를 떼거나 ⇧ 를 눌러도 취소되면 안 되기 때문에 호출하는 쪽이 이 값을 건너뛴다.
export function strokeOf(input: KeyInput): string | null {
  const code = codeOf(input);
  if (!code || MODIFIER_CODES.test(code)) return null;
  const parts: string[] = [];
  if (input.ctrlKey) parts.push("Ctrl");
  if (input.altKey) parts.push("Alt");
  if (input.shiftKey) parts.push("Shift");
  if (input.metaKey) parts.push("Meta");
  parts.push(code);
  return parts.join("+");
}

export type Pending = { prefix: string; at: number };

export type Step =
  | { kind: "run"; command: string; pending: null }
  // opens 는 첫 키가 chord 접두이면서 단독 키 명령도 있을 때 그 명령이다. 호출하는 쪽이 바로 실행하고 두 번째 키도 기다린다.
  | { kind: "pending"; pending: Pending; opens?: string }
  // chord 를 시작했지만 두 번째 키가 표에 없거나 시간이 지났다. 키는 삼키고 상태를 비운다.
  | { kind: "cancel"; pending: null }
  | { kind: "pass"; pending: null };

// 숨긴 화면의 명령(설정 Show Board, Show Slack 이 꺼진 board, inbox 등)은 표에 없는 것처럼 건너뛴다. 키는 pass 로 남아 기본 동작으로 넘어간다.
const usable = (b: Binding, ctx: KeyContext) => whenOk(b.when, ctx) && !ctx.hiddenCommands?.has(b.command);

const whenOk = (when: When | undefined, ctx: KeyContext) => {
  if (when === "terminal") return !!ctx.inTerminal;
  if (when === "notTerminal") return !ctx.inTerminal;
  if (when === "notEditor") return !ctx.inEditor;
  if (when === "editor") return !!ctx.inEditor;
  if (when === "editorArea") return !!ctx.inEditorArea;
  // ⌘1~⌘8 에디터 그룹 포커스: 에디터 영역 안이거나 Editor 중심 배치일 때
  if (when === "editorGroupKeys") return !!ctx.inEditorArea || !!ctx.inFocusLayout;
  if (when === "notComposer") return !ctx.inComposer;
  if (when === "notEditorOrComposer") return !ctx.inEditor && !ctx.inComposer;
  if (when === "electron") return !!ctx.inElectron;
  if (when === "browserTab") return !!ctx.inBrowser;
  if (when === "searchTab") return !!ctx.inSearch;
  // 대화 칸(타임라인, 입력창)에 포커스가 있고 에디터나 터미널이 아닐 때
  if (when === "chat") return !!ctx.inChat && !ctx.inEditor && !ctx.inTerminal;
  // 활성 칸에 도구 승인 카드가 떠 있을 때. 에디터와 터미널이 아니면 입력창이든 사이드바든 어디에 포커스가 있어도 듣는다(포커스를 카드로 옮기지 않고 답하려는 키).
  if (when === "approval") return !!ctx.approvalPending && !ctx.inEditor && !ctx.inTerminal;
  if (when === "focusLayout") return !!ctx.inFocusLayout;
  if (when === "focusNotEditor") return !!ctx.inFocusLayout && !ctx.inEditor;
  return true;
};

const isModified = (stroke: string) => /(^|\+)(Meta|Ctrl|Alt)\+/.test(stroke);

export function stepKey(pending: Pending | null, stroke: string, ctx: KeyContext, now: number, bindings: Binding[] = activeBindings()): Step {
  const live = pending && now - pending.at <= CHORD_TIMEOUT_MS ? pending : null;
  const opensOf = (key: string) => bindings.find((b) => b.keys.length === 1 && b.keys[0] === key && usable(b, ctx))?.command;
  if (live) {
    const hit = bindings.find((b) => b.keys.length === 2 && b.keys[0] === live.prefix && b.keys[1] === stroke && usable(b, ctx));
    if (ctx.inSearchOverlay) {
      // 접두 키를 다시 누르면 검색창이 닫히고 chord 를 다시 기다린다(⌘K ⌘K 뒤 W 나 방향키 chord 로 가는 길).
      const again = stroke === live.prefix ? opensOf(stroke) : undefined;
      if (again) return { kind: "pending", pending: { prefix: stroke, at: now }, opens: again };
      // 글자, 방향키, 맞지 않는 수정키 입력은 검색창이 받는다.
      if (hit && isModified(stroke)) return { kind: "run", command: hit.command, pending: null };
      return { kind: "pass", pending: null };
    }
    if (hit) return { kind: "run", command: hit.command, pending: null };
    return { kind: "cancel", pending: null };
  }
  // 터미널 전용 단독 키(⌘K 지우기)는 chord 를 시작하지 않는다: 지운 뒤 다음 키가 삼켜지면 안 된다.
  const terminalOnly = ctx.inTerminal ? bindings.find((b) => b.keys.length === 1 && b.keys[0] === stroke && b.when === "terminal") : undefined;
  if (terminalOnly) return { kind: "run", command: terminalOnly.command, pending: null };
  if (bindings.some((b) => b.keys.length === 2 && b.keys[0] === stroke)) {
    const opens = opensOf(stroke);
    return { kind: "pending", pending: { prefix: stroke, at: now }, ...(opens ? { opens } : {}) };
  }
  const hit = bindings.find((b) => b.keys.length === 1 && b.keys[0] === stroke && usable(b, ctx));
  return hit ? { kind: "run", command: hit.command, pending: null } : { kind: "pass", pending: null };
}

const isMenuKey = (stroke: string) => /(^|\+)(Meta|Alt)\+/.test(stroke);
const alwaysApplies = (b: Binding) => b.when === undefined || b.when === "electron";
export function keyupAwareStrokes(bindings: readonly Binding[]): ReadonlySet<string> {
  return new Set(bindings.filter((b) => b.keys.length === 1 && alwaysApplies(b) && (b.command === "quickOpen" || b.command === "commandPalette")).map((b) => b.keys[0]));
}

export function interceptStrokes(bindings: readonly Binding[]): ReadonlySet<string> {
  const keyup = keyupAwareStrokes(bindings);
  return new Set(bindings.filter((b) => b.keys.length === 1 && alwaysApplies(b)).map((b) => b.keys[0]).filter((stroke) => isMenuKey(stroke) && !keyup.has(stroke)));
}

// 페이지(guest) 안에 포커스가 있을 때는 이 키들도 메인이 받아 앱 창으로 넘긴다.
export function browserStrokes(bindings: readonly Binding[]): ReadonlySet<string> {
  return new Set(bindings.filter((b) => b.when === "browserTab").flatMap((b) => b.keys));
}

export const KEYUP_AWARE_STROKES: ReadonlySet<string> = keyupAwareStrokes(BINDINGS);
export const INTERCEPT_STROKES: ReadonlySet<string> = interceptStrokes(BINDINGS);
export const BROWSER_STROKES: ReadonlySet<string> = browserStrokes(BINDINGS);

// 코드 에디터가 프리셋 때문에 표에 넘겨야 하는 키(web/editorPresetKeys.ts). CodeMirror 기본 키맵이 같은 키로 따로 동작하면 표의 명령과 두 번 일어나므로 에디터는 이 키를 먹고 표가 처리하게 둔다.
// 에디터 안에서 참이 될 수 있는 조건의 줄만 든다. 수정키 없는 Esc, Enter, Tab, 방향키는 입력의 기본 동작이라 어떤 표에서도 넣지 않는다.
const EDITOR_REACHABLE: ReadonlySet<When | undefined> = new Set<When | undefined>([undefined, "editor", "editorArea", "editorGroupKeys", "electron", "notTerminal", "notComposer"]);
const PLAIN_EDITING_KEY = /^(Escape|Enter|Tab|Backspace|Delete|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Space)$/;

export function editorTakenStrokes(preset: KeymapPreset): ReadonlySet<string> {
  if (preset !== "webstorm") return new Set();
  return new Set(WEBSTORM_BINDINGS.filter((b) => b.keys.length === 1 && EDITOR_REACHABLE.has(b.when)).map((b) => b.keys[0]).filter((stroke) => !PLAIN_EDITING_KEY.test(stroke)));
}

// Electron 메뉴 가속키 표기. 단독 키만 되고 chord 와 모르는 키는 null.
const ACCELERATOR_KEYS: Record<string, string> = { Equal: "=", Minus: "-", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Period: ".", Comma: ",", Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Escape: "Esc", Numpad0: "num0", NumpadAdd: "numadd", NumpadSubtract: "numsub" };
const ACCELERATOR_MODIFIERS: Record<string, string> = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Cmd" };

export function acceleratorOf(stroke: string): string | null {
  const parts = stroke.split("+");
  const code = parts.pop() ?? "";
  const mods = parts.map((m) => ACCELERATOR_MODIFIERS[m]);
  if (mods.some((m) => !m)) return null;
  const key = ACCELERATOR_KEYS[code] ?? (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5) : /^(F[0-9]{1,2}|Enter|Backspace|Delete|Tab|Space|Home|End|PageUp|PageDown)$/.test(code) ? code : null);
  return key ? [...mods, key].join("+") : null;
}

export function chordFollowersOf(bindings: readonly Binding[], prefix: string, menuStrokes: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(bindings.flatMap((b) => (b.keys.length === 2 && b.keys[0] === prefix && menuStrokes.has(b.keys[1]) ? [b.keys[1]] : [])));
}

const ACCELERATOR_MODIFIER_STROKES: Record<string, string> = { command: "Meta", cmd: "Meta", commandorcontrol: "Meta", cmdorctrl: "Meta", super: "Meta", meta: "Meta", control: "Ctrl", ctrl: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift" };
const ACCELERATOR_KEY_CODES: Record<string, string> = Object.fromEntries(Object.entries(ACCELERATOR_KEYS).map(([code, key]) => [key.toLowerCase(), code]));

export function strokeOfAccelerator(accelerator: string): string | null {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set<string>();
  for (const part of parts) {
    const mod = ACCELERATOR_MODIFIER_STROKES[part.toLowerCase()];
    if (!mod) return null;
    mods.add(mod);
  }
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : /^F[0-9]{1,2}$/i.test(key) ? key.toUpperCase() : (ACCELERATOR_KEY_CODES[key.toLowerCase()] ?? null);
  if (!code) return null;
  return [...["Ctrl", "Alt", "Shift", "Meta"].filter((m) => mods.has(m)), code].join("+");
}

// 메뉴 항목이 보일 키: 표에서 그 명령의 첫 단독 키 중 어디서나 듣는 것(맥락이 갈리는 키는 메뉴에 두지 않는다). 없으면 null.
export function menuAccelerator(bindings: readonly Binding[], command: string): string | null {
  const candidates = bindings.filter((b) => b.command === command && b.keys.length === 1 && alwaysApplies(b) && acceleratorOf(b.keys[0]) !== null);
  const binding = candidates.find((b) => !b.keys[0].includes("Numpad")) ?? candidates[0];
  return binding ? acceleratorOf(binding.keys[0]) : null;
}

// 글자 키를 글자로 맞출 때 쓰는 값(소문자). 한글 입력 중에는 key 가 자모(C 자리가 ㅊ)라서 물리 키(code)의 글자로 읽는다.
// key 가 로마자면 그대로 써서 Dvorak 같은 배열은 지금처럼 찍히는 글자를 따른다. 글자 키가 아니면 key 그대로다.
export function latinKeyOf(e: { key: string; code?: string }): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(e.code ?? "");
  return physical ? physical[1].toLowerCase() : e.key;
}

// 터미널이 셸로 보내는 줄 편집 키의 바이트열. 해당 없는 키는 null 이라 xterm 이 평소대로 처리한다.
export function terminalKeySequence(e: Pick<KeyboardEvent, "key" | "metaKey" | "altKey" | "shiftKey" | "ctrlKey"> & { code?: string }, hasSelection: boolean): string | null {
  if (e.ctrlKey) return null;
  if (e.metaKey && !e.altKey && !e.shiftKey) {
    if (e.key === "ArrowLeft") return "\x01";
    if (e.key === "ArrowRight") return "\x05";
    if (e.key === "Backspace") return "\x15";
    if (latinKeyOf(e) === "c" && !hasSelection) return "\x19";
  }
  if (e.altKey && !e.metaKey && !e.shiftKey) {
    if (e.key === "ArrowLeft") return "\x1bb";
    if (e.key === "ArrowRight") return "\x1bf";
    if (e.key === "Backspace") return "\x17";
  }
  if (e.shiftKey && !e.metaKey && !e.altKey && e.key === "Enter") return "\x1b\r";
  return null;
}

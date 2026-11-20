import { sessionPanelToggleable } from "./centerPanels";
import { isPinnedTab } from "./floatLayout";
import { findInFiles, focusSearchResult } from "./findInFiles";
import { openChatFind } from "./chatFindState";
import { keepSelectedFile, undoSelectedFile } from "./changeCommands";
import { formatActive, newFileByPath, requestCloseTab, saveTab } from "./editorDocs";
import { runEditorCommand } from "./editorCommands";
import { moveEditorToGroup } from "./editorMove";
import { runGroupCommand } from "./groupCommands";
import { cycleSessionSwitcher } from "./sessionSwitcher";
import { focusActiveSession, toggleChatVisible, toggleFloatCollapsed } from "./floatActions";
import { copyTypeActive, currentSelection, definitionAsideActive, gotoProblemActive, quickFixActive, startQuickAsk } from "./Editor";
import { escapeFeedback, toggleFeedback } from "./Feedback";
import { rpc } from "./rpc";
import { stepChatFontSize, stepEditorFontSize } from "./fontSizeCommands";
import { toggleDetailsFromKey } from "./completionResolve";
import { setChordHint } from "./chordState";
import { activeKeymapPreset, CHORD_TIMEOUT_MS, stepKey, strokeOf, type KeyInput, type Pending } from "./keymap";
import { startHandoff } from "./handoffActions";
import { createWorktreePr, mergeWorktree } from "./worktreeActions";
import { answerToolApproval, pendingToolApproval } from "./approvalKeys";
import { closeFocused, focusApproval, requestAttachMenu, scrollToPrompt } from "./paneNav";
import { cycleEffort } from "./Pickers";
import { savePeekPreview } from "./peekView";
import { previewDesignDirection } from "./direction";
import { reloadWindow, restartDaemon } from "./reload";
import { morningReviewCommand } from "./reviewActions";
import { hiddenCommands } from "./screenVisibility";
import { clearTerminal, openTerminalAsk } from "./terminalHandles";
import { interruptAgent, openAdjacentSession, runSessionShortcut } from "./sessionActions";
import {
  activeAgent,
  activePane,
  activeTab,
  addAttachment,
  closeCard,
  dispatchBrowserAction,
  closeAllPanes,
  flash,
  focusPaneDirection,
  focusPaneIndex,
  focusPaneStep,
  goBackSession,
  goForwardSession,
  movePane,
  movePaneRow,
  focusAdjacentGroup,
  openBrowser,
  openInVSCode,
  openSearch,
  openUntitled,
  splitEditor,
  reopenClosedPane,
  getState,
  isTopWorkspace,
  openImprovements,
  openSide,
  setState,
  splitActivePane,
  splitActivePaneDown,
  startDraft,
  startQuickChat,
  toggleBoard,
  toggleInbox,
  toggleNotes, // NOTES
  openSkills, // SKILLS
  toggleLayoutMode,
  toggleSearchDetails,
  updateSearchView,
  focusPane,
  revealChat,
  setFocusSideOpen,
} from "./store";
import { S } from "./strings";
import { toggleTabFocusMode } from "./tabFocus";
import { createNoteAndOpen, flushNote } from "./notesStore"; // NOTES
import { toggleBottomPanel } from "./terminalScope";
import type { PanelAlignment } from "./layoutConfig";
import { getLayoutConfig, setLayoutConfig } from "./layoutConfigStore";
import { hint } from "./hint";
import { focusComposerIfLost } from "./overlayFocus";
import { navigateQuickOpen } from "./quickOpenNav";
import { strokeLabel } from "./shortcutList";
import { targetEditorKey } from "./activeEditor";

export const IN_ELECTRON = navigator.userAgent.includes("Electron");

// 명령 이름은 표(web/keymap.ts)의 command 와 Electron 메뉴(send)와 팔레트가 같이 쓴다. 인자가 필요한 명령은 "이름:인자".
export type Command =
  | "quickOpen"
  | "symbols"
  | "gotoLine"
  | "gotoSymbol"
  | "models"
  | "effort"
  | "cycleEffort"
  | "sessions"
  | "search"
  | "commandPalette"
  | "keyboardShortcuts"
  | "showProblems"
  | "newSession"
  | "quickChat"
  | "attach"
  | "attachMenu"
  | "interrupt"
  | "closeTab"
  | "close"
  | "closeAllChats"
  | "closeAllSessions"
  | "reopenClosed"
  | "handoff"
  | "mergeWorktree"
  | "createWorktreePr"
  | "split"
  | "splitDown"
  | "focusPanePrev"
  | "focusPaneNext"
  | "sessionSwitcher"
  | "sessionSwitcherBack"
  | "quickSwitchSession"
  | "focusPaneLeft"
  | "focusPaneRight"
  | "focusPaneUp"
  | "focusPaneDown"
  | "movePanePrev"
  | "movePaneNext"
  | "movePaneUp"
  | "movePaneDown"
  | "moveEditorToPreviousGroup"
  | "moveEditorToNextGroup"
  | "moveEditorToAboveGroup"
  | "moveEditorToBelowGroup"
  | "moveEditorToLeftGroup"
  | "moveEditorToRightGroup"
  | "sessionPrev"
  | "sessionNext"
  | "sessionBack"
  | "sessionForward"
  | "promptPrev"
  | "promptNext"
  | "focusApproval"
  | "acceptTool"
  | "skipTool"
  | "quickAsk"
  | "terminalAsk"
  | "terminalClear"
  | "btw"
  | "board"
  | "morningReview"
  | "openSettings"
  | "focusChatInput"
  | "inbox"
  | "feedback"
  | "toggleBottom"
  | "toggleRight"
  | "toggleFocusSide"
  | "toggleFocusChat"
  | "sourceControl"
  | "showFiles"
  | "focusCommitMessage"
  | "toggleTabFocusMode"
  | "toggleLayout"
  | "customizeLayout"
  | "toggleSidebarPosition"
  | "alignPanelLeft"
  | "alignPanelRight"
  | "alignPanelCenter"
  | "alignPanelJustify"
  | "toggleActivityBar"
  | "toggleFloat"
  | "focusSession"
  | "toggleSidebar"
  | "openBrowser"
  | "openSearch"
  | "findInFiles"
  | "replaceInFiles"
  | "focusNextSearchResult"
  | "focusPreviousSearchResult"
  | "browserZoomIn"
  | "browserZoomOut"
  | "browserZoomReset"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "editorFontZoomIn"
  | "editorFontZoomOut"
  | "editorFontZoomReset"
  | "chatFontZoomIn"
  | "chatFontZoomOut"
  | "chatFontZoomReset"
  | "browserFind"
  | "browserReload"
  | "chatFind"
  | "browserHistory"
  | "browserFavorite"
  | "addElement"
  | "commentElements"
  | "searchDetails"
  | "keepFile"
  | "undoFile"
  | "save"
  | "formatDocument"
  | "formatSelection"
  | "quickFix"
  | "nextProblem"
  | "prevProblem"
  | "copyType"
  | "copySignature"
  | "splitEditorRight"
  | "splitEditorDown"
  | "focusNextEditorGroup"
  | "focusPreviousEditorGroup"
  | "newUntitled"
  | "newFilePath"
  | "importVscode"
  | "improvements"
  | "skills" // SKILLS
  | "reloadWindow"
  | "newWindow"
  | "closeWindow"
  | "restartDaemon"
  | "previewDirection"
  | "escape";

// 키 이벤트에서 판정에 필요한 것만. Electron 메인이 가로채 넘긴 키(agent-nav:key)도 같은 모양이라 같은 길로 처리한다.
export type ShortcutEvent = KeyInput & { isComposing?: boolean; preventDefault?: () => void; target?: EventTarget | null };

let pending: Pending | null = null;
// 에디터의 ⌘F(찾기)가 ⌘K ⌘F 의 두 번째 키일 때는 찾기 패널을 열지 않도록 에디터 키맵이 묻는다.
export const isChordPending = () => pending !== null && Date.now() - pending.at <= CHORD_TIMEOUT_MS;
let hintTimer: ReturnType<typeof setTimeout> | null = null;

// 에디터 탭이 보이는지: Chat 배치는 오른쪽 패널이 열려 있을 때, Editor 배치는 늘.
// 글자를 입력하는 자리(에디터, 터미널, 입력칸)에 포커스가 있는가. Browser 탭 키(⌘F, ⌘D, ⌘Y 등)는 이런 자리에서는 그 자리의 기본 편집 키가 먼저라 듣지 않는다.
const isTextEntry = (el: Element | null | undefined) => !!el?.matches?.("input, textarea, select, [contenteditable]:not([contenteditable=false]), .cm-content, .xterm-helper-textarea");
const editorsVisible = () => getState().layoutMode === "editor" || getState().rightOpen;

// 도구 승인 단축키가 듣는 자리: 활성 칸에 도구 승인 카드가 떠 있고, 포커스가 입력창이거나 글자를 입력하는 자리가 아닐 때(설정 입력칸, 이름 바꾸기 등은 그 자리의 Enter 가 먼저다).
const approvalKeyApplies = (active: Element | null, inComposer: boolean) => (inComposer || !isTextEntry(active)) && pendingToolApproval() !== null;

const isSearchOpen = () => {
  const kind = getState().overlay?.kind;
  return kind === "search" || kind === "sessions";
};

// Esc 로 Board, Mentions, Improvements, PR 화면에서 세션 화면으로 돌아온다(dogfood 22). 글자를 입력하던 중이면 입력을 먼저 끝내고(포커스를 뺀다) 화면은 그대로 둔다.
// 터미널과 에디터의 Esc 는 그 자리 것이고, 열려 있는 대화창이나 메뉴(radix 레이어)는 자기 Esc 로 닫힌다.
function leaveCenterView() {
  const active = document.activeElement;
  if (active?.closest(".xterm, .cm-editor, .termask") || document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
  if (isTextEntry(active)) {
    (active as HTMLElement).blur();
    return;
  }
  closeCenterView();
}

function closeCenterView() {
  // fix5-2: Board 에서 카드 상세가 열려 있으면 Esc 는 상세만 닫는다. 한 번 더 누르면 Board 를 나간다.
  if (getState().centerView === "board" && getState().boardCardId) {
    setState({ boardCardId: null });
    return;
  }
  setState({ centerView: "sessions" });
  focusComposerIfLost();
}

// 열려 있는 팝업이 단축키 표보다 먼저 키를 가져간다(모델 목록의 ⌘1~⌘9). Electron 은 표에 든 ⌘숫자를 페이지 keydown 대신 이 경로로 넘기므로 입력칸의 onKeyDown 으로는 받지 못한다.
// 등록한 함수가 true 를 돌려주면 그 키는 처리된 것이다. 마지막에 등록한 것 하나만 듣는다.
let keyClaim: ((stroke: string) => boolean) | null = null;
export function claimKeys(handler: (stroke: string) => boolean) {
  keyClaim = handler;
  return () => {
    if (keyClaim === handler) keyClaim = null;
  };
}

export function runShortcut(event: ShortcutEvent) {
  // B1: F2 세션 이름 바꾸기, ⌘Backspace 완료 처리(진짜 키 이벤트만, Electron 이 넘긴 키는 표에 든 것뿐이다)
  if (event instanceof KeyboardEvent && runSessionShortcut(event)) return;
  // 한글 조합 중에는 키가 글자 입력이다. 수정키만 눌린 입력은 chord 를 끊으면 안 되므로 strokeOf 가 null 로 건너뛴다.
  if (event.isComposing) return;
  const stroke = strokeOf(event);
  if (!stroke) return;
  if (pending === null && keyClaim?.(stroke)) {
    event.preventDefault?.();
    return;
  }
  const active = document.activeElement ?? (event.target as Element | null);
  const where = (selector: string) => !!(event.target as Element | null)?.closest?.(selector) || !!active?.closest?.(selector);
  if (stroke === "Escape" && event instanceof KeyboardEvent && event.defaultPrevented) return;
  // 찾기 위젯이 이미 처리한 키(⌥↵ 전체 선택, ⌥⌘↵ 모두 바꾸기, ⌥⌘L 범위 바꾸기)는 같은 키의 표 명령(WebStorm 프리셋의 빠른 수정, 포맷)으로 또 보내지 않는다.
  if (event instanceof KeyboardEvent && event.defaultPrevented && where(".cm-find")) return;
  if (stroke === "Meta+KeyI" && toggleDetailsFromKey(active)) {
    event.preventDefault?.();
    return;
  }
  const step = stepKey(pending, stroke, { inTerminal: where(".xterm, .termask"), inEditor: where(".cm-editor"), inEditorArea: where(".editor-area"), inComposer: where(".composer textarea"), inBrowser: activeTab()?.kind === "browser" && editorsVisible() && (where(".browser-tab") || !isTextEntry(active)), inSearch: (activeTab()?.kind === "search" && editorsVisible()) || where(".search-view"), inChat: where(".agent"), inElectron: IN_ELECTRON, inSearchOverlay: isSearchOpen(), inFocusLayout: getState().layoutMode === "editor", approvalPending: approvalKeyApplies(active, where(".composer textarea")), hiddenCommands: hiddenCommands(getState().settings) }, Date.now());
  // WebStorm 프리셋: 에디터 안의 입력칸(찾기, 이름 바꾸기)에서 누른 키는 그 입력칸의 것이다. ⌘D, ⌘⌫, ⇧↵ 를 에디터 본문의 줄 복제, 줄 삭제, 줄 삽입으로 보내지 않는다(기본 동작도 막지 않는다).
  if (step.kind === "run" && step.command.startsWith("editor:") && activeKeymapPreset() === "webstorm" && isTextEntry(active) && !active?.matches(".cm-content") && !!active?.closest(".cm-editor")) {
    pending = null;
    clearChordHint();
    return;
  }
  const hadPending = pending !== null;
  const hadPendingPrefix = pending?.prefix ?? "";
  pending = step.pending;
  if (step.kind === "pass") {
    // chord 가 끝났거나 아직 없던 일반 키. 안내가 떠 있었으면 지운다.
    if (hadPending) clearChordHint();
    return;
  }
  // 표에 없는 두 번째 키: 키는 삼키지 않고(글자는 그대로 입력된다) chord 만 취소하며 알린다.
  if (step.kind === "cancel") {
    setChordHint({ kind: "miss", text: S.chordMiss(strokeLabel(hadPendingPrefix), strokeLabel(stroke)) }, CHORD_MISS_MS);
    return;
  }
  event.preventDefault?.();
  if (step.kind === "pending") {
    if (!step.opens) {
      showChordHint(strokeLabel(step.pending.prefix));
      return;
    }
    // ⌘K: 검색창이 닫혀 있으면 열고(안내 토스트 없이 검색창이 안내다), 열려 있으면 닫고 chord 를 기다린다.
    const wasOpen = isSearchOpen();
    runCommand(step.opens);
    if (wasOpen) showChordHint(strokeLabel(step.pending.prefix));
    else armChordTimeout(null);
    return;
  }
  clearChordHint();
  if (step.kind !== "run") return;
  // 검색창이 열린 채 chord 가 끝나면 검색창을 닫고, 닫히며 포커스를 돌려주는 일이 끝난 뒤에 실행한다.
  if (isSearchOpen()) {
    setState({ overlay: null });
    setTimeout(() => runCommand(step.command), 0);
    return;
  }
  runCommand(step.command);
}

function showChordHint(first: string) {
  armChordTimeout(S.chordWaiting(first));
}

const CHORD_MISS_MS = 2000;

// chord 대기를 CHORD_TIMEOUT_MS 뒤에 끝낸다. message 가 있으면 그동안 창 아래의 한 줄 안내로 보인다.
function armChordTimeout(message: string | null) {
  if (message) setChordHint({ kind: "waiting", text: message }, CHORD_TIMEOUT_MS);
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    pending = null;
  }, CHORD_TIMEOUT_MS);
}

function clearChordHint() {
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = null;
  setChordHint(null);
}


export function runCommand(command: Command | string) {
  const s = getState();
  // 에디터 그룹 명령(web/groupCommands.ts)
  if (runGroupCommand(command)) return;
  // EDPARITY: 에디터 명령 등록부의 명령(web/editorCommands.ts)
  if (command.startsWith("editor:")) {
    runEditorCommand(command.slice("editor:".length));
    return;
  }
  if (command === "revealDefinitionAside") {
    definitionAsideActive();
    return;
  }
  if (command.startsWith("focusPaneIndex:")) {
    const arg = command.slice("focusPaneIndex:".length);
    focusPaneIndex(arg === "last" ? "last" : Number(arg));
    return;
  }
  switch (command) {
    case "quickOpen":
      if (s.overlay?.kind === "quickOpen") {
        navigateQuickOpen(true);
        return;
      }
      setState({ overlay: { kind: "quickOpen" }, quickOpenQuery: "" });
      return;
    case "symbols":
      setState({ overlay: { kind: "symbols" } });
      return;
    // EDPARITY(C): 줄로 이동(⌃G)과 파일 안 심볼로 이동(⇧⌘O). 입력창이 포커스를 가져가기 전에 대상 에디터를 정한다.
    case "gotoLine":
      setState({ overlay: { kind: "gotoLine", tabKey: targetEditorKey() } });
      return;
    case "gotoSymbol":
      setState({ overlay: { kind: "gotoSymbol", tabKey: targetEditorKey() } });
      return;
    case "models":
      setState({ overlay: { kind: "models" } });
      return;
    case "effort":
      setState({ overlay: { kind: "effort" } });
      return;
    case "sessions":
      setState({ overlay: { kind: "sessions" } });
      return;
    // 통합 검색(⌘K). 열려 있으면 닫는다.
    case "search":
      setState({ overlay: isSearchOpen() ? null : { kind: "search", tab: "all" } });
      return;
    // B6: 명령 팔레트. 입력은 ">" 로 시작한다
    case "commandPalette":
      // QUICKOPEN: 파일 열기 안에서 ⇧⌘P 는 이전 행이다(quickOpenNavigatePreviousInFilePicker)
      if (s.overlay?.kind === "quickOpen") {
        navigateQuickOpen(false);
        return;
      }
      setState({ overlay: { kind: "commands" } });
      return;
    // FIX6C: 아래 패널을 Problems 탭으로 연다
    case "showProblems":
      setState({ bottomOpen: true, bottomTab: "problems" });
      return;
    case "keyboardShortcuts":
      setState({ overlay: s.overlay?.kind === "shortcuts" ? null : { kind: "shortcuts" } });
      return;
    case "newSession": {
      const workspaceId = s.activeWorkspaceId ?? s.workspaces.find(isTopWorkspace)?.id;
      if (workspaceId) startDraft(workspaceId);
      return;
    }
    case "attach": {
      const selection = currentSelection();
      if (!selection) {
        hint(S.noOpenFile);
        return;
      }
      addAttachment(activePane().id, selection);
      return;
    }
    case "interrupt": {
      const agent = activeAgent();
      if (agent && (agent.status === "running" || agent.status === "waiting")) interruptAgent(agent.id);
      if (s.quick?.run?.status === "running") void rpc.call("quick.cancel", { id: s.quick.run.id });
      if (s.side?.run?.status === "running") void rpc.call("side.cancel", { id: s.side.id });
      return;
    }
    case "closeTab":
      if (s.activeTabKey === "card") closeCard();
      else if (s.activeTabKey && !isPinnedTab(s.activeTabKey)) void requestCloseTab(s.activeTabKey);
      return;
    // B7: 저장, 포맷, 에디터 분할, 새 파일
    case "save": {
      // 참조 peek 의 미리보기에서 누른 ⌘S 는 그 미리보기의 파일을 저장한다
      if (savePeekPreview()) return;
      // NOTES: 메모장에서는 자동 저장을 기다리지 않고 바로 저장한다.
      if (s.centerView === "notes") {
        void flushNote();
        return;
      }
      const tab = activeTab();
      if (tab && (tab.kind === "file" || tab.kind === "untitled") && (s.dirtyTabs[tab.key] || tab.kind === "untitled")) void saveTab(tab.key);
      return;
    }
    case "formatDocument":
      void formatActive(false);
      return;
    case "formatSelection":
      void formatActive(true);
      return;
    case "quickFix":
      quickFixActive();
      return;
    case "nextProblem":
      gotoProblemActive(1);
      return;
    case "prevProblem":
      gotoProblemActive(-1);
      return;
    case "copyType":
      void copyTypeActive("type");
      return;
    case "copySignature":
      void copyTypeActive("signature");
      return;
    case "splitEditorRight":
      splitEditor("row");
      return;
    case "splitEditorDown":
      splitEditor("column");
      return;
    case "focusNextEditorGroup":
      focusAdjacentGroup(1);
      return;
    case "focusPreviousEditorGroup":
      focusAdjacentGroup(-1);
      return;
    case "newUntitled":
      openUntitled();
      return;
    case "newFilePath": {
      const pane = activePane();
      const agent = activeAgent();
      const workspaceId = agent ? (agent.workspaceId ? agent.workspaceId : null) : pane.kind === "draft" ? pane.workspaceId : s.activeWorkspaceId;
      if (workspaceId) void newFileByPath(workspaceId);
      else hint(S.searchNeedsFolder);
      return;
    }
    case "split":
      splitActivePane();
      return;
    // B5: 격자, 분할, 닫기, 세션 이동
    case "splitDown":
      splitActivePaneDown();
      return;
    case "close":
      if (s.overlay) setState({ overlay: null });
      else if (s.centerView !== "sessions") closeCenterView();
      else closeFocused();
      return;
    case "closeAllChats":
    case "closeAllSessions":
      closeAllPanes();
      return;
    case "reopenClosed":
      reopenClosedPane();
      return;
    case "handoff": {
      const agent = activeAgent();
      if (agent) startHandoff(agent.id);
      else hint(S.handoffNoSession);
      return;
    }
    case "mergeWorktree": {
      const agent = activeAgent();
      if (agent) void mergeWorktree(agent.id);
      else hint(S.worktreeOnly);
      return;
    }
    case "createWorktreePr": {
      const agent = activeAgent();
      if (agent) void createWorktreePr(agent.id);
      else hint(S.worktreeOnly);
      return;
    }
    // CTRLTAB: ⌃Tab, ⌃⇧Tab 은 최근 세션 전환 창(web/sessionSwitcher.ts). 칸 사이 이동(focusPaneNext, focusPanePrev)은 팔레트 명령으로만 남는다.
    case "sessionSwitcher":
      cycleSessionSwitcher(1);
      return;
    case "sessionSwitcherBack":
      cycleSessionSwitcher(-1);
      return;
    // 팔레트로 열면 누르고 있는 키가 없으니 ↑↓ 로 고르고 Enter 로 확정한다. 팔레트가 닫히며 포커스를 돌려주는 일이 끝난 뒤에 연다.
    case "quickSwitchSession":
      setTimeout(() => cycleSessionSwitcher(1, false), 0);
      return;
    case "focusPanePrev":
      focusPaneStep(-1);
      return;
    case "focusPaneNext":
      focusPaneStep(1);
      return;
    case "focusPaneLeft":
    case "focusPaneRight":
    case "focusPaneUp":
    case "focusPaneDown":
      focusPaneDirection(command.slice("focusPane".length).toLowerCase() as "left" | "right" | "up" | "down");
      return;
    case "movePanePrev":
      movePane(-1);
      return;
    case "movePaneNext":
      movePane(1);
      return;
    case "movePaneUp":
      movePaneRow(-1);
      return;
    case "movePaneDown":
      movePaneRow(1);
      return;
    case "moveEditorToPreviousGroup":
      moveEditorToGroup("previous");
      return;
    case "moveEditorToNextGroup":
      moveEditorToGroup("next");
      return;
    case "moveEditorToAboveGroup":
      moveEditorToGroup("up");
      return;
    case "moveEditorToBelowGroup":
      moveEditorToGroup("down");
      return;
    case "moveEditorToLeftGroup":
      moveEditorToGroup("left");
      return;
    case "moveEditorToRightGroup":
      moveEditorToGroup("right");
      return;
    case "sessionPrev":
      openAdjacentSession(-1);
      return;
    case "sessionNext":
      openAdjacentSession(1);
      return;
    case "sessionBack":
      goBackSession();
      return;
    case "sessionForward":
      goForwardSession();
      return;
    case "promptPrev":
      scrollToPrompt("prev");
      return;
    case "promptNext":
      scrollToPrompt("next");
      return;
    case "acceptTool":
      answerToolApproval("allow");
      return;
    case "skipTool":
      answerToolApproval("deny");
      return;
    case "focusApproval": {
      if (focusApproval()) return;
      const agent = activeAgent();
      const pane = activePane();
      const chat = agent ? agent.workspaceId === null : pane.kind === "draft" && pane.workspaceId === null;
      const workspaceId = getState().activeWorkspaceId;
      if (chat || (!agent && !workspaceId)) hint(S.noApprovalPending);
      else void openInVSCode(agent?.id ?? null, workspaceId);
      return;
    }
    case "attachMenu":
      requestAttachMenu();
      return;
    case "cycleEffort":
      cycleEffort();
      return;
    // B6: 폴더 없는 새 세션 화면(퀵 챗). ⌘I quickAsk(선택 코드 빠른 질문)와는 다른 기능이다.
    case "quickChat":
      startQuickChat();
      return;
    case "quickAsk":
      startQuickAsk();
      return;
    // TERMASK: 터미널에 포커스가 있을 때의 ⌘I. 명령 팔레트에서도 불러 열려 있는 터미널에 연다.
    case "terminalAsk":
      openTerminalAsk();
      return;
    // C: 터미널 화면 지우기. 키(⌘K)는 터미널에 포커스가 있을 때만 이 명령이 되고, 팔레트에서는 마지막으로 포커스를 가진 터미널을 지운다.
    case "terminalClear":
      clearTerminal();
      return;
    case "btw": {
      const agent = activeAgent();
      if (!agent) {
        hint(S.openSessionFirst);
        return;
      }
      openSide(agent.id);
      return;
    }
    case "openSettings":
      setState({ overlay: s.overlay?.kind === "status" ? null : { kind: "status" } });
      return;
    case "board":
      toggleBoard();
      return;
    case "morningReview":
      morningReviewCommand();
      return;
    case "inbox":
      toggleInbox();
      return;
    // NOTES: 메모장 화면을 열고 닫는다. 새 메모는 화면을 열면서 빈 메모를 하나 만든다.
    case "notes":
      toggleNotes();
      return;
    case "newNote":
      void createNoteAndOpen();
      return;
    case "feedback":
      toggleFeedback();
      return;
    case "toggleBottom":
      toggleBottomPanel();
      return;
    case "toggleRight":
      // 오른쪽 패널은 세션 화면 것이다. 보드나 멘션 화면에서는 보이지 않는 패널의 열림 상태를 바꾸지 않는다.
      // 메뉴와 제목줄 단추는 키 표의 when 을 거치지 않고 이 이름을 그대로 불러서, Editor 중심에서는 대화 패널로 보낸다.
      if (s.layoutMode === "editor") runCommand("toggleFocusChat");
      else if (sessionPanelToggleable(s.centerView)) setState({ rightOpen: !s.rightOpen });
      return;
    case "toggleFocusSide":
      if (sessionPanelToggleable(s.centerView)) setFocusSideOpen(!s.focusSideOpen);
      return;
    case "toggleFocusChat":
      if (sessionPanelToggleable(s.centerView)) toggleChatVisible();
      return;
    case "sourceControl":
    case "focusCommitMessage":
      if (sessionPanelToggleable(s.centerView)) setState({ activeTabKey: "scm", rightOpen: true, focusScmMessage: Date.now() });
      return;
    case "showFiles":
      if (sessionPanelToggleable(s.centerView)) setState({ activeTabKey: "files", rightOpen: true });
      return;
    case "toggleTabFocusMode":
      hint(toggleTabFocusMode() ? S.tabFocusOn : S.tabFocusOff);
      return;
    // FLOAT: 배치 전환, 떠 있는 창 접기와 펴기, 떠 있는 창과 에디터 사이 포커스
    case "toggleLayout":
      toggleLayoutMode();
      return;
    case "toggleFloat":
      toggleFloatCollapsed();
      return;
    case "customizeLayout":
      setState({ overlay: s.overlay?.kind === "customizeLayout" ? null : { kind: "customizeLayout" } });
      return;
    case "toggleSidebarPosition":
      setLayoutConfig({ sideBar: getLayoutConfig().sideBar === "left" ? "right" : "left" });
      return;
    case "alignPanelLeft":
    case "alignPanelRight":
    case "alignPanelCenter":
    case "alignPanelJustify":
      setLayoutConfig({ panelAlignment: command.slice("alignPanel".length).toLowerCase() as PanelAlignment });
      return;
    case "toggleActivityBar":
      setLayoutConfig({ activityBar: !getLayoutConfig().activityBar });
      return;
    case "focusSession":
      focusActiveSession();
      return;
    case "focusChatInput":
      revealChat();
      focusPane(s.activePaneId);
      return;
    case "toggleSidebar":
      // Editor 중심에는 앱 사이드바가 없고 그 자리의 왼쪽 막대와 사이드바가 있다(메뉴와 제목줄 단추용, 키는 표의 when 이 먼저 맞는다)
      if (s.layoutMode === "editor") runCommand("toggleFocusSide");
      else setState({ sidebarOpen: !s.sidebarOpen });
      return;
    case "openBrowser":
      openBrowser();
      return;
    case "openSearch":
      openSearch();
      return;
    case "findInFiles":
      if (sessionPanelToggleable(s.centerView)) findInFiles();
      return;
    case "replaceInFiles":
      if (sessionPanelToggleable(s.centerView)) findInFiles({ withReplace: true });
      return;
    case "focusNextSearchResult":
      focusSearchResult(1);
      return;
    case "focusPreviousSearchResult":
      focusSearchResult(-1);
      return;
    case "browserZoomIn":
      dispatchBrowserAction("zoomIn");
      return;
    case "browserZoomOut":
      dispatchBrowserAction("zoomOut");
      return;
    case "browserZoomReset":
      dispatchBrowserAction("zoomReset");
      return;
    case "zoomIn":
    case "zoomOut":
    case "zoomReset":
      void window.agentNavNative?.windowZoom?.(command === "zoomIn" ? "in" : command === "zoomOut" ? "out" : "reset");
      return;
    case "editorFontZoomIn":
    case "editorFontZoomOut":
    case "editorFontZoomReset":
      stepEditorFontSize(command === "editorFontZoomIn" ? 1 : command === "editorFontZoomOut" ? -1 : 0);
      return;
    case "chatFontZoomIn":
    case "chatFontZoomOut":
    case "chatFontZoomReset":
      stepChatFontSize(command === "chatFontZoomIn" ? 1 : command === "chatFontZoomOut" ? -1 : 0);
      return;
    case "browserFind":
      dispatchBrowserAction("find");
      return;
    case "browserReload":
      dispatchBrowserAction("reload");
      return;
    case "chatFind": {
      const s = getState();
      const pane = s.panes.find((p) => p.id === s.activePaneId);
      if (pane?.kind === "agent") openChatFind(pane.id);
      return;
    }
    case "browserFavorite":
      dispatchBrowserAction("favorite");
      return;
    case "addElement":
      dispatchBrowserAction("addElement");
      return;
    case "commentElements":
      dispatchBrowserAction("commentElements");
      return;
    case "searchDetails":
      if (document.activeElement?.closest(".search-view")) updateSearchView({ details: !s.searchView.details });
      else toggleSearchDetails();
      return;
    case "browserHistory": {
      const tab = activeTab();
      if (tab?.kind === "browser") setState({ overlay: { kind: "browserHistory", tabKey: tab.key } });
      else hint(S.browserNeedsTab);
      return;
    }
    case "importVscode":
      setState({ overlay: { kind: "status", section: "import" } });
      return;
    case "improvements":
      openImprovements();
      return;
    // SKILLS: 명령 팔레트의 Skills: Open. 키는 없다.
    case "skills":
      openSkills();
      return;
    case "reloadWindow":
      void reloadWindow();
      return;
    case "newWindow":
      void window.agentNavNative?.newWindow?.();
      return;
    case "closeWindow":
      void window.agentNavNative?.closeWindow?.();
      return;
    case "restartDaemon":
      void restartDaemon();
      return;
    case "previewDirection":
      void previewDesignDirection();
      return;
    case "keepFile":
      void keepSelectedFile();
      return;
    case "undoFile":
      void undoSelectedFile();
      return;
    case "escape":
      if (s.feedbackMode !== "off") escapeFeedback();
      else if (s.overlay) setState({ overlay: null });
      // 답을 받은 빠른 질문 창은 그 창 안에 포커스가 있을 때만 Esc 로 닫는다. 에디터나 대화에서 누른 Esc 로 답이 사라지지 않게 한다(닫기 단추는 그대로).
      else if (s.quick && (!s.quick.run || document.activeElement?.closest(".quick"))) setState({ quick: null });
      else if (s.side) setState({ side: null });
      else if (s.references) setState({ references: null });
      else if (s.centerView !== "sessions") leaveCenterView();
      return;
  }
}

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
import { addFolderToSession, moveChatToFolder, removeFolderFromSession } from "./sessionFolders";
import { newProjectInNewSession, openFolderInNewSession } from "./folderOpen";
import { createWorktreePr, mergeWorktree } from "./worktreeActions";
import { answerToolApproval, pendingToolApproval } from "./approvalKeys";
import { attachEditorSelection } from "./attachments";
import { closeFocused, focusApproval, requestAttachMenu, scrollToPrompt, stepChatTab } from "./paneNav";
import { cycleEffort } from "./Pickers";
import { savePeekPreview } from "./peekView";
import { previewDesignDirection } from "./direction";
import { reloadWindow, restartDaemon } from "./reload";
import { morningReviewCommand } from "./reviewActions";
import { hiddenCommands } from "./screenVisibility";
import { clearTerminal, openTerminalAsk, openTerminalFind } from "./terminalHandles";
import { interruptAgent, openAdjacentSession, runSessionShortcut } from "./sessionActions";
import {
  activeAgent,
  activePane,
  activeTab,
  closeCard,
  dispatchBrowserAction,
  closeAllPanes,
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
  startEditorChatDraft,
  startQuickChat,
  toggleBoard,
  toggleInbox,
  toggleNotes,
  openSkills,
  openAutomation,
  openAutomationEditor,
  toggleLayoutMode,
  toggleSearchDetails,
  updateSearchView,
  focusPane,
  revealChat,
  setFocusSideOpen,
} from "./store";
import { S } from "./strings";
import { toggleTabFocusMode } from "./tabFocus";
import { createNoteAndOpen, flushNote } from "./notesStore";
import { toggleBottomPanel } from "./terminalScope";
import type { PanelAlignment } from "./layoutConfig";
import { getLayoutConfig, setLayoutConfig } from "./layoutConfigStore";
import { hint } from "./hint";
import { focusComposerIfLost } from "./overlayFocus";
import { navigateQuickOpen } from "./quickOpenNav";
import { strokeLabel } from "./shortcutList";
import { targetEditorKey } from "./activeEditor";

export const IN_ELECTRON = navigator.userAgent.includes("Electron");

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
  | "addFolderToSession"
  | "removeFolderFromSession"
  | "moveChatToFolder"
  | "openFolder"
  | "newProject"
  | "mergeWorktree"
  | "createWorktreePr"
  | "split"
  | "splitDown"
  | "focusPanePrev"
  | "focusPaneNext"
  | "previousChatTab"
  | "nextChatTab"
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
  | "terminalFind"
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
  | "skills"
  | "automations"
  | "newAutomation"
  | "reloadWindow"
  | "newWindow"
  | "closeWindow"
  | "restartDaemon"
  | "previewDirection"
  | "escape";

export type ShortcutEvent = KeyInput & { isComposing?: boolean; preventDefault?: () => void; target?: EventTarget | null };

let pending: Pending | null = null;
export const isChordPending = () => pending !== null && Date.now() - pending.at <= CHORD_TIMEOUT_MS;
let hintTimer: ReturnType<typeof setTimeout> | null = null;

const isTextEntry = (el: Element | null | undefined) => !!el?.matches?.("input, textarea, select, [contenteditable]:not([contenteditable=false]), .cm-content, .xterm-helper-textarea");
const hasText = (el: Element | null | undefined) => isTextEntry(el) && !!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el?.textContent);
const editorsVisible = () => getState().layoutMode === "editor" || getState().rightOpen;

const approvalKeyApplies = (active: Element | null, inComposer: boolean) => (inComposer || !isTextEntry(active)) && pendingToolApproval() !== null;

const isSearchOpen = () => {
  const kind = getState().overlay?.kind;
  return kind === "search" || kind === "sessions";
};

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
  if (getState().centerView === "board" && getState().boardCardId) {
    setState({ boardCardId: null });
    return;
  }
  setState({ centerView: "sessions" });
  focusComposerIfLost();
}

let keyClaim: ((stroke: string) => boolean) | null = null;
export function claimKeys(handler: (stroke: string) => boolean) {
  keyClaim = handler;
  return () => {
    if (keyClaim === handler) keyClaim = null;
  };
}

export function runShortcut(event: ShortcutEvent) {
  if (event instanceof KeyboardEvent && runSessionShortcut(event)) return;
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
  if (event instanceof KeyboardEvent && event.defaultPrevented && where(".cm-find")) return;
  if (stroke === "Meta+KeyI" && toggleDetailsFromKey(active)) {
    event.preventDefault?.();
    return;
  }
  const step = stepKey(pending, stroke, { inTerminal: where(".xterm, .termask, .terminal-find"), inEditor: where(".cm-editor"), inEditorArea: where(".editor-area"), inComposer: where(".composer textarea"), inBrowser: activeTab()?.kind === "browser" && editorsVisible() && (where(".browser-tab") || !isTextEntry(active)), inSearch: (activeTab()?.kind === "search" && editorsVisible()) || where(".search-view"), inChat: where(".agent"), inElectron: IN_ELECTRON, inSearchOverlay: isSearchOpen(), inFocusLayout: getState().layoutMode === "editor", inFilledText: hasText(active), approvalPending: approvalKeyApplies(active, where(".composer textarea")), hiddenCommands: hiddenCommands(getState().settings) }, Date.now());
  if (step.kind === "run" && step.command.startsWith("editor:") && activeKeymapPreset() === "webstorm" && isTextEntry(active) && !active?.matches(".cm-content") && !!active?.closest(".cm-editor")) {
    pending = null;
    clearChordHint();
    return;
  }
  const hadPending = pending !== null;
  const hadPendingPrefix = pending?.prefix ?? "";
  pending = step.pending;
  if (step.kind === "pass") {
    if (hadPending) clearChordHint();
    return;
  }
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
    const wasOpen = isSearchOpen();
    runCommand(step.opens);
    if (wasOpen) showChordHint(strokeLabel(step.pending.prefix));
    else armChordTimeout(null);
    return;
  }
  clearChordHint();
  if (step.kind !== "run") return;
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
  if (runGroupCommand(command)) return;
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
    case "search":
      setState({ overlay: isSearchOpen() ? null : { kind: "search", tab: "all" } });
      return;
    case "commandPalette":
      if (s.overlay?.kind === "quickOpen") {
        navigateQuickOpen(false);
        return;
      }
      setState({ overlay: { kind: "commands" } });
      return;
    case "showProblems":
      setState({ bottomOpen: true, bottomTab: "problems" });
      return;
    case "keyboardShortcuts":
      setState({ overlay: s.overlay?.kind === "shortcuts" ? null : { kind: "shortcuts" } });
      return;
    case "newSession": {
      if (s.layoutMode === "editor") {
        startEditorChatDraft();
        return;
      }
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
      attachEditorSelection(activePane().id, selection);
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
    case "save": {
      if (savePeekPreview()) return;
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
    case "addFolderToSession":
    case "removeFolderFromSession":
    case "moveChatToFolder": {
      const agent = activeAgent();
      if (!agent) hint(S.folderNoSession);
      else if (command === "addFolderToSession") void addFolderToSession(agent.id);
      else if (command === "removeFolderFromSession") void removeFolderFromSession(agent.id);
      else void moveChatToFolder(agent.id);
      return;
    }
    case "openFolder":
      void openFolderInNewSession();
      return;
    case "newProject":
      void newProjectInNewSession();
      return;
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
    case "sessionSwitcher":
      cycleSessionSwitcher(1);
      return;
    case "sessionSwitcherBack":
      cycleSessionSwitcher(-1);
      return;
    case "quickSwitchSession":
      setTimeout(() => cycleSessionSwitcher(1, false), 0);
      return;
    case "focusPanePrev":
      focusPaneStep(-1);
      return;
    case "focusPaneNext":
      focusPaneStep(1);
      return;
    case "previousChatTab":
      stepChatTab(-1);
      return;
    case "nextChatTab":
      stepChatTab(1);
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
    case "quickChat":
      startQuickChat();
      return;
    case "quickAsk":
      startQuickAsk();
      return;
    case "terminalAsk":
      openTerminalAsk();
      return;
    case "terminalClear":
      clearTerminal();
      return;
    case "terminalFind":
      openTerminalFind();
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
    case "skills":
      openSkills();
      return;
    case "automations":
      openAutomation(getState().selectedAutomationId);
      return;
    case "newAutomation":
      openAutomation(getState().selectedAutomationId);
      openAutomationEditor({ mode: "create" });
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
      else if (s.quick && (!s.quick.run || document.activeElement?.closest(".quick"))) setState({ quick: null });
      else if (s.side) setState({ side: null });
      else if (s.references) setState({ references: null });
      else if (s.centerView !== "sessions") leaveCenterView();
      return;
  }
}

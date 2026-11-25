import { useSyncExternalStore } from "react";
import { defaultChangeScope, harnessOf, HARNESS_VALUES, PERMISSION_MODE_VALUES } from "../shared/protocol";
import type { CustomProviderView } from "../shared/customProviders";
import type { Agent, AntigravityMeta, CursorMeta, Board, BoardCard, ChangeScope, CodexMeta, Harness, InboxItem, InboxState, ChangedFile, CommandInfo, EffortLevel, ElementInfo, Feedback, FileChange, GitInfo, McpActionResult, Meta, PermissionMode, PullRequest, QuickRun, ResolvedDefaults, ScreenContext, Settings, ShellNote, SideRun, TimelineItem, Workspace } from "../shared/protocol";
import { announceWorkspaceChanged } from "./workspaceEvents";
import { cleanSlackText } from "../shared/inbox";
import type { ScmFileDiffSection } from "../shared/scm";
import { applyDiffFeedbackEvent, ensureDiffFeedback } from "./diffFeedbackState";
import { getChangesScope, getScoped, getShowOutside, pickChanges, selectChangedFile, storeChangesScope, storeScopedChanges, storeShowOutside } from "./changesState";
import { gridOf, moveToRow, neighbor, paneOrder, reconcileGrid, splitDown as gridSplitDown, step as gridStep, swapPanes, type Direction, type Grid, type PlaceSizes } from "./gridLayout";
import { planSessionDrop, type DropZone } from "./paneDrop";
import { pushRecent } from "./sessionSwitcherModel";
import { rpc } from "./rpc";
import { S } from "./strings";
import { notifyOnStatusChange } from "./notifications";
import type { BrowserAttachment } from "./browserAttach";
import { partitionFor, type EffectiveStorage } from "./browserUrl";
import type { DeviceRequest } from "./browserDevices";
import { noteActive, pickAfterClose, type TabMru } from "./tabMru";
import { adjacentGroup, groupIdsOf, groupOf, hasGroup, MAIN_GROUP, mainTabs, moveToGroup, normalizeLayout, removeGroup, setSplitSizes, SINGLE_LAYOUT, splitGroup, tabsOfGroup, type EditorLayout } from "./editorGroups";
import { insertNextToActive, removedFilesIndex } from "./tabOrder";
import { pinTab, planOpen } from "./previewTabs";
import { baseKeyOf, clampDrop, findInGroup, isDuplicable, sameContent, uniqueKey } from "./editorTabs";
import { groupInDirection } from "./editorLayoutOps";
import { notify, type NoticeSeverity } from "./notices";
import { absolutePath, EMBED, postToHost } from "./embed";
import type { SearchScope } from "./searchModel";
import { cardOpensInSessionPanel, sanitizeRestoredTabs } from "./centerPanels";
import { boardShown, centerViewHidden, slackShown } from "./screenVisibility";
import { isLayoutMode, isPinnedTab, normalizeTabs, sideKeyOf, startingMode, type FloatRect, type LayoutMode, type TabSlice } from "./floatLayout";
import { PINNED_FIT } from "./pinnedLayout";
import { activeAgentOf } from "./activeAgentOf";
import { chatPaneWorkspace, chatProject } from "./editorChat";
import { attachmentKey, dropDraftsOfMissing, dropStoredDraftsOfMissingPanes, flushDrafts, getDraft, loadStoredDrafts, restoreDrafts, setDraftStorage } from "./composerState";
import { applySideRun, dropSide, swapSide } from "./sideChats";
import { findDuplicate } from "./attachDedupe";
import { flashAttachment } from "./attachFlash";
import { WINDOW_ID, windowStorage } from "./windowStorage";
import { CHAT_WINDOW_QUERY } from "../shared/windows";
import { requestIdleReload } from "./idleReload";
import { collectExtras, forLaunch, loadHotExit, parseWindowState, pruneTabState, restoreHandoffs, setPendingHot, setPendingRestore, snapshotHandoffs, WINDOW_STATE_KEY, WINDOW_STATE_VERSION, type WindowExtras } from "./windowState";
import { revealPinned, setPinnedDrawer, setPinnedSide } from "./pinnedPanel";
import { cacheChatDock, cacheLayoutSettings, cachePerSession, loadCachedChatDock, loadCachedDefaultLayout, loadCachedPerSession, loadCachedRemember, loadFloatRect, loadLastLayout, saveFloatRect, saveLastLayout } from "./layoutPrefs";
import { chatDockOf, parseDockWidth, type ChatDock } from "./focusLayout";
import { dropTabFocus, isShown, pruneTabFocus, sanitizeTabFocus, settleSessionTabs, shownAgentsOf, shownTabs, type TabFocus } from "./sessionTabs";
import { dropSessionLayout, layoutKeyOf, layoutPatch, planSwitch, pruneSessionLayouts, sameLayout, sanitizeSessionLayouts, sliceOf as layoutSliceOf, type SessionLayouts } from "./sessionLayout";
import { hint } from "./hint";
import type { ReviewState } from "../shared/morningReview";
import type { AutomationsState } from "../shared/automations";
import type { FollowUpsState } from "../shared/followups";
import type { AssistantState } from "../shared/assistant";
import type { ReleaseState } from "../shared/release";
import type { SessionOrders } from "../shared/sessionOrder";
import { receiveReview, refreshReview } from "./reviewActions";
import { receiveFollowUps } from "./followUpActions";
import { holdEditorFocus, releaseEditorFocus } from "./editorFocusHold";
import { IDLE_RUN, sanitizeSearchView, type SearchRun, type SearchViewOptions } from "./searchViewModel";

export type FileTab = { key: string; kind: "file"; workspaceId: string; path: string; group?: string; preview?: boolean; sticky?: boolean };
export type UntitledTab = { key: string; kind: "untitled"; workspaceId: string; n: number; group?: string; sticky?: boolean };
export type DiffTab = { key: string; kind: "diff"; agentId: string; workspaceId: string; path: string; scope?: ChangeScope; group?: string; preview?: boolean; sticky?: boolean };
export type BrowserTab = { key: string; kind: "browser"; url: string; title: string; sharedWith?: string | null; partition?: string; scope?: EffectiveStorage; autoReload?: boolean; group?: string; sticky?: boolean };
export type SearchTab = { key: string; kind: "search"; workspaceId: string; query: string; details?: boolean; include?: string; seed?: Partial<SearchViewOptions>; autoRun?: boolean; group?: string; sticky?: boolean };
export type ScmDiffTab = { key: string; kind: "scm"; workspaceId: string; agentId?: string; path: string; rel: string; section: ScmFileDiffSection; group?: string; preview?: boolean; sticky?: boolean };
export type ReplacePreviewTab = { key: string; kind: "replace"; workspaceId: string; path: string; group?: string; preview?: boolean; sticky?: boolean };
export type PrViewTab = { key: string; kind: "pr"; repo: string; number: number; agentId?: string; group?: string; sticky?: boolean };
export type ChatTab = { key: string; kind: "chat"; agentId: string; title: string; group?: string; sticky?: boolean };
export type Tab = FileTab | UntitledTab | DiffTab | BrowserTab | SearchTab | ScmDiffTab | ReplacePreviewTab | PrViewTab | ChatTab;

export type BrowserAction = "navigate" | "reload" | "zoomIn" | "zoomOut" | "zoomReset" | "find" | "favorite" | "addElement" | "commentElements" | "consoleLogs" | "areaScreenshot" | "share" | "screenshot" | "applyPreset" | "setUserAgent";
export type BrowserActionRequest = { key: string; action: BrowserAction; url?: string; value?: string; nonce: number };

export type FileTarget = { workspaceId: string; path: string; line?: number; column?: number; endColumn?: number; search?: string };

export type ReferenceGroup = { workspaceId: string; path: string; hits: { line: number; column: number; text: string }[] };

export type LspStatus = "connecting" | "indexing" | "ready" | "error";

export type LspServerState = { key: string; id: string; label: string; primary: boolean; state: "idle" | "starting" | "ready" | "failed"; dir: string | null; reason?: string };

export type DraftSeed = { cardId: string | null; worktreeBranch: string | null; nonce: number };

export type Pane = ({ id: string; kind: "agent"; agentId: string } | { id: string; kind: "draft"; workspaceId: string | null; extraWorkspaceIds?: string[]; seed?: DraftSeed; handoff?: HandoffSeed }) & { sticky?: boolean };

export type HandoffSeed = { agentId: string };

export type ClosedPane = { agentId: string; closeSeq: number };
const CLOSED_PANES_MAX = 10;

export type Attachment = { id: string; workspaceId: string | null; path: string; startLine: number | null; endLine: number | null; text: string | null; inlineRef?: string; session?: { title: string }; quote?: { comment: string }; browser?: BrowserAttachment; handoff?: HandoffAttachment; image?: ImageAttachment; file?: FileAttachment };

export type ImageAttachment = { mediaType: string; data: string; thumb: string; name: string; bytes: number; hash?: string };

export type FileAttachment = { name: string; bytes: number; mediaType: string; path: string | null; status: "uploading" | "ready" | "error"; progress: number; uploadId: string | null; error?: string };

export type HandoffAttachment = { sourceId: string; title: string; status: "generating" | "ready"; id: string | null };

export type QuickState = {
  run: QuickRun | null;
  workspaceId: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tabKey: string;
  from: number;
  to: number;
  rel: { dx: number; dy: number } | null;
};

export type SideState = { id: string; agentId: string; run: SideRun | null; model: string | null; effort?: EffortLevel | null; draft?: { text: string; nonce: number } };

export type Terminal = { id: string; name: string; dir?: string };

export type FeedbackTarget = {
  info: ElementInfo;
  rect: { x: number; y: number; width: number; height: number };
  screenshot: string | null;
  screenshotNote: string | null;
};

export type FeedbackDraft = {
  text: string;
  shot: { png: string; thumb: string } | null;
  shotOn: boolean;
  screen: ScreenContext;
};

const RELOAD_KEY = "agent-nav:reload";
type ReloadSnapshot = Pick<State, "panes" | "activePaneId" | "activeWorkspaceId" | "tabs" | "filesIndex" | "activeTabKey" | "sidebarOpen" | "rightOpen" | "bottomOpen" | "centerView" | "selectedCardId" | "grid" | "editorLayout" | "activeGroupId" | "groupActive" | "layoutMode" | "floatCollapsed" | "sideTabKey" | "mainEditorKey" | "focusSideOpen" | "chatDockOpen" | "chatDockWidth" | "searchView">;
type RestoredWindow = Partial<ReloadSnapshot> & { extras: WindowExtras; sessionLayouts?: unknown; sessionTabFocus?: unknown };
function takeRestoredWindow(): RestoredWindow | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    if (raw) {
      sessionStorage.removeItem(RELOAD_KEY);
      const reload = parseWindowState<Partial<ReloadSnapshot>>(raw);
      if (reload) return reload;
    }
  } catch {
  }
  try {
    const launched = parseWindowState<Partial<ReloadSnapshot>>(windowStorage()?.getItem(WINDOW_STATE_KEY) ?? null);
    return launched ? { ...forLaunch(launched) } : null;
  } catch {
    return null;
  }
}

function buildWindowSnapshot(): string {
  const { panes, activePaneId, activeWorkspaceId, tabs, filesIndex, activeTabKey, sidebarOpen, rightOpen, bottomOpen, centerView, selectedCardId, grid, editorLayout, activeGroupId, groupActive, layoutMode, floatCollapsed, sideTabKey, mainEditorKey, focusSideOpen, chatDockOpen, chatDockWidth, panelWidths, sessionLayouts, sessionTabFocus, searchView } = state;
  const kept = tabs.filter((t) => (t.kind !== "untitled" || state.dirtyTabs[t.key]) && t.kind !== "replace");
  const extras = collectExtras({ tabKeys: new Set(kept.map((t) => t.key)), agentIds: new Set(panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : []))) }, { drafts: {}, panelWidths, handoffs: snapshotHandoffs(Object.fromEntries(Object.entries(state.attachments).filter(([key]) => !key.startsWith("new:") || panes.some((p) => p.id === key.slice(4))))) });
  return JSON.stringify({ version: WINDOW_STATE_VERSION, panes, activePaneId, activeWorkspaceId, tabs: kept, filesIndex: Math.min(filesIndex, mainTabs(kept).length), activeTabKey, sidebarOpen, rightOpen, bottomOpen, centerView, selectedCardId, grid, editorLayout, activeGroupId, groupActive, layoutMode, floatCollapsed, sideTabKey, mainEditorKey, focusSideOpen, chatDockOpen, chatDockWidth, sessionLayouts, sessionTabFocus, searchView, extras });
}

export function persistWindowState() {
  if (EMBED) return;
  try {
    windowStorage()?.setItem(WINDOW_STATE_KEY, buildWindowSnapshot());
  } catch {
  }
}

export function saveReloadSnapshot() {
  flushDrafts();
  try {
    const json = buildWindowSnapshot();
    sessionStorage.setItem(RELOAD_KEY, json);
    windowStorage()?.setItem(WINDOW_STATE_KEY, json);
  } catch {
  }
}
async function pruneRestoredWindow() {
  const workspaceIds = new Set(state.workspaces.map((w) => w.id));
  const agentIds = new Set(state.agents.map((a) => a.id));
  const missingFileKeys = new Set<string>();
  await Promise.all(
    state.tabs.map(async (tab) => {
      if (tab.kind !== "file" || !workspaceIds.has(tab.workspaceId)) return;
      const stat = await rpc.call("files.stat", { workspaceId: tab.workspaceId, path: tab.path }).catch(() => null);
      if (stat && stat.mtimeMs === null) missingFileKeys.add(tab.key);
    }),
  );
  dropDraftsOfMissing(agentIds);
  setState((s) => {
    const next = pruneTabState<Tab>(s, { workspaceIds, agentIds, missingFileKeys });
    const sessionLayouts = pruneSessionLayouts(s.sessionLayouts, agentIds);
    const sessionTabFocus = pruneTabFocus(s.sessionTabFocus, agentIds);
    if (next === s) return sessionLayouts === s.sessionLayouts && sessionTabFocus === s.sessionTabFocus ? {} : { sessionLayouts, sessionTabFocus };
    return { sessionLayouts, sessionTabFocus, tabs: next.tabs, filesIndex: next.filesIndex, activeTabKey: next.activeTabKey as RightTab | null, groupActive: next.groupActive, mainEditorKey: next.mainEditorKey, activeWorkspaceId: next.activeWorkspaceId };
  });
}

export function reloadWindow() {
  saveReloadSnapshot();
  location.reload();
}

const RELOAD_WAIT_MAX_MS = 60_000;
function reloadWhenDaemonReturns() {
  let sawDown = false;
  const off = rpc.onStatus((connected) => {
    if (!connected) sawDown = true;
    else if (sawDown) done();
  });
  const giveUp = setTimeout(done, RELOAD_WAIT_MAX_MS);
  function done() {
    off();
    clearTimeout(giveUp);
    reloadWindow();
  }
}

export type Layout = { sidebarWidth: number | null; sideChatWidth: number | null; bottomHeight: number | null; inboxDetailWidth: number | null; boardDetailWidth: number | null; improvementsDetailWidth: number | null; notionChatWidth: number | null; reviewHeight: number | null };
const LAYOUT_KEY = "agent-nav:layout";
function loadLayout(): Layout {
  try {
    const saved = JSON.parse(windowStorage()?.getItem(LAYOUT_KEY) ?? localStorage.getItem(LAYOUT_KEY) ?? "{}") as Partial<Layout>;
    return { sidebarWidth: saved.sidebarWidth ?? null, sideChatWidth: saved.sideChatWidth ?? null, bottomHeight: saved.bottomHeight ?? null, inboxDetailWidth: saved.inboxDetailWidth ?? null, boardDetailWidth: saved.boardDetailWidth ?? null, improvementsDetailWidth: saved.improvementsDetailWidth ?? null, notionChatWidth: saved.notionChatWidth ?? null, reviewHeight: saved.reviewHeight ?? null };
  } catch {
    return { sidebarWidth: null, sideChatWidth: null, bottomHeight: null, inboxDetailWidth: null, boardDetailWidth: null, improvementsDetailWidth: null, notionChatWidth: null, reviewHeight: null };
  }
}

export type LastPicked = { model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionMode; harness?: Harness; codexModel?: string | null; codexEffort?: EffortLevel | null; antigravityModel?: string | null; antigravityEffort?: EffortLevel | null; cursorModel?: string | null; cursorEffort?: EffortLevel | null; providerId?: string | null; providerModels?: Record<string, string> };
const LAST_PICKED_KEY = "agent-nav:lastPicked";
function loadLastPicked(): LastPicked {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_PICKED_KEY) ?? "{}") as Record<string, unknown>;
    const last: LastPicked = {};
    if (typeof saved.model === "string" || saved.model === null) last.model = saved.model;
    if (typeof saved.effort === "string" || saved.effort === null) last.effort = saved.effort as EffortLevel | null;
    if (typeof saved.permissionMode === "string" && (PERMISSION_MODE_VALUES as readonly string[]).includes(saved.permissionMode)) last.permissionMode = saved.permissionMode as PermissionMode;
    if (typeof saved.harness === "string" && (HARNESS_VALUES as readonly string[]).includes(saved.harness)) last.harness = saved.harness as Harness;
    if (typeof saved.codexModel === "string" || saved.codexModel === null) last.codexModel = saved.codexModel;
    if (typeof saved.codexEffort === "string" || saved.codexEffort === null) last.codexEffort = saved.codexEffort as EffortLevel | null;
    if (typeof saved.antigravityModel === "string" || saved.antigravityModel === null) last.antigravityModel = saved.antigravityModel;
    if (typeof saved.antigravityEffort === "string" || saved.antigravityEffort === null) last.antigravityEffort = saved.antigravityEffort as EffortLevel | null;
    if (typeof saved.cursorModel === "string" || saved.cursorModel === null) last.cursorModel = saved.cursorModel;
    if (typeof saved.cursorEffort === "string" || saved.cursorEffort === null) last.cursorEffort = saved.cursorEffort as EffortLevel | null;
    if (typeof saved.providerId === "string" || saved.providerId === null) last.providerId = saved.providerId;
    if (saved.providerModels && typeof saved.providerModels === "object" && !Array.isArray(saved.providerModels)) last.providerModels = Object.fromEntries(Object.entries(saved.providerModels).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return last;
  } catch {
    return {};
  }
}

export function rememberPick(patch: LastPicked) {
  setState((s) => ({ lastPicked: { ...s.lastPicked, ...patch } }));
  saveLastPicked();
}

export function forgetPick(key: keyof LastPicked) {
  setState((s) => {
    const { [key]: _gone, ...rest } = s.lastPicked;
    return { lastPicked: rest };
  });
  saveLastPicked();
}

function saveLastPicked() {
  try {
    localStorage.setItem(LAST_PICKED_KEY, JSON.stringify(state.lastPicked));
  } catch {
  }
}

const RECENT_AGENTS_KEY = "agent-nav:recent-sessions";
const RECENT_AGENTS_MAX = 12;
function loadRecentAgents(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_AGENTS_KEY) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string").slice(0, RECENT_AGENTS_MAX) : [];
  } catch {
    return [];
  }
}
export function rememberRecentAgent(agentId: string) {
  const next = pushRecent(state.recentAgentIds, agentId, RECENT_AGENTS_MAX);
  if (next === state.recentAgentIds) return;
  setState({ recentAgentIds: next });
  try {
    localStorage.setItem(RECENT_AGENTS_KEY, JSON.stringify(next));
  } catch {
  }
}

export type RecentFile = { workspaceId: string; path: string };
const RECENT_FILES_KEY = "agent-nav:recent-files";
const RECENT_FILES_MAX = 50;
function loadRecentFiles(): RecentFile[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((f): f is RecentFile => typeof f?.workspaceId === "string" && typeof f?.path === "string").slice(0, RECENT_FILES_MAX) : [];
  } catch {
    return [];
  }
}
function saveRecentFiles(next: RecentFile[]) {
  setState({ recentFiles: next });
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next));
  } catch {
  }
}
function rememberRecentFile(file: RecentFile) {
  saveRecentFiles([file, ...state.recentFiles.filter((f) => !(f.workspaceId === file.workspaceId && f.path === file.path))].slice(0, RECENT_FILES_MAX));
}
export function forgetRecentFile(file: RecentFile) {
  saveRecentFiles(state.recentFiles.filter((f) => !(f.workspaceId === file.workspaceId && f.path === file.path)));
}

export type Overlay =
  | { kind: "quickOpen" }
  | { kind: "symbols"; query?: string }
  | { kind: "models" }
  | { kind: "effort" }
  | { kind: "sessions" }
  | { kind: "search"; tab?: SearchScope }
  | { kind: "commands"; query?: string }
  | { kind: "shortcuts" }
  | { kind: "status"; section?: "browser" | "format" | "mentions" }
  | { kind: "browserHistory"; tabKey: string }
  | { kind: "sitePermissions"; url: string }
  | { kind: "devicePresets"; tabKey: string }
  | { kind: "userAgent"; tabKey: string; value: string }
  | { kind: "device"; request: DeviceRequest }
  | { kind: "choice"; id: string }
  | { kind: "gotoLine"; tabKey: string | null }
  | { kind: "gotoSymbol"; tabKey: string | null }
  | { kind: "editorPick"; id: string }
  | { kind: "customizeLayout" }
  | null;

export type RightTab = "changes" | "card" | string;

export type CenterView = "sessions" | "board" | "inbox" | "pr" | "improvements" | "notion" | "skills" | "automations" | "mate";

export type McpBusy = "reconnect" | "enable" | "disable";
export type McpNote = { ok: boolean; text: string };

export type State = {
  connected: boolean;
  workspaces: Workspace[];
  agents: Agent[];
  timelines: Record<string, TimelineItem[]>;
  files: Record<string, string[]>;
  localCommands: Record<string, CommandInfo[]>;
  emptyDirs: Record<string, string[]>;
  meta: Meta | null;
  metaRefreshing: boolean;
  mcpBusy: Record<string, McpBusy>;
  mcpNotes: Record<string, McpNote>;
  settings: Settings | null;
  modelPins: string[] | null;
  sessionOrders: SessionOrders;
  defaults: ResolvedDefaults | null;
  changes: Record<string, FileChange[]>;
  gitInfo: Record<string, GitInfo>;
  gitChanges: Record<string, { base: string | null; files: ChangedFile[]; outsideCount?: number; shellNote?: ShellNote }>;
  sessionChanges: Record<string, { base: string | null; files: ChangedFile[]; shellNote?: ShellNote }>;
  prs: Record<string, { available: boolean; reason: string | null; prs: PullRequest[] }>;
  viewed: Record<string, string[]>;
  activeWorkspaceId: string | null;
  panes: Pane[];
  activePaneId: string;
  attachments: Record<string, Attachment[]>;
  focusComposer: { paneId: string; nonce: number } | null;
  focusScmMessage: number | null;
  searchView: SearchViewOptions;
  searchRun: SearchRun;
  focusSearchInput: number | null;
  grid: Grid;
  closedPanes: ClosedPane[];
  sessionHistory: { back: string[]; forward: string[] };
  composerAction: { paneId: string; action: "attachMenu"; nonce: number } | null;
  lastPicked: LastPicked;
  draftModel: Record<string, string | null>;
  draftHarness: Record<string, Harness>;
  draftProvider: Record<string, string | null>;
  customProviders: CustomProviderView[] | null;
  codexMeta: CodexMeta | null;
  antigravityMeta: AntigravityMeta | null;
  cursorMeta: CursorMeta | null;
  draftEffort: Record<string, Settings["defaultEffort"]>;
  draftPermission: Record<string, PermissionMode>;
  tabs: Tab[];
  filesIndex: number;
  activeTabKey: RightTab | null;
  editorLayout: EditorLayout;
  activeGroupId: string;
  groupActive: Record<string, string | null>;
  maximizedGroup: string | null;
  dirtyTabs: Record<string, true>;
  sidebarOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  bottomTab: "output" | "terminal" | "problems";
  terminals: Record<string, Terminal[]>;
  activeTerminal: Record<string, string>;
  splitTerminals: boolean;
  lspStatus: Record<string, LspStatus>;
  lspInfo: Record<string, string>;
  lspFallback: Record<string, { label: string; reason: string }>;
  lspServers: Record<string, LspServerState[]>;
  toast: string | null;
  feedbackMode: "off" | "compose";
  feedbackPicking: boolean;
  feedbackTarget: FeedbackTarget | null;
  feedbackDraft: FeedbackDraft | null;
  feedbacks: Record<string, Feedback>;
  references: { title: string; groups: ReferenceGroup[] } | null;
  overlay: Overlay;
  browserAction: BrowserActionRequest | null;
  quickOpenQuery: string;
  recentAgentIds: string[];
  recentFiles: RecentFile[];
  quick: QuickState | null;
  side: SideState | null;
  sideStash: Record<string, SideState>;
  pendingReveal: Record<string, FileTarget>;
  layout: Layout;
  panelWidths: Record<string, number>;
  board: Board | null;
  centerView: CenterView;
  selectedCardId: string | null;
  boardCardId: string | null;
  composerPrefill: Record<string, { text: string; nonce: number; append?: boolean }>;
  inbox: InboxState | null;
  review: ReviewState | null;
  release: ReleaseState | null;
  operator: boolean | null;
  automations: AutomationsState | null;
  followUps: FollowUpsState | null;
  assistant: AssistantState | null;
  selectedAutomationId: string | null;
  automationEditor: AutomationEditorTarget | null;
  automationEditorOpen: boolean;
  selectedInboxId: string | null;
  selectedFeedbackId: string | null;
  layoutMode: LayoutMode;
  floatCollapsed: boolean;
  floatRect: FloatRect | null;
  sideTabKey: string;
  mainEditorKey: string | null;
  layoutTouched: boolean;
  sessionLayouts: SessionLayouts;
  sessionTabFocus: TabFocus;
  focusSideOpen: boolean;
  editorSessionChangesId: string | null;
  chatDockOpen: boolean;
  chatDockWidth: number | null;
  chatDock: ChatDock;
};

let paneSeq = 0;
export const newPaneId = () => `pane-${++paneSeq}`;

const restored = takeRestoredWindow();
if (restored) {
  setPendingRestore(restored.extras);
  setPendingHot(loadHotExit());
  restoreDrafts(restored.extras.drafts);
}
if (EMBED) setDraftStorage(null);
else {
  restoreDrafts(loadStoredDrafts());
  dropStoredDraftsOfMissingPanes(new Set((restored?.panes ?? []).map((p) => p.id)));
}
const initialChat = WINDOW_ID !== null && new URLSearchParams(location.search).get(CHAT_WINDOW_QUERY) === "1";
let pickFolderOnStart = !EMBED && WINDOW_ID !== null && !restored && !initialChat;
export function takePickFolderOnStart(): boolean {
  const pick = pickFolderOnStart;
  pickFolderOnStart = false;
  return pick;
}
const restoredTabs = sanitizeRestoredTabs(restored);
for (const pane of restored?.panes ?? []) paneSeq = Math.max(paneSeq, Number(pane.id.replace("pane-", "")) || 0);
const firstPane = newPaneId();

const restoredLayout: LayoutMode | null = isLayoutMode(restored?.layoutMode) ? (restored?.layoutMode ?? null) : null;
const openerLayout: LayoutMode | null = initialChat || pickFolderOnStart ? "chat" : null;
const startLayout: LayoutMode = EMBED ? "chat" : startingMode({ restored: restoredLayout ?? openerLayout,defaultLayout: loadCachedDefaultLayout(), remember: loadCachedRemember(), last: loadLastLayout() });

const EDITOR_ENTRY_PANELS = { focusSideOpen: true, sideTabKey: "files", bottomOpen: true, bottomTab: "terminal" } satisfies Partial<State>;
const CHAT_ENTRY_PANELS = { rightOpen: false, bottomOpen: false } satisfies Partial<State>;

let state: State = {
  connected: false,
  workspaces: [],
  agents: [],
  timelines: {},
  files: {},
  localCommands: {},
  emptyDirs: {},
  meta: null,
  metaRefreshing: false,
  mcpBusy: {},
  mcpNotes: {},
  settings: null,
  modelPins: null,
  sessionOrders: {},
  defaults: null,
  changes: {},
  gitInfo: {},
  gitChanges: {},
  sessionChanges: {},
  prs: {},
  viewed: {},
  activeWorkspaceId: null,
  panes: restored?.panes?.length ? restored.panes : [{ id: firstPane, kind: "draft", workspaceId: "" }],
  activePaneId: restored?.panes?.length ? (restored.activePaneId ?? restored.panes[0].id) : firstPane,
  attachments: restored ? restoreHandoffs(restored.extras.handoffs, new Set((restored.panes ?? []).map((p) => p.id))) : {},
  focusComposer: null,
  focusScmMessage: null,
  searchView: sanitizeSearchView(restored?.searchView),
  searchRun: IDLE_RUN,
  focusSearchInput: null,
  grid: restored?.grid ?? gridOf([]),
  closedPanes: [],
  sessionHistory: { back: [], forward: [] },
  composerAction: null,
  lastPicked: loadLastPicked(),
  draftModel: {},
  draftHarness: {},
  draftProvider: {},
  customProviders: null,
  codexMeta: null,
  antigravityMeta: null,
  cursorMeta: null,
  draftEffort: {},
  draftPermission: {},
  tabs: restored?.tabs ?? [],
  filesIndex: Math.min(restored?.filesIndex ?? 0, mainTabs(restored?.tabs ?? []).length),
  activeTabKey: restoredTabs.activeTabKey,
  editorLayout: restored?.editorLayout ?? SINGLE_LAYOUT,
  activeGroupId: restored?.activeGroupId ?? MAIN_GROUP,
  groupActive: restoredTabs.groupActive,
  maximizedGroup: null,
  dirtyTabs: {},
  sidebarOpen: restored?.sidebarOpen ?? true,
  rightOpen: restored?.rightOpen ?? false,
  bottomOpen: restored?.bottomOpen ?? false,
  bottomTab: "terminal",
  terminals: {},
  activeTerminal: {},
  splitTerminals: false,
  lspStatus: {},
  lspInfo: {},
  lspFallback: {},
  lspServers: {},
  toast: null,
  feedbackMode: "off",
  feedbackPicking: false,
  feedbackTarget: null,
  feedbackDraft: null,
  feedbacks: {},
  references: null,
  overlay: null,
  browserAction: null,
  quickOpenQuery: "",
  recentAgentIds: loadRecentAgents(),
  recentFiles: loadRecentFiles(),
  quick: null,
  side: null,
  sideStash: {},
  pendingReveal: {},
  layout: loadLayout(),
  panelWidths: restored?.extras.panelWidths ?? {},
  board: null,
  centerView: restored?.centerView ?? "sessions",
  selectedCardId: restored?.selectedCardId ?? null,
  boardCardId: null,
  composerPrefill: {},
  inbox: null,
  review: null,
  automations: null,
  followUps: null,
  assistant: null,
  selectedAutomationId: null,
  automationEditor: null,
  automationEditorOpen: false,
  release: null,
  operator: null,
  selectedInboxId: null,
  selectedFeedbackId: null,
  layoutMode: startLayout,
  floatCollapsed: restored?.floatCollapsed === true,
  floatRect: loadFloatRect(),
  sideTabKey: restoredTabs.sideTabKey,
  mainEditorKey: restored?.mainEditorKey ?? null,
  layoutTouched: false,
  sessionLayouts: !EMBED && loadCachedPerSession() ? sanitizeSessionLayouts(restored?.sessionLayouts) : {},
  sessionTabFocus: sanitizeTabFocus(restored?.sessionTabFocus),
  focusSideOpen: restored?.focusSideOpen === true,
  editorSessionChangesId: null,
  chatDockOpen: restored?.chatDockOpen !== false,
  chatDockWidth: parseDockWidth(restored?.chatDockWidth),
  chatDock: loadCachedChatDock(),
};

const launchLayout = state.sessionLayouts[layoutKeyOf(state) ?? ""] ?? null;
if (launchLayout) state = { ...state, ...layoutPatch(launchLayout, { activeTabKey: state.activeTabKey, tabKeys: state.tabs.map((t) => t.key), hasCard: !!state.selectedCardId }) };

state = { ...state, grid: reconcileGrid(state.grid, state.panes.map((p) => p.id), null) };
state = sanitizeEditorGroups(state);
state = settleTabs({ ...state, layoutMode: "chat" }, state);
if (!EMBED && !restored && !launchLayout && state.layoutMode === "editor") state = { ...state, ...EDITOR_ENTRY_PANELS };

const listeners = new Set<() => void>();

let tabMru: TabMru = {};
export const mruOf = (group: string): readonly string[] => tabMru[group] ?? [];

function activeAfterClose(s: State, group: string, key: string, siblings: readonly string[]): string | null {
  return pickAfterClose(tabMru, group, key, siblings, group === MAIN_GROUP ? sideKeyOf(s.sideTabKey, !!s.selectedCardId) : null);
}

function settleOwnedTabs(prev: State, next: State, applied: Partial<State>): State {
  if (EMBED) return next;
  if (!next.tabs.some((t) => t.kind === "pr" && t.agentId !== undefined) && Object.keys(next.sessionTabFocus).length === 0) return next;
  const groups = groupIdsOf(next.editorLayout);
  const activeOf = (s: State) => Object.fromEntries(groups.map((g) => [g, activeKeyOfGroup(s, g)]));
  const before = activeOf(next);
  const result = settleSessionTabs({
    tabs: next.tabs,
    groups,
    prevAgents: shownAgentsOf(prev),
    agents: shownAgentsOf(next),
    prevActive: activeOf(prev),
    active: before,
    focus: next.sessionTabFocus,
    restore: !("activeTabKey" in applied || "groupActive" in applied || "activeGroupId" in applied),
    pick: (group, hidden, shown) => pickAfterClose(tabMru, group, hidden, shown, group === MAIN_GROUP ? sideKeyOf(next.sideTabKey, !!next.selectedCardId) : null),
  });
  if (result.active === before && result.focus === next.sessionTabFocus) return next;
  let out: State = result.focus === next.sessionTabFocus ? next : { ...next, sessionTabFocus: result.focus };
  if (result.active !== before) {
    let groupActive = out.groupActive;
    for (const group of groups) {
      const key = result.active[group];
      if (key === before[group]) continue;
      if (group === out.activeGroupId) out = { ...out, activeTabKey: key as RightTab | null };
      else groupActive = { ...groupActive, [group]: key };
    }
    if (groupActive !== out.groupActive) out = { ...out, groupActive };
  }
  return out;
}
state = settleTabs({ ...state, layoutMode: "chat" }, settleOwnedTabs(state, state, {}));

export function getState() {
  return state;
}

export function closeTabsLike(key: string) {
  for (const tab of state.tabs.filter((t) => baseKeyOf(t.key) === key)) closeTab(tab.key);
}

export function setState(patch: Partial<State> | ((prev: State) => Partial<State>)) {
  const prev = state;
  let applied = typeof patch === "function" ? patch(state) : patch;
  if (Object.keys(applied).length === 0) return;
  if ("settings" in applied || "centerView" in applied || "operator" in applied) {
    const next = { ...state, ...applied };
    if (next.settings && centerViewHidden(next.centerView, next.settings, next.operator)) applied = { ...applied, centerView: "sessions" };
  }
  if (isTimelineOnly(applied)) {
    state = { ...state, ...applied };
    for (const listener of listeners) listener();
    return;
  }
  state = { ...state, ...applied };
  state = routeFocusPanels(prev, state, applied);
  state = rememberSessionLayout(prev, state);
  state = settleOwnedTabs(prev, state, applied);
  state = settleLayout(prev, state, applied);
  if (state.editorSessionChangesId && (state.sideTabKey !== "changes" || state.layoutMode !== "editor" || state.activePaneId !== prev.activePaneId)) {
    state = { ...state, editorSessionChangesId: null };
  }
  state = rememberSessionLayout(state, state);
  if (state.activeTabKey !== null && state.activeTabKey !== prev.activeTabKey && state.activeGroupId === prev.activeGroupId) {
    const group = groupOfKey(state.tabs, state.activeTabKey);
    if (group !== state.activeGroupId && hasGroup(state.editorLayout, group)) state = { ...state, activeGroupId: group, groupActive: { ...state.groupActive, [prev.activeGroupId]: prev.activeTabKey } };
  }
  if (state.activeTabKey !== prev.activeTabKey || state.activeGroupId !== prev.activeGroupId) tabMru = noteActive(tabMru, { group: prev.activeGroupId, key: prev.activeTabKey }, { group: state.activeGroupId, key: state.activeTabKey });
  if (!("side" in applied) && (state.panes !== prev.panes || state.activePaneId !== prev.activePaneId || state.agents !== prev.agents)) {
    const from = activeAgentOf(prev.panes, prev.activePaneId, prev.agents)?.id ?? null;
    const to = activeAgentOf(state.panes, state.activePaneId, state.agents)?.id ?? null;
    if (from !== to && (state.side || Object.keys(state.sideStash).length)) {
      const swapped = swapSide(state.side, state.sideStash, from, to);
      state = { ...state, side: swapped.side, sideStash: swapped.stash };
    }
  }
  if (state.panes !== prev.panes) {
    const grid = reconcileGrid(state.grid, state.panes.map((p) => p.id), prev.activePaneId);
    if (grid !== state.grid) state = { ...state, grid };
  }
  for (const listener of listeners) listener();
}

function isTimelineOnly(applied: Partial<State>) {
  for (const key in applied) if (key !== "timelines") return false;
  return true;
}

function sliceOf(s: State): TabSlice {
  return { layoutMode: s.layoutMode, activeTabKey: s.activeTabKey, sideTabKey: s.sideTabKey, mainEditorKey: s.mainEditorKey, groupActive: s.groupActive, tabKeys: shownTabsOf(s).map((t) => t.key), mainKeys: mainTabs(shownTabsOf(s)).map((t) => t.key) };
}

function settleTabs(prev: State, next: State): State {
  const out = normalizeTabs(sliceOf(prev), sliceOf(next));
  if (out.activeTabKey === next.activeTabKey && out.sideTabKey === next.sideTabKey && out.mainEditorKey === next.mainEditorKey && out.groupActive === next.groupActive) return next;
  return { ...next, activeTabKey: out.activeTabKey, sideTabKey: out.sideTabKey, mainEditorKey: out.mainEditorKey, groupActive: out.groupActive };
}

let perSessionOn = loadCachedPerSession();

const sharedLayoutKey = (s: State) => layoutKeyOf(s.panes.length > 1 ? { ...s, activePaneId: s.panes[0].id } : s);

function rememberSessionLayout(prev: State, next: State): State {
  if (EMBED) return next;
  const enabled = next.settings ? next.settings.rememberLayoutPerSession !== false : perSessionOn;
  if (enabled !== perSessionOn) {
    perSessionOn = enabled;
    cachePerSession(enabled);
  }
  const plan = planSwitch({ enabled, prevKey: sharedLayoutKey(prev), prev: layoutSliceOf(prev), key: sharedLayoutKey(next), current: layoutSliceOf(next), layouts: next.sessionLayouts });
  let out = plan.layouts === next.sessionLayouts ? next : { ...next, sessionLayouts: plan.layouts };
  const keepEditor = next.layoutMode === "editor" && plan.apply?.layoutMode === "chat";
  if (plan.apply && !keepEditor && !sameLayout(plan.apply, layoutSliceOf(out))) {
    const { floatRect: _rect, chatDockWidth: _dock, ...patch } = layoutPatch(plan.apply, { activeTabKey: out.activeTabKey, tabKeys: out.tabs.map((t) => t.key), hasCard: !!out.selectedCardId });
    out = { ...out, ...patch, ...(patch.layoutMode !== out.layoutMode ? { layoutTouched: true } : {}) };
  }
  return out;
}

function routeFocusPanels(prev: State, next: State, applied: Partial<State>): State {
  if (next.layoutMode !== "editor") return next;
  let out = next;
  if (applied.rightOpen !== undefined && applied.rightOpen !== prev.rightOpen) {
    const pinnedTab = applied.activeTabKey != null && isPinnedTab(applied.activeTabKey);
    out = { ...out, rightOpen: prev.rightOpen, ...(applied.rightOpen && pinnedTab ? { focusSideOpen: true } : {}) };
  }
  if (applied.references && !prev.references) out = { ...out, focusSideOpen: true };
  return out;
}

function settleLayout(prev: State, next: State, applied: Partial<State>): State {
  let out = next;
  if (out.activeTabKey !== prev.activeTabKey || out.tabs !== prev.tabs || out.layoutMode !== prev.layoutMode || out.groupActive !== prev.groupActive) out = settleTabs(prev, out);
  if (out.layoutMode !== "editor" && shownTabsOf(prev).length === 0 && shownTabsOf(out).length > 0) {
    const key = panelWidthKey(out);
    const saved = out.panelWidths[key];
    if (saved !== undefined && saved < PINNED_FIT) out = { ...out, panelWidths: { ...out.panelWidths, [key]: PINNED_FIT } };
  }
  if (out.layoutMode !== "editor" && shownTabsOf(out).length > 0 && out.tabs === prev.tabs && applied.activeTabKey != null && isPinnedTab(applied.activeTabKey)) revealPinned();
  return out;
}

export function setLayoutMode(mode: LayoutMode) {
  if (EMBED || state.layoutMode === mode) return;
  setState({ layoutMode: mode, layoutTouched: true, ...(mode === "editor" ? { floatCollapsed: false, chatDockOpen: true, ...EDITOR_ENTRY_PANELS } : CHAT_ENTRY_PANELS) });
  saveLastLayout(mode);
}

export function toggleLayoutMode() {
  setLayoutMode(state.layoutMode === "chat" ? "editor" : "chat");
}

export function setFloatCollapsed(collapsed: boolean) {
  if (state.floatCollapsed !== collapsed) setState({ floatCollapsed: collapsed });
}

export function revealChat() {
  if (state.layoutMode !== "editor") return;
  if (state.chatDock === "floating") setFloatCollapsed(false);
  else setChatDockOpen(true);
}

export function setFocusSideOpen(open: boolean) {
  if (state.focusSideOpen !== open) setState({ focusSideOpen: open });
}

export function setChatDockOpen(open: boolean) {
  if (state.chatDockOpen !== open) setState({ chatDockOpen: open });
}

export function setChatDockWidth(width: number | null) {
  if (state.chatDockWidth !== width) setState({ chatDockWidth: width });
}

export function setFocusView(view: string, open = true) {
  setState({ sideTabKey: view, focusSideOpen: open, editorSessionChangesId: null });
}

export function setFloatRect(rect: FloatRect | null, persist = true) {
  setState({ floatRect: rect });
  if (persist) saveFloatRect(rect);
}

function reconcileLayoutSettings(settings: Settings, first: boolean) {
  const defaultLayout = isLayoutMode(settings.defaultLayout) ? settings.defaultLayout : null;
  const remember = settings.rememberLastLayout === true;
  cacheLayoutSettings(defaultLayout, remember);
  setPinnedSide(settings.pinnedPanelSide);
  const chatDock = chatDockOf(settings.chatInEditorLayout);
  cacheChatDock(chatDock);
  if (chatDock !== state.chatDock) setState({ chatDock });
  if (!first || EMBED || restoredLayout || openerLayout || launchLayout || state.layoutTouched) return;
  const mode = startingMode({ restored: null, defaultLayout, remember, last: loadLastLayout() });
  if (mode !== state.layoutMode) setState({ layoutMode: mode, ...(mode === "editor" ? { floatCollapsed: false, ...EDITOR_ENTRY_PANELS } : CHAT_ENTRY_PANELS) });
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => selector(state),
  );
}

export function shownTabsOf(s: Pick<State, "tabs" | "panes">): Tab[] {
  return shownTabs(s.tabs, shownAgentsOf(s));
}

function groupOfKey(tabs: readonly Tab[], key: string | null) {
  return groupOf(tabs.find((t) => t.key === key));
}

export function activeKeyOfGroup(s: Pick<State, "tabs" | "activeGroupId" | "activeTabKey" | "groupActive"> & Partial<Pick<State, "panes">>, group: string): string | null {
  if (group === s.activeGroupId) return s.activeTabKey;
  const remembered = s.groupActive[group];
  if (group === MAIN_GROUP) return remembered ?? "changes";
  const agents = s.panes ? shownAgentsOf({ panes: s.panes }) : undefined;
  const inGroup = tabsOfGroup(s.tabs, group).filter((t) => isShown(t, agents));
  return inGroup.find((t) => t.key === remembered)?.key ?? inGroup[0]?.key ?? null;
}

function sanitizeEditorGroups(s: State): State {
  let layout = s.editorLayout;
  const known = new Set(groupIdsOf(layout));
  let tabs = s.tabs.map((t) => (t.group && !known.has(t.group) ? (({ group: _gone, ...rest }) => rest as Tab)(t) : t));
  layout = normalizeLayout(layout);
  const fixed: State = { ...s, tabs, editorLayout: layout, filesIndex: Math.min(s.filesIndex, mainTabs(tabs).length) };
  if (!hasGroup(layout, fixed.activeGroupId)) fixed.activeGroupId = MAIN_GROUP;
  const valid = (key: string | null) => key !== null && (isPinnedTab(key) || tabs.some((t) => t.key === key));
  if (!valid(fixed.activeTabKey) || (groupOfKey(tabs, fixed.activeTabKey) !== fixed.activeGroupId)) fixed.activeTabKey = fixed.activeGroupId === MAIN_GROUP ? (isPinnedTab(s.sideTabKey) ? s.sideTabKey : "changes") : (tabsOfGroup(tabs, fixed.activeGroupId)[0]?.key ?? null);
  return fixed;
}

export const fileTabKey = (workspaceId: string, path: string) => `${workspaceId}:${path}`;
export const diffTabKey = (agentId: string, path: string) => `diff:${agentId}:${path}`;

export type OpenOptions = { preview?: boolean; side?: boolean; preserveFocus?: boolean; keepDrawer?: boolean; scope?: ChangeScope; activeGroup?: boolean };

export function openFile(target: FileTarget, options: OpenOptions = {}): string | null {
  if (EMBED) {
    const dir = state.workspaces.find((w) => w.id === target.workspaceId)?.dir ?? "";
    postToHost({ type: "agent-nav:openFile", file: absolutePath(dir, target.path), line: target.line, column: target.column });
    return null;
  }
  rememberRecentFile({ workspaceId: target.workspaceId, path: target.path });
  const group = options.side ? sideGroup() : state.activeGroupId;
  let key = fileTabKey(target.workspaceId, target.path);
  setState((s) => {
    const like = { key, kind: "file" };
    const reveal = !options.activeGroup && s.settings?.revealIfOpen !== false;
    const open = options.side ? undefined : (findInGroup(s.tabs, group, like) ?? (reveal ? s.tabs.find((t) => sameContent(t, like)) : undefined));
    if (open && groupOf(open) !== group) {
      const openGroup = groupOf(open);
      key = open.key;
      return {
        pendingReveal: { ...s.pendingReveal, [open.key]: target },
        activeGroupId: openGroup,
        activeTabKey: open.key,
        groupActive: { ...s.groupActive, [s.activeGroupId]: s.activeTabKey },
        rightOpen: true,
      };
    }
    const placed = placeTab(s, { key, kind: "file", workspaceId: target.workspaceId, path: target.path }, options.preview === true, group);
    key = placed.key;
    return { ...placed.patch, pendingReveal: { ...s.pendingReveal, [key]: target }, activeTabKey: key, rightOpen: true };
  });
  if (options.preserveFocus && key) holdEditorFocus(key);
  else if (key) releaseEditorFocus(key);
  if (!options.keepDrawer) setPinnedDrawer(false);
  return key;
}

export function openDiff(agentId: string, workspaceId: string, path: string, options: OpenOptions = {}): string | null {
  if (EMBED) {
    postToHost({ type: "agent-nav:openDiff", agentId, file: path });
    return null;
  }
  const group = options.side ? sideGroup() : state.activeGroupId;
  let key = diffTabKey(agentId, path);
  setState((s) => {
    const placed = placeTab(s, { key, kind: "diff", agentId, workspaceId, path }, options.preview === true, group);
    key = placed.key;
    const scoped = options.scope === undefined ? {} : { tabs: withDiffScope(placed.patch.tabs ?? s.tabs, key, diffScopeOf(s, agentId, options.scope)) };
    return { ...placed.patch, ...scoped, activeTabKey: key, rightOpen: true };
  });
  setPinnedDrawer(false);
  return key;
}

function diffScopeOf(s: State, agentId: string, scope: ChangeScope): ChangeScope | undefined {
  const agent = s.agents.find((a) => a.id === agentId);
  return agent && scope === defaultChangeScope(agent) ? undefined : scope;
}

function withDiffScope(tabs: Tab[], key: string, scope: ChangeScope | undefined): Tab[] {
  return tabs.map((t) => {
    if (t.key !== key || t.kind !== "diff" || t.scope === scope) return t;
    const { scope: _old, ...rest } = t;
    return scope === undefined ? rest : { ...rest, scope };
  });
}

export const scmDiffTabKey = (workspaceId: string, section: ScmFileDiffSection, path: string) => `scm:${workspaceId}:${section}:${path}`;

export function openScmDiff(target: { workspaceId: string; agentId?: string }, entry: { path: string; rel: string }, section: ScmFileDiffSection, options: OpenOptions = {}) {
  if (EMBED) {
    postToHost({ type: "agent-nav:openFile", file: entry.path });
    return;
  }
  const group = options.side ? sideGroup() : state.activeGroupId;
  setState((s) => {
    const placed = placeTab(s, { key: scmDiffTabKey(target.workspaceId, section, entry.path), kind: "scm", workspaceId: target.workspaceId, ...(target.agentId ? { agentId: target.agentId } : {}), path: entry.path, rel: entry.rel, section }, options.preview === true, group);
    return { ...placed.patch, activeTabKey: placed.key, rightOpen: true };
  });
  setPinnedDrawer(false);
}

export const replacePreviewTabKey = (workspaceId: string, path: string) => `replace:${workspaceId}:${path}`;

export function openReplacePreviewTab(workspaceId: string, path: string, options: OpenOptions = {}): string | null {
  const group = options.side ? sideGroup() : state.activeGroupId;
  let key: string | null = null;
  setState((s) => {
    const placed = placeTab(s, { key: replacePreviewTabKey(workspaceId, path), kind: "replace", workspaceId, path }, options.preview === true, group);
    key = placed.key;
    return { ...placed.patch, activeTabKey: placed.key, rightOpen: true };
  });
  if (!options.keepDrawer) setPinnedDrawer(false);
  return key;
}

export function openSourceControl() {
  setState({ activeTabKey: "scm", rightOpen: true });
}

const previewEnabled = (s: State) => s.defaults?.previewEditors?.value ?? s.settings?.previewEditors ?? false;

function placeTab(s: State, tab: FileTab | DiffTab | ScmDiffTab | ReplacePreviewTab, preview: boolean, group: string): { key: string; patch: Partial<State> } {
  const existing = findInGroup(s.tabs, group, tab);
  const entry = existing ?? { ...tab, key: uniqueKey(s.tabs.map((t) => t.key), baseKeyOf(tab.key)) };
  const plan = planOpen(s.tabs, group, entry, preview && previewEnabled(s) ? "preview" : "pinned");
  const gone = plan.replaced;
  if (!gone) {
    if (plan.added) {
      const peers = group === MAIN_GROUP ? mainTabs(plan.tabs) : tabsOfGroup(plan.tabs, group);
      const at = peers.findIndex((t) => t.key === activeKeyOfGroup(s, group));
      const placed = peers.find((t) => t.key === entry.key);
      if (placed && at !== -1 && at < peers.length - 2) {
        const moved = moveToGroup({ tabs: plan.tabs, filesIndex: s.filesIndex }, entry.key, group, clampDrop(peers, placed, peers[at + 1].key));
        return { key: entry.key, patch: { tabs: moved.tabs, filesIndex: moved.filesIndex } };
      }
    }
    return { key: entry.key, patch: { tabs: plan.tabs } };
  }
  const rekey = (key: string | null) => (key === gone ? entry.key : key);
  const { [gone]: _dirty, ...dirtyTabs } = s.dirtyTabs;
  return {
    key: entry.key,
    patch: {
      tabs: plan.tabs,
      dirtyTabs,
      groupActive: Object.fromEntries(Object.entries(s.groupActive).map(([g, key]) => [g, rekey(key)])),
      mainEditorKey: rekey(s.mainEditorKey),
    },
  };
}

export function pinEditorTab(key: string) {
  if (!state.tabs.some((t) => t.key === key && "preview" in t && t.preview)) return;
  setState((s) => ({ tabs: pinTab(s.tabs, key) }));
}

let untitledSeq = 0;
export function openUntitled() {
  const pane = activePane();
  const agent = activeAgent();
  const workspaceId = agent ? (agent.workspaceId ? agent.workspaceId : null) : pane.kind === "draft" ? pane.workspaceId : state.activeWorkspaceId;
  if (!workspaceId) {
    hint(S.searchNeedsFolder);
    return null;
  }
  const n = Math.max(untitledSeq, ...state.tabs.map((t) => (t.kind === "untitled" ? t.n : 0))) + 1;
  untitledSeq = n;
  const key = `untitled:${n}`;
  setState((s) => ({ ...insertNextToActiveGroup(s, { key, kind: "untitled", workspaceId, n }), activeTabKey: key, rightOpen: true }));
  return key;
}

export function replaceTab(oldKey: string, next: Tab) {
  setState((s) => {
    const old = s.tabs.find((t) => t.key === oldKey);
    if (!old) return {};
    const tab = { ...next, ...(old.group ? { group: old.group } : {}), ...(old.sticky ? { sticky: true } : {}) } as Tab;
    const groupActive = Object.fromEntries(Object.entries(s.groupActive).map(([g, k]) => [g, k === oldKey ? next.key : k]));
    const { [oldKey]: _dirty, ...dirtyTabs } = s.dirtyTabs;
    return { tabs: s.tabs.map((t) => (t.key === oldKey ? tab : t)), activeTabKey: s.activeTabKey === oldKey ? next.key : s.activeTabKey, groupActive, dirtyTabs };
  });
}

export function setDirty(key: string, dirty: boolean) {
  if (!!state.dirtyTabs[key] === dirty) return;
  setState((s) => {
    const { [key]: _gone, ...rest } = s.dirtyTabs;
    return { dirtyTabs: dirty ? { ...rest, [key]: true } : rest, ...(dirty ? { tabs: pinTab(s.tabs, key) } : {}) };
  });
}

function insertNextToActiveGroup(s: State, tab: Tab): Pick<State, "tabs" | "filesIndex"> {
  if (s.activeGroupId === MAIN_GROUP) {
    const main = insertNextToActive({ tabs: mainTabs(s.tabs), filesIndex: s.filesIndex }, s.activeTabKey ?? "", tab);
    return { tabs: [...main.tabs, ...s.tabs.filter((t) => t.group)], filesIndex: main.filesIndex };
  }
  const group = tabsOfGroup(s.tabs, s.activeGroupId);
  const at = group.findIndex((t) => t.key === s.activeTabKey) + 1;
  const inserted = [...group.slice(0, at), { ...tab, group: s.activeGroupId } as Tab, ...group.slice(at)];
  return { tabs: [...s.tabs.filter((t) => groupOf(t) !== s.activeGroupId), ...inserted], filesIndex: s.filesIndex };
}

export function openBrowser(url = "", options: { sharedWith?: string | null } = {}) {
  const key = `browser:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const agent = activeAgent();
  const { partition, scope } = partitionFor(state.settings?.browserDataStorage ?? "default", agent?.workspaceId || state.activeWorkspaceId || null, key);
  setState((s) => ({ ...insertNextToActiveGroup(s, { key, kind: "browser", url, title: "", sharedWith: options.sharedWith ?? null, partition, scope }), activeTabKey: key, rightOpen: true }));
  return key;
}

export const prTabKey = (repo: string, number: number, agentId?: string | null) => `pr:${repo}#${number}${agentId ? `@${agentId}` : ""}`;

export function agentOfElement(element: Element | null): string | null {
  const paneId = element?.closest?.("[data-pane-id]")?.getAttribute("data-pane-id");
  const pane = state.panes.find((p) => p.id === (paneId ?? state.activePaneId));
  return pane?.kind === "agent" ? pane.agentId : null;
}

export function openPrTab(repo: string, number: number, agentId?: string | null): string {
  const owner = agentId === undefined ? agentOfElement(null) : agentId;
  if (owner && !shownAgentsOf(state).has(owner)) openAgent(owner);
  const key = prTabKey(repo, number, owner);
  setState((s) => {
    const open = s.tabs.find((t) => t.key === key);
    if (open) return { activeGroupId: groupOf(open), activeTabKey: key, groupActive: { ...s.groupActive, [s.activeGroupId]: s.activeTabKey }, rightOpen: true };
    return { ...insertNextToActiveGroup(s, { key, kind: "pr", repo, number, ...(owner ? { agentId: owner } : {}) }), activeTabKey: key, rightOpen: true };
  });
  setPinnedDrawer(false);
  return key;
}

export function openChatTab(agentId: string): string {
  const key = `chat:${agentId}`;
  const title = state.agents.find((a) => a.id === agentId)?.title ?? "";
  setState((s) => {
    const open = s.tabs.find((t) => t.key === key);
    if (open) return { activeGroupId: groupOf(open), activeTabKey: key, groupActive: { ...s.groupActive, [s.activeGroupId]: s.activeTabKey }, rightOpen: true, chatDockOpen: false };
    return { ...insertNextToActiveGroup(s, { key, kind: "chat", agentId, title }), activeTabKey: key, rightOpen: true, chatDockOpen: false };
  });
  return key;
}

export function searchWorkspaceOf(s: Pick<State, "panes" | "activePaneId" | "agents" | "activeWorkspaceId">): string | null {
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  const agent = pane?.kind === "agent" ? (s.agents.find((a) => a.id === pane.agentId) ?? null) : null;
  return (agent ? agent.workspaceId : pane?.kind === "draft" ? pane.workspaceId : s.activeWorkspaceId) || null;
}

export function openSearch(initialQuery = "", include?: string, extra: { seed?: Partial<SearchViewOptions>; autoRun?: boolean } = {}) {
  const workspaceId = searchWorkspaceOf(state);
  if (!workspaceId) {
    hint(S.searchNeedsFolder);
    return null;
  }
  const key = `search:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const details = !!include || !!extra.seed?.details || !!extra.seed?.exclude;
  setState((cur) => ({ ...insertNextToActiveGroup(cur, { key, kind: "search", workspaceId, query: initialQuery, ...(include ? { include } : {}), ...(details ? { details: true } : {}), ...(extra.seed ? { seed: extra.seed } : {}), ...(extra.autoRun ? { autoRun: true } : {}) }), activeTabKey: key, rightOpen: true }));
  return key;
}

export function dispatchBrowserAction(action: BrowserAction, url?: string, key: string | null = state.activeTabKey, value?: string) {
  const tab = state.tabs.find((t) => t.key === key && t.kind === "browser");
  if (!tab) {
    hint(S.browserNeedsTab);
    return;
  }
  setState({ browserAction: { key: tab.key, action, url, value, nonce: ++browserActionNonce } });
}
let browserActionNonce = 0;

export function patchSearchTab(key: string, patch: Partial<Pick<SearchTab, "autoRun">>) {
  setState((s) => {
    const tab = s.tabs.find((t): t is SearchTab => t.key === key && t.kind === "search");
    return tab ? { tabs: s.tabs.map((t) => (t === tab ? { ...tab, ...patch } : t)) } : {};
  });
}

export function updateSearchView(patch: Partial<SearchViewOptions>) {
  setState((s) => ({ searchView: { ...s.searchView, ...patch } }));
}

export function setSearchRun(run: SearchRun) {
  setState({ searchRun: run });
}

export function updateSearchTab(key: string, query: string) {
  setState((s) => {
    const tab = s.tabs.find((t): t is SearchTab => t.key === key && t.kind === "search");
    if (!tab || tab.query === query) return {};
    return { tabs: s.tabs.map((t) => (t === tab ? { ...tab, query } : t)) };
  });
}

export function toggleSearchDetails(key: string | null = state.activeTabKey) {
  setState((s) => {
    const tab = s.tabs.find((t): t is SearchTab => t.key === key && t.kind === "search");
    return tab ? { tabs: s.tabs.map((t) => (t === tab ? { ...tab, details: !tab.details } : t)) } : {};
  });
}

export function updateBrowserTab(key: string, patch: Partial<Pick<BrowserTab, "url" | "title" | "sharedWith" | "autoReload">>) {
  setState((s) => {
    const tab = s.tabs.find((t): t is BrowserTab => t.key === key && t.kind === "browser");
    if (!tab || ((patch.url ?? tab.url) === tab.url && (patch.title ?? tab.title) === tab.title && (patch.sharedWith === undefined || patch.sharedWith === (tab.sharedWith ?? null)) && (patch.autoReload === undefined || patch.autoReload === tab.autoReload))) return {};
    return { tabs: s.tabs.map((t) => (t === tab ? { ...tab, ...patch } : t)) };
  });
}

export function openChanges(path?: string) {
  if (EMBED) {
    const agent = activeAgent();
    if (agent) postToHost({ type: "agent-nav:openChanges", agentId: agent.id, file: path });
    return;
  }
  const agent = activeAgent();
  if (state.layoutMode === "editor") {
    setState({ sideTabKey: "changes", focusSideOpen: true, editorSessionChangesId: agent?.id ?? null });
  } else {
    setState({ activeTabKey: "changes", rightOpen: true });
  }
  const wide = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--size-panel-wide")) || 860;
  const width = state.panelWidths[panelWidthKey(state)] ?? null;
  const beside = state.layoutMode === "editor" || state.tabs.length > 0;
  if (!beside && (width === null || width < wide)) setPanelWidth(wide);
  if (!agent) return;
  const files = panelFiles(agent);
  selectChangedFile(agent.id, path ?? files[0]?.path ?? null);
}

function panelFiles(agent: Agent) {
  return pickChanges(agent, getChangesScope(agent), getShowOutside(agent.id), getScoped(agent.id), state.gitChanges[agent.id])?.files ?? [];
}

export function setChangesScope(agentId: string, scope: ChangeScope) {
  storeChangesScope(agentId, scope);
  selectChangedFile(agentId, null);
  void refreshScoped(agentId);
}

export function setShowOutside(agentId: string, show: boolean) {
  storeShowOutside(agentId, show);
  selectChangedFile(agentId, null);
  void refreshScoped(agentId);
}

async function refreshScoped(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) return;
  const scope = getChangesScope(agent);
  const includeOutside = getShowOutside(agentId);
  if (scope === defaultChangeScope(agent) && !includeOutside) return;
  try {
    const result = await rpc.call("git.changes", { agentId, scope, includeOutside });
    if (getChangesScope(agent) === scope && getShowOutside(agentId) === includeOutside) storeScopedChanges(agentId, { scope, includeOutside, ...result });
  } catch (error) {
    flash(S.gitStatusFailed((error as Error).message));
  }
}

let lastCloseSeq = 0;
const nextCloseSeq = () => ++lastCloseSeq;
const closedTabs: { tab: Tab; closeSeq: number }[] = [];
export const popClosedTab = () => closedTabs.pop()?.tab;

export function closeTab(key: string, remember = true) {
  setState((s) => {
    const closing = s.tabs.find((t) => t.key === key);
    if (!closing) return {};
    if (remember && (closing.kind === "file" || closing.kind === "diff" || closing.kind === "scm")) {
      closedTabs.push({ tab: closing, closeSeq: nextCloseSeq() });
      closedTabs.splice(0, Math.max(0, closedTabs.length - 20));
    }
    const group = groupOf(closing);
    const tabs = s.tabs.filter((t) => t.key !== key);
    const filesIndex = group === MAIN_GROUP ? Math.min(removedFilesIndex(mainTabs(s.tabs), s.filesIndex, key), mainTabs(tabs).length) : s.filesIndex;
    const wasActive = activeKeyOfGroup(s, group) === key;
    const shown = shownTabsOf(s);
    const siblings = (group === MAIN_GROUP ? mainTabs(shown) : tabsOfGroup(shown, group)).map((t) => t.key);
    const nextActive = wasActive ? activeAfterClose(s, group, key, siblings) : activeKeyOfGroup(s, group);
    const { [key]: _dirty, ...dirtyTabs } = s.dirtyTabs;
    if (group !== MAIN_GROUP && !tabsOfGroup(tabs, group).length) {
      const heir = adjacentGroup(s.editorLayout, group, -1) ?? adjacentGroup(s.editorLayout, group, 1) ?? MAIN_GROUP;
      const editorLayout = normalizeLayout(removeGroup(s.editorLayout, group));
      const { [group]: _gone, ...groupActive } = s.groupActive;
      if (s.activeGroupId !== group) return { tabs, filesIndex, dirtyTabs, editorLayout, groupActive };
      return { tabs, filesIndex, dirtyTabs, editorLayout, groupActive, activeGroupId: heir, activeTabKey: activeKeyOfGroup({ ...s, tabs, groupActive, activeGroupId: group, activeTabKey: null }, heir) };
    }
    if (group === s.activeGroupId) return { tabs, filesIndex, dirtyTabs, activeTabKey: nextActive };
    return { tabs, filesIndex, dirtyTabs, groupActive: { ...s.groupActive, [group]: nextActive } };
  });
}

let groupSeq = Math.max(0, ...groupIdsOf(state.editorLayout).map((id) => Number(id.replace("g", "")) || 0));
const splitIdsOf = (layout: EditorLayout): string[] => (layout.type === "group" ? [] : [layout.id, ...layout.children.flatMap(splitIdsOf)]);
let splitSeq = Math.max(0, ...splitIdsOf(state.editorLayout).map((id) => Number(id.replace("s", "")) || 0));

export const newGroupId = () => `g${++groupSeq}`;
export const newSplitId = () => `s${++splitSeq}`;

export function sideGroup(): string {
  const found = groupInDirection(state.editorLayout, state.activeGroupId, "right");
  if (found) return found;
  const id = newGroupId();
  const splitId = newSplitId();
  setState((cur) => ({ editorLayout: normalizeLayout(splitGroup(cur.editorLayout, cur.activeGroupId, "row", id, splitId, false)), rightOpen: true }));
  return id;
}

export function focusGroup(id: string) {
  setState((s) => {
    if (id === s.activeGroupId || !hasGroup(s.editorLayout, id)) return {};
    const key = activeKeyOfGroup(s, id);
    const editorKey = isPinnedTab(key) && (s.layoutMode === "editor" || s.tabs.length > 0) ? (s.mainEditorKey ?? mainTabs(s.tabs).at(-1)?.key ?? null) : key;
    return { activeGroupId: id, activeTabKey: editorKey, groupActive: { ...s.groupActive, [s.activeGroupId]: s.activeTabKey } };
  });
}

export function focusAdjacentGroup(step: 1 | -1) {
  const next = adjacentGroup(state.editorLayout, state.activeGroupId, step);
  if (next) focusGroup(next);
}

export function splitEditor(dir: "row" | "column", key: string | null = state.activeTabKey, before = false): boolean {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab) {
    hint(S.splitNeedsTab);
    return false;
  }
  return copyTabToNewGroup(tab.key, groupOf(tab), dir, before);
}

export function copyTabToNewGroup(key: string, target: string, dir: "row" | "column", before: boolean): boolean {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab || !hasGroup(state.editorLayout, target)) return false;
  if (!isDuplicable(tab)) return moveTabToNewGroup(key, target, dir, before);
  const id = newGroupId();
  const splitId = newSplitId();
  setState((cur) => {
    const copy = copyOfTab(tab, cur.tabs, id);
    return { editorLayout: normalizeLayout(splitGroup(cur.editorLayout, target, dir, id, splitId, before)), tabs: [...cur.tabs, copy], activeTabKey: copy.key, rightOpen: true };
  });
  return true;
}

export function copyTabToGroup(key: string, group: string, beforeKey: string | null): boolean {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab || !hasGroup(state.editorLayout, group)) return false;
  if (!isDuplicable(tab)) {
    moveTabToGroup(key, group, beforeKey);
    return true;
  }
  const twin = findInGroup(state.tabs, group, tab);
  if (twin) {
    setState({ activeTabKey: twin.key });
    return true;
  }
  setState((cur) => {
    const copy = copyOfTab(tab, cur.tabs, group);
    const groupTabs = group === MAIN_GROUP ? mainTabs(cur.tabs) : tabsOfGroup(cur.tabs, group);
    const moved = moveToGroup({ tabs: [...cur.tabs, copy], filesIndex: cur.filesIndex }, copy.key, group, clampDrop(groupTabs, copy, beforeKey));
    return { tabs: moved.tabs, filesIndex: moved.filesIndex, activeTabKey: copy.key, rightOpen: true };
  });
  return true;
}

function copyOfTab(tab: Tab, tabs: readonly Tab[], group: string): Tab {
  const { group: _group, preview: _preview, sticky: _sticky, ...rest } = tab as Tab & { preview?: boolean };
  return { ...rest, key: uniqueKey(tabs.map((t) => t.key), baseKeyOf(tab.key)), ...(group === MAIN_GROUP ? {} : { group }) } as Tab;
}

export function moveTabToNewGroup(key: string, target: string, dir: "row" | "column", before: boolean): boolean {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab || !hasGroup(state.editorLayout, target)) return false;
  const source = groupOf(tab);
  if (source === target && source !== MAIN_GROUP && tabsOfGroup(state.tabs, source).length === 1) {
    hint(S.splitNeedsAnotherTab);
    return false;
  }
  const newId = `g${++groupSeq}`;
  const splitId = `s${++splitSeq}`;
  setState((cur) => {
    const moved = moveToGroup({ tabs: cur.tabs, filesIndex: cur.filesIndex }, tab.key, newId, null);
    const siblings = (source === MAIN_GROUP ? mainTabs(cur.tabs) : tabsOfGroup(cur.tabs, source)).map((t) => t.key);
    const groupActive: Record<string, string | null> = { ...cur.groupActive, [cur.activeGroupId]: cur.activeTabKey };
    if (activeKeyOfGroup(cur, source) === tab.key) groupActive[source] = activeAfterClose(cur, source, tab.key, siblings);
    let editorLayout = splitGroup(cur.editorLayout, target, dir, newId, splitId, before);
    if (source !== MAIN_GROUP && !tabsOfGroup(moved.tabs, source).length) {
      editorLayout = removeGroup(editorLayout, source);
      delete groupActive[source];
    }
    return { editorLayout: normalizeLayout(editorLayout), tabs: moved.tabs, filesIndex: moved.filesIndex, activeGroupId: newId, activeTabKey: tab.key, groupActive, rightOpen: true };
  });
  return true;
}

export function moveTabToGroup(key: string, group: string, beforeKey: string | null) {
  const moving = state.tabs.find((t) => t.key === key);
  const twin = moving && groupOf(moving) !== group && hasGroup(state.editorLayout, group) ? findInGroup(state.tabs, group, moving) : undefined;
  if (twin) {
    closeTab(key, false);
    setState({ activeTabKey: twin.key });
    return;
  }
  setState((cur) => {
    const tab = cur.tabs.find((t) => t.key === key);
    if (!tab || !hasGroup(cur.editorLayout, group) || key === beforeKey) return {};
    const source = groupOf(tab);
    const moved = moveToGroup({ tabs: cur.tabs, filesIndex: cur.filesIndex }, key, group, clampDrop(group === MAIN_GROUP ? mainTabs(cur.tabs) : tabsOfGroup(cur.tabs, group), tab, beforeKey));
    const base = { tabs: moved.tabs, filesIndex: moved.filesIndex };
    const groupActive: Record<string, string | null> = { ...cur.groupActive, [cur.activeGroupId]: cur.activeTabKey };
    if (source !== group) {
      const siblings = (source === MAIN_GROUP ? mainTabs(cur.tabs) : tabsOfGroup(cur.tabs, source)).map((t) => t.key);
      if (activeKeyOfGroup(cur, source) === key) groupActive[source] = activeAfterClose(cur, source, key, siblings);
    }
    let editorLayout = cur.editorLayout;
    if (source !== MAIN_GROUP && source !== group && !tabsOfGroup(moved.tabs, source).length) {
      editorLayout = normalizeLayout(removeGroup(editorLayout, source));
      delete groupActive[source];
    }
    return { ...base, editorLayout, groupActive, activeGroupId: group, activeTabKey: key };
  });
}

export function resizeEditorSplit(splitId: string, sizes: number[]) {
  setState((s) => ({ editorLayout: setSplitSizes(s.editorLayout, splitId, sizes) }));
}

export function activeTab(): Tab | null {
  return state.tabs.find((t) => t.key === state.activeTabKey) ?? null;
}

export function activePane() {
  return state.panes.find((p) => p.id === state.activePaneId) ?? state.panes[0];
}

export function activeAgent() {
  const pane = activePane();
  return pane.kind === "agent" ? (state.agents.find((a) => a.id === pane.agentId) ?? null) : null;
}

export function openAgent(agentId: string, where: "active" | "new" = "active") {
  const agent = state.agents.find((a) => a.id === agentId);
  recordSessionVisit(activeAgent()?.id ?? null, agentId);
  rememberRecentAgent(agentId);
  const shown = state.panes.find((p) => p.kind === "agent" && p.agentId === agentId);
  if (shown) {
    focusPane(shown.id);
    openAgentData(agentId);
    return;
  }
  setState((s) => {
    const sticky = where === "active" && s.panes.some((p) => p.id === s.activePaneId && p.sticky);
    const pane: Pane = { id: where === "new" ? newPaneId() : s.activePaneId, kind: "agent", agentId, ...(sticky ? { sticky } : {}) };
    const panes = where === "new" ? [...s.panes, pane] : s.panes.map((p) => (p.id === s.activePaneId ? pane : p));
    const ws = s.workspaces.find((w) => w.id === agent?.workspaceId);
    return { panes, activePaneId: pane.id, centerView: "sessions", activeWorkspaceId: ws?.feedback || agent?.feedbackId ? s.activeWorkspaceId : (topWorkspaceId(agent?.workspaceId ?? null) ?? s.activeWorkspaceId) };
  });
  ensureTimeline(agentId);
  ensureChanges(agentId);
  ensureDiffFeedback(agentId);
  void refreshGit(agentId);
}

export function dropSessionOnPane(agentId: string, paneId: string, zone: DropZone, sizes?: PlaceSizes) {
  const plan = planSessionDrop({ panes: state.panes, grid: state.grid, activePaneId: state.activePaneId }, agentId, paneId, zone, newPaneId, sizes);
  if (!plan) return;
  const agent = state.agents.find((a) => a.id === agentId);
  recordSessionVisit(activeAgent()?.id ?? null, agentId);
  rememberRecentAgent(agentId);
  setState((s) => {
    const ws = s.workspaces.find((w) => w.id === agent?.workspaceId);
    return { ...plan, centerView: "sessions", focusComposer: { paneId: plan.activePaneId, nonce: Date.now() }, activeWorkspaceId: ws?.feedback || agent?.feedbackId ? s.activeWorkspaceId : (topWorkspaceId(agent?.workspaceId ?? null) ?? s.activeWorkspaceId) };
  });
  revealChat();
  openAgentData(agentId);
}

export const isTopWorkspace = (w: Workspace) => !w.parentId && !w.feedback;

export function topWorkspaceId(workspaceId: string | null) {
  return chatProject(workspaceId || null, state.workspaces);
}

function openAgentData(agentId: string) {
  ensureTimeline(agentId);
  ensureChanges(agentId);
  ensureDiffFeedback(agentId);
  void refreshGit(agentId);
}

export function ensureTimeline(agentId: string) {
  if (state.timelines[agentId]) return;
  void rpc.call("agents.timeline", { agentId }).then((items) => setState((s) => ({ timelines: { ...s.timelines, [agentId]: items } })));
}

export type FolderAgent = Agent & { workspaceId: string };
export function inFolder(agent: Agent | null | undefined): agent is FolderAgent {
  return !!agent && agent.workspaceId !== null;
}

export function ensureChanges(agentId: string) {
  if (state.changes[agentId] || !inFolder(state.agents.find((a) => a.id === agentId))) return;
  void rpc.call("changes.list", { agentId }).then((changes) => setState((s) => ({ changes: { ...s.changes, [agentId]: changes } })));
}

const gitRefreshing = new Set<string>();
const gitRefreshAgain = new Set<string>();

export async function refreshGit(agentId: string) {
  if (!inFolder(state.agents.find((a) => a.id === agentId))) return;
  if (gitRefreshing.has(agentId)) {
    gitRefreshAgain.add(agentId);
    return;
  }
  gitRefreshing.add(agentId);
  try {
    const agent = state.agents.find((a) => a.id === agentId);
    const sameAsSession = agent !== undefined && defaultChangeScope(agent) === "session";
    const [info, changes, session] = await Promise.all([rpc.call("git.info", { agentId }), rpc.call("git.changes", { agentId }), sameAsSession ? null : rpc.call("git.changes", { agentId, scope: "session" })]);
    setState((s) => ({ gitInfo: { ...s.gitInfo, [agentId]: info }, gitChanges: { ...s.gitChanges, [agentId]: changes }, sessionChanges: { ...s.sessionChanges, [agentId]: session ?? changes } }));
    await refreshScoped(agentId);
  } catch (error) {
    flash(S.gitStatusFailed((error as Error).message));
  } finally {
    gitRefreshing.delete(agentId);
    if (gitRefreshAgain.delete(agentId)) void refreshGit(agentId);
  }
}

export async function refreshPrs(agentId: string) {
  if (!inFolder(state.agents.find((a) => a.id === agentId))) return;
  const result = await rpc.call("git.prs", { agentId }).catch(() => ({ available: false, reason: S.prsFailed, prs: [] }));
  setState((s) => ({ prs: { ...s.prs, [agentId]: result } }));
}

export function toggleViewed(agentId: string, path: string) {
  setState((s) => {
    const list = s.viewed[agentId] ?? [];
    return { viewed: { ...s.viewed, [agentId]: list.includes(path) ? list.filter((p) => p !== path) : [...list, path] } };
  });
}

export function startEditorChatDraft() {
  const workspaceId = chatPaneWorkspace(activePane(), state.agents);
  startDraft(workspaceId, "new");
  revealChat();
}

export function finishSessionDraft(draft: Pane, agentId: string) {
  if (!state.panes.includes(draft)) return;
  if (state.activePaneId === draft.id) {
    openAgent(agentId);
    return;
  }
  const pane: Pane = { id: draft.id, kind: "agent", agentId, ...(draft.sticky ? { sticky: true } : {}) };
  setState((s) => ({ panes: s.panes.map((item) => item === draft ? pane : item) }));
  openAgentData(agentId);
}

export function startQuickChat(where: "active" | "new" = "active") {
  startDraft(null, where);
}

export function withoutPaneDraft<T>(record: Record<string, T>, paneId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== paneId));
}

export function startDraft(workspaceId: string | null, where: "active" | "new" = "active", options?: { seed?: DraftSeed; text?: string; handoff?: HandoffSeed; preset?: { model: string | null; effort: Settings["defaultEffort"]; permission: PermissionMode } }): string {
  const paneId = where === "new" ? newPaneId() : state.activePaneId;
  setState((s) => {
    const pane: Pane = { id: paneId, kind: "draft", workspaceId, ...(options?.seed ? { seed: options.seed } : {}), ...(options?.handoff ? { handoff: options.handoff } : {}) };
    const panes = where === "new" ? [...s.panes, pane] : s.panes.map((p) => (p.id === s.activePaneId ? pane : p));
    const { [pane.id]: _stale, ...others } = s.composerPrefill;
    const composerPrefill = options?.text ? { ...others, [pane.id]: { text: options.text, nonce: Date.now() } } : others;
    const preset = {
      draftModel: options?.preset ? { ...s.draftModel, [pane.id]: options.preset.model } : withoutPaneDraft(s.draftModel, pane.id),
      draftHarness: withoutPaneDraft(s.draftHarness, pane.id),
      draftProvider: withoutPaneDraft(s.draftProvider, pane.id),
      draftEffort: options?.preset ? { ...s.draftEffort, [pane.id]: options.preset.effort } : withoutPaneDraft(s.draftEffort, pane.id),
      draftPermission: options?.preset ? { ...s.draftPermission, [pane.id]: options.preset.permission } : withoutPaneDraft(s.draftPermission, pane.id),
    };
    return { panes, activePaneId: pane.id, centerView: "sessions", activeWorkspaceId: workspaceId ?? s.activeWorkspaceId, focusComposer: { paneId: pane.id, nonce: Date.now() }, composerPrefill, ...preset, ...(workspaceId === null ? { rightOpen: false } : s.activeTabKey === "changes" ? { activeTabKey: "files" as const } : {}) };
  });
  return paneId;
}

export function openSkills() {
  setState({ centerView: "skills" });
}

export function toggleAssistant() {
  setState((s) => ({ centerView: s.centerView === "mate" ? "sessions" : "mate" }));
  readAssistant();
}

export function openAssistant() {
  setState({ centerView: "mate" });
  readAssistant();
}

export function readAssistant() {
  const agent = state.agents.find((a) => a.id === state.assistant?.agentId);
  if (agent?.unread && state.centerView === "mate" && document.visibilityState === "visible") void rpc.call("agents.markRead", { agentId: agent.id, read: true }).catch(() => undefined);
}

function receiveAssistant(assistant: AssistantState | null) {
  setState({ assistant });
  if (assistant?.agentId) ensureTimeline(assistant.agentId);
}

export type AutomationEditorTarget = { mode: "create" } | { mode: "edit"; id: string };

export function toggleAutomations() {
  setState((s) => ({ centerView: s.centerView === "automations" ? "sessions" : "automations" }));
}

export function openAutomation(id: string | null) {
  setState({ selectedAutomationId: id, centerView: "automations" });
}

export function openAutomationEditor(target: AutomationEditorTarget) {
  setState({ automationEditor: target, automationEditorOpen: true });
}

export function closeAutomationEditor() {
  setState({ automationEditorOpen: false });
}

export function toggleInbox() {
  setState((s) => ({ centerView: s.centerView === "inbox" ? "sessions" : "inbox" }));
}

export function openInboxItem(id: string) {
  if (!slackShown(state.settings)) return;
  setState({ selectedInboxId: id, centerView: "inbox" });
  const item = state.inbox?.items.find((i) => i.id === id);
  if (item && !item.read) void rpc.call("inbox.markRead", { ids: [id], read: true }).catch(() => {});
}

export function closeInboxItem() {
  setState({ selectedInboxId: null });
}

export function toggleImprovements() {
  setState((s) => ({ centerView: s.centerView === "improvements" ? "sessions" : "improvements" }));
}

export function openImprovements() {
  setState({ centerView: "improvements" });
}

export function openImprovement(id: string) {
  setState({ selectedFeedbackId: id, centerView: "improvements" });
}

export function closeImprovement() {
  setState({ selectedFeedbackId: null });
}

export function refreshInbox() {
  void rpc.call("inbox.refresh", {}).catch((error: Error) => flash(S.inboxFailed(error.message)));
}

export async function refreshMeta() {
  if (state.metaRefreshing) return;
  setState({ metaRefreshing: true });
  try {
    setState({ meta: await rpc.call("meta.refresh", {}) });
  } catch (error) {
    flash(S.mcpActionFailed((error as Error).message));
  } finally {
    setState({ metaRefreshing: false });
  }
}

function mcpNote(result: McpActionResult, name: string, action: McpBusy): McpNote {
  const server = result.meta.mcp.find((m) => m.name === name);
  if (!result.ok) return { ok: false, text: server?.status === "needs-auth" ? S.mcpStillStatus("needs-auth") : (result.error ?? S.mcpUnknownError) };
  if (action === "disable") return { ok: true, text: S.mcpDisabled };
  if (server && server.status !== "connected") return { ok: false, text: S.mcpStillStatus(server.status) };
  if (action === "enable") return { ok: true, text: S.mcpEnabled };
  const turns = result.sessions.reconnected;
  return { ok: true, text: turns > 0 ? `${S.mcpReconnected}, ${S.mcpAlsoTurns(turns)}` : S.mcpReconnected };
}

async function runMcp(name: string, busy: McpBusy, call: () => Promise<McpActionResult>): Promise<McpActionResult | null> {
  if (state.mcpBusy[name]) return null;
  const { [name]: _old, ...notes } = state.mcpNotes;
  setState((s) => ({ mcpBusy: { ...s.mcpBusy, [name]: busy }, mcpNotes: notes }));
  try {
    const result = await call();
    setState((s) => ({ meta: result.meta, mcpNotes: { ...s.mcpNotes, [name]: mcpNote(result, name, busy) } }));
    return result;
  } catch (error) {
    setState((s) => ({ mcpNotes: { ...s.mcpNotes, [name]: { ok: false, text: (error as Error).message } } }));
    return null;
  } finally {
    setState((s) => {
      const { [name]: _done, ...rest } = s.mcpBusy;
      return { mcpBusy: rest };
    });
  }
}

export const reconnectMcp = (name: string) => runMcp(name, "reconnect", () => rpc.call("mcp.reconnect", { name }));
export const toggleMcp = (name: string, enabled: boolean) => runMcp(name, enabled ? "enable" : "disable", () => rpc.call("mcp.toggle", { name, enabled }));

export function startInboxSession(item: InboxItem) {
  const workspaceId = state.activeWorkspaceId ?? state.workspaces.find(isTopWorkspace)?.id;
  if (!workspaceId) {
    hint(S.inboxNoWorkspace);
    return;
  }
  startDraft(workspaceId, "active", { text: inboxDraft(item) });
}

const DRAFT_LIMIT = 6000;

export function inboxDraft(item: InboxItem) {
  const thread = item.thread?.messages.filter((m) => m.ts !== item.ts) ?? [];
  const lines = [
    S.inboxDraftHeader(item.from.name, item.channelName),
    item.permalink,
    "",
    cleanSlackText(item.text),
    ...(thread.length ? ["", S.inboxDraftThread(thread.length), ...thread.map((m) => `${m.from.name}: ${cleanSlackText(m.text)}`)] : []),
  ];
  const text = lines.join("\n");
  return text.length > DRAFT_LIMIT ? `${text.slice(0, DRAFT_LIMIT)}\n...` : text;
}

export async function addInboxItemToBoard(item: InboxItem) {
  if (!state.board) {
    flash(S.boardUnavailable);
    return;
  }
  const workspaceId = state.activeWorkspaceId ? topWorkspaceId(state.activeWorkspaceId) : null;
  try {
    const { card } = await rpc.call("inbox.addToBoard", { id: item.id, ...(workspaceId ? { workspaceId } : {}) });
    flash(S.addedToBoard);
    return card;
  } catch (error) {
    boardFailed(error);
  }
}

export async function markNotRequest(item: InboxItem) {
  try {
    await rpc.call("inbox.notRequest", { id: item.id });
  } catch (error) {
    flash(S.inboxFailed((error as Error).message));
  }
}

export async function reanalyzeMention(itemId: string) {
  try {
    await rpc.call("inbox.reanalyze", { id: itemId });
  } catch (error) {
    flash(S.reanalyzeFailed((error as Error).message));
  }
}

export function toggleBoard() {
  setState((s) => ({ centerView: s.centerView === "board" ? "sessions" : "board" }));
}

export function openCard(cardId: string) {
  setState((s) => {
    if (cardOpensInSessionPanel(s.centerView)) return { selectedCardId: cardId, activeTabKey: "card", rightOpen: true };
    if (!boardShown(s.settings)) return { selectedCardId: cardId, activeTabKey: "card", rightOpen: true, centerView: "sessions" };
    return { boardCardId: cardId, centerView: "board" };
  });
}

export function closeCard() {
  setState((s) => ({ selectedCardId: null, activeTabKey: s.activeTabKey === "card" ? "changes" : s.activeTabKey }));
}

export function closeBoardCard() {
  setState({ boardCardId: null });
}

export function startCardSession(card: BoardCard, worktree: boolean) {
  if (!card.workspaceId) return;
  const text = [card.title, card.body.trim()].filter(Boolean).join("\n\n");
  const branch = worktree ? card.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) : null;
  startDraft(card.workspaceId, "active", { text, seed: { cardId: card.id, worktreeBranch: branch, nonce: Date.now() } });
}

export function refreshBoard() {
  void rpc.call("board.get", {}).then((board) => setState({ board })).catch(() => {});
}

export function boardFailed(error: unknown) {
  flash(S.boardFailed(error instanceof Error ? error.message : String(error)));
  refreshBoard();
}

export function setBoardLocal(board: Board) {
  setState({ board });
}

export function splitActivePane() {
  setState((s) => {
    const current = s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0];
    const pane = blankPane(s, newPaneId());
    const index = s.panes.indexOf(current);
    return { panes: [...s.panes.slice(0, index + 1), pane, ...s.panes.slice(index + 1)], activePaneId: pane.id, focusComposer: { paneId: pane.id, nonce: Date.now() } };
  });
}

export function closePane(paneId: string) {
  setState((s) => {
    if (s.panes.length <= 1) return {};
    const closing = s.panes.find((p) => p.id === paneId);
    if (!closing) return {};
    const closedPanes = rememberClosed(s.closedPanes, [closing]);
    const editorChat = s.layoutMode === "editor" && s.activePaneId === paneId;
    const workspaceId = chatPaneWorkspace(closing, s.agents);
    const projectId = chatProject(workspaceId, s.workspaces);
    const order = editorChat
      ? s.panes.filter((p) => chatProject(chatPaneWorkspace(p, s.agents), s.workspaces) === projectId).map((p) => p.id)
      : paneOrder(s.grid);
    if (editorChat && order.length === 1) {
      const draft: Pane = { id: newPaneId(), kind: "draft", workspaceId };
      return { panes: s.panes.map((item) => item === closing ? draft : item), activePaneId: draft.id, closedPanes };
    }
    const index = order.indexOf(paneId);
    const panes = s.panes.filter((p) => p.id !== paneId);
    const activePaneId = s.activePaneId === paneId ? (order[index + 1] ?? order[index - 1] ?? panes[0].id) : s.activePaneId;
    return { panes, activePaneId, closedPanes };
  });
}

function rememberClosed(list: ClosedPane[], closed: Pane[]): ClosedPane[] {
  const added = closed.flatMap((p) => (p.kind === "agent" ? [{ agentId: p.agentId, closeSeq: nextCloseSeq() }] : []));
  return added.length ? [...list.filter((c) => !added.some((a) => a.agentId === c.agentId)), ...added].slice(-CLOSED_PANES_MAX) : list;
}

const blankPane = (s: State, id: string): Pane => ({ id, kind: "draft", workspaceId: s.activeWorkspaceId ?? s.workspaces.find(isTopWorkspace)?.id ?? "" });

export function closeFocusedPane(paneId: string = state.activePaneId): boolean {
  const pane = state.panes.find((p) => p.id === paneId);
  if (!pane) return false;
  if (state.panes.length > 1) {
    closePane(paneId);
    return true;
  }
  if (pane.kind === "draft") return false;
  const draft: Pane = state.layoutMode === "editor"
    ? { id: newPaneId(), kind: "draft", workspaceId: chatPaneWorkspace(pane, state.agents) }
    : blankPane(state, paneId);
  setState((s) => ({
    panes: [draft],
    activePaneId: draft.id,
    closedPanes: rememberClosed(s.closedPanes, [pane]),
  }));
  return true;
}

export function closeAllPanes() {
  setState((s) => {
    const active = s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0];
    const others = s.panes.filter((p) => p !== active);
    return { panes: [blankPane(s, active.id)], activePaneId: active.id, closedPanes: rememberClosed(s.closedPanes, [...others, active]) };
  });
}

export function closedEditorIsNewest(): boolean {
  const editorSeq = closedTabs.at(-1)?.closeSeq ?? 0;
  const chatSeq = state.closedPanes.findLast((c) => state.agents.some((a) => a.id === c.agentId))?.closeSeq ?? 0;
  return editorSeq > chatSeq;
}

export function reopenClosedPane() {
  const list = state.closedPanes.slice();
  let target: ClosedPane | undefined;
  while ((target = list.pop())) {
    const id = target.agentId;
    if (state.agents.some((a) => a.id === id)) break;
  }
  setState({ closedPanes: list });
  if (!target) {
    hint(S.noClosedChat);
    return;
  }
  if (state.layoutMode === "editor") openEditorChatSession(target.agentId);
  else openAgent(target.agentId, activePaneKeepsDraft() ? "new" : "active");
}

export function activePaneKeepsDraft() {
  const active = state.panes.find((p) => p.id === state.activePaneId);
  return active?.kind === "draft" && (!!getDraft(`new:${active.id}`).trim() || attachmentsOf(state, active.id).some((attachment) => !attachment.inlineRef));
}

export function openEditorChatSession(agentId: string) {
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) return;
  const pane = activePane();
  const inSameProject = topWorkspaceId(chatPaneWorkspace(pane, state.agents)) === topWorkspaceId(agent.workspaceId);
  const replaceDraft = pane.kind === "draft" && inSameProject && !activePaneKeepsDraft();
  openAgent(agentId, replaceDraft ? "active" : "new");
  setState({ focusComposer: { paneId: state.activePaneId, nonce: Date.now() } });
  revealChat();
}

export function switchToSession(agentId: string) {
  if (state.layoutMode === "editor") {
    openEditorChatSession(agentId);
    return;
  }
  if (!state.agents.some((a) => a.id === agentId)) return;
  openAgent(agentId, activePaneKeepsDraft() ? "new" : "active");
  setState({ focusComposer: { paneId: state.activePaneId, nonce: Date.now() } });
}

export function splitActivePaneDown() {
  setState((s) => {
    const current = s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0];
    const pane = blankPane(s, newPaneId());
    return { panes: [...s.panes, pane], grid: gridSplitDown(s.grid, current.id, pane.id), activePaneId: pane.id, focusComposer: { paneId: pane.id, nonce: Date.now() } };
  });
}

export function moveChatTab(paneId: string, beforeId: string | null) {
  if (paneId === beforeId) return;
  setState((s) => {
    const moving = s.panes.find((p) => p.id === paneId);
    if (!moving) return {};
    const rest = s.panes.filter((p) => p !== moving);
    const index = beforeId ? rest.findIndex((p) => p.id === beforeId) : -1;
    const panes = index < 0 ? [...rest, moving] : [...rest.slice(0, index), moving, ...rest.slice(index)];
    return panes.every((p, i) => p === s.panes[i]) ? {} : { panes };
  });
}

export function setChatTabSticky(paneId: string, sticky: boolean) {
  setState((s) => {
    const target = s.panes.find((p) => p.id === paneId);
    if (!target || !!target.sticky === sticky) return {};
    const next: Pane = { ...target, sticky };
    if (!sticky) delete next.sticky;
    const others = s.panes.filter((p) => p !== target);
    return { panes: sticky ? [...others, next] : [next, ...others] };
  });
}

export function focusPane(paneId: string, focusComposer = true) {
  if (!state.panes.some((p) => p.id === paneId)) return;
  setState({ activePaneId: paneId, centerView: "sessions", ...(focusComposer ? { focusComposer: { paneId, nonce: Date.now() } } : {}) });
}

export function focusPaneStep(delta: 1 | -1) {
  const id = gridStep(state.grid, state.activePaneId, delta);
  if (id) focusPane(id);
}

export function focusPaneDirection(direction: Direction) {
  const id = neighbor(state.grid, state.activePaneId, direction, direction === "up" || direction === "down" ? paneCenters() : undefined);
  if (id) focusPane(id);
}

function paneCenters(): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof document === "undefined") return out;
  for (const el of document.querySelectorAll<HTMLElement>("[data-pane-id]")) {
    const rect = el.firstElementChild?.getBoundingClientRect();
    if (rect && el.dataset.paneId) out[el.dataset.paneId] = rect.left + rect.width / 2;
  }
  return out;
}

export function focusPaneIndex(index: number | "last") {
  const order = paneOrder(state.grid);
  const id = index === "last" ? order[order.length - 1] : order[index];
  if (id) focusPane(id);
}

export function movePane(delta: 1 | -1) {
  const other = gridStep(state.grid, state.activePaneId, delta, true);
  if (!other) return;
  setState((s) => ({ grid: swapPanes(s.grid, s.activePaneId, other), focusComposer: { paneId: s.activePaneId, nonce: Date.now() } }));
}

export function movePaneRow(delta: 1 | -1) {
  const grid = moveToRow(state.grid, state.activePaneId, delta);
  if (!grid) return;
  setState((s) => ({ grid, focusComposer: { paneId: s.activePaneId, nonce: Date.now() } }));
}

export function setGridWeights(patch: { cols?: Record<string, number>; rows?: number[] | null }) {
  setState((s) => ({
    grid: {
      ...s.grid,
      ...(patch.cols === undefined ? {} : { colWeights: patch.cols }),
      ...(patch.rows === undefined ? {} : { rowWeights: patch.rows }),
    },
  }));
}

let replayingHistory = false;

function recordSessionVisit(from: string | null, to: string) {
  if (replayingHistory || !from || from === to) return;
  setState((s) => ({ sessionHistory: { back: [...s.sessionHistory.back.filter((id, i, all) => !(id === from && i === all.length - 1)), from].slice(-50), forward: [] } }));
}

export function goBackSession() {
  stepSessionHistory("back");
}
export function goForwardSession() {
  stepSessionHistory("forward");
}

export function leaveDoneSession(agentId: string) {
  const pane = state.panes.find((p) => p.kind === "agent" && p.agentId === agentId);
  if (!pane) return;
  const shown = new Set(state.panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : [])));
  const back = state.sessionHistory.back.filter((id) => id !== agentId);
  const target = back.findLast((id) => !shown.has(id) && state.agents.some((a) => a.id === id && !a.done));
  if (!target) {
    setState((s) => ({ sessionHistory: { ...s.sessionHistory, back } }));
    closeFocusedPane(pane.id);
    return;
  }
  setState((s) => ({ activePaneId: pane.id, sessionHistory: { back: back.filter((id) => id !== target), forward: s.sessionHistory.forward } }));
  replayingHistory = true;
  try {
    openAgent(target, "active");
  } finally {
    replayingHistory = false;
  }
}

function stepSessionHistory(direction: "back" | "forward") {
  const current = activeAgent()?.id ?? null;
  const from = direction === "back" ? state.sessionHistory.back.slice() : state.sessionHistory.forward.slice();
  let target: string | undefined;
  while ((target = from.pop())) {
    const id = target;
    if (state.agents.some((a) => a.id === id) && id !== current) break;
  }
  if (!target) {
    setState((s) => ({ sessionHistory: { ...s.sessionHistory, [direction]: [] } }));
    return;
  }
  const other = direction === "back" ? state.sessionHistory.forward : state.sessionHistory.back;
  setState((s) => ({ sessionHistory: { ...s.sessionHistory, [direction]: from, [direction === "back" ? "forward" : "back"]: current ? [...other, current] : other } }));
  replayingHistory = true;
  try {
    if (state.layoutMode === "editor") openEditorChatSession(target);
    else openAgent(target);
  } finally {
    replayingHistory = false;
  }
}

export const NO_ATTACHMENTS: Attachment[] = [];
export const attachmentsOf = (s: Pick<State, "attachments" | "panes">, paneId: string) => s.attachments[attachmentKey(s.panes, paneId)] ?? NO_ATTACHMENTS;

export function addAttachment(paneId: string, attachment: Omit<Attachment, "id">): string {
  const id = `${Date.now()}-${Math.random()}`;
  let existingId: string | null = null;
  setState((s) => {
    const key = attachmentKey(s.panes, paneId);
    const current = s.attachments[key] ?? [];
    const dup = findDuplicate(current, attachment, (workspaceId) => s.workspaces.find((w) => w.id === workspaceId)?.dir);
    if (dup) {
      existingId = dup.id;
      return { focusComposer: { paneId, nonce: Date.now() } };
    }
    return { attachments: { ...s.attachments, [key]: [...current, { ...attachment, id }] }, focusComposer: { paneId, nonce: Date.now() } };
  });
  if (existingId) {
    flashAttachment(existingId);
    return existingId;
  }
  return id;
}

export function findAttachedDuplicate(paneId: string, attachment: Omit<Attachment, "id">) {
  const s = state;
  return findDuplicate(attachmentsOf(s, paneId), attachment, (workspaceId) => s.workspaces.find((w) => w.id === workspaceId)?.dir);
}

function keyOfAttachment(s: Pick<State, "attachments">, id: string) {
  return Object.keys(s.attachments).find((key) => s.attachments[key].some((a) => a.id === id));
}

export function updateAttachment(_paneId: string, id: string, patch: Partial<Omit<Attachment, "id">>) {
  setState((s) => {
    const key = keyOfAttachment(s, id);
    return key ? { attachments: { ...s.attachments, [key]: s.attachments[key].map((a) => (a.id === id ? { ...a, ...patch } : a)) } } : {};
  });
}

export function removeAttachment(_paneId: string, id: string) {
  setState((s) => {
    const key = keyOfAttachment(s, id);
    return key ? { attachments: { ...s.attachments, [key]: s.attachments[key].filter((a) => a.id !== id) } } : {};
  });
}

export function clearAttachmentsByKey(key: string, ids?: ReadonlySet<string>) {
  setState((s) => (s.attachments[key]?.length ? { attachments: { ...s.attachments, [key]: ids ? s.attachments[key].filter((a) => !ids.has(a.id)) : [] } } : {}));
}

export function refreshLocalCommands(workspaceId: string) {
  void rpc
    .call("commands.local", { workspaceId })
    .then((list) => setState((s) => ({ localCommands: { ...s.localCommands, [workspaceId]: list } })))
    .catch(() => undefined);
}

const FILE_LIST_REFRESH_MS = 1500; // lint-tokens: allow 파일 목록을 다시 읽기 전 기다리는 시간(ms)
const fileListTimers = new Map<string, ReturnType<typeof setTimeout>>();
function refreshLoadedFiles(workspaceIds: string[]) {
  for (const id of workspaceIds) {
    if (!state.files[id] || fileListTimers.has(id)) continue;
    fileListTimers.set(
      id,
      setTimeout(() => {
        fileListTimers.delete(id);
        void Promise.all([rpc.call("files.list", { workspaceId: id }), rpc.call("files.dirs", { workspaceId: id }).catch(() => [] as string[])])
          .then(([files, dirs]) => setState((s) => ({ files: { ...s.files, [id]: files }, emptyDirs: { ...s.emptyDirs, [id]: dirs } })))
          .catch(() => undefined);
      }, FILE_LIST_REFRESH_MS),
    );
  }
}

export async function ensureFiles(workspaceId: string) {
  if (state.files[workspaceId]) return state.files[workspaceId];
  const files = await rpc.call("files.list", { workspaceId });
  setState((s) => ({ files: { ...s.files, [workspaceId]: files } }));
  void rpc.call("files.dirs", { workspaceId }).then((dirs) => setState((s) => ({ emptyDirs: { ...s.emptyDirs, [workspaceId]: dirs } }))).catch(() => undefined);
  return files;
}

function nextTerminalName(list: Terminal[]) {
  const used = new Set(list.map((t) => t.name));
  let n = 1;
  while (used.has(`zsh ${n}`)) n += 1;
  return `zsh ${n}`;
}

export function addTerminal(agentId: string, dir?: string) {
  setState((s) => {
    const list = s.terminals[agentId] ?? [];
    const terminal = { id: `term-${Date.now()}`, name: nextTerminalName(list), ...(dir ? { dir } : {}) };
    return {
      terminals: { ...s.terminals, [agentId]: [...list, terminal] },
      activeTerminal: { ...s.activeTerminal, [agentId]: terminal.id },
      bottomOpen: true,
      bottomTab: "terminal",
    };
  });
}

export function splitTerminal(agentId: string) {
  addTerminal(agentId);
  setState({ splitTerminals: true });
}

export function closeTerminal(agentId: string, id: string) {
  setState((s) => {
    const list = (s.terminals[agentId] ?? []).filter((t) => t.id !== id);
    return { terminals: { ...s.terminals, [agentId]: list }, activeTerminal: { ...s.activeTerminal, [agentId]: list[list.length - 1]?.id ?? "" }, ...(list.length === 0 ? { bottomOpen: false } : {}) };
  });
}

let codexMetaLoading: Promise<void> | null = null;
export function loadCodexMeta(refresh = false): Promise<void> {
  if (!refresh && state.codexMeta) return Promise.resolve();
  codexMetaLoading ??= rpc
    .call("codex.meta", { refresh })
    .then((codexMeta) => setState({ codexMeta }))
    .catch((error: Error) => setState({ codexMeta: { installed: true, version: null, loggedIn: false, account: null, models: [], defaultModel: null, defaultEffort: null, error: error.message, fetchedAt: new Date().toISOString() } }))
    .finally(() => {
      codexMetaLoading = null;
    });
  return codexMetaLoading;
}

let antigravityMetaLoading: Promise<void> | null = null;
export function loadAntigravityMeta(refresh = false): Promise<void> {
  if (!refresh && state.antigravityMeta) return Promise.resolve();
  antigravityMetaLoading ??= rpc
    .call("antigravity.meta", { refresh })
    .then((antigravityMeta) => setState({ antigravityMeta }))
    .catch((error: Error) => setState({ antigravityMeta: { installed: true, version: null, loggedIn: false, account: null, models: [], defaultModel: null, defaultEffort: null, error: error.message, fetchedAt: new Date().toISOString() } }))
    .finally(() => {
      antigravityMetaLoading = null;
    });
  return antigravityMetaLoading;
}

let cursorMetaLoading: Promise<void> | null = null;
export function loadCursorMeta(refresh = false): Promise<void> {
  if (!refresh && state.cursorMeta) return Promise.resolve();
  cursorMetaLoading ??= rpc
    .call("cursor.meta", { refresh })
    .then((cursorMeta) => setState({ cursorMeta }))
    .catch((error: Error) => setState({ cursorMeta: { installed: true, version: null, loggedIn: false, account: null, models: [], defaultModel: null, defaultEffort: null, error: error.message, fetchedAt: new Date().toISOString() } }))
    .finally(() => {
      cursorMetaLoading = null;
    });
  return cursorMetaLoading;
}

export function openSide(agentId: string, draft?: string) {
  const target = state.agents.find((a) => a.id === agentId);
  if (target && harnessOf(target) !== "claude") {
    hint(S.harnessUnavailable(harnessOf(target), "Side questions (/btw)"));
    return;
  }
  setState((s) => {
    const next = draft ? { text: draft, nonce: Date.now() } : undefined;
    if (s.side?.agentId === agentId) return next ? { side: { ...s.side, draft: next } } : {};
    return { side: { id: `side-${Date.now()}`, agentId, run: null, model: null, ...(next ? { draft: next } : {}) } };
  });
}

export function panelKey(s: Pick<State, "panes" | "activePaneId">) {
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  return pane?.kind === "agent" ? `agent:${pane.agentId}` : `draft:${pane?.id ?? ""}`;
}

export function panelWidthKey(s: Pick<State, "panes" | "activePaneId">) {
  return s.panes.length > 1 ? "panes" : panelKey(s);
}

export function setPanelWidth(width: number | null) {
  setState((s) => {
    const key = panelWidthKey(s);
    const { [key]: _removed, ...rest } = s.panelWidths;
    return { panelWidths: width === null ? rest : { ...rest, [key]: width } };
  });
}

export function setLayout(patch: Partial<Layout>) {
  setState((s) => ({ layout: { ...s.layout, ...patch } }));
  saveLayout();
}

function saveLayout() {
  try {
    const json = JSON.stringify(state.layout);
    windowStorage()?.setItem(LAYOUT_KEY, json);
    localStorage.setItem(LAYOUT_KEY, json);
  } catch {
  }
}

export function openInVSCode(agentId: string | null, workspaceId: string | null) {
  return rpc.call("workspaces.openInVSCode", agentId ? { agentId } : { workspaceId: workspaceId ?? undefined }).catch((error: Error) => flash(S.openVSCodeFailed(error.message.split("\n")[0])));
}

export function flash(message: string, severity: NoticeSeverity = "info") {
  notify({ message, severity });
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

let layoutReconciled = false;
let connectedBefore = false;

const LEGACY_MODEL_PINS_KEY = "agent-nav:pinned-models";

async function syncModelPins() {
  const previousPins = state.modelPins;
  let legacy: string[] | undefined;
  if (!EMBED) {
    try {
      const raw = localStorage.getItem(LEGACY_MODEL_PINS_KEY);
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (Array.isArray(parsed)) legacy = parsed.filter((pin): pin is string => typeof pin === "string");
    } catch {
      legacy = undefined;
    }
  }
  const modelPins = legacy === undefined
    ? await rpc.call("models.pins", {})
    : await rpc.call("models.importPins", { pins: legacy });
  if (state.connected && state.modelPins === previousPins) setState({ modelPins });
}

export function loadCustomProviders(): Promise<void> {
  return rpc.call("providers.list", {}).then(
    (customProviders) => setState({ customProviders }),
    () => setState({ customProviders: [] }),
  );
}

export function initStore() {
  rpc.onStatus((connected) => {
    setState(connected ? { connected } : { connected, modelPins: null });
    if (!connected) return;
    if (connectedBefore) {
      for (const agentId of Object.keys(state.timelines)) {
        void rpc
          .call("agents.timeline", { agentId })
          .then((items) => setState((s) => (s.timelines[agentId] ? { timelines: { ...s.timelines, [agentId]: items } } : {})))
          .catch(() => undefined);
      }
    }
    connectedBefore = true;
    void syncModelPins().catch((error: Error) => console.error("[model pins]", error.message));
    void loadCustomProviders();
    void rpc.call("board.get", {}).then((board) => setState({ board })).catch(() => setState({ board: null }));
    void rpc.call("inbox.get", {}).then((inbox) => setState({ inbox })).catch(() => setState({ inbox: null }));
    void refreshReview();
    void rpc.call("automations.list", {}).then((automations) => setState({ automations })).catch(() => setState({ automations: null }));
    void rpc.call("followUps.get", {}).then((followUps) => setState({ followUps })).catch(() => setState({ followUps: null }));
    void rpc.call("assistant.get", {}).then(receiveAssistant).catch(() => receiveAssistant(null));
    void rpc.call("release.get", {}).then((release) => setState({ release })).catch(() => setState({ release: null }));
    void rpc.call("runtime.info", {}).then((info) => setState({ operator: info.operator === true })).catch(() => undefined);
    void rpc.call("defaults.get", {}).then((defaults) => setState({ defaults })).catch(() => setState({ defaults: null }));
    void rpc.call("sessionOrder.list", {}).then((sessionOrders) => setState({ sessionOrders })).catch(() => setState({ sessionOrders: {} }));
    void Promise.all([
      rpc.call("workspaces.list", {}),
      rpc.call("agents.list", {}),
      rpc.call("meta.get", {}),
      rpc.call("settings.get", {}),
      rpc.call("feedback.list", {}),
    ]).then(([workspaces, agents, meta, settings, feedbacks]) =>
      setState((s) => {
        const top = workspaces.filter(isTopWorkspace);
        const activeWorkspaceId = s.activeWorkspaceId ?? top[0]?.id ?? null;
        const panes = s.panes.map((p): Pane => {
          if (p.kind === "agent") return agents.some((a) => a.id === p.agentId) ? p : { id: p.id, kind: "draft", workspaceId: activeWorkspaceId ?? "" };
          return p.workspaceId === "" && activeWorkspaceId ? { ...p, workspaceId: activeWorkspaceId } : p;
        });
        for (const p of panes) if (p.kind === "agent") queueMicrotask(() => openAgentData(p.agentId));
        return { workspaces, agents, meta, settings, activeWorkspaceId, panes, feedbacks: Object.fromEntries(feedbacks.map((f) => [f.id, f])) };
      }),
    ).then(() => {
      if (state.settings) reconcileLayoutSettings(state.settings, !layoutReconciled);
      layoutReconciled = true;
      if (restored) void pruneRestoredWindow();
    });
  });
  rpc.onEvent((event) => {
    switch (event.type) {
      case "board":
        setState({ board: event.board });
        return;
      case "inbox":
        setState({ inbox: event.inbox });
        return;
      case "review":
        receiveReview(event.review);
        return;
      case "automations":
        setState({ automations: event.state });
        return;
      case "followUps":
        receiveFollowUps(event.state);
        return;
      case "assistant":
        receiveAssistant(event.state);
        return;
      case "release":
        setState({ release: event.release });
        return;
      case "modelPins":
        setState({ modelPins: event.pins });
        return;
      case "customProviders":
        setState({ customProviders: event.providers });
        return;
      case "sessionOrders":
        setState({ sessionOrders: event.orders });
        return;
      case "workspaces":
        setState((s) => {
          const first = event.workspaces.find(isTopWorkspace)?.id ?? "";
          const panes = s.panes.map((p) => (p.kind === "draft" && p.workspaceId === "" && first ? { ...p, workspaceId: first } : p));
          return { workspaces: event.workspaces, panes, activeWorkspaceId: s.activeWorkspaceId ?? (first || null) };
        });
        return;
      case "agent":
        notifyOnStatusChange(state.agents.find((a) => a.id === event.agent.id), event.agent);
        setState((s) => ({
          agents: s.agents.some((a) => a.id === event.agent.id)
            ? s.agents.map((a) => (a.id === event.agent.id ? event.agent : a))
            : [...s.agents, event.agent],
        }));
        if (event.agent.assistant) readAssistant();
        return;
      case "showAgent": {
        if (EMBED || !state.agents.some((a) => a.id === event.agentId)) return;
        const shown = state.panes.find((p) => p.kind === "agent" && p.agentId === event.agentId);
        if (shown) focusPane(shown.id);
        else openAgent(event.agentId);
        return;
      }
      case "agentRemoved":
        setState((s) => {
          const panes = s.panes.map((p): Pane => {
            if (p.kind !== "agent" || p.agentId !== event.agentId) return p;
            const agent = s.agents.find((a) => a.id === event.agentId);
            return { id: p.id, kind: "draft", workspaceId: topWorkspaceId(agent?.workspaceId ?? null) ?? s.activeWorkspaceId ?? "" };
          });
          const tabs = s.tabs.some((t) => t.kind === "browser" && t.sharedWith === event.agentId) ? s.tabs.map((t) => (t.kind === "browser" && t.sharedWith === event.agentId ? { ...t, sharedWith: null } : t)) : s.tabs;
          const sides = dropSide(s.side, s.sideStash, event.agentId);
          return { agents: s.agents.filter((a) => a.id !== event.agentId), panes, tabs, side: sides.side, sideStash: sides.stash };
        });
        setState((s) => ({ sessionLayouts: dropSessionLayout(s.sessionLayouts, event.agentId), sessionTabFocus: dropTabFocus(s.sessionTabFocus, event.agentId) }));
        for (const tab of state.tabs.filter((t) => (t.kind === "pr" || t.kind === "chat") && t.agentId === event.agentId)) closeTab(tab.key, false);
        return;
      case "timelineUpsert":
        setState((s) => {
          const items = s.timelines[event.agentId];
          if (!items) return {};
          const index = items.findLastIndex((i) => i.id === event.item.id);
          const next = index === -1 ? [...items, event.item] : items.map((i, n) => (n === index ? event.item : i));
          return { timelines: { ...s.timelines, [event.agentId]: next } };
        });
        if (event.item.kind === "tool" && event.item.status === "done" && EDIT_TOOLS.has(event.item.name)) void refreshGit(event.agentId);
        return;
      case "timelineRemove":
        setState((s) => {
          const items = s.timelines[event.agentId];
          if (!items) return {};
          return { timelines: { ...s.timelines, [event.agentId]: items.filter((i) => i.id !== event.itemId) } };
        });
        return;
      case "meta":
        setState({ meta: event.meta });
        return;
      case "settings":
        setState((s) => ({ settings: event.settings, defaults: event.defaults ?? s.defaults }));
        reconcileLayoutSettings(event.settings, false);
        return;
      case "changes":
        setState((s) => ({ changes: { ...s.changes, [event.agentId]: event.changes } }));
        void refreshGit(event.agentId);
        return;
      case "workspaceChanged": {
        announceWorkspaceChanged(event.workspaceIds);
        refreshLoadedFiles(event.workspaceIds);
        const shown = new Set(state.panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : [])));
        for (const agent of state.agents) if (shown.has(agent.id) && agent.workspaceId && event.workspaceIds.includes(agent.workspaceId)) void refreshGit(agent.id);
        return;
      }
      case "diffFeedback":
        applyDiffFeedbackEvent(event);
        return;
      case "quick":
        setState((s) => (s.quick && s.quick.run?.id === event.run.id ? { quick: { ...s.quick, run: event.run } } : {}));
        return;
      case "side":
        setState((s) => {
          const next = applySideRun(s.side, s.sideStash, event.run);
          return next.side === s.side && next.stash === s.sideStash ? {} : { side: next.side, sideStash: next.stash };
        });
        return;
      case "feedback":
        setState((s) => ({ feedbacks: { ...s.feedbacks, [event.feedback.id]: event.feedback } }));
        if (state.agents.some((a) => a.id === event.feedback.agentId)) void refreshGit(event.feedback.agentId);
        return;
      case "reload":
        flushDrafts();
        if (!event.restarting) {
          if (event.immediate) setTimeout(reloadWindow, 200);
          else requestIdleReload(reloadWindow);
          return;
        }
        if (!window.agentNavNative?.readsWindowAfterDaemonRestart) reloadWhenDaemonReturns();
        return;
    }
  });
  rpc.connect();
}

import { useSyncExternalStore } from "react";
import { defaultChangeScope, harnessOf, HARNESS_VALUES, PERMISSION_MODE_VALUES } from "../shared/protocol";
import type { Agent, Board, BoardCard, ChangeScope, CodexMeta, Harness, InboxItem, InboxState, ChangedFile, CommandInfo, EffortLevel, ElementInfo, Feedback, FileChange, GitInfo, McpActionResult, Meta, PermissionMode, PullRequest, QuickRun, ResolvedDefaults, ScreenContext, Settings, ShellNote, SideRun, TimelineItem, Workspace } from "../shared/protocol";
import { announceWorkspaceChanged } from "./workspaceEvents";
import { cleanSlackText } from "../shared/inbox";
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
import { attachmentKey, dropDraftsOfMissing, dropStoredDraftsOfMissingPanes, flushDrafts, getDraft, loadStoredDrafts, restoreDrafts, setDraftStorage } from "./composerState";
import { applySideRun, dropSide, swapSide } from "./sideChats";
import { findDuplicate } from "./attachDedupe";
import { flashAttachment } from "./attachFlash";
import { WINDOW_ID, windowStorage } from "./windowStorage";
import { requestIdleReload } from "./idleReload";
import { collectExtras, forLaunch, loadHotExit, parseWindowState, pruneExtras, pruneTabState, restoreHandoffs, setPendingHot, setPendingRestore, snapshotHandoffs, WINDOW_STATE_KEY, WINDOW_STATE_VERSION, type WindowExtras } from "./windowState";
import { revealPinned, setPinnedDrawer, setPinnedSide } from "./pinnedPanel";
import { cacheChatDock, cacheLayoutSettings, cachePerSession, loadCachedChatDock, loadCachedDefaultLayout, loadCachedPerSession, loadCachedRemember, loadFloatRect, loadFocusedLayout, loadLastLayout, saveFloatRect, saveFocusedLayout, saveLastLayout } from "./layoutPrefs";
import { chatDockOf, parseDockWidth, type ChatDock } from "./focusLayout";
import { dropTabFocus, isShown, pruneTabFocus, sanitizeTabFocus, settleSessionTabs, shownAgentsOf, shownTabs, type TabFocus } from "./sessionTabs";
import { dropSessionLayout, layoutKeyOf, layoutPatch, planSwitch, pruneSessionLayouts, sameLayout, sanitizeSessionLayouts, sliceOf as layoutSliceOf, type SessionLayouts } from "./sessionLayout";
import { hint } from "./hint";
import type { ReviewState } from "../shared/morningReview"; // MORNINGREVIEW
import type { ReleaseState } from "../shared/release"; // RELEASE
import type { SessionOrders } from "../shared/sessionOrder"; // SESSIONORDER
import { receiveReview, refreshReview } from "./reviewActions";
import { holdEditorFocus, releaseEditorFocus } from "./editorFocusHold";
import { IDLE_RUN, sanitizeSearchView, type SearchRun, type SearchViewOptions } from "./searchViewModel";

export type FileTab = { key: string; kind: "file"; workspaceId: string; path: string; group?: string; preview?: boolean; sticky?: boolean };
// 이름 없는 새 탭(New Untitled Text File). 저장(⌘S)할 때 경로를 물어 파일 탭으로 바뀐다.
export type UntitledTab = { key: string; kind: "untitled"; workspaceId: string; n: number; group?: string; sticky?: boolean };
// 파일 하나의 diff 탭. path 는 절대 경로.
// scope 는 변경 목록이 이 탭을 열 때 보던 범위다(DiffTab 이 그 범위의 기준과 비교한다). 세션의 기본 범위이거나 다른 곳에서 열었으면 없다.
export type DiffTab = { key: string; kind: "diff"; agentId: string; workspaceId: string; path: string; scope?: ChangeScope; group?: string; preview?: boolean; sticky?: boolean };
// Browser 탭. url 은 마지막으로 연 주소(빈 문자열이면 아직 주소가 없는 빈 탭), title 은 페이지 제목.
// sharedWith 는 이 탭을 읽고 조작하도록 공유한 세션 id(Share with Agent). null 이면 공유 안 함. 옛 저장본에는 없다.
// partition 과 scope 는 탭을 만들 때 설정 Data Storage 로 정한 저장 범위다(바꿔도 열린 탭은 그대로). autoReload 는 이 탭의 Refresh Automatically(file: 주소일 때만 뜻이 있고, 없으면 설정 Auto Reload On File Change 를 따른다).
export type BrowserTab = { key: string; kind: "browser"; url: string; title: string; sharedWith?: string | null; partition?: string; scope?: EffectiveStorage; autoReload?: boolean; group?: string; sticky?: boolean };
export type SearchTab = { key: string; kind: "search"; workspaceId: string; query: string; details?: boolean; include?: string; seed?: Partial<SearchViewOptions>; autoRun?: boolean; group?: string; sticky?: boolean };
// FIX6B: Source Control 의 Open Changes 가 여는 diff 탭. 세션과 무관하게 저장소의 인덱스 기준으로 보인다(staged 는 HEAD 대 인덱스, changes 는 인덱스 대 작업 트리).
// path 는 절대 경로, rel 은 저장소 루트 기준 경로다. agentId 는 패널이 세션 폴더를 보고 있을 때만 있고 서버가 그 세션의 작업 폴더를 찾는 데 쓴다.
export type ScmDiffTab = { key: string; kind: "scm"; workspaceId: string; agentId?: string; path: string; rel: string; section: "staged" | "changes"; group?: string; preview?: boolean; sticky?: boolean };
export type ReplacePreviewTab = { key: string; kind: "replace"; workspaceId: string; path: string; group?: string; preview?: boolean; sticky?: boolean };
// PRLINK: Lodestar 의 PR 화면을 에디터 칸의 탭으로 연 것(대화 속 PR 링크). repo 는 "owner/name". 화면의 상태(탭, 고른 파일)는 web/prStore.ts 가 탭 키로 들고 있다.
// PRTABSESSION: agentId 는 이 탭이 붙은 세션(링크를 누른 대화)이다. 그 세션이 칸에 열려 있을 때만 탭줄에 보이고(web/sessionTabs.ts), 세션이 없는 화면에서 연 탭은 agentId 가 없어 어디서나 보인다.
// 같은 PR 을 두 세션에서 열면 탭이 둘이다(키 끝에 @세션 id).
export type PrViewTab = { key: string; kind: "pr"; repo: string; number: number; agentId?: string; group?: string; sticky?: boolean };
// 세션 대화를 에디터 칸의 탭으로 연 것(Editor 배치의 대화 패널 머리 Open Chat in Editor Tab). title 은 연 때의 세션 제목이고 탭줄은 지금 제목을 보인다.
export type ChatTab = { key: string; kind: "chat"; agentId: string; title: string; group?: string; sticky?: boolean };
export type Tab = FileTab | UntitledTab | DiffTab | BrowserTab | SearchTab | ScmDiffTab | ReplacePreviewTab | PrViewTab | ChatTab;

export type BrowserAction = "navigate" | "reload" | "zoomIn" | "zoomOut" | "zoomReset" | "find" | "favorite" | "addElement" | "commentElements" | "consoleLogs" | "areaScreenshot" | "share" | "screenshot" | "applyPreset" | "setUserAgent";
// url 은 navigate 의 주소, value 는 applyPreset 의 프리셋 이름과 setUserAgent 의 글이다.
export type BrowserActionRequest = { key: string; action: BrowserAction; url?: string; value?: string; nonce: number };

// endColumn 이 있으면(같은 줄) 열면서 column 부터 endColumn 앞까지를 선택한다(Search 뷰의 일치 행).
export type FileTarget = { workspaceId: string; path: string; line?: number; column?: number; endColumn?: number; search?: string };

export type ReferenceGroup = { workspaceId: string; path: string; hits: { line: number; column: number; text: string }[] };

export type LspStatus = "connecting" | "indexing" | "ready" | "error";

// 데몬이 알리는 언어 서버별 상태(server/lspMux.ts 의 $/lodestar/servers). 주 서버(TypeScript) 외에 Relay 같은 서버가 뜨고 실패하는 것을 상태 줄에 보인다.
export type LspServerState = { key: string; id: string; label: string; primary: boolean; state: "idle" | "starting" | "ready" | "failed"; dir: string | null; reason?: string };

// 보드 카드에서 시작한 새 세션 입력 화면의 시작값. nonce 가 바뀌면 입력 화면이 새로 만들어진다.
// cardId 가 null 이면 보드 카드와 무관한 시작이다(사이드바 폴더 메뉴의 New Session in Worktree).
export type DraftSeed = { cardId: string | null; worktreeBranch: string | null; nonce: number };

// 가운데 영역의 칸. 세션 하나 또는 새 세션 입력 화면. 입력 화면의 workspaceId 가 null 이면 폴더 없는 퀵 챗(B6-02), "" 는 아직 폴더를 모르는 상태.
export type Pane = { id: string; kind: "agent"; agentId: string } | { id: string; kind: "draft"; workspaceId: string | null; seed?: DraftSeed; handoff?: HandoffSeed };

// HANDOFF: 핸드오프로 열린 새 세션 화면의 출처. 위치 선택(같은 폴더, 같은 worktree, 새 worktree)과 모델, 권한 기본값이 이 세션을 따른다.
export type HandoffSeed = { agentId: string };

// B5: ⌘W 나 칸 X 로 치운 채팅. ⇧⌘T 가 최근 것부터 다시 연다(세션은 지워지지 않으므로 id 만 들고 있으면 된다).
export type ClosedPane = { agentId: string };
const CLOSED_PANES_MAX = 10;

// B3: session 이 있으면 다른 세션의 요약을 붙인 칩이다(path 는 그 세션 id, text 는 요약 글).
// note 가 있으면 메모장의 메모를 붙인 칩이다(path 는 그 메모 id, text 는 본문 전체. 세션 칩처럼 프롬프트에 글로 들어간다).
// browser 가 있으면 Browser 탭에서 붙인 요소나 페이지 칩이다(path 는 그 주소, 본문 글은 web/browserAttach.ts 가 만든다).
export type Attachment = { id: string; workspaceId: string | null; path: string; startLine: number | null; endLine: number | null; text: string | null; session?: { title: string }; note?: { title: string }; browser?: BrowserAttachment; handoff?: HandoffAttachment; image?: ImageAttachment; file?: FileAttachment };

// fixB: 입력창에 붙인 이미지. data 는 base64 원본(보낼 때 서버에 올린다), thumb 은 칩에 보일 작은 PNG data URL, path 는 파일 이름이다.
export type ImageAttachment = { mediaType: string; data: string; thumb: string; name: string; bytes: number; hash?: string };

// FILEATTACH: 입력창에 붙인 이미지가 아닌 파일. path 는 디스크의 절대 경로(Finder 에서 놓은 파일은 원래 경로, 경로를 모르면 업로드가 끝난 뒤의 데몬 저장 경로)다.
// status: uploading 은 업로드 폴백이 올리는 중(progress 0~1, 보내기가 막힌다), ready 는 보낼 수 있음, error 는 업로드 실패(지우고 다시 붙여야 한다). uploadId 는 데몬이 저장한 폴더 id 로, 칩을 지울 때 그 파일을 같이 지운다.
export type FileAttachment = { name: string; bytes: number; mediaType: string; path: string | null; status: "uploading" | "ready" | "error"; progress: number; uploadId: string | null; error?: string };

// HANDOFF: 인계 문서 칩. generating 이면 문서를 만드는 중이고(보내기가 막힌다), ready 가 되면 text 에 문서가, id 에 ~/.agent-nav/handoffs/<id>.md 의 id 가 들어 있다.
export type HandoffAttachment = { sourceId: string; title: string; status: "generating" | "ready"; id: string | null };

export type QuickState = {
  run: QuickRun | null;
  workspaceId: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  // 질문한 에디터 탭과 선택 영역(문서 위치). 창은 이 위치의 줄을 따라간다(위치는 web/quickAnchor.ts 의 필드가 문서 변경에 맞춰 옮긴다).
  tabKey: string;
  from: number;
  to: number;
  // 창 왼쪽 위 모서리가 그 줄 왼쪽 위(from 줄 윗변)에서 떨어진 거리(px). 처음 열 때 정하고 머리를 끌면 바뀐다. 모르면 null.
  rel: { dx: number; dy: number } | null;
};

// /btw 사이드 챗. 메인 세션 하나에 붙는다.
// B2: draft 는 대화에서 고른 글을 질문 입력에 채워 열 때(Ask in a Side Chat). nonce 가 바뀔 때마다 한 번 채운다.
export type SideState = { id: string; agentId: string; run: SideRun | null; model: string | null; draft?: { text: string; nonce: number } };

// dir 은 Files 트리의 Open in Integrated Terminal 이 정한 시작 폴더(작업 폴더 기준 상대 경로)다. 없으면 세션이나 작업 폴더에서 뜬다.
export type Terminal = { id: string; name: string; dir?: string };

// 피드백으로 집은 요소: 요소 정보, 화면 좌표, 스크린샷(PNG base64, Electron 에서만)
export type FeedbackTarget = {
  info: ElementInfo;
  rect: { x: number; y: number; width: number; height: number };
  screenshot: string | null;
  screenshotNote: string | null;
};

// FBNOEL: 피드백 입력 창이 열린 순간의 창 스크린샷(PNG base64)과 말풍선용 썸네일, 그때 화면 상태. 요소 고르기로 입력 창이 잠깐 닫혀도 글과 함께 남는다.
export type FeedbackDraft = {
  text: string;
  shot: { png: string; thumb: string } | null;
  shotOn: boolean;
  screen: ScreenContext;
};

// 창 상태 저장본(web/windowState.ts). 두 길이 같은 형태를 쓴다.
// 1. Reload Window, 피드백 반영: pagehide 가 sessionStorage 에 맡기고 다음 읽기가 한 번 꺼낸다. 배치(layoutMode)까지 그대로 따른다.
// 2. 앱을 껐다 켬: 상태가 바뀔 때마다(짧은 지연 뒤) localStorage 에 남기고, 새로 켤 때 읽는다. 읽어도 지우지 않는다(다음 저장이 덮는다). 배치는 Settings 가 정한다.
const RELOAD_KEY = "agent-nav:reload";
type ReloadSnapshot = Pick<State, "panes" | "activePaneId" | "activeWorkspaceId" | "tabs" | "filesIndex" | "activeTabKey" | "sidebarOpen" | "rightOpen" | "bottomOpen" | "centerView" | "selectedCardId" | "grid" | "editorLayout" | "activeGroupId" | "groupActive" | "layoutMode" | "floatCollapsed" | "sideTabKey" | "mainEditorKey" | "focusSideOpen" | "chatDockOpen" | "chatDockWidth" | "searchView">;
// PERLAYOUT: sessionLayouts 는 세션별로 기억한 배치. 저장본 최상위에 실리고 읽을 때 sanitizeSessionLayouts 가 거른다.
// PRTABSESSION: sessionTabFocus 는 세션이 화면에서 떠날 때 그 세션 PR 탭을 보던 그룹과 탭(web/sessionTabs.ts). 저장본 최상위에 실린다.
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
    // sessionStorage 가 막혀도 아래 저장본을 본다
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
  // 이름 없는 탭은 내용이 메모리에만 있다. 내용이 있는 탭만 남기고(내용은 hot exit 보관소가 갖는다), 빈 탭은 복원하지 않는다.
  const kept = tabs.filter((t) => (t.kind !== "untitled" || state.dirtyTabs[t.key]) && t.kind !== "replace");
  const extras = collectExtras({ tabKeys: new Set(kept.map((t) => t.key)), agentIds: new Set(panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : []))) }, { drafts: {}, panelWidths, handoffs: snapshotHandoffs(Object.fromEntries(Object.entries(state.attachments).filter(([key]) => !key.startsWith("new:") || panes.some((p) => p.id === key.slice(4))))) });
  return JSON.stringify({ version: WINDOW_STATE_VERSION, panes, activePaneId, activeWorkspaceId, tabs: kept, filesIndex: Math.min(filesIndex, mainTabs(kept).length), activeTabKey, sidebarOpen, rightOpen, bottomOpen, centerView, selectedCardId, grid, editorLayout, activeGroupId, groupActive, layoutMode, floatCollapsed, sideTabKey, mainEditorKey, focusSideOpen, chatDockOpen, chatDockWidth, sessionLayouts, sessionTabFocus, searchView, extras });
}

// 상태가 바뀔 때마다 부르는 저장(localStorage 만). 창을 닫기 전에 못 쓰고 끝나는 경우(강제 종료)를 줄인다.
export function persistWindowState() {
  if (EMBED) return;
  try {
    windowStorage()?.setItem(WINDOW_STATE_KEY, buildWindowSnapshot());
  } catch {
    // 저장이 막혀도 화면은 그대로 동작한다
  }
}

// 창을 다시 읽어도(피드백 반영, ⌘R) 칸과 탭 순서, 에디터 그룹 배치가 이어지도록 sessionStorage 에 맡긴다. 같은 내용을 앱 재시작용 저장본에도 쓴다.
export function saveReloadSnapshot() {
  flushDrafts();
  try {
    const json = buildWindowSnapshot();
    sessionStorage.setItem(RELOAD_KEY, json);
    windowStorage()?.setItem(WINDOW_STATE_KEY, json);
  } catch {
    // 저장이 막혀도 다시 읽기는 한다
  }
}
// 복원한 탭 중 지워진 폴더, 세션, 파일을 가리키는 것을 조용히 뺀다(알림 없음). 지워진 세션을 가리키던 칸은 위 목록 처리에서 새 세션 칸이 된다.
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
    // PERLAYOUT: 지워진 세션이 기억해 둔 배치도 같이 정리한다
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

// 브라우저로 붙은 창: 데몬이 재시작하면 소켓이 끊겼다가 새 데몬에 다시 이어진다. 끊김을 한 번 본 뒤 이어졌을 때 읽는다.
// 재시작 알림을 보낸 옛 데몬은 종료되는 동안에도 응답하므로, 응답 여부만으로는 새 데몬이 떴는지 알 수 없다.
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

// 끌어서 바꾼 패널 크기(px). null 이면 CSS 기본값(사이드바 size-sidebar, 오른쪽 54%, 아래 240px).
// 세션 격자의 칸 폭과 행 높이 비율은 B5 의 state.grid 가 가진다(칸 구조와 함께 움직이기 때문).
// 오른쪽 패널 폭은 여기 없다: 세션마다 따로 state.panelWidths 에 두고, 창 상태 저장본(web/windowState.ts)에 실려 앱을 다시 켜도 돌아온다.
// 멘션 화면과 보드 화면이 목록 옆에 두는 상세 칸의 폭은 세션 오른쪽 패널과 따로 기억한다.
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

// CODEX: harness 는 새 세션 화면의 Claude, Codex 선택. codexModel 과 codexEffort 는 Codex 쪽 마지막 선택(Claude 의 model, effort 와 섞이지 않게 따로 둔다).
export type LastPicked = { model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionMode; harness?: Harness; codexModel?: string | null; codexEffort?: EffortLevel | null };
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
    return last;
  } catch {
    return {};
  }
}

// 모델이나 effort 를 고르면 기억해 두었다가 다음 새 세션 화면과 퀵 챗이 이어받는다. forget 은 Settings 의 Reset.
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
    // 저장이 막힌 환경에서는 이번 실행 동안만 이어받는다
  }
}

// B6: 세션 검색의 recently opened. openAgent 가 쌓고 localStorage 에 남겨 다시 열어도 이어진다.
// CTRLTAB: ⌃Tab 세션 전환 창(web/sessionSwitcher.ts)도 이 목록을 최근 포커스 순서로 쓴다. 전환 창이 12개를 보여서 10에서 12로 늘렸다.
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
    // 저장이 막힌 환경에서는 세션 동안만 유지
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
    // 저장이 막힌 환경에서는 세션 동안만 유지
  }
}
function rememberRecentFile(file: RecentFile) {
  saveRecentFiles([file, ...state.recentFiles.filter((f) => !(f.workspaceId === file.workspaceId && f.path === file.path))].slice(0, RECENT_FILES_MAX));
}
// QUICKOPEN: 빠른 열기의 "Remove from Recently Opened"
export function forgetRecentFile(file: RecentFile) {
  saveRecentFiles(state.recentFiles.filter((f) => !(f.workspaceId === file.workspaceId && f.path === file.path)));
}

export type Overlay =
  | { kind: "quickOpen" }
  // QUICKOPEN: 빠른 열기에서 "@" 로 넘어올 때는 그 뒤의 글자가 query 로 온다
  | { kind: "symbols"; query?: string }
  | { kind: "models" }
  | { kind: "effort" }
  // 세션 선택(⌃⌥R, 제목줄 칩)은 통합 검색을 Sessions 탭으로 연 것이다.
  | { kind: "sessions" }
  // 통합 검색(⌘K). tab 은 처음 고른 탭(없으면 All)
  | { kind: "search"; tab?: SearchScope }
  // B6: 명령 팔레트(⇧⌘P). query 는 처음 채울 입력(">" 로 시작)
  | { kind: "commands"; query?: string }
  // FIX6C: 키보드 단축키 목록(⌘K ⌘S)
  | { kind: "shortcuts" }
  // section 이 있으면 그 구역으로 스크롤해서 연다(Browser 탭 `...` 의 Browser Settings 는 "browser").
  | { kind: "status"; section?: "browser" | "import" | "format" | "mentions" }
  // Browser 탭의 History, Site Permissions, 기기 프리셋, 사용자 에이전트 빠른 선택창. tabKey 는 결과를 받을 탭이다.
  | { kind: "browserHistory"; tabKey: string }
  | { kind: "sitePermissions"; url: string }
  | { kind: "devicePresets"; tabKey: string }
  | { kind: "userAgent"; tabKey: string; value: string }
  // G8: 기기 선택창(USB, 시리얼, HID, 블루투스)과 에이전트가 묻는 "공유할 탭 고르기". request 는 메인이 갱신할 때마다 바뀐다.
  | { kind: "device"; request: DeviceRequest }
  | { kind: "choice"; id: string }
  // EDPARITY(C): 줄로 이동(⌃G), 파일 안 심볼로 이동(⇧⌘O), 상태 표시줄 선택 목록. tabKey 는 대상 에디터 탭이다(입력창이 포커스를 가져가기 전에 정한다).
  | { kind: "gotoLine"; tabKey: string | null }
  | { kind: "gotoSymbol"; tabKey: string | null }
  | { kind: "editorPick"; id: string }
  | { kind: "customizeLayout" }
  | null;

// 오른쪽 패널의 탭: "changes" 는 항상 첫 탭, "card" 는 세션 화면에서 연 보드 카드 상세(열린 카드가 있을 때만), 나머지는 파일과 diff 탭.
export type RightTab = "changes" | "card" | string;

// 가운데 영역에 무엇을 보이는지. 보드로 바꿔도 세션 칸은 그대로 두었다가 돌아오면 이어서 보인다.
export type CenterView = "sessions" | "board" | "inbox" | "pr" | "improvements" | "notion" | "notes" | "skills"; // NOTION2, NOTES, SKILLS

// 설정 패널과 Inbox 가 같이 보는 MCP 동작 상태. busy 는 서버 이름별로 지금 도는 동작, note 는 마지막 결과 한 줄.
export type McpBusy = "reconnect" | "enable" | "disable";
export type McpNote = { ok: boolean; text: string };

export type State = {
  connected: boolean;
  workspaces: Workspace[];
  agents: Agent[];
  timelines: Record<string, TimelineItem[]>;
  files: Record<string, string[]>;
  localCommands: Record<string, CommandInfo[]>;
  // 파일이 하나도 없는 폴더(git ls-files 에는 안 보인다). Files 트리가 그린다.
  emptyDirs: Record<string, string[]>;
  meta: Meta | null;
  metaRefreshing: boolean;
  mcpBusy: Record<string, McpBusy>;
  mcpNotes: Record<string, McpNote>;
  settings: Settings | null;
  // 사이드바에서 손으로 정한 세션 순서(scope 별 id 목록, shared/sessionOrder.ts). 데몬이 sessionOrders 이벤트로 모든 화면에 같은 값을 보낸다.
  sessionOrders: SessionOrders;
  defaults: ResolvedDefaults | null;
  // 덩어리 "유지" 로 앞당긴 기준 (없으면 git 기준)
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
  // fixQ1: Source Control 의 커밋 메시지 입력으로 포커스를 옮기라는 요청 시각(ms). 입력이 마운트되어 있지 않으면 잠깐 기다렸다가 버려진다.
  focusScmMessage: number | null;
  // FINDINFILES: 왼쪽 사이드바(Chat 중심에서는 오른쪽 패널)의 Search 뷰. searchView 는 검색어와 옵션(창 상태 저장본에 실린다), searchRun 은 마지막 검색 결과(저장하지 않는다).
  // focusSearchInput 은 검색 입력으로 포커스를 옮기고 글을 전체 선택하라는 요청 시각(ms)이다. 입력이 읽으면 null 로 되돌린다.
  searchView: SearchViewOptions;
  searchRun: SearchRun;
  focusSearchInput: number | null;
  // B5: 격자 구조(행과 열), 닫은 채팅 기록(⇧⌘T), 세션 이동 기록(⌃-), 입력창에 보내는 동작 요청(⌘/ 첨부 선택창 등)
  grid: Grid;
  closedPanes: ClosedPane[];
  sessionHistory: { back: string[]; forward: string[] };
  composerAction: { paneId: string; action: "attachMenu"; nonce: number } | null;
  lastPicked: LastPicked;
  draftModel: Record<string, string | null>;
  // CODEX: 새 세션 화면(칸)마다 고른 도구. 없으면 마지막으로 고른 값(lastPicked.harness), 그것도 없으면 claude.
  draftHarness: Record<string, Harness>;
  // CODEX: Codex 앱 서버에서 읽은 모델 목록과 로그인 상태. Codex 를 고르거나 Codex 세션을 열면 한 번 읽는다.
  codexMeta: CodexMeta | null;
  draftEffort: Record<string, Settings["defaultEffort"]>;
  // permbug: 새 세션 화면(칸)마다 이번에 고른 권한 모드. 없으면 draftDefaults 가 정한다.
  draftPermission: Record<string, PermissionMode>;
  tabs: Tab[];
  // tabs 의 앞 filesIndex 개는 변경 탭과 파일 탭 사이에 있다(web/tabOrder.ts).
  filesIndex: number;
  // 활성 탭은 활성 그룹의 것이다. 다른 그룹이 가진 활성 탭은 groupActive 에 있다(활성 그룹의 값은 쓰지 않는다).
  activeTabKey: RightTab | null;
  // B7: 에디터 그룹 배치(분할 트리). 나뉘지 않았으면 main 그룹 하나다.
  editorLayout: EditorLayout;
  activeGroupId: string;
  groupActive: Record<string, string | null>;
  // 최대화한 에디터 그룹(Toggle Maximize Editor Group). 다른 그룹은 접힌다. 저장하지 않는다.
  maximizedGroup: string | null;
  // 저장 안 한 변경이 있는 탭(web/editorDocs.ts 가 갱신)
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
  // ts7: 워크스페이스 TypeScript 대신 번들 TypeScript 로 돌아왔을 때의 상태 줄 표시와 이유(server/lsp.ts 의 $/lodestar/serverInfo)
  lspFallback: Record<string, { label: string; reason: string }>;
  lspServers: Record<string, LspServerState[]>;
  toast: string | null;
  feedbackMode: "off" | "compose";
  // 요소 고르기. compose 와 함께 켜진다(web/feedbackFlow.ts)
  feedbackPicking: boolean;
  feedbackTarget: FeedbackTarget | null;
  feedbackDraft: FeedbackDraft | null;
  feedbacks: Record<string, Feedback>;
  references: { title: string; groups: ReferenceGroup[] } | null;
  overlay: Overlay;
  // Browser 탭에 보내는 요청 한 건(메뉴, 단축키, 팔레트, 빠른 선택창이 같은 길로 보낸다). nonce 가 바뀔 때마다 해당 탭이 한 번 처리한다.
  browserAction: BrowserActionRequest | null;
  quickOpenQuery: string;
  // B6: 최근에 연 세션 id(최근 것이 앞). 세션 검색의 recently opened 구역
  recentAgentIds: string[];
  recentFiles: RecentFile[];
  quick: QuickState | null;
  side: SideState | null;
  // C: 지금 보지 않는 세션의 곁다리(세션 id 별). 그 세션으로 돌아오면 side 로 되살린다(web/sideChats.ts).
  sideStash: Record<string, SideState>;
  pendingReveal: Record<string, FileTarget>;
  layout: Layout;
  // 오른쪽 패널을 끌거나 변경 칩으로 넓힌 폭(px). 세션(또는 새 세션 화면 칸)마다 따로, 이 실행 동안만 기억한다. 없으면 좁은 기본 폭.
  panelWidths: Record<string, number>;
  // 칸반 보드. 옛 데몬이 board.get 을 모르면 null 로 남는다.
  board: Board | null;
  centerView: CenterView;
  // 세션 오른쪽 패널의 Card 탭이 보이는 카드(세션 화면에서 연 것)
  selectedCardId: string | null;
  // 보드 화면이 자기 상세 칸에 보이는 카드. 세션 오른쪽 패널과 상관없다.
  boardCardId: string | null;
  // 보드 카드의 Start Session 이 새 세션 입력창에 채워 둘 글. nonce 가 바뀔 때 한 번 채운다.
  // append 면 입력창에 쓰던 글이 있을 때 덮지 않고 뒤에 붙인다(큐의 Edit).
  composerPrefill: Record<string, { text: string; nonce: number; append?: boolean }>;
  // Slack Inbox. 옛 데몬이 inbox.get 을 모르면 null. selectedInboxId 는 멘션 화면의 상세 칸에 보이는 항목이다.
  inbox: InboxState | null;
  // MORNINGREVIEW: 아침 리뷰(최근 7일)와 만드는 중인지. 옛 데몬이 review.get 을 모르면 null 로 남아 영역을 그리지 않는다.
  review: ReviewState | null;
  // RELEASE: 설치된 버전과 데몬이 마지막으로 확인한 최신 릴리스. 옛 데몬이 release.get 을 모르면 null.
  release: ReleaseState | null;
  selectedInboxId: string | null;
  // IMPROVE: Improvements 화면의 상세 칸에 보이는 피드백 id
  selectedFeedbackId: string | null;
  // FLOAT: 배치 모드. editor 면 에디터 그룹이 가운데 전체를 쓰고 활성 칸의 대화가 오른쪽 아래 떠 있는 창으로 간다(칸과 격자는 그대로).
  // editor 일 때 activeTabKey 는 늘 가운데 에디터 탭이고, 오른쪽 패널이 보이는 고정 탭(changes, files, card)은 sideTabKey 에 있다(web/floatLayout.ts normalizeTabs).
  layoutMode: LayoutMode;
  floatCollapsed: boolean;
  // 떠 있는 창의 자리와 크기. null 이면 기본 자리(오른쪽 아래). localStorage 에 남는다.
  floatRect: FloatRect | null;
  sideTabKey: string;
  mainEditorKey: string | null;
  // 이번 실행에서 사용자가 배치를 직접 바꿨다. 켜져 있으면 늦게 도착한 Settings 가 모드를 덮지 않는다.
  layoutTouched: boolean;
  // PERLAYOUT: 세션 id 별로 기억한 배치(web/sessionLayout.ts). setState 가 세션이 바뀔 때 되살리고 배치가 바뀔 때 갱신한다.
  sessionLayouts: SessionLayouts;
  // PRTABSESSION: 세션이 화면에서 떠날 때 그 세션의 PR 탭을 보던 그룹과 탭. 돌아오면 그 탭을 다시 활성으로 한다.
  sessionTabFocus: TabFocus;
  // FOCUS: Editor 중심(포커스 모드)의 구성. 왼쪽 Activity Bar 옆 Primary Side Bar 가 열려 있는지, 고른 뷰는 sideTabKey 다.
  // Changes, Files, Source Control 을 열라는 요청은 Chat 중심에서는 rightOpen 을, Editor 중심에서는 이 값을 연다(settleLayout). 두 배치가 서로의 패널 상태를 건드리지 않는다.
  focusSideOpen: boolean;
  // FOCUS: 오른쪽에 도킹한 대화 패널의 열림과 폭(null 이면 기본 폭). chatDock 이 docked 일 때만 뜻이 있다.
  chatDockOpen: boolean;
  chatDockWidth: number | null;
  // FOCUS: Settings 의 Chat in editor layout. docked 는 오른쪽 패널, floating 은 떠 있는 창
  chatDock: ChatDock;
};

let paneSeq = 0;
export const newPaneId = () => `pane-${++paneSeq}`;

const restored = takeRestoredWindow();
if (restored) {
  setPendingRestore(restored.extras);
  // FIX6A: 지난번에 저장 안 한 채 닫은 에디터 내용. 에디터가 문서를 붙일 때 받아 가 더러운 탭으로 되살린다.
  setPendingHot(loadHotExit());
  // 옛 저장본에 실려 있던 초안을 먼저 넣는다(저장소로 옮겨 쓴다).
  restoreDrafts(restored.extras.drafts);
}
// 입력창 초안은 창 상태 저장본과 따로 저장소에 있다(web/composerState.ts). 저장본이 없어도 돌아오고, 칸이 사라진 새 세션 초안은 지운다. 확장 안 화면은 저장하지 않는다.
if (EMBED) setDraftStorage(null);
else {
  restoreDrafts(loadStoredDrafts());
  dropStoredDraftsOfMissingPanes(new Set((restored?.panes ?? []).map((p) => p.id)));
}
// New Window 로 막 연 빈 창(저장본 없는 데스크톱 창)은 새 세션 화면의 폴더 목록을 한 번 펼쳐 프로젝트부터 고르게 한다.
let pickFolderOnStart = !EMBED && WINDOW_ID !== null && !restored;
export function takePickFolderOnStart(): boolean {
  const pick = pickFolderOnStart;
  pickFolderOnStart = false;
  return pick;
}
const restoredTabs = sanitizeRestoredTabs(restored);
// 저장해 둔 칸 id 와 겹치지 않게 번호를 이어 간다.
for (const pane of restored?.panes ?? []) paneSeq = Math.max(paneSeq, Number(pane.id.replace("pane-", "")) || 0);
const firstPane = newPaneId();

// FLOAT: 시작 모드. Settings 는 데몬에서 늦게 오므로 지난번에 받은 값(layoutPrefs)으로 첫 화면을 그리고, 도착하면 reconcileLayoutSettings 가 한 번 맞춘다.
const restoredLayout: LayoutMode | null = isLayoutMode(restored?.layoutMode) ? (restored?.layoutMode ?? null) : null;
// NEWWIN: New Window 로 연 빈 창은 Settings 의 Default layout 대신 그 창을 연(앞에 있던) 창의 배치로 시작한다.
const openerLayout: LayoutMode | null = pickFolderOnStart ? loadFocusedLayout() : null;
const startLayout: LayoutMode = EMBED ? "chat" : startingMode({ restored: restoredLayout ?? openerLayout,defaultLayout: loadCachedDefaultLayout(), remember: loadCachedRemember(), last: loadLastLayout() });

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
  codexMeta: null,
  draftEffort: {},
  draftPermission: {},
  tabs: restored?.tabs ?? [],
  filesIndex: Math.min(restored?.filesIndex ?? 0, mainTabs(restored?.tabs ?? []).length),
  // 저장된 값에 남은 옛 "inbox" 탭 키는 걸러낸다(멘션 상세는 이제 멘션 화면 안에서 열린다).
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
  release: null,
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
  chatDockOpen: restored?.chatDockOpen !== false,
  chatDockWidth: parseDockWidth(restored?.chatDockWidth),
  chatDock: loadCachedChatDock(),
};

// PERLAYOUT: 앱을 다시 켰을 때 처음 보이는 세션이 기억해 둔 배치가 있으면 Settings 의 Default layout 보다 앞선다.
const launchLayout = state.sessionLayouts[layoutKeyOf(state) ?? ""] ?? null;
if (launchLayout) state = { ...state, ...layoutPatch(launchLayout, { activeTabKey: state.activeTabKey, tabKeys: state.tabs.map((t) => t.key), hasCard: !!state.selectedCardId }) };

state = { ...state, grid: reconcileGrid(state.grid, state.panes.map((p) => p.id), null) };
state = sanitizeEditorGroups(state);
state = settleTabs({ ...state, layoutMode: "chat" }, state);

const listeners = new Set<() => void>();

// 그룹별 탭 최근 활성 순서. 탭을 닫을 때 직전에 보던 탭으로 돌아가는 데만 쓰므로 다시 읽으면 비어도 된다(이웃 탭으로 대신한다).
let tabMru: TabMru = {};
// 그룹의 탭 최근 활성 순서(가장 최근이 뒤). Ctrl+Tab 탭 전환 화면이 쓴다.
export const mruOf = (group: string): readonly string[] => tabMru[group] ?? [];

// NEWWIN: 앞에 있는 창이 자기 배치를 적어 둔다. 창이 앞으로 올 때와 앞에 있는 동안 배치가 바뀔 때 적는다.
if (!EMBED && WINDOW_ID !== null && typeof window !== "undefined") {
  let notedLayout: LayoutMode | null = null;
  const noteFocusedLayout = () => {
    if (!document.hasFocus()) return;
    notedLayout = state.layoutMode;
    saveFocusedLayout(state.layoutMode);
  };
  window.addEventListener("focus", noteFocusedLayout);
  listeners.add(() => {
    if (state.layoutMode !== notedLayout) noteFocusedLayout();
  });
}

// 닫는 탭 대신 활성이 될 탭: 그 그룹에서 직전에 활성이던 탭, 없으면 이웃 탭, 그것도 없으면 main 은 오른쪽 패널이 보던 고정 탭.
// Chat 중심에서 마지막 에디터 탭을 닫으면 고정 칸이 보이던 Changes 또는 Files 로 돌아간다. Editor 중심에서는 고정 탭이 가운데에 보일 수 없어 normalizeTabs 가 에디터 쪽으로 되돌린다.
function activeAfterClose(s: State, group: string, key: string, siblings: readonly string[]): string | null {
  return pickAfterClose(tabMru, group, key, siblings, group === MAIN_GROUP ? sideKeyOf(s.sideTabKey, !!s.selectedCardId) : null);
}

// PRTABSESSION: 보이지 않는 세션의 PR 탭이 활성인 그룹을 보이는 탭으로 옮긴다. 다시 읽어 복원한 값도 여기서 맞춘다.
// 세션이 칸에서 사라지고 나타나는 순간에 떠나는 세션의 탭을 기억하고 돌아온 세션의 탭을 되살리는 일도 같이 한다(web/sessionTabs.ts settleSessionTabs).
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
    // 이번 갱신이 활성 탭을 직접 정했으면(탭을 열거나 누름) 돌아온 세션의 탭으로 덮어쓰지 않는다
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

// 같은 파일의 탭이 여러 그룹에 있을 때(키 끝의 #번호) 그 파일의 탭을 모두 닫는다(변경을 되돌린 뒤 diff 탭 정리).
export function closeTabsLike(key: string) {
  for (const tab of state.tabs.filter((t) => baseKeyOf(t.key) === key)) closeTab(tab.key);
}

export function setState(patch: Partial<State> | ((prev: State) => Partial<State>)) {
  const prev = state;
  let applied = typeof patch === "function" ? patch(state) : patch;
  // 바뀐 것이 없으면 구독자를 깨우지 않는다. 안 연 세션의 타임라인 갱신(timelineUpsert 가 {} 를 돌려준다)이 가장 흔한 경우라, 깨우면 응답이 흐르는 동안 화면 전체의 선택자가 이벤트마다 다시 돈다(PERF2).
  if (Object.keys(applied).length === 0) return;
  // 숨겨진 화면(Board, Slack)은 어느 길로 열려 해도, 저장돼 있던 창을 다시 읽어도 세션 화면으로 돌린다. 설정을 아직 못 읽었으면 판정하지 않는다(App 이 그린 뒤에야 판정한다).
  if ("settings" in applied || "centerView" in applied) {
    const next = { ...state, ...applied };
    if (next.settings && centerViewHidden(next.centerView, next.settings)) applied = { ...applied, centerView: "sessions" };
  }
  // 응답이 흐르는 동안 가장 자주 오는 갱신(타임라인 항목 하나)은 배치, 탭, 칸에 아무 영향이 없다. 아래 배치 보정을 전부 건너뛴다.
  if (isTimelineOnly(applied)) {
    state = { ...state, ...applied };
    for (const listener of listeners) listener();
    return;
  }
  state = { ...state, ...applied };
  state = routeFocusPanels(prev, state, applied);
  // PERLAYOUT: 보는 세션이 바뀌면 그 세션의 배치를 같은 갱신 안에서 되살린다(두 번 그리지 않아 깜빡임이 없다). 아래 settleLayout 이 되살린 모드를 보고 탭을 맞춘다.
  state = rememberSessionLayout(prev, state);
  // PRTABSESSION: 세션이 칸에서 사라지거나 나타나면 그 세션 PR 탭의 활성 상태를 맞춘다(settleLayout 이 되살린 활성 탭을 보고 탭을 맞추도록 그 앞에서).
  state = settleOwnedTabs(prev, state, applied);
  // FLOAT: editor 배치에서 고정 탭과 에디터 탭을 가르고, 에디터 탭을 열 때 오른쪽 패널을 따라 열지 않는다.
  state = settleLayout(prev, state, applied);
  // B7: 활성 탭을 다른 그룹의 탭으로 바꾸면(탭을 열거나 누르는 모든 길) 그 그룹이 활성 그룹이 된다. 떠나는 그룹의 활성 탭은 groupActive 에 남긴다.
  // 활성 탭이 null 이면(보이는 탭이 없는 분할 그룹) 그룹은 그대로다
  if (state.activeTabKey !== null && state.activeTabKey !== prev.activeTabKey && state.activeGroupId === prev.activeGroupId) {
    const group = groupOfKey(state.tabs, state.activeTabKey);
    if (group !== state.activeGroupId && hasGroup(state.editorLayout, group)) state = { ...state, activeGroupId: group, groupActive: { ...state.groupActive, [prev.activeGroupId]: prev.activeTabKey } };
  }
  if (state.activeTabKey !== prev.activeTabKey || state.activeGroupId !== prev.activeGroupId) tabMru = noteActive(tabMru, { group: prev.activeGroupId, key: prev.activeTabKey }, { group: state.activeGroupId, key: state.activeTabKey });
  // C: 보는 세션이 바뀌면 곁다리 대화도 그 세션 것으로 바뀐다(openSide 처럼 이 갱신이 side 를 직접 정한 경우는 건드리지 않는다).
  if (!("side" in applied) && (state.panes !== prev.panes || state.activePaneId !== prev.activePaneId || state.agents !== prev.agents)) {
    const from = activeAgentOf(prev.panes, prev.activePaneId, prev.agents)?.id ?? null;
    const to = activeAgentOf(state.panes, state.activePaneId, state.agents)?.id ?? null;
    if (from !== to && (state.side || Object.keys(state.sideStash).length)) {
      const swapped = swapSide(state.side, state.sideStash, from, to);
      state = { ...state, side: swapped.side, sideStash: swapped.stash };
    }
  }
  // B5: 칸 목록이 바뀌면 격자 구조를 맞춘다. 새 칸은 바뀌기 전 활성 칸 오른쪽에 들어온다.
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

// --- FLOAT: 배치 모드 ---

function sliceOf(s: State): TabSlice {
  return { layoutMode: s.layoutMode, activeTabKey: s.activeTabKey, sideTabKey: s.sideTabKey, mainEditorKey: s.mainEditorKey, groupActive: s.groupActive, tabKeys: shownTabsOf(s).map((t) => t.key), mainKeys: mainTabs(shownTabsOf(s)).map((t) => t.key) };
}

function settleTabs(prev: State, next: State): State {
  const out = normalizeTabs(sliceOf(prev), sliceOf(next));
  if (out.activeTabKey === next.activeTabKey && out.sideTabKey === next.sideTabKey && out.mainEditorKey === next.mainEditorKey && out.groupActive === next.groupActive) return next;
  return { ...next, activeTabKey: out.activeTabKey, sideTabKey: out.sideTabKey, mainEditorKey: out.mainEditorKey, groupActive: out.groupActive };
}

// PERLAYOUT: Settings 가 도착하기 전에는 지난번에 받은 값을 쓴다. 자동으로 되살린 값은 사용자가 고른 것이 아니라서 마지막 배치 캐시(saveLastLayout)와 떠 있는 창 자리 캐시(saveFloatRect)는 건드리지 않는다.
let perSessionOn = loadCachedPerSession();

// 칸이 둘 이상이면 화면 배치를 칸들이 나눠 쓰므로 첫째 칸의 세션이 정한다. 칸을 오가도 배치가 바뀌지 않는다.
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
  if (plan.apply && !sameLayout(plan.apply, layoutSliceOf(out))) {
    // Editor 중심의 떠 있는 대화 창 크기와 도킹한 대화 패널 폭은 세션을 바꿔도 지금 값을 그대로 둔다(열림과 배치 모드만 세션마다 되살린다).
    const { floatRect: _rect, chatDockWidth: _dock, ...patch } = layoutPatch(plan.apply, { activeTabKey: out.activeTabKey, tabKeys: out.tabs.map((t) => t.key), hasCard: !!out.selectedCardId });
    out = { ...out, ...patch, ...(patch.layoutMode !== out.layoutMode ? { layoutTouched: true } : {}) };
  }
  return out;
}

// FOCUS: editor 배치에는 오른쪽 패널이 없고 그 자리를 왼쪽 사이드바(Activity Bar)가 맡는다. rightOpen 은 Chat 배치의 값이라 editor 배치에서는 바뀌지 않게 되돌린다.
// 에디터 탭을 열면서 오른쪽 패널까지 열라는 패치(openFile, openDiff, openBrowser 등)는 사이드바를 열지 않는다.
// 고정 탭(openChanges, openSourceControl, 카드)이나 참조 목록을 열라는 패치는 사이드바를 연다. 세션별 기억(rememberSessionLayout)이 되돌리기 전 값을 적지 않도록 그 앞에서 부른다.
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
  // Chat 중심에서 첫 에디터 탭이 열려 고정 칸이 옆으로 갈라질 때 사용자가 끌어 둔 패널 폭이 둘을 다 못 담으면, 트리가 서랍 뒤로 숨지 않게 둘이 들어갈 폭으로 넓힌다
  if (out.layoutMode !== "editor" && shownTabsOf(prev).length === 0 && shownTabsOf(out).length > 0) {
    const key = panelWidthKey(out);
    const saved = out.panelWidths[key];
    if (saved !== undefined && saved < PINNED_FIT) out = { ...out, panelWidths: { ...out.panelWidths, [key]: PINNED_FIT } };
  }
  // Chat 중심에서 에디터와 고정 칸이 나뉘어 있을 때 Changes 나 Files 를 고르는 요청이 오면 접힌 고정 칸을 편다(서랍이면 연다)
  if (out.layoutMode !== "editor" && shownTabsOf(out).length > 0 && out.tabs === prev.tabs && applied.activeTabKey != null && isPinnedTab(applied.activeTabKey)) revealPinned();
  return out;
}

// 배치 모드를 바꾼다. Editor 로 가면 떠 있는 창을 펼쳐 보인다. 쓰는 중 바꾼 값은 Remember last layout 이 켜져 있을 때만 다음 실행에 쓰인다.
export function setLayoutMode(mode: LayoutMode) {
  if (EMBED || state.layoutMode === mode) return;
  // FOCUS: Editor 로 가면 대화가 보이는 쪽(떠 있는 창을 펼치거나 오른쪽 패널을 연다). 왼쪽 사이드바와 Chat 의 오른쪽 패널은 각자의 열림을 그대로 둔다.
  setState({ layoutMode: mode, layoutTouched: true, ...(mode === "editor" ? { floatCollapsed: false, chatDockOpen: true } : {}) });
  saveLastLayout(mode);
}

export function toggleLayoutMode() {
  setLayoutMode(state.layoutMode === "chat" ? "editor" : "chat");
}

export function setFloatCollapsed(collapsed: boolean) {
  if (state.floatCollapsed !== collapsed) setState({ floatCollapsed: collapsed });
}

// FOCUS: Editor 배치에서 숨은 대화를 보이게 한다(떠 있는 창은 펼치고, 도킹한 패널은 연다). Chat 배치에서는 할 일이 없다.
export function revealChat() {
  if (state.layoutMode !== "editor") return;
  if (state.chatDock === "floating") setFloatCollapsed(false);
  else setChatDockOpen(true);
}

// FOCUS: 포커스 모드의 왼쪽 사이드바와 오른쪽 대화 패널. 여닫는 키(⌘B, ⌥⌘B), Activity Bar, 제목줄 단추가 모두 이 함수들을 지난다.
export function setFocusSideOpen(open: boolean) {
  if (state.focusSideOpen !== open) setState({ focusSideOpen: open });
}

export function setChatDockOpen(open: boolean) {
  if (state.chatDockOpen !== open) setState({ chatDockOpen: open });
}

// 끄는 동안 값이 계속 들어온다. null 은 기본 폭으로 되돌린다.
export function setChatDockWidth(width: number | null) {
  if (state.chatDockWidth !== width) setState({ chatDockWidth: width });
}

// 사이드바 뷰를 고른다(files, changes, scm, card). 뷰와 열림을 한 번에 바꿔 두 번 그리지 않는다.
export function setFocusView(view: string, open = true) {
  setState({ sideTabKey: view, focusSideOpen: open });
}

// 끄는 동안은 저장하지 않고(persist false), 놓을 때 한 번 저장한다.
export function setFloatRect(rect: FloatRect | null, persist = true) {
  setState({ floatRect: rect });
  if (persist) saveFloatRect(rect);
}

// 처음 도착한 Settings 로 시작 모드를 한 번 맞춘다. 창을 다시 읽어 복원한 모드나 사용자가 이미 바꾼 모드는 건드리지 않는다. 값은 다음 실행의 첫 화면을 위해 캐시한다.
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
  if (mode !== state.layoutMode) setState({ layoutMode: mode, ...(mode === "editor" ? { floatCollapsed: false } : {}) });
}

// React 밖(테마 적용 등)에서 상태 변화를 듣는다.
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

// PRTABSESSION: 지금 화면에 칸으로 열린 세션들에서 보이는 탭. 탭줄, 전환 목록, 닫기 대상, 배치 판단은 state.tabs 대신 이것을 본다(본문 마운트와 저장은 전체 탭).
export function shownTabsOf(s: Pick<State, "tabs" | "panes">): Tab[] {
  return shownTabs(s.tabs, shownAgentsOf(s));
}

// 탭 키가 속한 그룹. changes, files, card 같은 고정 탭은 탭 목록에 없으므로 main 이다.
function groupOfKey(tabs: readonly Tab[], key: string | null) {
  return groupOf(tabs.find((t) => t.key === key));
}

// 그룹이 가진 활성 탭 키. 활성 그룹은 activeTabKey, 그 밖은 groupActive(없거나 닫힌 탭이면 첫 탭, main 은 changes).
// PRTABSESSION: panes 를 같이 주면 보이지 않는 세션의 PR 탭은 후보에서 뺀다(기억한 탭이 숨겨졌거나 첫 탭이 숨겨진 그룹).
export function activeKeyOfGroup(s: Pick<State, "tabs" | "activeGroupId" | "activeTabKey" | "groupActive"> & Partial<Pick<State, "panes">>, group: string): string | null {
  if (group === s.activeGroupId) return s.activeTabKey;
  const remembered = s.groupActive[group];
  if (group === MAIN_GROUP) return remembered ?? "changes";
  const agents = s.panes ? shownAgentsOf({ panes: s.panes }) : undefined;
  const inGroup = tabsOfGroup(s.tabs, group).filter((t) => isShown(t, agents));
  return inGroup.find((t) => t.key === remembered)?.key ?? inGroup[0]?.key ?? null;
}

// 다시 읽어 복원한 값이 어긋나 있어도 화면이 깨지지 않게 맞춘다: 없는 그룹의 탭은 main 으로, 탭 없는 그룹은 지우고, 없는 활성 탭은 changes 로.
function sanitizeEditorGroups(s: State): State {
  let layout = s.editorLayout;
  const known = new Set(groupIdsOf(layout));
  let tabs = s.tabs.map((t) => (t.group && !known.has(t.group) ? (({ group: _gone, ...rest }) => rest as Tab)(t) : t));
  layout = normalizeLayout(layout);
  const fixed: State = { ...s, tabs, editorLayout: layout, filesIndex: Math.min(s.filesIndex, mainTabs(tabs).length) };
  if (!hasGroup(layout, fixed.activeGroupId)) fixed.activeGroupId = MAIN_GROUP;
  const valid = (key: string | null) => key !== null && (isPinnedTab(key) || tabs.some((t) => t.key === key));
  if (!valid(fixed.activeTabKey) || (groupOfKey(tabs, fixed.activeTabKey) !== fixed.activeGroupId)) fixed.activeTabKey = fixed.activeGroupId === MAIN_GROUP ? "changes" : (tabsOfGroup(tabs, fixed.activeGroupId)[0]?.key ?? null);
  return fixed;
}

export const fileTabKey = (workspaceId: string, path: string) => `${workspaceId}:${path}`;
export const diffTabKey = (agentId: string, path: string) => `diff:${agentId}:${path}`;

// 새 탭은 활성 그룹의 맨 끝에 붙는다.
function appendToActiveGroup(s: State, tab: Tab): Tab[] {
  return [...s.tabs, s.activeGroupId === MAIN_GROUP ? tab : { ...tab, group: s.activeGroupId }];
}

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
  // Files 트리에서 연 파일도 평범한 에디터 탭이다. 트리는 에디터 옆 고정 칸에 그대로 남는다(RightPanel 의 EditorsWithSide).
  setState((s) => {
    // 이미 열린 파일은 새 탭을 만들지 않고 그 탭으로 포커스만 옮긴다(side 로 열 때는 제외). 활성 그룹에 있으면 그 탭이 우선이다.
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
  // 패널이 좁아 고정 칸이 서랍으로 뜬 상태에서 트리로 파일을 열었으면 서랍을 닫아 연 파일이 보이게 한다
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

// 세션의 기본 범위로 연 diff 탭은 scope 를 적지 않는다(다른 곳에서 연 탭과 같은 모양으로 둔다).
function diffScopeOf(s: State, agentId: string, scope: ChangeScope): ChangeScope | undefined {
  const agent = s.agents.find((a) => a.id === agentId);
  return agent && scope === defaultChangeScope(agent) ? undefined : scope;
}

// 같은 파일을 다른 범위로 다시 열면 열려 있던 탭이 새 범위의 기준으로 다시 그려진다.
function withDiffScope(tabs: Tab[], key: string, scope: ChangeScope | undefined): Tab[] {
  return tabs.map((t) => {
    if (t.key !== key || t.kind !== "diff" || t.scope === scope) return t;
    const { scope: _old, ...rest } = t;
    return scope === undefined ? rest : { ...rest, scope };
  });
}

// FIX6B: Source Control 의 Open Changes. 세션 없이도 열린다.
export const scmDiffTabKey = (workspaceId: string, section: "staged" | "changes", path: string) => `scm:${workspaceId}:${section}:${path}`;

export function openScmDiff(target: { workspaceId: string; agentId?: string }, entry: { path: string; rel: string }, section: "staged" | "changes", options: OpenOptions = {}) {
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

// 바꾸기 미리보기 탭을 연다(같은 파일이면 그 탭을 다시 쓴다). 미리보기 탭이라 다음 일치를 누르면 자리가 바뀐다.
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

// FIX6B: 오른쪽 패널의 Source Control 고정 탭을 연다.
export function openSourceControl() {
  setState({ activeTabKey: "scm", rightOpen: true });
}

const previewEnabled = (s: State) => s.defaults?.previewEditors?.value ?? s.settings?.previewEditors ?? false;

// 탭 하나를 group 그룹에 연 결과: 실제 탭 키(그 그룹에 같은 내용의 탭이 있으면 그 키, 없으면 다른 그룹의 같은 파일과 겹치지 않는 새 키)와, tabs 와 미리보기 탭을 바꿔 끼웠으면 그 탭 키를 가리키던 상태.
// 설정이 꺼져 있으면 preview 요청도 고정 탭으로 연다.
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

// R4FIX: 미리보기 탭을 고정한다(탭 더블클릭, 편집 시작, 저장).
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
  // 복원된 이름 없는 탭과 번호가 겹치지 않게 이어 간다
  const n = Math.max(untitledSeq, ...state.tabs.map((t) => (t.kind === "untitled" ? t.n : 0))) + 1;
  untitledSeq = n;
  const key = `untitled:${n}`;
  setState((s) => ({ ...insertNextToActiveGroup(s, { key, kind: "untitled", workspaceId, n }), activeTabKey: key, rightOpen: true }));
  return key;
}

// 같은 자리에서 탭 하나를 다른 탭으로 바꾼다(이름 없는 탭을 저장하면 파일 탭이 된다).
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
    // 편집을 시작하면 미리보기 탭이 고정된다
    return { dirtyTabs: dirty ? { ...rest, [key]: true } : rest, ...(dirty ? { tabs: pinTab(s.tabs, key) } : {}) };
  });
}

// 새 Browser, Search, 이름 없는 탭은 활성 탭 바로 옆, 활성 그룹 안에 들어간다.
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

// 새 Browser 탭. 저장 범위(설정 Data Storage)는 이때 정한다. 에이전트가 연 탭은 처음부터 그 세션에 공유된다.
export function openBrowser(url = "", options: { sharedWith?: string | null } = {}) {
  const key = `browser:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const agent = activeAgent();
  const { partition, scope } = partitionFor(state.settings?.browserDataStorage ?? "default", agent?.workspaceId || state.activeWorkspaceId || null, key);
  setState((s) => ({ ...insertNextToActiveGroup(s, { key, kind: "browser", url, title: "", sharedWith: options.sharedWith ?? null, partition, scope }), activeTabKey: key, rightOpen: true }));
  return key;
}

// 세션에 붙은 탭은 키 끝에 @세션 id 가 붙어서 같은 PR 을 두 세션이 열어도 탭이 따로다. 세션이 없으면 붙지 않는다.
export const prTabKey = (repo: string, number: number, agentId?: string | null) => `pr:${repo}#${number}${agentId ? `@${agentId}` : ""}`;

// 링크를 누른 대화의 세션 id. 그 대화가 든 칸(data-pane-id)의 세션이고, 칸을 못 찾으면 활성 칸의 세션, 그것도 없으면(새 세션 화면) null 이다.
export function agentOfElement(element: Element | null): string | null {
  const paneId = element?.closest?.("[data-pane-id]")?.getAttribute("data-pane-id");
  const pane = state.panes.find((p) => p.id === (paneId ?? state.activePaneId));
  return pane?.kind === "agent" ? pane.agentId : null;
}

// PR 화면 탭을 연다. agentId 는 탭이 붙을 세션(링크를 누른 대화)이고, 안 주면 활성 칸의 세션이다. 그 세션이 칸에 안 열려 있으면 먼저 연다(안 그러면 탭이 보이지 않는다).
// 같은 PR 이 그 세션에 이미 탭으로 있으면(어느 그룹이든) 새로 만들지 않고 그 탭으로 간다. 새 탭은 Browser 탭과 같은 자리(활성 탭 옆, 활성 그룹)에 들어간다.
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

// 세션 대화를 에디터 탭으로 연다. 이미 탭이 있으면 그 탭으로 가고, 같은 대화가 두 곳에 보이지 않게 오른쪽 대화 패널은 닫는다.
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

// 본문 검색의 대상 폴더. 열린 세션의 폴더, 없으면 새 세션 화면에서 고른 폴더, 그것도 없으면 지금 보는 폴더다. 폴더 없는 세션이면 null.
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

// 활성 Browser 탭(또는 key 의 탭)에 동작 하나를 보낸다. Browser 탭이 없으면 안내만 띄운다.
export function dispatchBrowserAction(action: BrowserAction, url?: string, key: string | null = state.activeTabKey, value?: string) {
  const tab = state.tabs.find((t) => t.key === key && t.kind === "browser");
  if (!tab) {
    hint(S.browserNeedsTab);
    return;
  }
  setState({ browserAction: { key: tab.key, action, url, value, nonce: ++browserActionNonce } });
}
let browserActionNonce = 0;

// Search 탭의 조건을 고친다(autoRun 끄기 등)
export function patchSearchTab(key: string, patch: Partial<Pick<SearchTab, "autoRun">>) {
  setState((s) => {
    const tab = s.tabs.find((t): t is SearchTab => t.key === key && t.kind === "search");
    return tab ? { tabs: s.tabs.map((t) => (t === tab ? { ...tab, ...patch } : t)) } : {};
  });
}

// 사이드바 Search 뷰의 검색어와 옵션을 고친다. 창 상태 저장본에 실린다.
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

// Search 탭의 Toggle Search Details. key 가 없으면 활성 Search 탭.
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

// B4: 변경 칩이나 파일 행을 눌러 변경 패널을 연다. 패널이 좁은 목록 상태면 넓은 상태(--size-panel-wide)로 넓히고, 첫 파일(또는 고른 파일)을 선택한다.
export function openChanges(path?: string) {
  if (EMBED) {
    const agent = activeAgent();
    if (agent) postToHost({ type: "agent-nav:openChanges", agentId: agent.id, file: path });
    return;
  }
  setState({ activeTabKey: "changes", rightOpen: true });
  const wide = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--size-panel-wide")) || 860;
  const width = state.panelWidths[panelWidthKey(state)] ?? null;
  // 에디터 탭이 열려 옆으로 갈라진 패널은 이미 에디터와 고정 칸이 나뉘어 있어 넓히면 에디터가 눌린다. 고정 칸에 Changes 만 보인다.
  // FOCUS: Editor 배치의 Changes 는 왼쪽 사이드바라 넓힐 수 없다. 파일은 에디터 탭의 diff 로 연다.
  const beside = state.layoutMode === "editor" || state.tabs.length > 0;
  if (!beside && (width === null || width < wide)) setPanelWidth(wide);
  const agent = activeAgent();
  if (!agent) return;
  const files = panelFiles(agent);
  selectChangedFile(agent.id, path ?? files[0]?.path ?? null);
}

// 변경 패널이 지금 보이는 범위의 파일 목록. 기본 범위(폴더 밖 제외)는 gitChanges, 그 밖에는 따로 받아 둔 목록.
function panelFiles(agent: Agent) {
  return pickChanges(agent, getChangesScope(agent), getShowOutside(agent.id), getScoped(agent.id), state.gitChanges[agent.id])?.files ?? [];
}

// 변경 범위 메뉴에서 범위를 바꾼다. 기본 범위가 아니면 그 범위의 변경을 바로 받아 온다.
export function setChangesScope(agentId: string, scope: ChangeScope) {
  storeChangesScope(agentId, scope);
  selectChangedFile(agentId, null);
  void refreshScoped(agentId);
}

// "Show changes outside this folder" 토글
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
    // 응답을 기다리는 사이 다른 범위나 토글을 골랐으면 버린다
    if (getChangesScope(agent) === scope && getShowOutside(agentId) === includeOutside) storeScopedChanges(agentId, { scope, includeOutside, ...result });
  } catch (error) {
    flash(S.gitStatusFailed((error as Error).message));
  }
}

// 닫은 에디터 기록(Reopen Closed Editor, ⇧⌘T). 파일과 diff 탭만, 최근 20개.
const closedTabs: Tab[] = [];
export const popClosedTab = () => closedTabs.pop();

// remember 가 false 면 닫은 에디터 기록(⇧⌘T)에 남기지 않는다(같은 파일 탭과 합쳐지며 닫히는 경우).
export function closeTab(key: string, remember = true) {
  setState((s) => {
    const closing = s.tabs.find((t) => t.key === key);
    if (!closing) return {};
    if (remember && (closing.kind === "file" || closing.kind === "diff" || closing.kind === "scm")) {
      closedTabs.push(closing);
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
    // 비게 된 그룹은 닫고, 활성 그룹이었으면 이웃 그룹으로 포커스가 간다.
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
// 다시 읽어 복원한 배치의 분할 id(s1, s2 ...)와 겹치지 않게 이어 센다.
const splitIdsOf = (layout: EditorLayout): string[] => (layout.type === "group" ? [] : [layout.id, ...layout.children.flatMap(splitIdsOf)]);
let splitSeq = Math.max(0, ...splitIdsOf(state.editorLayout).map((id) => Number(id.replace("s", "")) || 0));

// 새 그룹과 분할의 id. web/groupActions.ts 의 배치 명령도 같은 번호를 이어 쓴다.
export const newGroupId = () => `g${++groupSeq}`;
export const newSplitId = () => `s${++splitSeq}`;

// 활성 그룹의 옆(오른쪽) 그룹. 없으면 활성 그룹 오른쪽에 빈 그룹을 만들어 돌려준다(Open to the Side).
export function sideGroup(): string {
  const found = groupInDirection(state.editorLayout, state.activeGroupId, "right");
  if (found) return found;
  const id = newGroupId();
  const splitId = newSplitId();
  setState((cur) => ({ editorLayout: normalizeLayout(splitGroup(cur.editorLayout, cur.activeGroupId, "row", id, splitId, false)), rightOpen: true }));
  return id;
}

// 에디터 그룹 포커스. 그 그룹의 활성 탭이 활성 탭이 된다.
export function focusGroup(id: string) {
  setState((s) => {
    if (id === s.activeGroupId || !hasGroup(s.editorLayout, id)) return {};
    // main 그룹이 기억한 탭이 없으면 고정 탭 changes 가 나오는데, 에디터가 따로 보이는 상태에서는 그 값이 오른쪽 고정 칸을 바꿔 버린다. 마지막 에디터 탭을 쓴다.
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

// 탭을 복사해 target 그룹 옆의 새 그룹에 연다(Split 계열 명령, ⌥ 누르고 가장자리로 끌기). 복사할 수 없는 탭 종류는 옮긴다.
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

// 탭을 복사해 group 그룹의 beforeKey 앞(null 이면 끝)에 연다(⌥ 누르고 탭줄이나 본문으로 끌기). 그 그룹에 같은 파일이 이미 있으면 그 탭을 보인다.
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

// 같은 내용의 새 탭 하나: 새 키, 미리보기와 붙박이는 이어받지 않는다.
function copyOfTab(tab: Tab, tabs: readonly Tab[], group: string): Tab {
  const { group: _group, preview: _preview, sticky: _sticky, ...rest } = tab as Tab & { preview?: boolean };
  return { ...rest, key: uniqueKey(tabs.map((t) => t.key), baseKeyOf(tab.key)), ...(group === MAIN_GROUP ? {} : { group }) } as Tab;
}

// 탭을 target 그룹 옆의 새 그룹으로 옮긴다(탭을 그룹 가장자리에 끌어다 놓을 때). 원래 그룹이 비게 되면 그 그룹은 닫힌다.
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

// 탭을 그 줄의 beforeKey 앞(null 이면 끝)으로 옮긴다. 다른 그룹으로도 옮기고, 옮긴 탭은 활성 탭이 된다. 비게 된 그룹은 닫힌다.
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

// 에디터 그룹 사이 경계를 끌어 크기를 바꾼다.
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

// 세션을 연다. where 가 "new" 면 격자에 칸을 하나 더 만들어 나란히 띄운다.
// 같은 세션이 이미 칸에 열려 있으면 칸을 늘리거나 바꾸지 않고 그 칸으로 포커스만 옮긴다.
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
    const pane: Pane = { id: where === "new" ? newPaneId() : s.activePaneId, kind: "agent", agentId };
    const panes = where === "new" ? [...s.panes, pane] : s.panes.map((p) => (p.id === s.activePaneId ? pane : p));
    // 피드백 개선 세션의 워크스페이스는 "새 세션" 의 기본 프로젝트가 되면 안 된다.
    const ws = s.workspaces.find((w) => w.id === agent?.workspaceId);
    return { panes, activePaneId: pane.id, centerView: "sessions", activeWorkspaceId: ws?.feedback || agent?.feedbackId ? s.activeWorkspaceId : (topWorkspaceId(agent?.workspaceId ?? null) ?? s.activeWorkspaceId) };
  });
  ensureTimeline(agentId);
  ensureChanges(agentId);
  ensureDiffFeedback(agentId);
  void refreshGit(agentId);
}

// SESSIONDRAG: 사이드바 세션 행을 칸에 끌어 놓았을 때(web/sessionDrag.ts). 칸 목록과 격자를 바꾸는 규칙은 web/paneDrop.ts 의 planSessionDrop 이 맡는다.
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
  // 떠 있는 창이 알약으로 접혀 있거나 오른쪽 대화 패널이 닫혀 있으면 놓은 세션이 보이도록 연다
  revealChat();
  openAgentData(agentId);
}

// 사이드바의 프로젝트 묶음이 되는 워크스페이스. worktree 와 피드백 개선 세션의 워크스페이스는 제외한다.
export const isTopWorkspace = (w: Workspace) => !w.parentId && !w.feedback;

// worktree 워크스페이스는 원래 프로젝트 아래에 속한다.
export function topWorkspaceId(workspaceId: string | null) {
  if (!workspaceId) return null;
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  return workspace?.parentId ?? workspaceId;
}

// 열려 있는 세션의 타임라인, 변경, git 상태를 읽는다.
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

// B6: 폴더 없는 세션(퀵 챗)은 git 도, 파일 트리도, 변경 목록도 없다. 이 조건이 참인 세션에는 그쪽 RPC 를 부르지 않는다.
export type FolderAgent = Agent & { workspaceId: string };
export function inFolder(agent: Agent | null | undefined): agent is FolderAgent {
  return !!agent && agent.workspaceId !== null;
}

export function ensureChanges(agentId: string) {
  if (state.changes[agentId] || !inFolder(state.agents.find((a) => a.id === agentId))) return;
  void rpc.call("changes.list", { agentId }).then((changes) => setState((s) => ({ changes: { ...s.changes, [agentId]: changes } })));
}

const gitRefreshing = new Set<string>();
// 읽는 중에 다시 요청이 오면(Keep 으로 기준이 바뀐 뒤 등) 이미 시작한 읽기는 옛 기준일 수 있으니 끝난 뒤 한 번 더 읽는다.
const gitRefreshAgain = new Set<string>();

// git 상태는 타이머로 돌리지 않는다. 세션을 열 때, 도구가 파일을 고쳤을 때, 사용자가 새로고침할 때만.
export async function refreshGit(agentId: string) {
  if (!inFolder(state.agents.find((a) => a.id === agentId))) return;
  if (gitRefreshing.has(agentId)) {
    gitRefreshAgain.add(agentId);
    return;
  }
  gitRefreshing.add(agentId);
  try {
    const agent = state.agents.find((a) => a.id === agentId);
    // 기본 범위가 이미 Session 이면(갈래 세션) 같은 계산을 두 번 하지 않는다
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

// B6: ⌘K ⌘N. 폴더 없는 세션을 만드는 새 세션 화면을 연다.
export function startQuickChat(where: "active" | "new" = "active") {
  startDraft(null, where);
}

// 칸 하나의 초안 기록(모델, effort, 권한)을 뺀 사본.
export function withoutPaneDraft<T>(record: Record<string, T>, paneId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== paneId));
}

// 새 칸(또는 바꾼 칸)의 id 를 돌려준다. preset 은 이 칸의 모델, effort, 권한 시작값(핸드오프가 원 세션 값을 이어받는다).
export function startDraft(workspaceId: string | null, where: "active" | "new" = "active", options?: { seed?: DraftSeed; text?: string; handoff?: HandoffSeed; preset?: { model: string | null; effort: Settings["defaultEffort"]; permission: PermissionMode } }): string {
  const paneId = where === "new" ? newPaneId() : state.activePaneId;
  setState((s) => {
    const pane: Pane = { id: paneId, kind: "draft", workspaceId, ...(options?.seed ? { seed: options.seed } : {}), ...(options?.handoff ? { handoff: options.handoff } : {}) };
    const panes = where === "new" ? [...s.panes, pane] : s.panes.map((p) => (p.id === s.activePaneId ? pane : p));
    // 이전 초안이 새 입력창에 되살아나지 않도록, 글이 없으면 이 칸의 초안 기록을 지운다.
    const { [pane.id]: _stale, ...others } = s.composerPrefill;
    const composerPrefill = options?.text ? { ...others, [pane.id]: { text: options.text, nonce: Date.now() } } : others;
    const preset = {
      draftModel: options?.preset ? { ...s.draftModel, [pane.id]: options.preset.model } : withoutPaneDraft(s.draftModel, pane.id),
      draftHarness: withoutPaneDraft(s.draftHarness, pane.id),
      draftEffort: options?.preset ? { ...s.draftEffort, [pane.id]: options.preset.effort } : withoutPaneDraft(s.draftEffort, pane.id),
      draftPermission: options?.preset ? { ...s.draftPermission, [pane.id]: options.preset.permission } : withoutPaneDraft(s.draftPermission, pane.id),
    };
    return { panes, activePaneId: pane.id, centerView: "sessions", activeWorkspaceId: workspaceId ?? s.activeWorkspaceId, focusComposer: { paneId: pane.id, nonce: Date.now() }, composerPrefill, ...preset, ...(workspaceId === null ? { rightOpen: false } : s.activeTabKey === "changes" ? { activeTabKey: "files" as const } : {}) };
  });
  return paneId;
}

// --- Slack Inbox ---

// NOTES: 메모장 화면. 열려 있는 메모와 저장 상태는 web/notesStore.ts 가 갖고, 여기서는 가운데 화면만 바꾼다.
export function toggleNotes() {
  setState((s) => ({ centerView: s.centerView === "notes" ? "sessions" : "notes" }));
}

export function openNotes() {
  setState({ centerView: "notes" });
}

// SKILLS: 스킬 목록 화면. 목록과 검색어는 web/SkillsView.tsx 가 들고, 여기서는 가운데 화면만 바꾼다.
export function toggleSkills() {
  setState((s) => ({ centerView: s.centerView === "skills" ? "sessions" : "skills" }));
}

export function openSkills() {
  setState({ centerView: "skills" });
}

export function toggleInbox() {
  setState((s) => ({ centerView: s.centerView === "inbox" ? "sessions" : "inbox" }));
}

// 항목 상세를 멘션 화면의 상세 칸에 열고(세션 오른쪽 패널은 건드리지 않는다), 안 읽은 항목이면 읽음으로 표시한다 (Slack 쪽 읽음 표시는 건드리지 않는다. 이 앱 안의 상태다).
export function openInboxItem(id: string) {
  if (!slackShown(state.settings)) return;
  setState({ selectedInboxId: id, centerView: "inbox" });
  const item = state.inbox?.items.find((i) => i.id === id);
  if (item && !item.read) void rpc.call("inbox.markRead", { ids: [id], read: true }).catch(() => {});
}

export function closeInboxItem() {
  setState({ selectedInboxId: null });
}

// --- IMPROVE: Improvements 화면 (Lodestar 가 피드백으로 만든 개선 세션 목록) ---

export function toggleImprovements() {
  setState((s) => ({ centerView: s.centerView === "improvements" ? "sessions" : "improvements" }));
}

// 제목줄 피드백 버튼 우클릭, 명령 팔레트, 검색창이 부른다. 이미 열려 있으면 그대로 둔다.
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

// 모델과 MCP 상태를 CLI 를 새로 띄워 다시 읽는다. 끈 서버와 재연결 결과도 이 때 처음 상태로 돌아온다.
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
  // 인증이 필요한 서버를 재연결하면 CLI 는 "Server status: needs-auth" 라는 내부 문구로 거절한다. 화면에는 상태로 말한다.
  if (!result.ok) return { ok: false, text: server?.status === "needs-auth" ? S.mcpStillStatus("needs-auth") : (result.error ?? S.mcpUnknownError) };
  if (action === "disable") return { ok: true, text: S.mcpDisabled };
  // 동작은 성공했는데 상태가 아직 연결이 아니면(pending 이 안 끝났거나 인증이 필요) 그대로 알린다.
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

// 항목에서 새 세션 입력창을 연다. 메시지와 읽어 둔 스레드를 초안으로 채우고, 보내는 것은 사용자가 확인한 뒤다.
export function startInboxSession(item: InboxItem) {
  const workspaceId = state.activeWorkspaceId ?? state.workspaces.find(isTopWorkspace)?.id;
  if (!workspaceId) {
    hint(S.inboxNoWorkspace);
    return;
  }
  startDraft(workspaceId, "active", { text: inboxDraft(item) });
}

const DRAFT_LIMIT = 6000;

// 세션 초안: 보낸 사람과 채널, 링크, 본문, 읽어 둔 스레드. 길면 잘라서 입력창이 감당할 크기로 둔다.
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

// 멘션을 칸반 카드로 만든다 (데몬이 Todo 열에, 판단 단계의 제목과 요약으로 만든다. 이미 카드가 있으면 그 카드를 쓴다).
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

// "Not a request": 이 멘션으로 만든 카드를 지우고 표시를 바꾼다 (Slack 에는 아무것도 하지 않는다).
export async function markNotRequest(item: InboxItem) {
  try {
    await rpc.call("inbox.notRequest", { id: item.id });
  } catch (error) {
    flash(S.inboxFailed((error as Error).message));
  }
}

// 읽기 전용 분석을 다시 돌려 연결된 카드를 새 결과로 고친다.
export async function reanalyzeMention(itemId: string) {
  try {
    await rpc.call("inbox.reanalyze", { id: itemId });
  } catch (error) {
    flash(S.reanalyzeFailed((error as Error).message));
  }
}

// --- 칸반 보드 ---

export function toggleBoard() {
  setState((s) => ({ centerView: s.centerView === "board" ? "sessions" : "board" }));
}

// 카드 상세를 연다. 세션 화면에서는 오른쪽 패널의 Card 탭으로, 그 밖(보드, 멘션, PR)에서는 보드 화면의 상세 칸으로 간다.
// 보드로 열 때는 세션 오른쪽 패널의 열림 여부, 폭, 탭을 건드리지 않는다.
export function openCard(cardId: string) {
  setState((s) => {
    if (cardOpensInSessionPanel(s.centerView)) return { selectedCardId: cardId, activeTabKey: "card", rightOpen: true };
    // Board 를 숨겼으면 보드 화면의 상세 칸이 없다. 세션 화면으로 돌아가 오른쪽 패널의 Card 탭으로 연다.
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

// 카드의 워크스페이스에서 새 세션 입력창을 열고 제목과 설명을 초안으로 채운다. 보내는 것은 사용자가 확인한 뒤다.
export function startCardSession(card: BoardCard, worktree: boolean) {
  if (!card.workspaceId) return;
  const text = [card.title, card.body.trim()].filter(Boolean).join("\n\n");
  const branch = worktree ? card.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) : null;
  startDraft(card.workspaceId, "active", { text, seed: { cardId: card.id, worktreeBranch: branch, nonce: Date.now() } });
}

export function cardsOfAgent(agentId: string) {
  return state.board?.cards.filter((c) => c.agentIds.includes(agentId)) ?? [];
}

export function refreshBoard() {
  void rpc.call("board.get", {}).then((board) => setState({ board })).catch(() => {});
}

// 보드 RPC 가 실패하면 이유를 알리고 서버의 보드로 되돌린다 (낙관적으로 바꿔 둔 화면 포함).
export function boardFailed(error: unknown) {
  flash(S.boardFailed(error instanceof Error ? error.message : String(error)));
  refreshBoard();
}

// 끄는 동안과 키보드 이동 직후에 먼저 화면을 바꾸고, 서버 응답(board 이벤트)이 같은 결과로 덮어쓴다.
export function setBoardLocal(board: Board) {
  setState({ board });
}

// ⌘\: 활성 칸 오른쪽에 새 열을 만들고 빈 새 세션 화면을 열어 포커스를 옮긴다. 한 세션에 채팅이 하나뿐이라 같은 세션을 복제해도 쓸모가 없다.
// 기존 세션을 나란히 여는 것은 사이드바 행 ⌥클릭과 세션 검색의 ⌥Enter 가 맡는다.
export function splitActivePane() {
  setState((s) => {
    const current = s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0];
    const pane = blankPane(s, newPaneId());
    const index = s.panes.indexOf(current);
    return { panes: [...s.panes.slice(0, index + 1), pane, ...s.panes.slice(index + 1)], activePaneId: pane.id, focusComposer: { paneId: pane.id, nonce: Date.now() } };
  });
}

// 칸을 닫는다(머리의 X). 세션은 사이드바에 남고, 닫은 채팅 기록에 들어가 ⇧⌘T 로 되살릴 수 있다.
export function closePane(paneId: string) {
  setState((s) => {
    if (s.panes.length <= 1) return {};
    const closing = s.panes.find((p) => p.id === paneId);
    const order = paneOrder(s.grid);
    const index = order.indexOf(paneId);
    const panes = s.panes.filter((p) => p.id !== paneId);
    const activePaneId = s.activePaneId === paneId ? (order[index + 1] ?? order[index - 1] ?? panes[0].id) : s.activePaneId;
    return { panes, activePaneId, closedPanes: rememberClosed(s.closedPanes, closing ? [closing] : []) };
  });
}

function rememberClosed(list: ClosedPane[], closed: Pane[]): ClosedPane[] {
  const added = closed.flatMap((p) => (p.kind === "agent" ? [{ agentId: p.agentId }] : []));
  return added.length ? [...list.filter((c) => !added.some((a) => a.agentId === c.agentId)), ...added].slice(-CLOSED_PANES_MAX) : list;
}

const blankPane = (s: State, id: string): Pane => ({ id, kind: "draft", workspaceId: s.activeWorkspaceId ?? s.workspaces.find(isTopWorkspace)?.id ?? "" });

// ⌘W 로 칸 하나를 닫는다. 칸이 하나뿐이면 그 칸을 빈 새 세션 화면으로 바꾼다. 세션은 지우지도 닫지도 않는다. 닫을 것이 없으면(칸 하나가 이미 빈 새 세션 화면) false.
export function closeFocusedPane(paneId: string = state.activePaneId): boolean {
  const pane = state.panes.find((p) => p.id === paneId);
  if (!pane) return false;
  if (state.panes.length > 1) {
    closePane(paneId);
    return true;
  }
  if (pane.kind === "draft") return false;
  setState((s) => ({ panes: s.panes.map((p) => (p.id === paneId ? blankPane(s, paneId) : p)), closedPanes: rememberClosed(s.closedPanes, [pane]) }));
  return true;
}

// ⌘K W, ⌘K ⌘W. 열린 칸을 모두 치우고 활성 칸 자리에 빈 새 세션 화면 하나만 남긴다. 활성 칸이 마지막으로 기록되어 ⇧⌘T 가 그것부터 되살린다.
export function closeAllPanes() {
  setState((s) => {
    const active = s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0];
    const others = s.panes.filter((p) => p !== active);
    return { panes: [blankPane(s, active.id)], activePaneId: active.id, closedPanes: rememberClosed(s.closedPanes, [...others, active]) };
  });
}

// ⇧⌘T. 가장 최근에 닫은 채팅을 활성 칸에 다시 연다(칸 수는 그대로). 그 사이 사라진 세션은 건너뛴다.
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
  openAgent(target.agentId, activePaneKeepsDraft() ? "new" : "active");
}

// 활성 칸이 쓰던 글이나 첨부가 있는 새 세션 화면이면 덮지 않고 옆에 새 칸으로 연다(그 초안은 칸의 것으로 남는다).
export function activePaneKeepsDraft() {
  const active = state.panes.find((p) => p.id === state.activePaneId);
  return active?.kind === "draft" && (!!getDraft(`new:${active.id}`).trim() || attachmentsOf(state, active.id).length > 0);
}

// CTRLTAB: ⌃Tab 전환 창에서 고른 세션으로 간다. 이미 칸에 열려 있으면 그 칸에 포커스, 아니면 활성 칸에 연다(쓰던 새 세션 초안은 지키려고 옆 칸). 어느 쪽이든 포커스는 그 칸의 입력창으로 간다.
export function switchToSession(agentId: string) {
  if (!state.agents.some((a) => a.id === agentId)) return;
  openAgent(agentId, activePaneKeepsDraft() ? "new" : "active");
  setState({ focusComposer: { paneId: state.activePaneId, nonce: Date.now() } });
}

// ⌘K ⌘\: 활성 칸 아래에 새 행을 만들고 빈 새 세션 화면을 연다.
export function splitActivePaneDown() {
  setState((s) => {
    const current = s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0];
    const pane = blankPane(s, newPaneId());
    return { panes: [...s.panes, pane], grid: gridSplitDown(s.grid, current.id, pane.id), activePaneId: pane.id, focusComposer: { paneId: pane.id, nonce: Date.now() } };
  });
}

// 칸 포커스. 포커스는 입력창으로 간다.
export function focusPane(paneId: string) {
  if (!state.panes.some((p) => p.id === paneId)) return;
  setState({ activePaneId: paneId, centerView: "sessions", focusComposer: { paneId, nonce: Date.now() } });
}

export function focusPaneStep(delta: 1 | -1) {
  const id = gridStep(state.grid, state.activePaneId, delta);
  if (id) focusPane(id);
}

// 방향 이웃. 위, 아래는 화면에서 가로 중심이 가장 가까운 칸(DOM 을 읽을 수 있을 때)으로 간다.
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

// n 번째 칸(0부터, 읽는 순서). "last" 는 마지막 칸.
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

// 경계를 끌어 바꾼 폭과 높이 비율. cols 는 칸 id 별 폭 전체(호출하는 쪽이 현재 값에 덧씌워 준다), rows 는 행 순서대로의 높이(null 이면 같은 높이).
export function setGridWeights(patch: { cols?: Record<string, number>; rows?: number[] | null }) {
  setState((s) => ({
    grid: {
      ...s.grid,
      ...(patch.cols === undefined ? {} : { colWeights: patch.cols }),
      ...(patch.rows === undefined ? {} : { rowWeights: patch.rows }),
    },
  }));
}

// --- B5: 세션 이동 ---

let replayingHistory = false;

// 활성 칸의 세션이 바뀔 때 이전 세션을 뒤로 가기 목록에 쌓는다. 되감기 중에는 쌓지 않는다.
function recordSessionVisit(from: string | null, to: string) {
  if (replayingHistory || !from || from === to) return;
  setState((s) => ({ sessionHistory: { back: [...s.sessionHistory.back.filter((id, i, all) => !(id === from && i === all.length - 1)), from].slice(-50), forward: [] } }));
}

// 제목줄 뒤로, 앞으로(⌃-, ⌃⇧-). 사라진 세션은 건너뛴다.
export function goBackSession() {
  stepSessionHistory("back");
}
export function goForwardSession() {
  stepSessionHistory("forward");
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
    openAgent(target);
  } finally {
    replayingHistory = false;
  }
}

// FIX6C: attachments 의 키는 칸 id 가 아니라 composerState.attachmentKey (세션 id 또는 `new:<칸 id>`). 칸 id 를 받는 함수는 지금 그 칸이 보여 주는 세션의 키로 바꿔 쓴다.
export const NO_ATTACHMENTS: Attachment[] = [];
export const attachmentsOf = (s: Pick<State, "attachments" | "panes">, paneId: string) => s.attachments[attachmentKey(s.panes, paneId)] ?? NO_ATTACHMENTS;

// ATTACH-DEDUPE: 같은 파일(같은 줄 범위), 같은 세션 요약, 같은 인계 문서, 같은 이미지는 다시 붙이지 않고 기존 칩을 강조한다. 이때 돌려주는 id 는 기존 칩의 id 다.
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

// 이 칸 입력창에 같은 칩이 이미 있으면 그 칩(없으면 undefined). 칩을 붙이기 전에 비싼 일을 시작해도 되는지 볼 때 쓴다.
export function findAttachedDuplicate(paneId: string, attachment: Omit<Attachment, "id">) {
  const s = state;
  return findDuplicate(attachmentsOf(s, paneId), attachment, (workspaceId) => s.workspaces.find((w) => w.id === workspaceId)?.dir);
}

// 칩 id 는 전역에서 유일하므로 칩을 붙인 뒤 칸의 세션이 바뀌었어도(핸드오프 문서가 다 만들어진 사이) 붙어 있던 자리에서 찾아 고친다.
function keyOfAttachment(s: Pick<State, "attachments">, id: string) {
  return Object.keys(s.attachments).find((key) => s.attachments[key].some((a) => a.id === id));
}

// HANDOFF: 이미 붙인 칩의 내용을 바꾼다(문서가 다 만들어졌거나 사용자가 고쳤을 때). 칩을 지웠으면 아무 일도 없다.
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

// 입력창이 보낸 뒤 비운다. 보내는 사이 칸이 새 세션 화면에서 세션 화면으로 바뀌므로 칸 id 가 아니라 입력창이 마운트될 때 쥔 키로 비운다.
// ids 가 있으면 그 첨부만 지운다(보내는 동안 새로 붙인 첨부는 남긴다).
export function clearAttachmentsByKey(key: string, ids?: ReadonlySet<string>) {
  setState((s) => (s.attachments[key]?.length ? { attachments: { ...s.attachments, [key]: ids ? s.attachments[key].filter((a) => !ids.has(a.id)) : [] } } : {}));
}

// `/` 메뉴를 열 때마다 디스크의 스킬을 다시 읽는다. 옛 데몬이 모르면 비워 둔다.
export function refreshLocalCommands(workspaceId: string) {
  void rpc
    .call("commands.local", { workspaceId })
    .then((list) => setState((s) => ({ localCommands: { ...s.localCommands, [workspaceId]: list } })))
    .catch(() => undefined);
}

// 바깥에서 파일이 생기거나 지워지면(에이전트의 도구, 다른 편집기, 터미널) 이미 읽어 둔 파일 목록을 다시 읽는다. 안 그러면 Files 트리와 파일 열기에 새 파일이 새로고침 전까지 안 보인다.
// 알림이 이어져도 폴더마다 한 번씩만 읽는다.
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
  // 빈 폴더 목록은 트리에서만 쓰니 늦어도 된다. 옛 데몬이 모르면 비워 둔다.
  void rpc.call("files.dirs", { workspaceId }).then((dirs) => setState((s) => ({ emptyDirs: { ...s.emptyDirs, [workspaceId]: dirs } }))).catch(() => undefined);
  return files;
}

// 닫고 다시 열어도 이름이 겹치지 않게 열린 이름에 없는 가장 작은 번호를 쓴다.
function nextTerminalName(list: Terminal[]) {
  const used = new Set(list.map((t) => t.name));
  let n = 1;
  while (used.has(`zsh ${n}`)) n += 1;
  return `zsh ${n}`;
}

// 터미널 탭. 실제 셸은 Terminal 컴포넌트가 마운트될 때 사용자 조작으로만 뜬다.
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

// C: Split Terminal. 새 셸을 더하고 모든 터미널을 나란히 보인다. 이름은 열린 터미널 이름과 겹치지 않는 가장 작은 번호를 쓴다.
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

// CODEX: Codex 앱 서버의 모델 목록과 로그인 상태를 읽어 둔다. refresh 가 아니면 한 번 읽은 값을 쓴다. 옛 데몬이면 코덱스 정보가 없다고 알린다.
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

export function openSide(agentId: string, draft?: string) {
  // CODEX: 곁다리 질문은 Claude 세션 기록을 갈라서 묻는 기능이라 Codex 세션에는 아직 없다(2단계)
  const target = state.agents.find((a) => a.id === agentId);
  if (target && harnessOf(target) === "codex") {
    hint(S.codexUnavailable("Side questions (/btw)"));
    return;
  }
  setState((s) => {
    const next = draft ? { text: draft, nonce: Date.now() } : undefined;
    if (s.side?.agentId === agentId) return next ? { side: { ...s.side, draft: next } } : {};
    return { side: { id: `side-${Date.now()}`, agentId, run: null, model: null, ...(next ? { draft: next } : {}) } };
  });
}

// 오른쪽 패널 폭의 키: 열린 세션이면 그 세션, 새 세션 화면이면 그 칸. 퀵 챗과 새 세션 화면은 늘 좁게 시작한다.
export function panelKey(s: Pick<State, "panes" | "activePaneId">) {
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  return pane?.kind === "agent" ? `agent:${pane.agentId}` : `draft:${pane?.id ?? ""}`;
}

// 오른쪽 패널 폭을 담는 키. 칸이 여럿이면 활성 칸을 옮길 때마다 패널 폭이 바뀌어 칸 폭이 흔들리므로 칸 전체가 폭 하나를 쓴다.
export function panelWidthKey(s: Pick<State, "panes" | "activePaneId">) {
  return s.panes.length > 1 ? "panes" : panelKey(s);
}

// 지금 보는 세션의 패널 폭을 바꾼다. null 은 기본값으로 되돌리기(더블클릭). 저장하지 않는다.
export function setPanelWidth(width: number | null) {
  setState((s) => {
    const key = panelWidthKey(s);
    const { [key]: _removed, ...rest } = s.panelWidths;
    return { panelWidths: width === null ? rest : { ...rest, [key]: width } };
  });
}

// 패널 크기를 바꾸고 저장한다. null 은 기본값으로 되돌리기(더블클릭).
export function setLayout(patch: Partial<Layout>) {
  setState((s) => ({ layout: { ...s.layout, ...patch } }));
  saveLayout();
}

function saveLayout() {
  try {
    // 이 창의 값과 함께, 새 창이 이어받을 마지막 값도 공용 이름에 남긴다
    const json = JSON.stringify(state.layout);
    windowStorage()?.setItem(LAYOUT_KEY, json);
    localStorage.setItem(LAYOUT_KEY, json);
  } catch {
    // 저장이 막힌 환경(사생활 보호 창)에서는 세션 동안만 유지
  }
}

export function openInVSCode(agentId: string | null, workspaceId: string | null) {
  return rpc.call("workspaces.openInVSCode", agentId ? { agentId } : { workspaceId: workspaceId ?? undefined }).catch((error: Error) => flash(S.openVSCodeFailed(error.message.split("\n")[0])));
}

// 잠깐 보이는 알림. 창 오른쪽 아래 알림 영역(web/NoticeStack.tsx)에 쌓인다. 버튼이 필요하면 notify 를 직접 부른다.
export function flash(message: string, severity: NoticeSeverity = "info") {
  notify({ message, severity });
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

let layoutReconciled = false;
let connectedBefore = false;

export function initStore() {
  rpc.onStatus((connected) => {
    setState({ connected });
    if (!connected) return;
    // 다시 이어진 연결이면 끊긴 사이 놓친 항목(응답 끝, 다른 곳에서 답한 승인)이 있으니 읽어 둔 타임라인을 새로 읽는다. ensureTimeline 은 읽어 둔 것을 다시 읽지 않는다.
    if (connectedBefore) {
      for (const agentId of Object.keys(state.timelines)) {
        void rpc
          .call("agents.timeline", { agentId })
          .then((items) => setState((s) => (s.timelines[agentId] ? { timelines: { ...s.timelines, [agentId]: items } } : {})))
          .catch(() => undefined);
      }
    }
    connectedBefore = true;
    // 보드는 따로 읽는다. board.get 을 모르는 옛 데몬이어도 나머지 화면은 떠야 한다.
    void rpc.call("board.get", {}).then((board) => setState({ board })).catch(() => setState({ board: null }));
    void rpc.call("inbox.get", {}).then((inbox) => setState({ inbox })).catch(() => setState({ inbox: null }));
    void refreshReview();
    void rpc.call("release.get", {}).then((release) => setState({ release })).catch(() => setState({ release: null }));
    // 옛 데몬은 defaults.get 이 없다. 그러면 화면은 고른 값만 쓴다.
    void rpc.call("defaults.get", {}).then((defaults) => setState({ defaults })).catch(() => setState({ defaults: null }));
    // 옛 데몬은 sessionOrder.list 가 없다. 그러면 사이드바는 기본 정렬 그대로다.
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
        // 창을 다시 읽고 복원한 칸 중 사라진 세션은 새 세션 칸으로 바꾼다.
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
      case "release":
        setState({ release: event.release });
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
          // 그 세션에 공유했던 Browser 탭은 공유를 끝낸다
          const tabs = s.tabs.some((t) => t.kind === "browser" && t.sharedWith === event.agentId) ? s.tabs.map((t) => (t.kind === "browser" && t.sharedWith === event.agentId ? { ...t, sharedWith: null } : t)) : s.tabs;
          const sides = dropSide(s.side, s.sideStash, event.agentId);
          return { agents: s.agents.filter((a) => a.id !== event.agentId), panes, tabs, side: sides.side, sideStash: sides.stash };
        });
        // PERLAYOUT: 위 갱신에서 보던 세션이 사라지면 setState 가 마지막 배치를 한 번 더 적으므로, 그 뒤에 지운다
        setState((s) => ({ sessionLayouts: dropSessionLayout(s.sessionLayouts, event.agentId), sessionTabFocus: dropTabFocus(s.sessionTabFocus, event.agentId) }));
        // PRTABSESSION: 지워진 세션은 되살릴 수 없으니 그 세션에 붙은 PR 탭도 닫는다(칸을 닫거나 완료 처리한 세션은 남아 있어서 탭도 숨겨진 채 남는다)
        for (const tab of state.tabs.filter((t) => (t.kind === "pr" || t.kind === "chat") && t.agentId === event.agentId)) closeTab(tab.key, false);
        return;
      case "timelineUpsert":
        setState((s) => {
          const items = s.timelines[event.agentId];
          if (!items) return {};
          // 스트리밍 중인 항목은 거의 항상 마지막 근처라 뒤에서부터 찾는다
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
        // 유지한 변경은 변경 패널의 +/- 에서 빠지므로(server/index.ts withKeptCounts) 기준이 바뀌면 숫자를 다시 읽는다
        void refreshGit(event.agentId);
        return;
      case "workspaceChanged": {
        // FIX4A: 바깥의 파일 변화. 칸에 열려 있는 세션의 변경 목록을 다시 읽고, Source Control 과 새 세션 화면은 이 알림을 직접 듣는다.
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
        // 개선 세션이 파일을 고쳤거나 끝난 뒤의 변경 목록을 새로 읽는다.
        if (state.agents.some((a) => a.id === event.feedback.agentId)) void refreshGit(event.feedback.agentId);
        return;
      case "reload":
        // 창이 다시 읽히기 전에 쓰던 글부터 남긴다
        flushDrafts();
        if (!event.restarting) {
          // 피드백 반영은 입력이 멈춘 틈에 모아서 읽는다. 사람이 누른 되돌리기(immediate)만 바로 읽는다.
          if (event.immediate) setTimeout(reloadWindow, 200);
          else requestIdleReload(reloadWindow);
          return;
        }
        // 새 메인이 띄운 앱 창은 메인이 새 데몬이 응답하는 것을 확인한 뒤에 다시 읽는다(electron/main.ts reloadAppWindow). 여기서 읽으면 아직 종료 중인 옛 데몬이 답해서, 다시 읽는 순간 서버가 없는 틈에 떨어졌다(Chromium 오류 페이지로 멈춤).
        if (!window.agentNavNative?.readsWindowAfterDaemonRestart) reloadWhenDaemonReturns();
        return;
    }
  });
  rpc.connect();
}

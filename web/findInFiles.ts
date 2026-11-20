import { EditorView } from "@codemirror/view";
import { rpc } from "./rpc";
import { openReplacePreview } from "./replacePreview";
import { replaceActiveOf } from "./searchReplaceModel";
import { revealPinned } from "./pinnedPanel";
import { SearchHistory } from "./searchHistory";
import { EMPTY_RESULT, IDLE_RUN, buildSearchRequest, planFindInFiles, togglesOf } from "./searchViewModel";
import { currentModel, getSearchUi, refreshSearchSettings, setSearchUi } from "./searchState";
import { collapsibleKeys, hasExpanded, initialCollapsed, orderedHits, visibleRows, type SearchHit } from "./searchTree";
import { getState, openFile, openSearch, searchWorkspaceOf, setSearchRun, setState, updateSearchView } from "./store";


// ⇧⌘F 와 Find in Folder. 뷰를 열고(Editor 중심은 왼쪽 사이드바, Chat 중심은 오른쪽 패널) 검색 입력에 포커스를 줘 글을 전체 선택한다.
// 에디터에 한 줄 안의 선택이 있으면 그 글로 검색어를 채워 바로 검색한다. 검색 뷰 입력에 포커스가 있으면 뷰는 그대로 두고 입력만 다시 선택한다.
// withReplace 는 ⇧⌘H(Replace in Files): 같은 일에 바꾸기 줄을 펼친다.
export function findInFiles(options: { include?: string; withReplace?: boolean } = {}) {
  const s = getState();
  const plan = planFindInFiles({ ...focusOfPage(), include: options.include, query: s.searchView.query });
  setState({
    searchView: { ...s.searchView, ...(plan.seed !== null ? { query: plan.seed } : {}), ...(plan.include !== null ? { include: plan.include, details: true } : {}), ...(options.withReplace ? { showReplace: true } : {}) },
    activeTabKey: "search",
    rightOpen: true,
    focusSearchInput: Date.now(),
  });
  if (plan.run) void runSearchView();
}

// 지금 키보드 포커스가 에디터 그룹의 코드 에디터와 Search 뷰 중 어디 있는지, 에디터라면 선택한 글.
// 창이 포커스를 잃은 상태에서는 EditorView.hasFocus 가 거짓이라 DOM 에서 에디터를 찾는다(web/lsp.ts focusedViewKey 는 쓰지 않는다).
function focusOfPage(): { inEditor: boolean; inSearchView: boolean; selection: string | null } {
  const active = document.activeElement;
  const inSearchView = !!active?.closest(".search-view");
  const host = active?.closest<HTMLElement>(".editor-area .cm-editor");
  const view = host ? EditorView.findFromDOM(host) : null;
  const range = view?.state.selection.main;
  return { inEditor: view !== null, inSearchView, selection: view && range && !range.empty ? view.state.sliceDoc(range.from, range.to) : null };
}


const HISTORY_KEY = "lodestar:search-history";
export type HistoryKind = "search" | "replace" | "include" | "exclude";
const histories: Record<HistoryKind, SearchHistory> = loadHistories();

function loadHistories(): Record<HistoryKind, SearchHistory> {
  let saved: Partial<Record<HistoryKind, unknown>> = {};
  try {
    saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}") ?? {};
  } catch {
    // 깨진 기록은 비운다
  }
  const of = (kind: HistoryKind) => new SearchHistory(Array.isArray(saved[kind]) ? (saved[kind] as unknown[]).filter((v): v is string => typeof v === "string") : []);
  return { search: of("search"), replace: of("replace"), include: of("include"), exclude: of("exclude") };
}

export const historyOf = (kind: HistoryKind) => histories[kind];

export function addToHistory(kind: HistoryKind, value: string) {
  histories[kind].add(value);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ search: histories.search.values(), replace: histories.replace.values(), include: histories.include.values(), exclude: histories.exclude.values() }));
  } catch {
    // 저장소가 막혀 있으면 이번 실행 동안만 기억한다
  }
}

// --- 검색 실행 ---

let runSeq = 0;
let delayTimer: ReturnType<typeof setTimeout> | null = null;
let slowTimer: ReturnType<typeof setTimeout> | null = null;
let historyTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSearchView(delay: number) {
  if (delayTimer) clearTimeout(delayTimer);
  delayTimer = null;
  if (delay <= 0) {
    void runSearchView();
    return;
  }
  delayTimer = setTimeout(() => {
    delayTimer = null;
    void runSearchView({ triggeredOnType: true });
  }, delay);
}

export async function runSearchView(options: { triggeredOnType?: boolean } = {}) {
  if (delayTimer) clearTimeout(delayTimer);
  delayTimer = null;
  const s = getState();
  const view = s.searchView;
  const workspaceId = searchWorkspaceOf(s);
  if (view.query.length === 0 || !workspaceId) {
    clearResults();
    return;
  }
  const mine = ++runSeq;
  if (slowTimer) clearTimeout(slowTimer);
  if (historyTimer) clearTimeout(historyTimer);
  const settings = getSearchUi().settings;
  setSearchUi({ phase: 1, note: null, canceled: false, limitHit: false, dismissed: new Set(), cursor: null });
  setSearchRun({ kind: "busy" });
  slowTimer = setTimeout(() => {
    if (mine === runSeq) setSearchUi({ phase: 2 });
  }, 2000);
  historyTimer = setTimeout(() => {
    if (mine === runSeq) addToHistory("search", view.query);
  }, 2000);
  void refreshSearchSettings();
  const openPaths = s.tabs.filter((t) => t.kind === "file" && t.workspaceId === workspaceId).map((t) => (t as { path: string }).path);
  try {
    const request = buildSearchRequest(workspaceId, view, openPaths, { ranges: true, smartCase: settings.smartCase });
    const result = request ? await rpc.call("files.search", request) : EMPTY_RESULT;
    if (mine !== runSeq) return;
    const limit = settings.maxResults;
    const limited = limit !== null && result.matches >= limit;
    setSearchRun({ kind: "done", result, query: view.query, toggles: togglesOf(view), workspaceId });
    const model = currentModel();
    setSearchUi({ phase: 0, limitHit: result.truncated || limited, collapsed: initialCollapsed(model.nodes, getSearchUi().settings.collapseResults) });
    if (options.triggeredOnType !== true) addToHistory("search", view.query);
  } catch (error) {
    if (mine === runSeq) {
      setSearchRun({ kind: "error", message: (error as Error).message });
      setSearchUi({ phase: 0 });
    }
  } finally {
    if (mine === runSeq && slowTimer) clearTimeout(slowTimer);
  }
}

// 진행 중인 검색을 취소한다(Cancel Search, Escape). 결과는 비워 두고 "Search was canceled" 안내를 보인다.
export function cancelSearchView() {
  if (getSearchUi().phase === 0) return;
  runSeq++;
  setSearchUi({ phase: 0, canceled: true });
  setSearchRun(IDLE_RUN);
}

function clearResults() {
  runSeq++;
  if (delayTimer) clearTimeout(delayTimer);
  delayTimer = null;
  setSearchUi({ phase: 0, note: null, canceled: false, limitHit: false, dismissed: new Set(), cursor: null, collapsed: new Set() });
  setSearchRun(IDLE_RUN);
}

export function clearSearchView() {
  updateSearchView({ query: "", replaceText: "" });
  clearResults();
  setState({ focusSearchInput: Date.now() });
}

export function openNewSearchEditor() {
  openSearch("");
}

export function openSearchInEditor() {
  const { query, include, ...rest } = getState().searchView;
  openSearch(query, include.trim() ? include : undefined, { seed: { ...rest, include }, autoRun: query.trim() !== "" });
}

// --- 결과 트리 조작 ---

export function setViewMode(mode: "tree" | "list") {
  updateSearchView({ viewMode: mode });
  setSearchUi({ collapsed: initialCollapsed(currentModel().nodes, getSearchUi().settings.collapseResults) });
}

export function collapseAll() {
  setSearchUi({ collapsed: new Set(collapsibleKeys(currentModel().nodes).filter((key) => key.startsWith("file:"))) });
}

export function expandAll() {
  setSearchUi({ collapsed: new Set() });
}

// Collapse All 이 보이는 조건: 결과가 없거나 펼쳐진 노드가 있다
export const canCollapse = () => {
  const model = currentModel();
  return model.nodes.length === 0 || hasExpanded(model.nodes, getSearchUi().collapsed);
};

export function toggleCollapsed(key: string) {
  const next = new Set(getSearchUi().collapsed);
  if (!next.delete(key)) next.add(key);
  setSearchUi({ collapsed: next });
}

export function setCollapsed(key: string, collapsed: boolean) {
  const next = new Set(getSearchUi().collapsed);
  if (collapsed) next.add(key);
  else next.delete(key);
  setSearchUi({ collapsed: next });
}

// Dismiss: 일치들을 결과에서 뺀다. 파일의 마지막 일치를 지우면 파일 행도 사라진다.
export function dismissHits(hits: readonly SearchHit[]) {
  const next = new Set(getSearchUi().dismissed);
  hits.forEach((hit) => next.add(hit.key));
  setSearchUi({ dismissed: next });
}

// 일치 행을 연다. 한 번 누르면 미리보기 탭으로 열고 포커스는 결과 목록에 남는다. 두 번 누르거나 Enter 면 고정 탭이고 포커스가 에디터로 간다.
// 바꾸기가 켜져 있고 바꿀 글이 있으면(search.useReplacePreview) 파일을 여는 대신 바꾸기 미리보기 diff 를 연다.
export function openHit(hit: SearchHit, options: { pinned: boolean; preserveFocus: boolean; side?: boolean }) {
  const workspaceId = searchWorkspaceOf(getState());
  if (!workspaceId) return;
  setSearchUi({ cursor: hit.key });
  if (!options.pinned && replaceActiveOf(getState().searchView, getSearchUi().settings)) {
    openReplacePreview(workspaceId, hit, options);
  } else {
    openFile({ workspaceId, path: hit.path, line: hit.line, column: hit.start + 1, endColumn: hit.end + 1 }, { preview: !options.pinned && !options.side, side: options.side, preserveFocus: options.preserveFocus, keepDrawer: true });
  }
  // Chat 중심에서 첫 파일이 열리면 패널이 에디터와 고정 칸으로 갈라지는데, 좁으면 고정 칸이 서랍으로 접혀 결과 목록이 사라진다. 결과를 이어서 누르도록 다시 편다.
  if (getState().layoutMode !== "editor") revealPinned();
}

// 결과 트리에서 행이 빠진 뒤(Dismiss, Replace) 그 자리에서 가까운 다음 행을 고른다. 일치 행이면 미리보기로 열되 포커스는 목록에 남는다.
export function advanceAfterRemoval(at: number) {
  const rows = visibleRows(currentModel().nodes, getSearchUi().collapsed);
  const next = rows[Math.min(Math.max(at, 0), rows.length - 1)];
  setSearchUi({ cursor: next?.node.key ?? null });
  if (next?.node.kind === "hit") openHit(next.node.hit, { pinned: false, preserveFocus: true });
}

// 지금 포커스한 행의 화면 위치(없으면 -1)
export const cursorRowIndex = () => visibleRows(currentModel().nodes, getSearchUi().collapsed).findIndex((row) => row.node.key === getSearchUi().cursor);

// F4 와 ⇧F4: 화면 순서로 다음, 이전 일치를 에디터에 연다. 지금 위치가 없으면 처음(또는 마지막)부터. 끝에서는 반대쪽 끝으로 돌아간다.
export function focusSearchResult(step: 1 | -1) {
  const hits = orderedHits(currentModel().nodes);
  if (hits.length === 0) return;
  const at = hits.findIndex((hit) => hit.key === getSearchUi().cursor);
  const next = at === -1 ? (step === 1 ? 0 : hits.length - 1) : (at + step + hits.length) % hits.length;
  openHit(hits[next], { pinned: false, preserveFocus: false });
}

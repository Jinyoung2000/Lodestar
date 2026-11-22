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
import { activeSearchRoots, mergeRootResults, searchTargetOf } from "./searchRoots";


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
  }
}

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
  const roots = activeSearchRoots(s);
  const openPathsOf = (id: string) => s.tabs.filter((t) => t.kind === "file" && t.workspaceId === id).map((t) => (t as { path: string }).path);
  const searchIn = async (id: string) => {
    const request = buildSearchRequest(id, view, openPathsOf(id), { ranges: true, smartCase: settings.smartCase });
    return request ? rpc.call("files.search", request) : EMPTY_RESULT;
  };
  try {
    const result = roots ? mergeRootResults(await Promise.all(roots.map(async (root) => ({ root, result: await searchIn(root.workspaceId).catch(() => EMPTY_RESULT) })))) : await searchIn(workspaceId);
    if (mine !== runSeq) return;
    const limit = settings.maxResults;
    const limited = limit !== null && result.matches >= limit;
    setSearchRun({ kind: "done", result, query: view.query, toggles: togglesOf(view), workspaceId, ...(roots ? { roots } : {}) });
    const model = currentModel();
    const collapsed = initialCollapsed(model.nodes, getSearchUi().settings.collapseResults);
    if (roots) for (const node of model.nodes) collapsed.delete(node.key);
    setSearchUi({ phase: 0, limitHit: result.truncated || limited, collapsed });
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

export function dismissHits(hits: readonly SearchHit[]) {
  const next = new Set(getSearchUi().dismissed);
  hits.forEach((hit) => next.add(hit.key));
  setSearchUi({ dismissed: next });
}

export function openHit(hit: SearchHit, options: { pinned: boolean; preserveFocus: boolean; side?: boolean }) {
  const target = searchTargetOf(hit.path);
  if (!target) return;
  const multi = target.path !== hit.path;
  setSearchUi({ cursor: hit.key });
  if (!multi && !options.pinned && replaceActiveOf(getState().searchView, getSearchUi().settings)) {
    openReplacePreview(target.workspaceId, hit, options);
  } else {
    openFile({ workspaceId: target.workspaceId, path: target.path, line: hit.line, column: hit.start + 1, endColumn: hit.end + 1 }, { preview: !options.pinned && !options.side, side: options.side, preserveFocus: options.preserveFocus, keepDrawer: true });
  }
  if (getState().layoutMode !== "editor") revealPinned();
}

export function advanceAfterRemoval(at: number) {
  const rows = visibleRows(currentModel().nodes, getSearchUi().collapsed);
  const next = rows[Math.min(Math.max(at, 0), rows.length - 1)];
  setSearchUi({ cursor: next?.node.key ?? null });
  if (next?.node.kind === "hit") openHit(next.node.hit, { pinned: false, preserveFocus: true });
}

export const cursorRowIndex = () => visibleRows(currentModel().nodes, getSearchUi().collapsed).findIndex((row) => row.node.key === getSearchUi().cursor);

export function focusSearchResult(step: 1 | -1) {
  const hits = orderedHits(currentModel().nodes);
  if (hits.length === 0) return;
  const at = hits.findIndex((hit) => hit.key === getSearchUi().cursor);
  const next = at === -1 ? (step === 1 ? 0 : hits.length - 1) : (at + step + hits.length) % hits.length;
  openHit(hits[next], { pinned: false, preserveFocus: false });
}

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { PrDetail, PrFile, PrListResult, PrMergeMethod, PrStatusResult } from "../shared/prTypes";
import { parsePrUrl, prRefOfUrl, type PrAnchor, type PrTab } from "../shared/prUrl";
import { rpc } from "./rpc";
import { P } from "./prStrings";
import { activePaneKeepsDraft, flash, getState, openPrTab, setState, startDraft, subscribe } from "./store";

export { prRefOfUrl };
export type { PrAnchor, PrTab };

export type PrListState = { data: PrListResult | null; loading: boolean; error: string | null; at: number };
export type PrRef = { repo: string; number: number };

export type PrData = {
  detail: PrDetail | null;
  detailError: string | null;
  detailLoading: boolean;
  files: PrFile[] | null;
  filesError: string | null;
  busy: string | null;
};

export type PrView = { ref: PrRef; tab: PrTab; selectedFile: string | null; focus: PrAnchor | null };

export type PrUi = {
  status: PrStatusResult | null;
  statusLoading: boolean;
  lists: Record<string, PrListState>;
  views: Record<string, PrView>;
  data: Record<string, PrData>;
  refreshMinutes: number;
  collapsed: Record<string, boolean>;
  filesListWidth: number | null;
};

export const CENTER = "center";
export const refKey = (ref: PrRef) => `${ref.repo}#${ref.number}`;

const PREFS_KEY = "agent-nav:pr-prefs";
const REFRESH_CHOICES = [0, 1, 2, 5, 10, 15, 30] as const;
export const PR_REFRESH_CHOICES: readonly number[] = REFRESH_CHOICES;

function loadPrefs(): Pick<PrUi, "refreshMinutes" | "collapsed" | "filesListWidth"> {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as { refreshMinutes?: number; collapsed?: Record<string, boolean>; filesListWidth?: number };
    return { refreshMinutes: PR_REFRESH_CHOICES.includes(saved.refreshMinutes ?? -1) ? (saved.refreshMinutes as number) : 5, collapsed: saved.collapsed ?? { section: true }, filesListWidth: typeof saved.filesListWidth === "number" ? saved.filesListWidth : null };
  } catch {
    return { refreshMinutes: 5, collapsed: { section: true }, filesListWidth: null };
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ refreshMinutes: ui.refreshMinutes, collapsed: ui.collapsed, ...(ui.filesListWidth !== null ? { filesListWidth: ui.filesListWidth } : {}) }));
  } catch {
  }
}

const OPEN_KEY = "agent-nav:pr-open";
function loadCenter(): Record<string, PrView> {
  try {
    const saved = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "null") as PrRef | null;
    return saved && typeof saved.repo === "string" && Number.isInteger(saved.number) ? { [CENTER]: newView(saved) } : {};
  } catch {
    return {};
  }
}

const newView = (ref: PrRef): PrView => ({ ref, tab: "overview", selectedFile: null, focus: null });
const EMPTY_DATA: PrData = { detail: null, detailError: null, detailLoading: false, files: null, filesError: null, busy: null };

let ui: PrUi = {
  status: null,
  statusLoading: false,
  lists: {},
  views: loadCenter(),
  data: {},
  ...loadPrefs(),
};
const listeners = new Set<() => void>();

function set(patch: Partial<PrUi> | ((prev: PrUi) => Partial<PrUi>)) {
  const before = ui.views[CENTER]?.ref;
  ui = { ...ui, ...(typeof patch === "function" ? patch(ui) : patch) };
  const center = ui.views[CENTER]?.ref;
  if (center !== before) {
    try {
      sessionStorage.setItem(OPEN_KEY, JSON.stringify(center ?? null));
    } catch {
    }
  }
  for (const listener of listeners) listener();
}

function patchView(id: string, patch: Partial<PrView>) {
  set((s) => (s.views[id] ? { views: { ...s.views, [id]: { ...s.views[id], ...patch } } } : {}));
}

function patchData(key: string, patch: Partial<PrData>) {
  set((s) => ({ data: { ...s.data, [key]: { ...(s.data[key] ?? EMPTY_DATA), ...patch } } }));
}

export function usePr<T>(selector: (s: PrUi) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => selector(ui),
  );
}

export const getPr = () => ui;

export const getCenterRef = () => ui.views[CENTER]?.ref ?? null;

export function subscribePr(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function setCollapsed(key: string, collapsed: boolean) {
  set((s) => ({ collapsed: { ...s.collapsed, [key]: collapsed } }));
  savePrefs();
}

export function setFilesListWidth(width: number | null) {
  set({ filesListWidth: width });
  savePrefs();
}

export function setRefreshMinutes(minutes: number) {
  set({ refreshMinutes: minutes });
  savePrefs();
  armTimer();
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const PrViewContext = createContext<{ id: string; ref: PrRef | null }>({ id: CENTER, ref: null });

export type PrViewModel = PrData & { ref: PrRef | null; tab: PrTab; selectedFile: string | null; focus: PrAnchor | null };

function modelOf(s: PrUi, id: string, fallback: PrRef | null): PrViewModel {
  const view = s.views[id];
  const ref = view?.ref ?? fallback;
  const data = ref ? (s.data[refKey(ref)] ?? EMPTY_DATA) : EMPTY_DATA;
  return { ...data, ref, tab: view?.tab ?? "overview", selectedFile: view?.selectedFile ?? null, focus: view?.focus ?? null };
}

export function usePrView<T>(selector: (model: PrViewModel) => T): T {
  const { id, ref } = useContext(PrViewContext);
  return usePr((s) => selector(modelOf(s, id, ref)));
}

export const usePrViewId = () => useContext(PrViewContext).id;

export function usePrActions() {
  const id = usePrViewId();
  return useMemo(() => actionsOf(id), [id]);
}

export type PrActions = ReturnType<typeof actionsOf>;

function actionsOf(id: string) {
  const ref = () => ui.views[id]?.ref ?? null;
  return {
    selectTab: (tab: PrTab) => patchView(id, { tab }),
    selectFile: (path: string | null) => patchView(id, { selectedFile: path }),
    reload: (silent = false) => {
      const target = ref();
      return target ? loadDetail(target, silent) : Promise.resolve();
    },
    clearFocus: () => patchView(id, { focus: null }),
    showFocus: (tab: PrTab, file: string | null) => patchView(id, { tab, ...(file !== null ? { selectedFile: file } : {}) }),
    createThread: (input: NewThread) => write(id, "thread", async ({ detail, target }) => void (await rpc.call("pr.createThread", { ...target, confirmed: true, prId: detail.id, headSha: detail.headSha, pendingReviewId: detail.pendingReview?.id ?? null, ...input }))),
    replyTo: (threadId: string, body: string) => write(id, "reply", async ({ detail, target }) => void (await rpc.call("pr.reply", { ...target, confirmed: true, threadId, body, pendingReviewId: detail.pendingReview?.id ?? null }))),
    addTimelineComment: (body: string) => write(id, "comment", async ({ detail, target }) => void (await rpc.call("pr.addComment", { ...target, confirmed: true, prId: detail.id, body }))),
    editComment: (commentId: string, kind: "review" | "issue", body: string) => write(id, "edit", async () => void (await rpc.call("pr.editComment", { confirmed: true, id: commentId, kind, body }))),
    deleteComment: (commentId: string, kind: "review" | "issue") => write(id, "delete", async () => void (await rpc.call("pr.deleteComment", { confirmed: true, id: commentId, kind }))),
    setResolved: (threadId: string, resolved: boolean) => write(id, "resolve", async () => void (await rpc.call("pr.setResolved", { confirmed: true, threadId, resolved }))),
    submitReview: async (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => {
      const done = await write(id, "review", async ({ detail, target }) => void (await rpc.call("pr.submitReview", { ...target, confirmed: true, prId: detail.id, event, body, pendingReviewId: detail.pendingReview?.id ?? null })));
      if (done) flash(P.submitted);
      return done;
    },
    discardReview: () =>
      write(id, "discard", async ({ detail }) => {
        if (detail.pendingReview) await rpc.call("pr.discardReview", { confirmed: true, pendingReviewId: detail.pendingReview.id });
      }),
    setViewed: async (path: string, viewed: boolean) => {
      const target = ref();
      if (!target) return;
      const key = refKey(target);
      const previous = ui.data[key]?.files ?? null;
      patchData(key, { files: previous?.map((f) => (f.path === path ? { ...f, viewed } : f)) ?? null });
      const done = await write(id, "viewed", async ({ detail }) => void (await rpc.call("pr.setViewed", { ...target, confirmed: true, prId: detail.id, path, viewed })), "none");
      if (!done) patchData(key, { files: previous });
    },
    merge: async (method: PrMergeMethod, commitHeadline: string, commitBody: string, seenHead?: string) => {
      const done = await write(id, "merge", async ({ detail, target }) => void (await rpc.call("pr.merge", { ...target, confirmed: true, prId: detail.id, method, expectedHeadOid: seenHead ?? detail.headSha, commitHeadline, commitBody })));
      if (done) void refreshLists();
      return done;
    },
    readyForReview: () => write(id, "ready", async ({ detail, target }) => void (await rpc.call("pr.readyForReview", { ...target, confirmed: true, prId: detail.id }))),
    deleteBranch: async () => {
      let branch: string | null = null;
      const done = await write(id, "deleteBranch", async ({ detail, target }) => {
        if (!detail.merge.headRefId) throw new Error(P.branchGone);
        branch = (await rpc.call("pr.deleteBranch", { ...target, confirmed: true, headRefId: detail.merge.headRefId })).branch;
      });
      if (done && branch) flash(P.deletedRemoteBranch(branch));
      return done;
    },
    checkout: (reviewText?: string) => checkout(id, reviewText),
    reviewWithClaude: () => {
      const target = ref();
      const detail = target ? ui.data[refKey(target)]?.detail : null;
      if (!target || !detail) return Promise.resolve();
      return checkout(id, P.reviewPrompt(target.repo, detail.number, detail.baseRef));
    },
  };
}

let statusRun: Promise<void> | null = null;
let statusAgain = false;

export function loadStatus(): Promise<void> {
  if (statusRun) {
    statusAgain = true;
    return statusRun;
  }
  statusRun = (async () => {
    set({ statusLoading: true });
    do {
      statusAgain = false;
      try {
        set({ status: await rpc.call("pr.status", {}) });
      } catch (error) {
        set({ status: { available: false, reason: message(error), viewer: null, repos: [] } });
      }
    } while (statusAgain);
    set({ statusLoading: false });
  })().finally(() => {
    statusRun = null;
  });
  return statusRun;
}

async function loadList(repo: string) {
  set((s) => ({ lists: { ...s.lists, [repo]: { data: s.lists[repo]?.data ?? null, loading: true, error: null, at: s.lists[repo]?.at ?? 0 } } }));
  try {
    const data = await rpc.call("pr.list", { repo });
    set((s) => ({ lists: { ...s.lists, [repo]: { data, loading: false, error: null, at: Date.now() } } }));
  } catch (error) {
    set((s) => ({ lists: { ...s.lists, [repo]: { data: s.lists[repo]?.data ?? null, loading: false, error: message(error), at: s.lists[repo]?.at ?? 0 } } }));
  }
}

export async function refreshLists() {
  await loadStatus();
  const repos = ui.status?.available ? ui.status.repos : [];
  await Promise.all(repos.map((repo) => loadList(repo.fullName)));
}

let timer: ReturnType<typeof setInterval> | null = null;
let armed = 0;
let stopWatchingFolders: (() => void) | null = null;

const folderSignature = () => getState().workspaces.map((w) => w.dir).join("\n");
function watchFolders() {
  let seen = folderSignature();
  return subscribe(() => {
    const now = folderSignature();
    if (now === seen) return;
    seen = now;
    void refreshLists();
  });
}

function armTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (!armed || ui.refreshMinutes === 0) return;
  timer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void refreshLists();
    for (const view of visibleViews()) void loadDetail(view.ref, true);
  }, ui.refreshMinutes * 60_000);
}

function visibleViews(): PrView[] {
  const centerOn = getState().centerView === "pr";
  return Object.entries(ui.views)
    .filter(([id]) => id !== CENTER || centerOn)
    .map(([, view]) => view);
}

export function startAutoRefresh() {
  armed++;
  if (armed === 1) {
    void refreshLists();
    armTimer();
    stopWatchingFolders = watchFolders();
  }
  return () => {
    armed--;
    if (armed === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      stopWatchingFolders?.();
      stopWatchingFolders = null;
    }
  };
}

export type PrHint = { tab?: PrTab; anchor?: PrAnchor | null; agentId?: string | null };

export function openPr(repo: string, number: number, hint?: PrHint) {
  openView(CENTER, { repo, number }, hint);
  setState({ centerView: "pr" });
}

export function openPrBeside(repo: string, number: number, hint?: PrHint) {
  const key = openPrTab(repo, number, hint?.agentId);
  openView(key, { repo, number }, hint);
}

export function openView(id: string, ref: PrRef, hint?: PrHint) {
  const current = ui.views[id];
  const same = current !== undefined && refKey(current.ref) === refKey(ref);
  const key = refKey(ref);
  set((s) => ({
    views: {
      ...s.views,
      [id]: same ? { ...current, ...(hint?.tab ? { tab: hint.tab } : {}), ...(hint?.anchor ? { focus: hint.anchor } : {}) } : { ...newView(ref), tab: hint?.tab ?? "overview", focus: hint?.anchor ?? null },
    },
  }));
  if (id === CENTER && !same) sweep();
  void loadDetail(ref, same || ui.data[key]?.detail != null);
}

export function openPrFromLink(repo: string, number: number, hint?: PrHint) {
  if (getState().centerView === "sessions") openPrBeside(repo, number, hint);
  else openPr(repo, number, hint);
}

export function openPrBesideByUrl(url: string, agentId?: string | null) {
  const link = parsePrUrl(url);
  if (link) openPrFromLink(link.repo, link.number, { tab: link.tab, anchor: link.anchor, ...(agentId !== undefined ? { agentId } : {}) });
  else window.open(url, "_blank");
}

export function closePr() {
  setState({ centerView: "sessions" });
}

function sweep() {
  const tabIds = new Set(getState().tabs.filter((t) => t.kind === "pr").map((t) => t.key));
  const views = Object.fromEntries(Object.entries(ui.views).filter(([id]) => id === CENTER || tabIds.has(id)));
  const used = new Set(Object.values(views).map((v) => refKey(v.ref)));
  const data = Object.fromEntries(Object.entries(ui.data).filter(([key]) => used.has(key)));
  if (Object.keys(views).length !== Object.keys(ui.views).length || Object.keys(data).length !== Object.keys(ui.data).length) set({ views, data });
}

let sweptTabs = getState().tabs;
subscribe(() => {
  const tabs = getState().tabs;
  if (tabs === sweptTabs) return;
  sweptTabs = tabs;
  sweep();
});

export function ensureTabView(id: string, ref: PrRef) {
  if (ui.views[id]) {
    if (!ui.data[refKey(ref)]?.detail && !ui.data[refKey(ref)]?.detailLoading) void loadDetail(ref);
    return;
  }
  openView(id, ref);
}

const detailSeq = new Map<string, number>();

export async function loadDetail(ref: PrRef, silent = false) {
  const key = refKey(ref);
  const seq = (detailSeq.get(key) ?? 0) + 1;
  detailSeq.set(key, seq);
  const stale = () => detailSeq.get(key) !== seq;
  if (!silent) patchData(key, { detailLoading: true, detailError: null });
  try {
    const detail = await rpc.call("pr.get", ref);
    if (stale()) return;
    patchData(key, { detail, detailLoading: false, detailError: null });
    const files = await rpc.call("pr.files", { ...ref, prId: detail.id }).catch((error) => {
      if (!stale()) patchData(key, { filesError: message(error) });
      return null;
    });
    if (stale() || !files) return;
    patchData(key, { files, filesError: null });
  } catch (error) {
    if (!stale()) patchData(key, { detailLoading: false, detailError: message(error) });
  }
}

type WriteContext = { detail: PrDetail; target: PrRef };

async function write(id: string, label: string, run: (context: WriteContext) => Promise<void>, after: "detail" | "none" = "detail"): Promise<boolean> {
  const target = ui.views[id]?.ref;
  if (!target) return false;
  const key = refKey(target);
  patchData(key, { busy: label });
  try {
    const detail = ui.data[key]?.detail;
    if (!detail) throw new Error(P.notFound);
    await run({ detail, target });
    if (after === "detail") await loadDetail(target, true);
    return true;
  } catch (error) {
    flash(P.failed(message(error)), "error");
    return false;
  } finally {
    patchData(key, { busy: null });
  }
}

export type NewThread = { path: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; startSide?: "LEFT" | "RIGHT"; body: string; mode: "single" | "review" };

async function checkout(id: string, reviewText?: string) {
  let result: Awaited<ReturnType<typeof rpc.call<"pr.checkout">>> | null = null;
  let pr: PrRef | null = null;
  await write(
    id,
    "checkout",
    async ({ target }) => {
      pr = target;
      result = await rpc.call("pr.checkout", { ...target, confirmed: true });
    },
    "none",
  );
  if (!result || !pr) return;
  const { workspaceId, branch, reused } = result;
  const { repo, number } = pr;
  flash(reused ? P.checkoutReused(branch) : P.checkoutDone(branch));
  if (reviewText) {
    startDraft(workspaceId, activePaneKeepsDraft() ? "new" : "active", { text: reviewText });
    openPrBeside(repo, number, { agentId: null });
    return;
  }
  const { panes, activePaneId } = getState();
  startDraft(workspaceId, panes.find((p) => p.id === activePaneId)?.kind === "draft" ? "active" : "new");
}

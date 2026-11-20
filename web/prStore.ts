import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { PrDetail, PrFile, PrListResult, PrMergeMethod, PrStatusResult } from "../shared/prTypes";
import { parsePrUrl, prRefOfUrl, type PrAnchor, type PrTab } from "../shared/prUrl";
import { rpc } from "./rpc";
import { P } from "./prStrings";
import { activePaneKeepsDraft, flash, getState, openPrTab, setState, startDraft, subscribe } from "./store";

export { prRefOfUrl };
export type { PrAnchor, PrTab };

// PR: Pull Requests 화면의 상태. 쓰기 동작은 이 파일의 함수를 통해서만 데몬에 가고, 모두 사용자가 버튼을 눌렀을 때 부른다(자동 호출 경로 없음).
// store.ts 와 분리한 자체 저장소다. 센터 화면 전환(centerView)과 옆 칸 탭(openPrTab)만 store.ts 에 맡긴다.
//
// PR 화면은 두 자리에 뜬다: 가운데(id "center", 사이드바 목록에서 연 것)와 에디터 칸의 탭(id 가 탭 키, 대화 속 링크에서 연 것). 자리마다 PrView 가 따로 있어서(어느 PR, 어느 탭, 어느 파일)
// 가운데와 옆 칸에 다른 PR 을 동시에 열 수 있다. PR 의 내용(PrData)은 저장소와 번호가 같으면 한 벌만 두므로, 두 자리가 같은 PR 을 열어도 서로 어긋나지 않고 쓰기 뒤의 새로 읽기가 둘 다에 닿는다.
// 쓰기 함수는 늘 "어느 자리에서 눌렀나"(view id)로 PR 을 찾는다. 전역 "열린 PR" 이 없으니 옆 칸에서 쓴 코멘트가 가운데 PR 에 가는 일이 없다.

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
  // Files Changed 의 파일 목록 폭. null 이면 기본 폭(--size-changes-list)
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
    // 저장이 막힌 환경에서는 이번 실행 동안만 유지
  }
}

// 창을 다시 읽어도(⌘R) 가운데 PR 화면이 이어지게, 가운데에 열린 PR 은 세션 저장소에 맡긴다. centerView 는 store.ts 의 다시 읽기 기록이 복원한다.
// 옆 칸 탭은 탭 목록(store.ts)이 저장하고, 탭 화면이 뜰 때 자기 view 를 만든다.
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
      // 저장이 막힌 환경에서는 이번 실행 동안만 유지
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

// 가운데 PR 화면에 열린 PR (없으면 null)
export const getCenterRef = () => ui.views[CENTER]?.ref ?? null;

// React 밖에서 PR 상태 변화를 듣는다(통합 검색의 Recent 기록).
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

// --- 자리(view)와 화면 쪽 훅 ---

// PR 화면 컴포넌트들은 자기가 어느 자리에 있는지(id)를 context 로 받는다. ref 는 view 가 만들어지기 전 첫 프레임용이다(옆 칸 탭이 복원돼 막 뜬 때).
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

// 자리 하나에서 부르는 동작들. 버튼의 onClick 에서만 부른다.
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
    // 주소의 앵커를 화면이 처리했다(스크롤을 마쳤거나 대상이 없다)
    clearFocus: () => patchView(id, { focus: null }),
    // 앵커 대상이 있는 탭과 파일로 옮긴다
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
    // Viewed 는 화면을 먼저 바꾸고 GitHub 에 반영한다. 실패하면 되돌린다.
    setViewed: async (path: string, viewed: boolean) => {
      const target = ref();
      if (!target) return;
      const key = refKey(target);
      const previous = ui.data[key]?.files ?? null;
      patchData(key, { files: previous?.map((f) => (f.path === path ? { ...f, viewed } : f)) ?? null });
      const done = await write(id, "viewed", async ({ detail }) => void (await rpc.call("pr.setViewed", { ...target, confirmed: true, prId: detail.id, path, viewed })), "none");
      if (!done) patchData(key, { files: previous });
    },
    // 머지: 확인 단계의 버튼을 눌렀을 때만 부른다. expectedHeadOid 는 화면이 본 head(확인 단계를 연 때의 seenHead)라서 그 사이 push 가 있으면 GitHub 가 거절한다. 목록의 상태도 바뀌므로 함께 다시 읽는다.
    merge: async (method: PrMergeMethod, commitHeadline: string, commitBody: string, seenHead?: string) => {
      const done = await write(id, "merge", async ({ detail, target }) => void (await rpc.call("pr.merge", { ...target, confirmed: true, prId: detail.id, method, expectedHeadOid: seenHead ?? detail.headSha, commitHeadline, commitBody })));
      if (done) void refreshLists();
      return done;
    },
    readyForReview: () => write(id, "ready", async ({ detail, target }) => void (await rpc.call("pr.readyForReview", { ...target, confirmed: true, prId: detail.id }))),
    // 머지 뒤 원격 head 브랜치 지우기(확장의 Delete Branch... 의 Delete Remote Branch)
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
    // Claude 구독 모델로 리뷰: PR 을 체크아웃하고, 리뷰 요청이 채워진 새 세션 입력창을 연다. GitHub 에는 아무것도 쓰지 않는다.
    reviewWithClaude: () => {
      const target = ref();
      const detail = target ? ui.data[refKey(target)]?.detail : null;
      if (!target || !detail) return Promise.resolve();
      return checkout(id, P.reviewPrompt(target.repo, detail.number, detail.baseRef));
    },
  };
}

// --- 목록 ---

// 읽는 중에 또 요청이 오면(폴더를 더한 직후처럼 저장소 목록이 바뀐 경우) 같은 읽기를 기다리게 하고, 끝난 뒤 한 번 더 읽는다. 옛 목록으로 끝나지 않게.
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

// --- 자동 갱신 ---

let timer: ReturnType<typeof setInterval> | null = null;
let armed = 0;
let stopWatchingFolders: (() => void) | null = null;

// FIX6C: 폴더를 더하거나 빼면 저장소 목록(pr.status)이 달라진다. 자동 갱신 주기를 기다리지 않고 바로 다시 읽는다.
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

// 지금 화면에 떠 있을 수 있는 자리: 가운데 PR 화면이 켜져 있으면 그 PR, 옆 칸 탭은 열려 있는 것 전부
function visibleViews(): PrView[] {
  const centerOn = getState().centerView === "pr";
  return Object.entries(ui.views)
    .filter(([id]) => id !== CENTER || centerOn)
    .map(([, view]) => view);
}

// 사이드바 구역이 떠 있는 동안만 돈다(여러 번 호출돼도 한 번만 시작한다).
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

// --- 열린 PR ---

// agentId 는 옆 칸 탭이 붙을 세션(링크를 누른 대화)이다. 안 주면 활성 칸의 세션이고, null 이면 세션에 붙지 않는 탭이다(web/store.ts openPrTab).
export type PrHint = { tab?: PrTab; anchor?: PrAnchor | null; agentId?: string | null };

// 가운데 PR 화면으로 연다(사이드바 목록, 통합 검색).
export function openPr(repo: string, number: number, hint?: PrHint) {
  openView(CENTER, { repo, number }, hint);
  setState({ centerView: "pr" });
}

// 에디터 칸의 탭으로 연다(대화 속 링크, 세션 칩). 대화는 그대로 보인다. 같은 PR 이 그 세션에 이미 탭으로 열려 있으면 그 탭으로 간다.
// 탭은 링크를 누른 대화의 세션에 붙는다(PRTABSESSION). 다른 세션으로 옮기면 탭줄에서 숨고 돌아오면 다시 보인다.
export function openPrBeside(repo: string, number: number, hint?: PrHint) {
  const key = openPrTab(repo, number, hint?.agentId);
  openView(key, { repo, number }, hint);
}

// 자리에 PR 을 놓고 내용을 읽는다. 같은 PR 이 이미 놓여 있으면 탭과 파일 선택을 그대로 두고(힌트가 있을 때만 옮긴다) 조용히 다시 읽는다.
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

// 링크나 세션 화면의 단추에서 연 PR. 세션 화면이면 옆 칸 탭(대화가 보인다), 보드나 PR 화면처럼 옆 칸이 없는 화면이면 가운데 PR 화면이다.
// 에디터 탭은 세션 화면의 오른쪽 패널에만 보이기 때문이다(web/centerPanels.ts).
export function openPrFromLink(repo: string, number: number, hint?: PrHint) {
  if (getState().centerView === "sessions") openPrBeside(repo, number, hint);
  else openPr(repo, number, hint);
}

// PR 주소(탭과 앵커 포함)를 openPrFromLink 로 연다. PR 주소가 아니면 밖에서 연다. agentId 는 openPrBeside 의 것과 같다.
export function openPrBesideByUrl(url: string, agentId?: string | null) {
  const link = parsePrUrl(url);
  if (link) openPrFromLink(link.repo, link.number, { tab: link.tab, anchor: link.anchor, ...(agentId !== undefined ? { agentId } : {}) });
  else window.open(url, "_blank");
}

export function closePr() {
  setState({ centerView: "sessions" });
}

// 탭이 닫혔거나 가운데 PR 이 바뀌어 아무 자리도 쓰지 않는 PR 의 내용을 버린다. 탭이 닫힌 자리의 view 도 버린다.
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

// 옆 칸 탭 화면이 뜰 때(복원 포함) 자기 view 와 내용을 만든다.
export function ensureTabView(id: string, ref: PrRef) {
  if (ui.views[id]) {
    if (!ui.data[refKey(ref)]?.detail && !ui.data[refKey(ref)]?.detailLoading) void loadDetail(ref);
    return;
  }
  openView(id, ref);
}

// 상세와 파일 목록. 같은 PR 의 읽기가 겹치면 나중 것만 반영한다.
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

// --- 쓰기 ---
// 모든 쓰기는 confirmed: true 를 싣는다. 이 함수들은 버튼의 onClick 에서만 부른다.

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

// 체크아웃: PR 브랜치를 worktree 로 열고, 그 폴더로 새 세션 입력창을 연다. 원격은 바꾸지 않는다.
// reviewText 가 있으면 새 입력창에 그 글을 채워 둔다(Claude 에게 리뷰 시키기). 보내는 건 사용자가 한다.
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
  // Review with Claude: 리뷰 세션 입력창이 가운데 칸을 차지하고 PR 은 오른쪽 패널의 탭으로 옮긴다(옆에 칸을 하나 더 열지 않는다).
  // 쓰던 새 세션 초안이 있을 때만 그 초안을 지키려고 옆 칸에 연다(openAgent 와 같은 규칙). PR 탭은 아직 세션이 없으니 어느 세션에도 붙이지 않는다.
  if (reviewText) {
    startDraft(workspaceId, activePaneKeepsDraft() ? "new" : "active", { text: reviewText });
    openPrBeside(repo, number, { agentId: null });
    return;
  }
  // 지금 칸이 빈 새 세션 화면이면 그 칸을 쓰고, 아니면 옆에 새 칸을 연다
  const { panes, activePaneId } = getState();
  startDraft(workspaceId, panes.find((p) => p.id === activePaneId)?.kind === "draft" ? "active" : "new");
}

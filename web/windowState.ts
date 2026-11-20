import type { ChatAnchor } from "./chatAnchor";
import { MAIN_GROUP } from "./editorGroups";
import { windowStorage } from "./windowStorage";

// 창 상태 복원(round-4 발견 5). 칸, 편집기 탭, 사이드바와 패널, 대화 스크롤, 입력창 초안을 localStorage 에 변경 때마다 남겨서 앱을 껐다 켜도 돌아오게 한다.
// 같은 저장본을 Reload Window(sessionStorage)도 쓴다. 여기는 store 를 모르는 순수 로직과 작은 등록부만 둔다(test/windowstate.test.ts).

export const WINDOW_STATE_KEY = "agent-nav:window-state";
export const WINDOW_STATE_VERSION = 1;

export type EditorPos = { anchor: number; head: number; scrollTop: number };
// atBottom 이면 복원하지 않는다(새 글이 오면 바닥을 따라간다). anchor 는 화면 맨 위를 지나는 메시지와 그 안 오프셋이고(web/chatAnchor.ts), top 은 기준 메시지가 사라졌거나 옛 저장본일 때의 대체 값이다.
export type ChatScroll = { top: number; atBottom: boolean; anchor?: ChatAnchor };

// 칸이나 탭 구조 밖의, 보이는 화면에서만 읽을 수 있는 값들
export type WindowExtras = {
  editorPos: Record<string, EditorPos>;
  chatScroll: Record<string, ChatScroll>;
  drafts: Record<string, string>;
  panelWidths: Record<string, number>;
  // FIX6C: 입력창에 붙은 인계 문서 칩. 키는 첨부 키(세션 id 또는 `new:<칸 id>`, web/composerState.ts attachmentKey)
  handoffs: Record<string, SavedHandoff[]>;
};

// 인계 문서 칩 중 문서가 다 만들어진 것(status ready)만 남긴다. 만드는 중이던 칩은 요청이 앱과 함께 끝났으니 되살릴 수 없다.
export type SavedHandoff = { id: string; workspaceId: string | null; sourceId: string; title: string; docId: string; text: string };
type ChipLike = { id: string; workspaceId: string | null; text: string | null; handoff?: { sourceId: string; title: string; status: string; id: string | null } };
export const HANDOFF_SAVE_LIMIT = 200_000;

export function snapshotHandoffs(attachments: Record<string, ChipLike[]>): Record<string, SavedHandoff[]> {
  const out: Record<string, SavedHandoff[]> = {};
  for (const [key, chips] of Object.entries(attachments)) {
    const kept: SavedHandoff[] = [];
    for (const chip of chips) {
      const handoff = chip.handoff;
      if (!handoff || handoff.status !== "ready" || !handoff.id || chip.text === null || chip.text.length > HANDOFF_SAVE_LIMIT) continue;
      kept.push({ id: chip.id, workspaceId: chip.workspaceId, sourceId: handoff.sourceId, title: handoff.title, docId: handoff.id, text: chip.text });
    }
    if (kept.length) out[key] = kept;
  }
  return out;
}

// 저장본의 칩을 입력창 첨부 모양으로 되살린다. 새 세션 화면 키(`new:<칸 id>`)는 그 칸이 남아 있을 때만 되살린다. 세션 키는 지워진 세션이면 pruneExtras 가 걸러 둔다.
export function restoreHandoffs(saved: Record<string, SavedHandoff[]>, paneIds: ReadonlySet<string>) {
  const out: Record<string, { id: string; workspaceId: string | null; path: string; startLine: null; endLine: null; text: string; handoff: { sourceId: string; title: string; status: "ready"; id: string } }[]> = {};
  for (const [key, chips] of Object.entries(saved)) {
    if (key.startsWith("new:") && !paneIds.has(key.slice(4))) continue;
    out[key] = chips.map((c) => ({ id: c.id, workspaceId: c.workspaceId, path: c.sourceId, startLine: null, endLine: null, text: c.text, handoff: { sourceId: c.sourceId, title: c.title, status: "ready" as const, id: c.docId } }));
  }
  return out;
}

// --- 읽기 등록부: 화면에 떠 있는 에디터와 대화가 자기 위치를 알려 준다 ---

const editorReaders = new Map<string, () => EditorPos | null>();
const chatReaders = new Map<string, () => ChatScroll | null>();

export function registerEditorReader(tabKey: string, read: () => EditorPos | null) {
  editorReaders.set(tabKey, read);
  return () => {
    if (editorReaders.get(tabKey) === read) editorReaders.delete(tabKey);
  };
}

export function registerChatReader(agentId: string, read: () => ChatScroll | null) {
  chatReaders.set(agentId, read);
  return () => {
    if (chatReaders.get(agentId) === read) chatReaders.delete(agentId);
  };
}

// --- 복원 대기: 저장본에서 읽어 왔지만 화면이 아직 받아 가지 않은 값 ---

let pendingEditors: Record<string, EditorPos> = {};
let pendingChats: Record<string, ChatScroll> = {};

export function setPendingRestore(extras: Pick<WindowExtras, "editorPos" | "chatScroll">) {
  pendingEditors = { ...extras.editorPos };
  pendingChats = { ...extras.chatScroll };
}

// 한 번만 돌려준다. 받아 간 뒤에는 화면의 읽기 등록부가 그 값을 이어 저장한다.
export function takeEditorRestore(tabKey: string): EditorPos | null {
  const found = pendingEditors[tabKey] ?? null;
  delete pendingEditors[tabKey];
  return found;
}

export function takeChatRestore(agentId: string): ChatScroll | null {
  const found = pendingChats[agentId] ?? null;
  delete pendingChats[agentId];
  return found;
}

// 지금 저장할 값: 화면이 읽어 준 것이 우선이고, 아직 화면이 받아 가지 않은 복원 대기 값(탭이나 세션이 아직 살아 있는 것)을 그대로 이어 간다.
export function collectExtras(alive: { tabKeys: ReadonlySet<string>; agentIds: ReadonlySet<string> }, base: Pick<WindowExtras, "drafts" | "panelWidths" | "handoffs">): WindowExtras {
  const editorPos: Record<string, EditorPos> = {};
  for (const [key, pos] of Object.entries(pendingEditors)) if (alive.tabKeys.has(key)) editorPos[key] = pos;
  for (const [key, read] of editorReaders) {
    const pos = read();
    if (pos && alive.tabKeys.has(key)) editorPos[key] = pos;
  }
  const chatScroll: Record<string, ChatScroll> = {};
  for (const [id, scroll] of Object.entries(pendingChats)) if (alive.agentIds.has(id)) chatScroll[id] = scroll;
  for (const [id, read] of chatReaders) {
    const scroll = read();
    if (scroll && alive.agentIds.has(id)) chatScroll[id] = scroll;
  }
  return { editorPos, chatScroll, drafts: base.drafts, panelWidths: base.panelWidths, handoffs: base.handoffs };
}

// --- 저장 예약 ---

let saver: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
export const SAVE_DELAY_MS = 400;

export function setWindowSaver(fn: (() => void) | null) {
  saver = fn;
}

// 스크롤, 커서, 초안처럼 store 를 거치지 않는 변화도 이 호출로 저장을 예약한다. 마지막 변화 뒤 SAVE_DELAY_MS 가 지나면 한 번 쓴다.
export function noteWindowChanged() {
  if (!saver) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    saver?.();
  }, SAVE_DELAY_MS);
}

// 예약된 저장이 있으면 기다리지 않고 지금 쓴다. 창을 닫거나 다시 읽기 직전에 부른다.
export function flushWindowChanged() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  saver?.();
}

// --- 저장본 읽기와 정리 ---

export type TabLike = { key: string; kind: string; workspaceId?: string; agentId?: string; group?: string };

// 저장본의 형태가 쓸 만한지 거른다. 모르는 버전이나 깨진 글은 null(복원하지 않는다).
export function parseWindowState<T extends { panes?: unknown; tabs?: unknown }>(raw: string | null): (T & { extras: WindowExtras }) | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.version !== undefined && value.version !== WINDOW_STATE_VERSION) return null;
    if (value.panes !== undefined && !Array.isArray(value.panes)) return null;
    if (value.tabs !== undefined && !Array.isArray(value.tabs)) return null;
    return { ...(value as T), extras: sanitizeExtras(value.extras) };
  } catch {
    return null;
  }
}

function record<V>(value: unknown, accept: (v: unknown) => v is V): Record<string, V> {
  const out: Record<string, V> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) if (accept(entry)) out[key] = entry;
  return out;
}

const isText = (v: unknown): v is string => typeof v === "string";

function cleanHandoffs(value: unknown): Record<string, SavedHandoff[]> {
  const out: Record<string, SavedHandoff[]> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const kept = list.flatMap((c): SavedHandoff[] => {
      const chip = c as Partial<SavedHandoff> | null;
      if (!chip || !isText(chip.id) || !isText(chip.sourceId) || !isText(chip.title) || !isText(chip.docId) || !isText(chip.text)) return [];
      return [{ id: chip.id, workspaceId: isText(chip.workspaceId) ? chip.workspaceId : null, sourceId: chip.sourceId, title: chip.title, docId: chip.docId, text: chip.text }];
    });
    if (kept.length) out[key] = kept;
  }
  return out;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function sanitizeExtras(value: unknown): WindowExtras {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    editorPos: record(raw.editorPos, (v): v is EditorPos => !!v && typeof v === "object" && isNum((v as EditorPos).anchor) && isNum((v as EditorPos).head) && isNum((v as EditorPos).scrollTop)),
    chatScroll: Object.fromEntries(Object.entries(record(raw.chatScroll, (v): v is ChatScroll => !!v && typeof v === "object" && isNum((v as ChatScroll).top) && typeof (v as ChatScroll).atBottom === "boolean")).map(([id, scroll]) => [id, cleanScroll(scroll)])),
    drafts: record(raw.drafts, (v): v is string => typeof v === "string" && v.length > 0),
    panelWidths: record(raw.panelWidths, isNum),
    handoffs: cleanHandoffs(raw.handoffs),
  };
}

// 기준 메시지가 모양이 맞지 않으면(깨진 저장본) 버리고 픽셀 값만 쓴다.
function cleanScroll(scroll: ChatScroll): ChatScroll {
  const anchor = scroll.anchor as Partial<ChatAnchor> | undefined;
  const valid = !!anchor && typeof anchor.turn === "string" && anchor.turn.length > 0 && Number.isInteger(anchor.child) && isNum(anchor.offset);
  return valid ? { top: scroll.top, atBottom: scroll.atBottom, anchor: { turn: anchor.turn!, child: anchor.child!, offset: anchor.offset! } } : { top: scroll.top, atBottom: scroll.atBottom };
}

export type KnownIds = {
  workspaceIds: ReadonlySet<string>;
  agentIds: ReadonlySet<string>;
  // 디스크에서 사라진 파일 탭의 키
  missingFileKeys: ReadonlySet<string>;
};

export type TabState<T extends TabLike> = {
  tabs: T[];
  filesIndex: number;
  activeTabKey: string | null;
  groupActive: Record<string, string | null>;
  mainEditorKey: string | null;
  activeWorkspaceId: string | null;
};

// 사라진 폴더, 세션, 파일을 가리키는 탭을 조용히 뺀다. 가리키던 활성 탭은 Changes 로, 그룹의 활성 탭은 없음으로 돌아가고 Files 탭 자리(filesIndex)는 빠진 앞쪽 탭 수만큼 당겨진다.
export function pruneTabState<T extends TabLike>(state: TabState<T>, known: KnownIds): TabState<T> {
  const gone = (tab: T) => {
    if (tab.kind === "browser" || tab.kind === "untitled") return false;
    if (tab.workspaceId !== undefined && !known.workspaceIds.has(tab.workspaceId)) return true;
    if ((tab.kind === "diff" || tab.kind === "pr" || tab.kind === "chat") && tab.agentId !== undefined && !known.agentIds.has(tab.agentId)) return true;
    return tab.kind === "file" && known.missingFileKeys.has(tab.key);
  };
  const dropped = new Set(state.tabs.filter(gone).map((t) => t.key));
  const activeWorkspaceId = state.activeWorkspaceId !== null && !known.workspaceIds.has(state.activeWorkspaceId) ? null : state.activeWorkspaceId;
  if (dropped.size === 0) return activeWorkspaceId === state.activeWorkspaceId ? state : { ...state, activeWorkspaceId };
  const main = state.tabs.filter((t) => (t.group ?? MAIN_GROUP) === MAIN_GROUP);
  const droppedBefore = main.slice(0, state.filesIndex).filter((t) => dropped.has(t.key)).length;
  const groupActive: Record<string, string | null> = {};
  for (const [group, key] of Object.entries(state.groupActive)) groupActive[group] = key !== null && dropped.has(key) ? null : key;
  return {
    ...state,
    tabs: state.tabs.filter((t) => !dropped.has(t.key)),
    filesIndex: Math.max(0, state.filesIndex - droppedBefore),
    activeTabKey: state.activeTabKey !== null && dropped.has(state.activeTabKey) ? "changes" : state.activeTabKey,
    groupActive,
    mainEditorKey: state.mainEditorKey !== null && dropped.has(state.mainEditorKey) ? null : state.mainEditorKey,
    activeWorkspaceId,
  };
}

// 지워진 세션의 초안과 대화 위치를 뺀다. 새 세션 칸의 초안(`new:` 접두)은 칸 id 로 묶여 있어 그대로 둔다.
export function pruneExtras(extras: WindowExtras, agentIds: ReadonlySet<string>): WindowExtras {
  const drafts: Record<string, string> = {};
  for (const [key, text] of Object.entries(extras.drafts)) if (key.startsWith("new:") || agentIds.has(key)) drafts[key] = text;
  const chatScroll: Record<string, ChatScroll> = {};
  for (const [id, scroll] of Object.entries(extras.chatScroll)) if (agentIds.has(id)) chatScroll[id] = scroll;
  const handoffs: Record<string, SavedHandoff[]> = {};
  for (const [key, chips] of Object.entries(extras.handoffs)) if (key.startsWith("new:") || agentIds.has(key)) handoffs[key] = chips;
  return { ...extras, drafts, chatScroll, handoffs };
}

// 앱을 새로 켰을 때는 배치(Chat 중심, Editor 중심)를 저장본이 정하지 않는다. Settings 의 Default layout 과 Remember last layout 이 정한다.
export function forLaunch<T extends { layoutMode?: unknown }>(snapshot: T): Omit<T, "layoutMode"> {
  const { layoutMode: _layout, ...rest } = snapshot;
  return rest;
}

// 에디터 위치를 문서 길이 안으로 맞춘다.
export function clampEditorPos(pos: EditorPos, docLength: number): EditorPos {
  const clamp = (n: number) => Math.min(Math.max(Math.round(n), 0), docLength);
  return { anchor: clamp(pos.anchor), head: clamp(pos.head), scrollTop: Math.max(0, pos.scrollTop) };
}


export const HOT_EXIT_KEY = "agent-nav:hot-exit";
export const HOT_EXIT_VERSION = 1;
// localStorage 는 출처당 약 5M 글자다. 창 상태 저장본과 나눠 쓸 수 있게 2M 글자까지만 보관한다. 넘는 탭은 건너뛰고 다음 실행에서 알린다.
export const HOT_EXIT_MAX_CHARS = 2_000_000;
export const HOT_SAVE_DELAY_MS = 500;

export type HotDoc = { text: string; baseMtimeMs: number | null };
export type HotExit = { docs: Record<string, HotDoc>; skipped: string[] };

const hotReaders = new Map<string, () => HotDoc | null>();
let pendingHot: Record<string, HotDoc> = {};
let pendingSkipped = new Set<string>();

// 에디터가 문서를 붙일 때 등록한다. 수정이 있는 동안만 값을 내고, 저장돼 깨끗하면 null.
export function registerHotReader(tabKey: string, read: () => HotDoc | null) {
  hotReaders.set(tabKey, read);
  noteHotChanged();
  return () => {
    if (hotReaders.get(tabKey) !== read) return;
    hotReaders.delete(tabKey);
    noteHotChanged();
  };
}

// 저장본에서 읽어 왔지만 에디터가 아직 받아 가지 않은 내용. 탭이 살아 있는 동안 다음 저장에 그대로 이어 간다.
export function setPendingHot(hot: HotExit) {
  pendingHot = { ...hot.docs };
  pendingSkipped = new Set(hot.skipped);
}

export function takeHotRestore(tabKey: string): HotDoc | null {
  const found = pendingHot[tabKey] ?? null;
  delete pendingHot[tabKey];
  return found;
}

export function takeHotSkipped(tabKey: string): boolean {
  return pendingSkipped.delete(tabKey);
}

// 지금 보관할 내용. alive 는 열려 있는 탭 키(탭 순서). 에디터가 읽어 준 값이 우선이고, 아직 에디터가 안 받아 간 복원 대기 값을 잇는다. 총 글자 수가 상한을 넘으면 뒤 탭부터 건너뛴다.
export function collectHotExit(alive: ReadonlySet<string>, maxChars = HOT_EXIT_MAX_CHARS): HotExit {
  const docs: Record<string, HotDoc> = {};
  const skipped: string[] = [];
  let total = 0;
  for (const key of alive) {
    const live = hotReaders.get(key)?.() ?? null;
    const doc = live ?? pendingHot[key] ?? null;
    if (!doc) {
      if (pendingSkipped.has(key)) skipped.push(key);
      continue;
    }
    if (total + doc.text.length > maxChars) {
      skipped.push(key);
      continue;
    }
    total += doc.text.length;
    docs[key] = doc;
  }
  return { docs, skipped };
}

export function serializeHotExit(hot: HotExit): string | null {
  if (Object.keys(hot.docs).length === 0 && hot.skipped.length === 0) return null;
  return JSON.stringify({ version: HOT_EXIT_VERSION, docs: hot.docs, skipped: hot.skipped });
}

export function parseHotExit(raw: string | null): HotExit {
  const empty: HotExit = { docs: {}, skipped: [] };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || value.version !== HOT_EXIT_VERSION) return empty;
    const docs: Record<string, HotDoc> = {};
    if (value.docs && typeof value.docs === "object" && !Array.isArray(value.docs)) {
      for (const [key, entry] of Object.entries(value.docs as Record<string, unknown>)) {
        const doc = entry as Partial<HotDoc> | null;
        if (doc && typeof doc.text === "string" && (doc.baseMtimeMs === null || isNum(doc.baseMtimeMs))) docs[key] = { text: doc.text, baseMtimeMs: doc.baseMtimeMs };
      }
    }
    const skipped = Array.isArray(value.skipped) ? value.skipped.filter((k): k is string => typeof k === "string") : [];
    return { docs, skipped };
  } catch {
    return empty;
  }
}

// 복원한 내용을 디스크에서 읽은 문서에 올릴 때의 판단. 디스크 수정 시각이 보관할 때와 다르면 그 사이 밖에서 바뀐 것이라 충돌 안내를 띄운다(덮어쓰기는 사용자가 정한다).
// 이름 없는 탭(디스크 시각이 null)은 항상 외부 변경이 없다.
export function planHotRestore(diskMtimeMs: number | null, hot: HotDoc): { externalChange: boolean } {
  return { externalChange: diskMtimeMs !== null && hot.baseMtimeMs !== null && diskMtimeMs !== hot.baseMtimeMs };
}

// --- 저장 ---

type HotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
let hotAlive: (() => ReadonlySet<string>) | null = null;
let hotTimer: ReturnType<typeof setTimeout> | null = null;

export function setHotAliveProvider(fn: (() => ReadonlySet<string>) | null) {
  hotAlive = fn;
}

function defaultStorage(): HotStorage | null {
  return windowStorage();
}

export function loadHotExit(storage: HotStorage | null = defaultStorage()): HotExit {
  try {
    return parseHotExit(storage?.getItem(HOT_EXIT_KEY) ?? null);
  } catch {
    return { docs: {}, skipped: [] };
  }
}

// 지금 동기로 쓴다. 보관할 것이 없으면 키를 지운다. 저장이 막혀도(용량, 비공개 모드) 화면은 그대로 동작한다.
export function saveHotExitNow(storage: HotStorage | null = defaultStorage()) {
  if (hotTimer) clearTimeout(hotTimer);
  hotTimer = null;
  if (!storage || !hotAlive) return;
  try {
    const raw = serializeHotExit(collectHotExit(hotAlive()));
    if (raw === null) storage.removeItem(HOT_EXIT_KEY);
    else storage.setItem(HOT_EXIT_KEY, raw);
  } catch {
    // 용량을 넘었거나 막힌 저장소
  }
}

// 사용자가 "버려도 된다" 고 확인한 뒤의 다시 읽기(Reload Window, Restart Daemon)는 보관한 내용을 지워 되살리지 않는다.
export function clearHotExit(storage: HotStorage | null = defaultStorage()) {
  if (hotTimer) clearTimeout(hotTimer);
  hotTimer = null;
  pendingHot = {};
  try {
    storage?.removeItem(HOT_EXIT_KEY);
  } catch {
    // 막힌 저장소
  }
}

// 내용이 바뀌었거나 수정 표시가 켜지고 꺼질 때 부른다. 마지막 변화 뒤 HOT_SAVE_DELAY_MS 가 지나면 한 번 쓴다.
export function noteHotChanged() {
  if (!hotAlive) return;
  if (hotTimer) clearTimeout(hotTimer);
  hotTimer = setTimeout(() => {
    hotTimer = null;
    saveHotExitNow();
  }, HOT_SAVE_DELAY_MS);
}

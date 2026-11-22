import type { ChatAnchor } from "./chatAnchor";
import { MAIN_GROUP } from "./editorGroups";
import { windowStorage } from "./windowStorage";

export const WINDOW_STATE_KEY = "agent-nav:window-state";
export const WINDOW_STATE_VERSION = 1;

export type EditorPos = { anchor: number; head: number; scrollTop: number };
export type ChatScroll = { top: number; atBottom: boolean; anchor?: ChatAnchor };

export type WindowExtras = {
  editorPos: Record<string, EditorPos>;
  chatScroll: Record<string, ChatScroll>;
  drafts: Record<string, string>;
  panelWidths: Record<string, number>;
  handoffs: Record<string, SavedHandoff[]>;
};

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

export function restoreHandoffs(saved: Record<string, SavedHandoff[]>, paneIds: ReadonlySet<string>) {
  const out: Record<string, { id: string; workspaceId: string | null; path: string; startLine: null; endLine: null; text: string; handoff: { sourceId: string; title: string; status: "ready"; id: string } }[]> = {};
  for (const [key, chips] of Object.entries(saved)) {
    if (key.startsWith("new:") && !paneIds.has(key.slice(4))) continue;
    out[key] = chips.map((c) => ({ id: c.id, workspaceId: c.workspaceId, path: c.sourceId, startLine: null, endLine: null, text: c.text, handoff: { sourceId: c.sourceId, title: c.title, status: "ready" as const, id: c.docId } }));
  }
  return out;
}

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

let pendingEditors: Record<string, EditorPos> = {};
let pendingChats: Record<string, ChatScroll> = {};

export function setPendingRestore(extras: Pick<WindowExtras, "editorPos" | "chatScroll">) {
  pendingEditors = { ...extras.editorPos };
  pendingChats = { ...extras.chatScroll };
}

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

let saver: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
export const SAVE_DELAY_MS = 400;

export function setWindowSaver(fn: (() => void) | null) {
  saver = fn;
}

export function noteWindowChanged() {
  if (!saver) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    saver?.();
  }, SAVE_DELAY_MS);
}

export function flushWindowChanged() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  saver?.();
}

export type TabLike = { key: string; kind: string; workspaceId?: string; agentId?: string; group?: string };

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

function cleanScroll(scroll: ChatScroll): ChatScroll {
  const anchor = scroll.anchor as Partial<ChatAnchor> | undefined;
  const valid = !!anchor && typeof anchor.turn === "string" && anchor.turn.length > 0 && Number.isInteger(anchor.child) && isNum(anchor.offset);
  return valid ? { top: scroll.top, atBottom: scroll.atBottom, anchor: { turn: anchor.turn!, child: anchor.child!, offset: anchor.offset! } } : { top: scroll.top, atBottom: scroll.atBottom };
}

export type KnownIds = {
  workspaceIds: ReadonlySet<string>;
  agentIds: ReadonlySet<string>;
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

export function pruneExtras(extras: WindowExtras, agentIds: ReadonlySet<string>): WindowExtras {
  const drafts: Record<string, string> = {};
  for (const [key, text] of Object.entries(extras.drafts)) if (key.startsWith("new:") || agentIds.has(key)) drafts[key] = text;
  const chatScroll: Record<string, ChatScroll> = {};
  for (const [id, scroll] of Object.entries(extras.chatScroll)) if (agentIds.has(id)) chatScroll[id] = scroll;
  const handoffs: Record<string, SavedHandoff[]> = {};
  for (const [key, chips] of Object.entries(extras.handoffs)) if (key.startsWith("new:") || agentIds.has(key)) handoffs[key] = chips;
  return { ...extras, drafts, chatScroll, handoffs };
}

export function forLaunch<T extends { layoutMode?: unknown }>(snapshot: T): Omit<T, "layoutMode"> {
  const { layoutMode: _layout, ...rest } = snapshot;
  return rest;
}

export function clampEditorPos(pos: EditorPos, docLength: number): EditorPos {
  const clamp = (n: number) => Math.min(Math.max(Math.round(n), 0), docLength);
  return { anchor: clamp(pos.anchor), head: clamp(pos.head), scrollTop: Math.max(0, pos.scrollTop) };
}


export const HOT_EXIT_KEY = "agent-nav:hot-exit";
export const HOT_EXIT_VERSION = 1;
export const HOT_EXIT_MAX_CHARS = 2_000_000;
export const HOT_SAVE_DELAY_MS = 500;

export type HotDoc = { text: string; baseMtimeMs: number | null };
export type HotExit = { docs: Record<string, HotDoc>; skipped: string[] };

const hotReaders = new Map<string, () => HotDoc | null>();
let pendingHot: Record<string, HotDoc> = {};
let pendingSkipped = new Set<string>();

export function registerHotReader(tabKey: string, read: () => HotDoc | null) {
  hotReaders.set(tabKey, read);
  noteHotChanged();
  return () => {
    if (hotReaders.get(tabKey) !== read) return;
    hotReaders.delete(tabKey);
    noteHotChanged();
  };
}

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

export function planHotRestore(diskMtimeMs: number | null, hot: HotDoc): { externalChange: boolean } {
  return { externalChange: diskMtimeMs !== null && hot.baseMtimeMs !== null && diskMtimeMs !== hot.baseMtimeMs };
}

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

export function saveHotExitNow(storage: HotStorage | null = defaultStorage()) {
  if (hotTimer) clearTimeout(hotTimer);
  hotTimer = null;
  if (!storage || !hotAlive) return;
  try {
    const raw = serializeHotExit(collectHotExit(hotAlive()));
    if (raw === null) storage.removeItem(HOT_EXIT_KEY);
    else storage.setItem(HOT_EXIT_KEY, raw);
  } catch {
  }
}

export function clearHotExit(storage: HotStorage | null = defaultStorage()) {
  if (hotTimer) clearTimeout(hotTimer);
  hotTimer = null;
  pendingHot = {};
  try {
    storage?.removeItem(HOT_EXIT_KEY);
  } catch {
  }
}

export function noteHotChanged() {
  if (!hotAlive) return;
  if (hotTimer) clearTimeout(hotTimer);
  hotTimer = setTimeout(() => {
    hotTimer = null;
    saveHotExitNow();
  }, HOT_SAVE_DELAY_MS);
}

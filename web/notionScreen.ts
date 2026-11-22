import { useSyncExternalStore } from "react";
import { isNotionUrl, notionPageKey } from "../shared/notionLink";
import type { NotionPageView } from "../shared/protocol";
import { rpc } from "./rpc";
import { getState, setState, startDraft } from "./store";

export type NotionScreen = {
  url: string | null;
  view: NotionPageView | null;
  loading: boolean;
  error: string | null;
  chats: Record<string, string>;
};

const PREFS_KEY = "agent-nav:notion-screen";
const RECENT_MS = 30_000;

function loadUrl(): string | null {
  try {
    const url = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}").url;
    return typeof url === "string" && isNotionUrl(url) ? url : null;
  } catch {
    return null;
  }
}

let ui: NotionScreen = { url: loadUrl(), view: null, loading: false, error: null, chats: {} };
const listeners = new Set<() => void>();

function set(patch: Partial<NotionScreen>) {
  ui = { ...ui, ...patch };
  for (const listener of listeners) listener();
}

export function useNotionScreen<T>(select: (ui: NotionScreen) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(ui),
  );
}

let readSeq = 0;

export function openNotionScreen(url: string) {
  if (!isNotionUrl(url)) return;
  const same = ui.url !== null && notionPageKey(ui.url) === notionPageKey(url);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ url }));
  } catch {
  }
  set({ url, view: same ? ui.view : null, error: null });
  setState({ centerView: "notion" });
  if (same && ui.view && !ui.loading && Date.now() - Date.parse(ui.view.fetchedAt) < RECENT_MS) return;
  void loadScreen(url, same);
}

async function loadScreen(url: string, keepView: boolean) {
  const seq = ++readSeq;
  if (!keepView) {
    const cached = await rpc.call("notion.page.cached", { url }).catch(() => null);
    if (seq !== readSeq) return;
    if (cached) set({ view: cached });
  }
  await readNow(url, seq);
}

async function readNow(url: string, seq: number) {
  set({ loading: true, error: null });
  try {
    const view = await rpc.call("notion.page.read", { url });
    if (seq !== readSeq) return;
    set({ view, loading: false });
  } catch (error) {
    if (seq !== readSeq) return;
    set({ loading: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export function refreshNotionScreen() {
  if (!ui.url) return;
  void readNow(ui.url, ++readSeq);
}

export const chatOfPage = (chats: Record<string, string>, url: string | null) => (url ? (chats[notionPageKey(url)] ?? null) : null);

export function initNotionScreen() {
  rpc.onStatus((connected) => {
    if (!connected) return;
    void rpc.call("notion.chats.list", {}).then((chats) => set({ chats })).catch(() => undefined);
    if (getState().centerView === "notion" && ui.url) void loadScreen(ui.url, false);
  });
  rpc.onEvent((event) => {
    if (event.type === "notionChats") set({ chats: event.chats });
    else if (event.type === "notionChanged" && ui.url && notionPageKey(ui.url) === event.key) refreshNotionScreen();
    else if (event.type === "notionStartSession") startDraft(null, "new", { text: event.prompt });
  });
}

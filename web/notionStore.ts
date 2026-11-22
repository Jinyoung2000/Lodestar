import { useSyncExternalStore } from "react";
import { isNotionUrl, notionOpenPlan, notionTitleFromUrl, sameNotionPage } from "../shared/notionLink";
import { openNotionScreen } from "./notionScreen";
import { pinMatches, type NotionPin, type NotionPinInput } from "../shared/notionPins";
import { readTitleInBackground } from "./notionPage";
import { N } from "./notionStrings";
import { hint } from "./hint";
import { rpc } from "./rpc";
import { flash, getState, openBrowser, setState, subscribe, type BrowserTab } from "./store";

type NotionUi = { pins: NotionPin[] | null };

let ui: NotionUi = { pins: null };
const listeners = new Set<() => void>();

function set(patch: Partial<NotionUi>) {
  ui = { ...ui, ...patch };
  for (const listener of listeners) listener();
}

export function useNotion<T>(select: (ui: NotionUi) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(ui),
  );
}

export const notionPins = () => ui.pins ?? [];

const fail = (error: unknown) => flash(error instanceof Error ? error.message : String(error));

export async function pinNotionPage(input: NotionPinInput, quiet = false): Promise<NotionPin | null> {
  try {
    const { pin, added } = await rpc.call("notion.pins.add", input);
    if (added && !quiet) hint(N.pinned, undefined, { check: true });
    if (added && pin.titleSource === "url") void refineTitle(pin);
    return pin;
  } catch (error) {
    fail(error);
    return null;
  }
}

async function refineTitle(pin: NotionPin) {
  const title = await readTitleInBackground(pin.url).catch(() => null);
  if (!title || title === pin.title) return;
  const current = ui.pins?.find((p) => p.id === pin.id);
  if (current && current.titleSource === "url") await rpc.call("notion.pins.update", { id: pin.id, patch: { title, titleSource: "page" } }).catch(() => undefined);
}

export async function unpinNotionPage(id: string) {
  try {
    await rpc.call("notion.pins.remove", { id });
    hint(N.unpinned, undefined, { check: true });
  } catch (error) {
    fail(error);
  }
}

export const pinFor = (pins: NotionPin[] | null, url: string) => (pins ?? []).find((p) => isNotionUrl(url) && pinMatches(p, url)) ?? null;

export function usePinFor(url: string) {
  return useNotion((s) => pinFor(s.pins, url));
}

export async function togglePinOfTab(tab: Pick<BrowserTab, "url" | "title">) {
  const existing = pinFor(ui.pins, tab.url);
  if (existing) return unpinNotionPage(existing.id);
  await pinNotionPage({ title: usableTitle(tab.title, tab.url) ?? "", url: tab.url });
}

export function usableTitle(title: string, url: string): string | null {
  const text = title.trim();
  if (!text || text === "Notion" || text === url || text === new URL(url).host) return null;
  return text;
}

const syncedTitles = new Map<string, string>();
function syncPinTitles() {
  for (const tab of getState().tabs) {
    if (tab.kind !== "browser" || !isNotionUrl(tab.url)) continue;
    const title = usableTitle(tab.title, tab.url);
    const pin = title ? pinFor(ui.pins, tab.url) : null;
    if (!title || !pin || pin.titleSource === "user" || pin.title === title || syncedTitles.get(pin.id) === title) continue;
    syncedTitles.set(pin.id, title);
    void rpc.call("notion.pins.update", { id: pin.id, patch: { title, titleSource: "page" } }).catch(() => syncedTitles.delete(pin.id));
  }
}

export function openNotionInApp(url: string): string {
  const existing = getState().tabs.find((t): t is BrowserTab => t.kind === "browser" && sameNotionPage(t.url, url));
  if (existing) {
    setState({ activeTabKey: existing.key, rightOpen: true, centerView: "sessions" });
    return existing.key;
  }
  const key = openBrowser(url);
  setState({ centerView: "sessions" });
  return key;
}

export const guessTitle = (url: string) => notionTitleFromUrl(url) ?? "";

export function initNotion() {
  rpc.onStatus((connected) => {
    if (!connected) return;
    void rpc.call("notion.pins.list", {}).then((pins) => set({ pins })).catch(() => set({ pins: null }));
  });
  rpc.onEvent((event) => {
    if (event.type === "notionPins") set({ pins: event.pins });
  });
  subscribe(syncPinTitles);
  window.addEventListener("agent-nav:open-notion", (event) => {
    const url = (event as CustomEvent<unknown>).detail;
    if (typeof url !== "string" || !isNotionUrl(url)) return;
    if (notionOpenPlan(url, getState().settings ?? {})?.via === "screen") openNotionScreen(url);
    else openNotionInApp(url);
  });
}

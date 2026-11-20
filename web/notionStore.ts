import { useSyncExternalStore } from "react";
import { isNotionUrl, notionOpenPlan, notionTitleFromUrl, sameNotionPage } from "../shared/notionLink";
import { openNotionScreen } from "./notionScreen";
import { pinMatches, type NotionPin, type NotionPinInput } from "../shared/notionPins";
import { readTitleInBackground } from "./notionPage";
import { N } from "./notionStrings";
import { hint } from "./hint";
import { rpc } from "./rpc";
import { flash, getState, openBrowser, setState, subscribe, type BrowserTab } from "./store";

// NOTION: 사이드바 Notion 묶음의 상태와 고정 동작. 목록의 정본은 데몬(notion.pins.*)이고, 여기는 notionPins 이벤트로 받은 사본만 든다.
// store.ts 와 분리한 자체 저장소다(prStore.ts 와 같은 방식).

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

// 페이지를 고정한다. 제목은 Browser 탭에서 읽은 제목, 없으면 주소에서 추정한다. 이미 고정돼 있으면 새로 만들지 않는다.
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

// 주소만 알고 제목을 모르는 고정(붙여 넣은 주소, 링크 우클릭)은 눈에 안 보이는 webview 로 페이지 제목을 읽어 맞춘다. 로그인 전이거나 못 읽으면 추정한 이름 그대로 둔다.
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

// 지금 보는 Browser 탭 페이지를 고정하거나 고정을 푼다.
export async function togglePinOfTab(tab: Pick<BrowserTab, "url" | "title">) {
  const existing = pinFor(ui.pins, tab.url);
  if (existing) return unpinNotionPage(existing.id);
  await pinNotionPage({ title: usableTitle(tab.title, tab.url) ?? "", url: tab.url });
}

// 탭 제목이 아직 읽히지 않은 값(비어 있음, 주소, 로딩 중의 "Notion")이면 null
export function usableTitle(title: string, url: string): string | null {
  const text = title.trim();
  if (!text || text === "Notion" || text === url || text === new URL(url).host) return null;
  return text;
}

// 열려 있는 Notion 탭에서 읽은 제목으로 고정 항목의 제목을 새로 맞춘다(사용자가 직접 바꾼 이름은 그대로 둔다).
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

// 이미 열린 같은 페이지의 Browser 탭이 있으면 그 탭으로, 없으면 새 탭으로 연다.
export function openNotionInApp(url: string): string {
  const existing = getState().tabs.find((t): t is BrowserTab => t.kind === "browser" && sameNotionPage(t.url, url));
  // 보드, Slack, PR 화면에서 눌렀을 때도 탭이 보이게 세션 화면으로 돌아온다(Browser 탭은 세션 화면의 오른쪽 패널에 있다).
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
    // 옛 데몬은 notion.pins.list 를 모른다. 그러면 묶음은 안내만 보인다.
    void rpc.call("notion.pins.list", {}).then((pins) => set({ pins })).catch(() => set({ pins: null }));
  });
  rpc.onEvent((event) => {
    if (event.type === "notionPins") set({ pins: event.pins });
  });
  subscribe(syncPinTitles);
  // 메인 프로세스가 Notion 링크를 앱 안 탭으로 열라고 보낸다(window.open 과 Browser 탭 안의 새 창 요청)
  window.addEventListener("agent-nav:open-notion", (event) => {
    const url = (event as CustomEvent<unknown>).detail;
    if (typeof url !== "string" || !isNotionUrl(url)) return;
    // 메인 프로세스는 앱 안에서 열라는 것만 알린다. Notion 화면과 Browser 탭 중 어디로 열지는 설정이 정한다.
    if (notionOpenPlan(url, getState().settings ?? {})?.via === "screen") openNotionScreen(url);
    else openNotionInApp(url);
  });
}

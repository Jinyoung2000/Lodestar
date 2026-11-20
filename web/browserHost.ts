import type { BrowserSharedPage, ServerEvent } from "../shared/protocol";
import { similarPage } from "./browserUrl";
import { confirmDialog } from "./ConfirmDialog";
import { openChoice } from "./QuickChoice";
import { rpc } from "./rpc";
import { getState, openBrowser, setState, subscribe, updateBrowserTab, type BrowserTab, type State } from "./store";
import { S } from "./strings";

// 에이전트의 Browser 도구가 앱 안의 공유된 탭에 닿는 화면 쪽 길.
//  1. 공유한 탭 목록을 데몬에 알린다(browser.setShares). 데몬은 이 목록에 없는 탭과 다른 세션의 탭에는 도구를 보내지 않는다.
//  2. 데몬이 browserTool 이벤트로 도구를 시키면, 그 탭이 정말 그 세션에 공유된 것인지 한 번 더 확인하고 메인 프로세스(agent-nav:browser-tool)에서 실행해 결과를 돌려준다.
// 데몬의 WebSocket 연결마다 공유 목록이 따로 있어서, 연결이 다시 맺어지면 목록을 다시 올린다.

// <webview> 의 webContents id. 탭이 자기 것을 등록한다(공유와 관계없이). id 를 에이전트에게 알리지 않고 이 화면 안에서만 쓴다.
const guests = new Map<string, () => number | null>();

export function registerGuest(tabKey: string, getId: () => number | null): () => void {
  guests.set(tabKey, getId);
  return () => {
    if (guests.get(tabKey) === getId) guests.delete(tabKey);
  };
}

// 공유 중인 탭 목록. 세션이 지워졌으면 공유도 없는 것으로 본다.
export function sharedPages(state: Pick<State, "tabs" | "agents"> & Partial<Pick<State, "activeTabKey" | "rightOpen" | "layoutMode" | "centerView">>): BrowserSharedPage[] {
  const pages: BrowserSharedPage[] = [];
  for (const tab of state.tabs) {
    if (tab.kind !== "browser" || !tab.sharedWith || !state.agents.some((a) => a.id === tab.sharedWith)) continue;
    pages.push({ pageId: tab.key, agentId: tab.sharedWith, url: tab.url, title: tab.title, visible: state.activeTabKey === tab.key && (state.centerView ?? "sessions") === "sessions" && (state.rightOpen !== false || state.layoutMode === "editor") ? "active" : "hidden" });
  }
  return pages;
}

// 공유되지 않은 채 열려 있는 탭(주소가 있는 것). 에이전트의 list_browser_pages 안내문이 센다.
export const unsharedCount = (state: Pick<State, "tabs">) => state.tabs.filter((t) => t.kind === "browser" && !t.sharedWith && t.url !== "").length;

export function initBrowserHost() {
  const native = window.agentNavNative;
  if (!native?.browserTool) return;
  let last = "";
  let released = new Map<string, string>();
  const sync = () => {
    const state = getState();
    const pages = sharedPages(state);
    const open = unsharedCount(state);
    // 공유가 끝난 탭은 대화상자 가로채기와 코드 실행을 멈춘다
    const now = new Map(pages.map((p) => [p.pageId, p.agentId]));
    for (const key of released.keys()) {
      if (now.has(key)) continue;
      const id = guests.get(key)?.() ?? null;
      if (id !== null) void native.browserTool!(id, "release", {}).catch(() => undefined);
    }
    released = now;
    const key = JSON.stringify({ pages, open });
    if (key === last) return;
    last = key;
    void rpc.call("browser.setShares", { pages, open }).catch(() => {
      last = "";
    });
  };
  subscribe(sync);
  rpc.onStatus((connected) => {
    if (!connected) return;
    last = "";
    sync();
  });
  rpc.onEvent((event) => {
    if (event.type === "browserTool") void runTool(event);
    if (event.type === "browserOpen") void runOpen(event);
  });
  // 페이지가 USB, 시리얼, HID, 블루투스 기기를 요청하면 메인이 알린다(목록이 바뀔 때마다 같은 요청으로 다시 온다).
  native.onBrowserDevice?.((request) => setState({ overlay: { kind: "device", request: request as never } }));
  // 페이지가 카메라, 위치 같은 권한을 요청하면(기록도 기본 허용도 없을 때) 메인이 여기로 묻는다. 창을 닫으면 답하지 않은 것으로 둔다(허용되지 않는다).
  native.onBrowserPermission?.(async ({ requestId, origin, category }) => {
    const info = S.browserPermissions.find((p) => p.category === category);
    if (!info) return void native.browserPermissionAnswer?.(requestId, null);
    const choice = await confirmDialog({ title: S.browserPermissionPrompt(hostOf(origin), info.name), detail: `\u2022 ${info.detail}`, buttons: [S.browserPermissionBlock, S.cancel, S.browserPermissionAllow] });
    void native.browserPermissionAnswer?.(requestId, choice === 2 ? "allow" : choice === 0 ? "deny" : null);
  });
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
};

type ToolEvent = Extract<ServerEvent, { type: "browserTool" }>;

const HIDDEN_HINT = /bring|not visible|cannot be captured/i;
const REVEAL_WAIT_MS = 400;

async function runTool(event: ToolEvent) {
  const reply = (body: { result?: { text?: string; image?: string }; error?: string }) => void rpc.call("browser.toolResult", { id: event.id, ...body }).catch(() => undefined);
  const tab = getState().tabs.find((t) => t.key === event.pageId && t.kind === "browser");
  if (!tab || tab.kind !== "browser" || tab.sharedWith !== event.agentId) {
    reply({ error: "This page is not shared with this session." });
    return;
  }
  const id = guests.get(tab.key)?.() ?? null;
  if (id === null) {
    reply({ error: "The page is not loaded yet." });
    return;
  }
  const call = () => window.agentNavNative!.browserTool!(id, event.tool, event.args);
  try {
    reply({ result: await call() });
  } catch (error) {
    // 탭이 가려져 있어 화면을 읽거나 가리킬 수 없으면 탭을 앞으로 가져와 한 번 더 한다
    const message = error instanceof Error ? error.message : String(error);
    if (!HIDDEN_HINT.test(message) || getState().activeTabKey === tab.key) {
      reply({ error: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
      return;
    }
    setState({ activeTabKey: tab.key, rightOpen: true });
    await new Promise((r) => setTimeout(r, REVEAL_WAIT_MS));
    try {
      reply({ result: await call() });
    } catch (retry) {
      reply({ error: (retry instanceof Error ? retry.message : String(retry)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
    }
  }
}

type OpenEvent = Extract<ServerEvent, { type: "browserOpen" }>;
const OPEN_LOAD_WAIT_MS = 8000;

// open_browser_page. url 이 없으면 사용자에게 공유할 열린 탭을 고르게 한다. url 이 있으면 같은 곳이 이미 열려 있는지 보고, 없으면 새 탭을 열어 이 세션에 공유한다.
async function runOpen(event: OpenEvent) {
  const reply = (body: { result?: { text?: string }; error?: string }) => void rpc.call("browser.toolResult", { id: event.id, ...body }).catch(() => undefined);
  try {
    reply({ result: { text: await openPage(event) } });
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) });
  }
}

const browserTabs = () => getState().tabs.filter((t): t is BrowserTab => t.kind === "browser");

const pageLine = (tab: BrowserTab) => `  - [${tab.key}] ${tab.title || "Untitled"} (${tab.url || "about:blank"}) (${getState().activeTabKey === tab.key ? "active" : "not visible"})`;

async function openPage(event: OpenEvent): Promise<string> {
  const native = window.agentNavNative;
  if (!native?.browserTool) throw new Error("Browser pages can only be opened in the Lodestar desktop app.");
  const agent = getState().agents.find((a) => a.id === event.agentId);
  if (!agent) throw new Error("This session no longer exists.");
  const mayAsk = agent.permissionMode !== "bypassPermissions";
  const tabs = browserTabs();
  if (!event.url) {
    if (tabs.length === 0) return "No browser pages are currently open.";
    const picked = mayAsk ? await askShare(tabs.filter((t) => !t.sharedWith && t.url !== ""), null) : null;
    return picked ? shareAndSummarize(picked, event.agentId) : "The user opted not to share an existing page.";
  }
  if (!event.forceNew) {
    const shared = tabs.filter((t) => t.sharedWith === event.agentId && similarPage(t.url, event.url!, true));
    if (shared.length > 0) return `At least one similar page is already open:\n${shared.map(pageLine).join("\n")}\n\nUse an existing page or pass \`forceNew: true\` to open a new one.`;
    const available = tabs.filter((t) => !t.sharedWith && t.url !== "" && similarPage(t.url, event.url!));
    if (available.length > 0 && mayAsk) {
      const picked = await askShare(available, event.url);
      if (picked) return shareAndSummarize(picked, event.agentId);
    }
  }
  const key = openBrowser(event.url, { sharedWith: event.agentId });
  return summarize(key);
}

const DECLINE = "__decline__";

async function askShare(tabs: BrowserTab[], url: string | null): Promise<BrowserTab | null> {
  if (tabs.length === 0) return null;
  const items = tabs.map((t) => ({ id: t.key, label: S.browserShareYes(t.title || t.url, t.url.length > 40 ? `${t.url.slice(0, 40)}\u2026` : t.url) }));
  items.push({ id: DECLINE, label: url ? S.browserShareOpenNew(url) : S.browserShareNone });
  const picked = await openChoice({ title: S.browserShareTitle, placeholder: S.browserSharePlaceholder, items });
  return tabs.find((t) => t.key === picked) ?? null;
}

async function shareAndSummarize(tab: BrowserTab, agentId: string) {
  updateBrowserTab(tab.key, { sharedWith: agentId });
  return summarize(tab.key);
}

// 탭이 뜨고 페이지가 읽힐 때까지 기다려 `Page ID` 와 접근성 스냅샷을 돌려준다
async function summarize(key: string): Promise<string> {
  const deadline = Date.now() + OPEN_LOAD_WAIT_MS;
  let id: number | null = null;
  while (Date.now() < deadline) {
    id = guests.get(key)?.() ?? null;
    if (id !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (id === null) return `Page ID: ${key}\n\nSummary:\n(The page is still loading. Call read_page to read it.)`;
  await window.agentNavNative!.browserTool!(id, "wait_loaded", {}).catch(() => undefined);
  const read = await window.agentNavNative!.browserTool!(id, "read_page", {}).catch((error: Error) => ({ text: `(Could not read the page yet: ${error.message})` }));
  return `Page ID: ${key}\n\nSummary:\n${read.text ?? ""}`;
}

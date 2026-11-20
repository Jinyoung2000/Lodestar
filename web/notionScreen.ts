import { useSyncExternalStore } from "react";
import { isNotionUrl, notionPageKey } from "../shared/notionLink";
import type { NotionPageView } from "../shared/protocol";
import { rpc } from "./rpc";
import { getState, setState, startDraft } from "./store";

// NOTION2: 앱 안 Notion 화면의 상태. 페이지 내용의 정본은 데몬(notion.page.*, Notion MCP 로 읽음)이고, 여기는 지금 보는 페이지와 읽기 상태, 페이지별 전용 대화 목록만 든다.
// store.ts 와 분리한 자체 저장소다(notionStore.ts, prStore.ts 와 같은 방식). 화면 전환(centerView)만 store.ts 에 맡긴다.

export type NotionScreen = {
  // 지금 보는 페이지 주소. 없으면 안내 화면.
  url: string | null;
  view: NotionPageView | null;
  // 새로 읽는 중 (view 가 있으면 마지막 복사본을 보이면서 읽는다)
  loading: boolean;
  error: string | null;
  // 페이지 키(notionPageKey) -> 전용 대화 세션 id
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

// 읽기 요청 번호. 페이지를 바꾼 뒤 늦게 도착한 옛 응답은 버린다.
let readSeq = 0;

// 앱 안 Notion 화면으로 연다. 마지막으로 읽어 둔 내용이 있으면 바로 보이고, 새로 읽는 동안 갱신 표시가 돈다.
export function openNotionScreen(url: string) {
  if (!isNotionUrl(url)) return;
  const same = ui.url !== null && notionPageKey(ui.url) === notionPageKey(url);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ url }));
  } catch {
    // 저장이 막힌 환경에서는 이번 실행 동안만 기억한다
  }
  set({ url, view: same ? ui.view : null, error: null });
  setState({ centerView: "notion" });
  // 방금 읽은 같은 페이지를 다시 누르면 다시 읽지 않는다 (읽기마다 모델 호출 비용이 든다). 새로 고침 단추가 있다.
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
    // 창을 다시 읽은 뒤(⌘R) 이 화면이 열려 있으면 이어서 읽는다
    if (getState().centerView === "notion" && ui.url) void loadScreen(ui.url, false);
  });
  rpc.onEvent((event) => {
    if (event.type === "notionChats") set({ chats: event.chats });
    // 쓰기가 끝나 페이지가 바뀌었다. 지금 보는 페이지면 다시 읽는다.
    else if (event.type === "notionChanged" && ui.url && notionPageKey(ui.url) === event.key) refreshNotionScreen();
    // 에이전트의 start_work_session: 새 세션 초안을 열고 첫 메시지를 채워 둔다. 작업 폴더는 사용자가 고른다.
    else if (event.type === "notionStartSession") startDraft(null, "new", { text: event.prompt });
  });
}

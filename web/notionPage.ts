import { BROWSER_PARTITION } from "./browserUrl";
import { NOTION_PROBE_SCRIPT, NOTION_READ_SCRIPT } from "./notionScript";
import type { NotionBlock } from "../shared/notionMarkdown";

// Notion 페이지 본문 읽기. 열려 있는 Browser 탭이면 그 탭의 <webview> 에서, 아니면 눈에 안 보이는 <webview> 를 잠깐 만들어 같은 로그인 저장소(partition)로 읽는다.
// 로그인은 Browser 탭에서 사용자가 직접 한다. 여기서는 로그인 화면이면 읽지 못했다고만 알린다.

export type NotionRead = { ok: true; title: string; url: string; blocks: NotionBlock[] } | { ok: false; reason: "login" | "empty" | "unavailable" };

// 페이지 안에서 글 하나를 실행하고 그 결과를 돌려주는 손잡이(<webview>.executeJavaScript)
export type PageExec = (code: string) => Promise<unknown>;

const POLL_MS = 300;
const SETTLE_MS = 500;
const TAB_TIMEOUT_MS = 6000;
const BACKGROUND_TIMEOUT_MS = 25000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 본문이 그려질 때까지 기다렸다가 읽는다. Notion 은 SPA 라 로드가 끝나도 본문이 비어 있을 수 있다.
export async function readNotionPage(exec: PageExec, timeoutMs: number): Promise<NotionRead> {
  const deadline = Date.now() + timeoutMs;
  let state: unknown = "loading";
  while (Date.now() < deadline) {
    try {
      state = await exec(NOTION_PROBE_SCRIPT);
    } catch {
      state = "loading";
    }
    if (state === "ready" || state === "login") break;
    await sleep(POLL_MS);
  }
  if (state === "login") return { ok: false, reason: "login" };
  if (state !== "ready") return { ok: false, reason: "empty" };
  await sleep(SETTLE_MS);
  try {
    const parsed = JSON.parse(String(await exec(NOTION_READ_SCRIPT))) as { ok: boolean; title?: string; url?: string; blocks?: NotionBlock[] };
    return parsed.ok && Array.isArray(parsed.blocks) ? { ok: true, title: parsed.title ?? "", url: parsed.url ?? "", blocks: parsed.blocks } : { ok: false, reason: "empty" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

// 열려 있는 Browser 탭이 자기 <webview> 를 등록해 두는 곳(탭 key 가 키)
const tabExecs = new Map<string, PageExec>();

export function registerTabReader(tabKey: string, exec: PageExec): () => void {
  tabExecs.set(tabKey, exec);
  return () => {
    if (tabExecs.get(tabKey) === exec) tabExecs.delete(tabKey);
  };
}

export const readFromTab = (tabKey: string): Promise<NotionRead> => {
  const exec = tabExecs.get(tabKey);
  return exec ? readNotionPage(exec, TAB_TIMEOUT_MS) : Promise.resolve({ ok: false, reason: "unavailable" });
};

// 탭이 없는 페이지의 제목만 읽는다(고정할 때 주소만 알고 제목을 모르는 경우). 로그인 화면이거나 제목이 안 읽히면 null.
export async function readTitleInBackground(url: string): Promise<string | null> {
  const read = await withHiddenView(url, async (exec) => {
    const deadline = Date.now() + TITLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = JSON.parse(String(await exec(TITLE_SCRIPT).catch(() => '{"login":false,"title":""}'))) as { login: boolean; title: string };
      if (state.login) return null;
      if (state.title && state.title !== "Notion") return state.title;
      await sleep(POLL_MS);
    }
    return null;
  });
  return read ?? null;
}

const TITLE_TIMEOUT_MS = 10000;
const TITLE_SCRIPT = `JSON.stringify({ login: /^\\/(login|signup|sign-up)(\\/|$)/.test(location.pathname) || !!document.querySelector("input[type=email], input[name=email]"), title: (document.title || "").trim() })`;

// 탭이 없는 페이지: 화면 밖에 둔 <webview> 로 열어 읽고 지운다. Browser 탭을 만들거나 앞으로 가져오지 않는다.
export async function readInBackground(url: string): Promise<NotionRead> {
  const read = await withHiddenView(url, (exec) => readNotionPage(exec, BACKGROUND_TIMEOUT_MS));
  return read ?? { ok: false, reason: "empty" };
}

// 화면 밖의 임시 <webview> 로 주소를 열고 dom-ready 뒤에 run 을 돌린 다음 지운다. 열리지 않으면 null.
async function withHiddenView<T>(url: string, run: (exec: PageExec) => Promise<T>): Promise<T | null> {
  if (!window.agentNavNative) return null;
  const view = document.createElement("webview") as unknown as HTMLElement & { executeJavaScript: PageExec };
  view.setAttribute("partition", BROWSER_PARTITION);
  view.setAttribute("webpreferences", "contextIsolation=yes, nodeIntegration=no, sandbox=yes");
  view.setAttribute("data-notion-reader", "");
  // 화면 밖에 두는 임시 webview 라 토큰이 아닌 고정 크기를 쓴다(Notion 이 데스크톱 폭 화면을 그리게 한다)
  // lint-tokens: allow offscreen reader size
  view.style.cssText = "position:fixed;left:-12000px;top:0;width:1100px;height:800px;pointer-events:none;";
  const ready = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), BACKGROUND_TIMEOUT_MS);
    view.addEventListener("dom-ready", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  view.setAttribute("src", url);
  document.body.appendChild(view);
  try {
    if (!(await ready)) return null;
    return await run((code) => view.executeJavaScript(code));
  } finally {
    view.remove();
  }
}

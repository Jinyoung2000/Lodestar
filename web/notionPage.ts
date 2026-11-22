import { BROWSER_PARTITION } from "./browserUrl";
import { NOTION_PROBE_SCRIPT, NOTION_READ_SCRIPT } from "./notionScript";
import type { NotionBlock } from "../shared/notionMarkdown";

export type NotionRead = { ok: true; title: string; url: string; blocks: NotionBlock[] } | { ok: false; reason: "login" | "empty" | "unavailable" };

export type PageExec = (code: string) => Promise<unknown>;

const POLL_MS = 300;
const SETTLE_MS = 500;
const TAB_TIMEOUT_MS = 6000;
const BACKGROUND_TIMEOUT_MS = 25000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

export async function readInBackground(url: string): Promise<NotionRead> {
  const read = await withHiddenView(url, (exec) => readNotionPage(exec, BACKGROUND_TIMEOUT_MS));
  return read ?? { ok: false, reason: "empty" };
}

async function withHiddenView<T>(url: string, run: (exec: PageExec) => Promise<T>): Promise<T | null> {
  if (!window.agentNavNative) return null;
  const view = document.createElement("webview") as unknown as HTMLElement & { executeJavaScript: PageExec };
  view.setAttribute("partition", BROWSER_PARTITION);
  view.setAttribute("webpreferences", "contextIsolation=yes, nodeIntegration=no, sandbox=yes");
  view.setAttribute("data-notion-reader", "");
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

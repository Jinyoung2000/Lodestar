import { confirmWithCheckbox } from "./ConfirmDialog";
import type { BrowserComment } from "./Feedback";
import { rpc } from "./rpc";
import { activeAgent, activePane, addAttachment, attachmentsOf, flash, getState, removeAttachment, updateBrowserTab } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

const SKIP_SHARE_PROMPT_KEY = "agent-nav:browserShareNoPrompt";
const SKIP_UNTRUSTED_KEY = "agent-nav:browserUntrustedNoWarn";

const readFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};
const writeFlag = (key: string) => {
  try {
    localStorage.setItem(key, "1");
  } catch {
  }
};

export async function toggleShare(tabKey: string, sharedWith: string | null): Promise<void> {
  if (sharedWith) {
    updateBrowserTab(tabKey, { sharedWith: null });
    hint(S.browserShareStopped);
    return;
  }
  const agent = activeAgent();
  if (!agent) {
    hint(S.browserShareNeedsSession);
    return;
  }
  if (!window.agentNavNative?.browserTool) {
    hint(S.browserDesktopOnly);
    return;
  }
  if (!readFlag(SKIP_SHARE_PROMPT_KEY)) {
    const { choice, checked } = await confirmWithCheckbox({ title: S.shareConfirmTitle, detail: S.shareConfirmDetail, checkbox: S.dontAskAgain, buttons: [S.shareDeny, S.shareAllow] });
    if (choice !== 1) return;
    if (checked) writeFlag(SKIP_SHARE_PROMPT_KEY);
  }
  updateBrowserTab(tabKey, { sharedWith: agent.id });
}

export function isLocalPage(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

async function confirmUntrusted(url: string): Promise<boolean> {
  if (isLocalPage(url) || readFlag(SKIP_UNTRUSTED_KEY)) return true;
  const { choice, checked } = await confirmWithCheckbox({ title: S.untrustedTitle, detail: S.untrustedDetail, checkbox: S.dontShowAgain, buttons: [S.untrustedOk] });
  if (choice === null) return false;
  if (checked) writeFlag(SKIP_UNTRUSTED_KEY);
  return true;
}

async function saveShot(png: string | null): Promise<string | null> {
  if (!png) return null;
  try {
    return (await rpc.call("browser.saveShot", { png })).path;
  } catch (error) {
    flash((error as Error).message);
    return null;
  }
}

function needsNative(webContentsId: number | null) {
  if (!window.agentNavNative?.browserPick || webContentsId === null) {
    hint(S.browserDesktopOnly);
    return false;
  }
  return true;
}

export async function addElementToChat(webContentsId: number | null, pageUrl: string): Promise<boolean> {
  if (!needsNative(webContentsId) || !(await confirmUntrusted(pageUrl))) return false;
  const image = getState().settings?.browserAttachElementImage ?? true;
  const picked = await window.agentNavNative!.browserPick!(webContentsId!, "element", { image }).catch((e: Error) => {
    flash(e.message);
    return null;
  });
  if (!picked || picked.kind !== "element") return false;
  const shot = await saveShot(picked.png);
  addAttachment(activePane().id, { workspaceId: null, path: picked.url, startLine: null, endLine: null, text: null, browser: { kind: "element", url: picked.url, title: picked.title, selector: picked.selector, tag: picked.tag, html: picked.html, shot } });
  hint(S.browserElementAdded, undefined, { check: true });
  return true;
}

export async function commentOnElements(webContentsId: number | null, pageUrl: string): Promise<number> {
  const native = window.agentNavNative;
  if (!needsNative(webContentsId) || !native?.onBrowserComment || !(await confirmUntrusted(pageUrl))) return 0;
  const paneId = activePane().id;
  const stop = native.onBrowserComment(({ id, item }) => {
    if (id === webContentsId) void attachComment(paneId, item);
  });
  const stopRemoved = native.onBrowserCommentRemoved?.(({ id, number }) => {
    if (id !== webContentsId) return;
    const chip = attachmentsOf(getState(), paneId).find((a) => a.browser?.kind === "element" && a.browser.comment?.number === number);
    if (chip) removeAttachment(paneId, chip.id);
  });
  try {
    const result = await native.browserPick!(webContentsId!, "comment");
    return result?.kind === "comments" ? result.count : 0;
  } catch (error) {
    flash((error as Error).message);
    return 0;
  } finally {
    stop();
    stopRemoved?.();
  }
}

async function attachComment(paneId: string, item: BrowserComment) {
  const shot = await saveShot(item.png);
  addAttachment(paneId, { workspaceId: null, path: item.url, startLine: null, endLine: null, text: null, browser: { kind: "element", url: item.url, title: item.title, selector: item.selector, tag: item.tag, html: item.html, shot, comment: { number: item.number, text: item.comment } } });
  hint(S.browserCommentAdded(item.number), undefined, { check: true });
}

export async function addConsoleLogs(webContentsId: number | null, pageUrl: string): Promise<void> {
  const native = window.agentNavNative;
  if (!native?.browserConsole || webContentsId === null) {
    hint(S.browserDesktopOnly);
    return;
  }
  if (!(await confirmUntrusted(pageUrl))) return;
  const logs = await native.browserConsole(webContentsId).catch((e: Error) => {
    flash(e.message);
    return null;
  });
  if (!logs) return;
  addAttachment(activePane().id, { workspaceId: null, path: logs.url, startLine: null, endLine: null, text: null, browser: { kind: "console", url: logs.url, title: logs.title, text: logs.text } });
  hint(S.browserConsoleAdded, undefined, { check: true });
}

export async function addScreenshotToChat(page: { webContentsId: number | null; url: string; title: string }): Promise<void> {
  const native = window.agentNavNative;
  if (native?.browserCapture && page.webContentsId !== null && !(await confirmUntrusted(page.url))) return;
  let { url, title } = page;
  let shot: string | null = null;
  if (native?.browserCapture && page.webContentsId !== null) {
    try {
      const captured = await native.browserCapture(page.webContentsId);
      if (captured) {
        ({ url, title } = { url: captured.url || url, title: captured.title || title });
        shot = await saveShot(captured.png);
      }
    } catch (error) {
      flash((error as Error).message);
    }
  }
  addAttachment(activePane().id, { workspaceId: null, path: url, startLine: null, endLine: null, text: null, browser: { kind: "page", url, title, shot } });
  hint(shot ? S.browserPageShared : S.browserPageSharedNoShot, undefined, { check: true });
}

export async function addAreaScreenshot(webContentsId: number | null, pageUrl: string): Promise<boolean> {
  if (!needsNative(webContentsId) || !(await confirmUntrusted(pageUrl))) return false;
  const picked = await window.agentNavNative!.browserPick!(webContentsId!, "area").catch((e: Error) => {
    flash(e.message);
    return null;
  });
  if (!picked || picked.kind !== "area") return false;
  const shot = await saveShot(picked.png);
  addAttachment(activePane().id, { workspaceId: null, path: picked.url, startLine: null, endLine: null, text: null, browser: { kind: "page", url: picked.url, title: picked.title, shot, area: true } });
  hint(S.browserAreaAdded, undefined, { check: true });
  return true;
}

export async function addFullPageScreenshot(webContentsId: number | null, pageUrl: string): Promise<void> {
  const native = window.agentNavNative;
  if (!native?.browserCaptureFull || webContentsId === null) {
    hint(S.browserDesktopOnly);
    return;
  }
  if (!(await confirmUntrusted(pageUrl))) return;
  try {
    const captured = await native.browserCaptureFull(webContentsId);
    if (!captured) return;
    const shot = await saveShot(captured.png);
    addAttachment(activePane().id, { workspaceId: null, path: captured.url, startLine: null, endLine: null, text: null, browser: { kind: "page", url: captured.url, title: captured.title, shot, full: true } });
    hint(S.browserPageShared, undefined, { check: true });
  } catch (error) {
    flash((error as Error).message);
  }
}

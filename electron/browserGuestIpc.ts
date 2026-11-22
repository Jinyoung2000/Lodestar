import { watch, type FSWatcher } from "node:fs";
import { ipcMain, session, webContents } from "electron";
import { BROWSER_PARTITION, filePathOf, isBrowserPartition } from "../web/browserUrl";
import type { DeviceRequest } from "../web/browserDevices";
import { DeviceRequests } from "./browserDevices";
import { answerDialog, applyTouch, fullPageScreenshot, onDialogChange, pendingDialog } from "./guestDebugger";
import { consoleLogs, formatConsole, runGuestTool } from "./browserTools";
import { PICK_READ_SCRIPT, PICK_STOP_SCRIPT, pickScript, type PickMode, type PickTheme } from "./pickScript";

const PICK_WORLD = 1000;

const PICK_TIMEOUT_MS = 120_000;

const PICK_POLL_MS = 120;

const MAX_CAPTURE_WIDTH = 1600;

const picking = new Map<number, () => void>();

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

async function captureRect(guest: Electron.WebContents, rect: { x: number; y: number; width: number; height: number } | undefined) {
  if (!rect) return null;
  const zoom = guest.getZoomFactor();
  const [x, y, width, height] = [rect.x * zoom, rect.y * zoom, rect.width * zoom, rect.height * zoom].map((n) => Math.round(Number(n)));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  let image = await guest.capturePage({ x: Math.max(0, x), y: Math.max(0, y), width, height });
  if (image.isEmpty()) return null;
  if (image.getSize().width > MAX_CAPTURE_WIDTH) image = image.resize({ width: MAX_CAPTURE_WIDTH });
  return image.toPNG().toString("base64");
}

type PickItem = { type: string; url?: string; title?: string; tag?: string; selector?: string; html?: string; text?: string; comment?: string; number?: number; rect?: { x: number; y: number; width: number; height: number } };

type EmulationParams = { width: number; height: number; dpr: number; mobile?: boolean; userAgent?: string | null };

const defaultUserAgents = new Map<number, string>();

const mobileApplied = new Set<number>();

const fileWatchers = new Map<number, { path: string; watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>();

const FILE_RELOAD_DEBOUNCE_MS = 300;

function stopWatchingFile(id: number) {
  const entry = fileWatchers.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.watcher.close();
  fileWatchers.delete(id);
}

export type BrowserGuestIpcDeps = {
  fromOurPage: (event: Electron.IpcMainInvokeEvent) => boolean;
  hostContents: (contents: Electron.WebContents | null | undefined) => Electron.WebContents | null;
  pickTheme: () => PickTheme;
  browsable: (url: string) => boolean;
  devicesAllowed: (origin: string) => boolean;
};

export function registerBrowserGuestIpc(deps: BrowserGuestIpcDeps) {
  function guestContents(event: Electron.IpcMainInvokeEvent, id: unknown) {
    if (!deps.fromOurPage(event) || typeof id !== "number") throw new Error("browser request refused");
    const contents = webContents.fromId(id);
    if (!contents || contents.isDestroyed() || contents.getType() !== "webview" || contents.hostWebContents !== event.sender) throw new Error("not a browser tab");
    return contents;
  }

  ipcMain.handle("agent-nav:browser-pick", async (event, id: unknown, mode: unknown, options: unknown) => {
    const guest = guestContents(event, id);
    const pickMode: PickMode = mode === "comment" || mode === "area" ? mode : "element";
    const withImage = !!(options && typeof options === "object" && (options as { image?: unknown }).image === true);
    picking.get(guest.id)?.();
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    picking.set(guest.id, cancel);
    const onNavigate = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame) cancel();
    };
    guest.on("did-start-navigation", onNavigate);
    let comments = 0;
    try {
      await guest.executeJavaScriptInIsolatedWorld(PICK_WORLD, [{ code: pickScript(pickMode, deps.pickTheme()) }]);
      const deadline = Date.now() + PICK_TIMEOUT_MS;
      while (!cancelled && !guest.isDestroyed() && Date.now() < deadline) {
        const raw = (await guest.executeJavaScriptInIsolatedWorld(PICK_WORLD, [{ code: PICK_READ_SCRIPT }])) as string | null;
        for (const item of raw ? (JSON.parse(raw) as PickItem[]) : []) {
          if (item.type === "commentRemoved") {
            event.sender.send("agent-nav:browser-comment-removed", { id: guest.id, number: Number(item.number) });
            continue;
          }
          if (item.type === "cancelled") return pickMode === "comment" ? { kind: "comments", count: comments } : null;
          if (item.type === "done") return pickMode === "comment" ? { kind: "comments", count: comments } : null;
          const base = { url: clip(item.url, 2000), title: clip(item.title, 300) };
          if (item.type === "area") return { kind: "area", ...base, png: await captureRect(guest, item.rect) };
          const element = { ...base, tag: clip(item.tag, 40), selector: clip(item.selector, 1000), html: clip(item.html, 20000), text: clip(item.text, 200), png: withImage ? await captureRect(guest, item.rect) : null };
          if (item.type === "element") return { kind: "element", ...element };
          if (item.type === "comment") {
            comments++;
            event.sender.send("agent-nav:browser-comment", { id: guest.id, item: { ...element, comment: clip(item.comment, 2000), number: Number(item.number) || comments } });
          }
        }
        await new Promise((r) => setTimeout(r, PICK_POLL_MS));
      }
      return pickMode === "comment" ? { kind: "comments", count: comments } : null;
    } finally {
      guest.removeListener("did-start-navigation", onNavigate);
      if (picking.get(guest.id) === cancel) picking.delete(guest.id);
      if (!guest.isDestroyed()) await guest.executeJavaScriptInIsolatedWorld(PICK_WORLD, [{ code: PICK_STOP_SCRIPT }]).catch(() => undefined);
    }
  });

  ipcMain.handle("agent-nav:browser-pick-cancel", (event, id: unknown) => {
    guestContents(event, id);
    picking.get(id as number)?.();
  });

  ipcMain.handle("agent-nav:browser-capture", async (event, id: unknown) => {
    const guest = guestContents(event, id);
    let image = await guest.capturePage();
    if (image.isEmpty()) return null;
    if (image.getSize().width > MAX_CAPTURE_WIDTH) image = image.resize({ width: MAX_CAPTURE_WIDTH });
    return { png: image.toPNG().toString("base64"), url: clip(guest.getURL(), 2000), title: clip(guest.getTitle(), 300) };
  });

  ipcMain.handle("agent-nav:browser-clear-storage", async (event, partition: unknown) => {
    if (!deps.fromOurPage(event)) throw new Error("browser request refused");
    const browserSession = session.fromPartition(isBrowserPartition(partition) ? partition : BROWSER_PARTITION);
    await browserSession.clearStorageData();
    await browserSession.clearCache();
  });

  ipcMain.handle("agent-nav:browser-emulate", (event, id: unknown, params: EmulationParams | null) => {
    const guest = guestContents(event, id);
    if (!defaultUserAgents.has(guest.id)) defaultUserAgents.set(guest.id, guest.getUserAgent());
    const base = defaultUserAgents.get(guest.id)!;
    if (!params) {
      guest.disableDeviceEmulation();
      if (guest.getUserAgent() !== base) guest.setUserAgent(base);
      void applyTouch(guest, false, false).catch(() => undefined);
      return;
    }
    const [width, height] = [params.width, params.height].map((n) => Math.round(Number(n)));
    const dpr = Number(params.dpr) || 0;
    if (![width, height].every((n) => Number.isFinite(n) && n >= 1 && n <= 10000) || dpr < 0 || dpr > 8) throw new Error("bad emulation size");
    const userAgent = typeof params.userAgent === "string" && params.userAgent.trim() ? params.userAgent.trim().slice(0, 500) : base;
    if (guest.getUserAgent() !== userAgent) guest.setUserAgent(userAgent);
    const frame = { screenSize: { width, height }, viewSize: { width, height }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: dpr, scale: 1 };
    if (params.mobile && !mobileApplied.has(guest.id)) guest.enableDeviceEmulation({ ...frame, screenPosition: "desktop" });
    if (params.mobile) mobileApplied.add(guest.id);
    else mobileApplied.delete(guest.id);
    guest.enableDeviceEmulation({ ...frame, screenPosition: params.mobile ? "mobile" : "desktop" });
    void applyTouch(guest, true, params.mobile === true).catch(() => undefined);
  });

  ipcMain.handle("agent-nav:browser-tool", async (event, id: unknown, tool: unknown, args: unknown) => {
    const guest = guestContents(event, id);
    return runGuestTool(guest, String(tool), args && typeof args === "object" ? (args as Record<string, unknown>) : {}, (url) => deps.browsable(url));
  });

  ipcMain.handle("agent-nav:browser-console", (event, id: unknown) => {
    const guest = guestContents(event, id);
    return { url: clip(guest.getURL(), 2000), title: clip(guest.getTitle(), 300), text: formatConsole(consoleLogs(guest.id, 100)) };
  });

  onDialogChange((id, dialog) => deps.hostContents(webContents.fromId(id))?.send("agent-nav:browser-dialog", { id, dialog }));

  ipcMain.handle("agent-nav:browser-dialog-answer", async (event, id: unknown, accept: unknown, text: unknown) => {
    const guest = guestContents(event, id);
    if (!pendingDialog(guest)) return;
    await answerDialog(guest, accept === true, typeof text === "string" ? text : undefined);
  });

  ipcMain.handle("agent-nav:browser-capture-full", async (event, id: unknown) => {
    const guest = guestContents(event, id);
    return { png: await fullPageScreenshot(guest), url: clip(guest.getURL(), 2000), title: clip(guest.getTitle(), 300) };
  });

  ipcMain.handle("agent-nav:browser-watch-file", (event, id: unknown, enabled: unknown) => {
    const guest = guestContents(event, id);
    const path = enabled === true ? filePathOf(guest.getURL()) : null;
    const current = fileWatchers.get(guest.id);
    if (current && current.path === path) return;
    stopWatchingFile(guest.id);
    if (!path) return;
    try {
      const watcher = watch(path, () => {
        const entry = fileWatchers.get(guest.id);
        if (!entry || guest.isDestroyed()) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => deps.hostContents(guest)?.send("agent-nav:browser-file-changed", { id: guest.id }), FILE_RELOAD_DEBOUNCE_MS);
      });
      watcher.on("error", () => stopWatchingFile(guest.id));
      fileWatchers.set(guest.id, { path, watcher, timer: null });
    } catch {
    }
  });

  const deviceRequests = new DeviceRequests(
    (request: DeviceRequest, guest) => {
      const host = deps.hostContents(guest);
      if (!host) return false;
      host.send("agent-nav:browser-device", request);
      return true;
    },
    deps.devicesAllowed,
  );

  ipcMain.handle("agent-nav:browser-device-answer", (event, requestId: unknown, deviceId: unknown) => {
    if (!deps.fromOurPage(event) || typeof requestId !== "string") throw new Error("device refused");
    deviceRequests.resolve(requestId, typeof deviceId === "string" ? deviceId : null);
  });

  return { deviceRequests, stopWatchingFile };
}

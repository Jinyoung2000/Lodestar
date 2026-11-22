import { createServer } from "node:http";
import { app, Menu, screen, webContents, type BrowserWindow, type Notification } from "electron";
import { DEVICE_TYPES, type DeviceType } from "../web/browserDevices";
import type { DeviceRequests } from "./browserDevices";
import type { QuickEntryWindow } from "./quickEntry";
import type { QuickShortcutStatus } from "../shared/quickEntry";
import { S } from "../web/strings";

export type E2ERequest = { action: string; [key: string]: unknown };

export type E2EWindow = { id: string; win: BrowserWindow; loadCount: number };

export type E2EContext<W extends E2EWindow, P extends { agentId: string }> = {
  windowById: (id: string) => W | null;
  currentWindow: () => W | null;
  liveWindows: () => W[];
  lastActiveId: () => string | null;
  setLastActiveId: (id: string) => void;
  openAgentsOf: (windowId: string) => Iterable<string>;
  openNewWindow: () => W;
  whenAppReady: (entry: W) => Promise<boolean>;
  closeWindow: (entry: W | null) => void;
  requestOpen: (path: string, source: "argv" | "e2e", cwd: string) => Promise<unknown>;
  openState: () => unknown;
  registryState: () => unknown;
  quitting: () => boolean;
  daemonPid: () => number | null;
  notifyRoutes: readonly unknown[];
  notifier: {
    stubbed: readonly { payload: P }[];
    realShown: readonly unknown[];
    shown: ReadonlyMap<string, Notification>;
    used: (payload: P, button: "body" | "action") => void;
    clear: (agentId: string) => void;
  };
  folderPicks: { answers: (string | null)[]; asked: number };
  deviceRequests: DeviceRequests;
  quickEntry: QuickEntryWindow;
  quickShortcutStatus: () => QuickShortcutStatus;
  quickProbe: unknown;
  applyQuickConfig: (config: { enabled: boolean; accelerator: string }) => QuickShortcutStatus;
};

export function startE2E(port: number, handleE2E: (request: E2ERequest) => Promise<unknown>) {
  const server = createServer((req, res) => {
    const host = req.headers.host ?? "";
    if (req.headers.origin !== undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      res.writeHead(403).end();
      req.resume();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const request = JSON.parse(body || "{}") as E2ERequest;
        const result = await handleE2E(request);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: String(error) }));
      }
    });
  });
  server.on("error", (error) => {
    console.error(`[e2e] could not listen on ${port}, exiting:`, error);
    app.exit(1);
  });
  server.listen(port, "127.0.0.1");
}

const fakeDeviceResults: { deviceType: string; deviceId: string | null }[] = [];

const WINDOWLESS_E2E = new Set(["openPath", "openOutcomes", "windows", "newWindow", "activate", "registry", "quitState", "menu", "notifications", "notificationClick", "realNotifications", "notificationEmit", "notificationClear", "notificationRoutes", "badgeCount", "deviceRequest", "deviceAdd", "deviceRemove", "deviceResults", "quickToggle", "quickOpen", "quickHide", "quickDestroy", "quickState", "quickBlur", "quickSetBounds", "quickConfigure", "quickEval", "quickKey", "quickType", "quickShot", "procInfo"]);

export function createE2EHandler<W extends E2EWindow, P extends { agentId: string }>(ctx: E2EContext<W, P>) {
  return async (request: E2ERequest): Promise<unknown> => {
    const wanted = request.window === undefined ? null : String(request.window);
    const target = wanted ? ctx.windowById(wanted) : ctx.currentWindow();
    if (wanted && !target && !WINDOWLESS_E2E.has(request.action)) throw new Error(`no such window: ${wanted}`);
    if (!target && !WINDOWLESS_E2E.has(request.action)) throw new Error(S.electronNoWindow);
    const win = target?.win as BrowserWindow;
    const contents = win?.webContents as Electron.WebContents;
    switch (request.action) {
      case "windows":
        return {
          target: ctx.currentWindow()?.id ?? null,
          lastActive: ctx.lastActiveId(),
          windows: ctx.liveWindows().map((w) => ({ id: w.id, title: w.win.getTitle(), url: w.win.webContents.getURL(), bounds: w.win.getBounds(), focused: w.win.isFocused(), openAgents: [...ctx.openAgentsOf(w.id)], loads: w.loadCount })),
        };
      case "newWindow": {
        const entry = ctx.openNewWindow();
        await ctx.whenAppReady(entry);
        return { id: entry.id };
      }
      case "closeWindow": {
        ctx.closeWindow(target);
        await new Promise((r) => setTimeout(r, 500));
        return { open: ctx.liveWindows().map((w) => w.id) };
      }
      case "focusWindow": {
        ctx.setLastActiveId(target!.id);
        return ctx.lastActiveId();
      }
      case "activate": {
        app.emit("activate");
        await new Promise((r) => setTimeout(r, 500));
        const entry = ctx.currentWindow();
        if (entry) await ctx.whenAppReady(entry);
        return { open: ctx.liveWindows().map((w) => w.id) };
      }
      case "openPath":
        return ctx.requestOpen(String(request.path), request.source === "argv" ? "argv" : "e2e", typeof request.cwd === "string" ? request.cwd : process.cwd());
      case "openOutcomes":
        return ctx.openState();
      case "registry":
        return ctx.registryState();
      case "quitState":
        return { quitting: ctx.quitting(), windows: ctx.liveWindows().length, daemonPid: ctx.daemonPid() };
      case "procInfo":
        return { mainPid: process.pid, daemonPid: ctx.daemonPid() };
      case "notificationRoutes":
        return ctx.notifyRoutes;
      case "key": {
        const keyCode = String(request.key);
        const modifiers = (request.modifiers as Electron.InputEvent["modifiers"]) ?? [];
        if (request.phase !== "up") contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        if (!request.phase && keyCode.length === 1) contents.sendInputEvent({ type: "char", keyCode, modifiers });
        if (request.phase !== "down") contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        await new Promise((r) => setTimeout(r, 300));
        return null;
      }
      case "appInfo": {
        const appMenu = Menu.getApplicationMenu()?.items[0];
        return {
          name: app.getName(),
          windowTitle: win.getTitle(),
          userData: app.getPath("userData"),
          logs: app.getPath("logs"),
          menuTitle: appMenu?.label,
          menuItems: appMenu?.submenu?.items.map((item) => item.label || item.role || "-"),
        };
      }
      case "eval":
        return contents.executeJavaScript(String(request.js));
      case "mouse": {
        const type = String(request.type) as "mouseDown" | "mouseUp" | "mouseMove";
        contents.sendInputEvent({ type, x: Number(request.x), y: Number(request.y), button: request.button === "right" ? "right" : "left", clickCount: Number(request.clickCount ?? 1), modifiers: (request.modifiers as Electron.InputEvent["modifiers"]) ?? [] });
        await new Promise((r) => setTimeout(r, 50));
        return null;
      }
      case "screenshot": {
        const image = await contents.capturePage();
        const { writeFile } = await import("node:fs/promises");
        await writeFile(String(request.path), image.toPNG());
        return String(request.path);
      }
      case "setSize":
        win.setSize(Number(request.width), Number(request.height));
        await new Promise((r) => setTimeout(r, 300));
        return win.getSize();
      case "edit": {
        const command = String(request.command);
        if (!["undo", "redo", "cut", "copy", "paste", "selectAll"].includes(command)) throw new Error("bad edit command");
        contents[command as "undo"]();
        await new Promise((r) => setTimeout(r, 200));
        return null;
      }
      case "title":
        return win.getTitle();
      case "loads":
        return target!.loadCount;
      case "menu": {
        const top = Menu.getApplicationMenu()?.items ?? [];
        if (!Array.isArray(request.path)) return top.map((item) => ({ label: item.label, items: item.submenu?.items.map((sub) => ({ label: sub.label || sub.role || "-", accelerator: sub.accelerator ?? null })) }));
        const [menuName, itemName] = request.path.map(String);
        const target = top.find((item) => item.label === menuName)?.submenu?.items.find((sub) => sub.label === itemName);
        if (!target) throw new Error("no such menu item");
        target.click();
        return null;
      }
      case "notifications":
        return ctx.notifier.stubbed;
      case "notificationClick": {
        const entry = ctx.notifier.stubbed[Number(request.index)];
        if (!entry) throw new Error("no such notification");
        ctx.notifier.used(entry.payload, request.button === "action" ? "action" : "body");
        return null;
      }
      case "realNotifications":
        return ctx.notifier.realShown;
      case "notificationEmit": {
        const notification = ctx.notifier.shown.get(String(request.agentId));
        if (!notification) throw new Error("no such notification");
        notification.emit(request.event === "action" ? "action" : "click", {}, 0);
        notification.close();
        return null;
      }
      case "notificationClear":
        ctx.notifier.clear(String(request.agentId));
        return null;
      case "folderPickAnswer":
        ctx.folderPicks.answers.push(typeof request.path === "string" ? request.path : null);
        return ctx.folderPicks.answers.length;
      case "folderPicks":
        return ctx.folderPicks;
      case "badgeCount":
        return app.getBadgeCount();
      case "focused":
        return win.isFocused();
      case "cdp": {
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
        return await contents.debugger.sendCommand(String(request.method), (request.params as Record<string, unknown> | undefined) ?? {});
      }
      case "cdpMouse": {
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
        const type = String(request.type);
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", { type, x: Number(request.x), y: Number(request.y), button: type === "mouseMoved" && !request.pressed ? "none" : "left", buttons: type === "mousePressed" || request.pressed ? 1 : 0, clickCount: 1 });
        return null;
      }
      case "guestShot": {
        const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && c.hostWebContents === win?.webContents && !c.isDestroyed());
        if (!guest) throw new Error("no browser tab");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(String(request.path), (await guest.capturePage()).toPNG());
        return String(request.path);
      }
      case "guestMouse": {
        const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && c.hostWebContents === win?.webContents && !c.isDestroyed());
        if (!guest) throw new Error("no browser tab");
        const type = String(request.type) as "mouseDown" | "mouseUp" | "mouseMove";
        guest.sendInputEvent({ type, x: Number(request.x), y: Number(request.y), button: "left", clickCount: 1 });
        await new Promise((r) => setTimeout(r, 60));
        return null;
      }
      case "guestKey": {
        const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && c.hostWebContents === win?.webContents && !c.isDestroyed());
        if (!guest) throw new Error("no browser tab");
        const keyCode = String(request.key);
        guest.sendInputEvent({ type: "keyDown", keyCode });
        if (keyCode.length === 1) guest.sendInputEvent({ type: "char", keyCode });
        guest.sendInputEvent({ type: "keyUp", keyCode });
        await new Promise((r) => setTimeout(r, 120));
        return null;
      }
      case "deviceRequest": {
        const deviceType = String(request.deviceType) as DeviceType;
        if (!DEVICE_TYPES.includes(deviceType)) throw new Error("bad device type");
        return ctx.deviceRequests.begin({ guest: null, origin: String(request.origin ?? "http://localhost:7801"), deviceType, devices: request.devices as never, invoke: (deviceId) => fakeDeviceResults.push({ deviceType, deviceId }) });
      }
      case "deviceAdd":
        ctx.deviceRequests.add(null, String(request.deviceType) as DeviceType, request.device as never);
        return null;
      case "deviceRemove":
        ctx.deviceRequests.remove(null, String(request.deviceType) as DeviceType, String(request.deviceId));
        return null;
      case "deviceResults":
        return fakeDeviceResults;
      case "quickToggle":
        ctx.quickEntry.toggle();
        await new Promise((r) => setTimeout(r, 400));
        return ctx.quickEntry.visible;
      case "quickOpen":
        ctx.quickEntry.show();
        await new Promise((r) => setTimeout(r, 600));
        return ctx.quickEntry.bounds;
      case "quickHide":
        ctx.quickEntry.hide();
        return null;
      case "quickDestroy":
        ctx.quickEntry.destroy();
        return null;
      case "quickState":
        return { visible: ctx.quickEntry.visible, bounds: ctx.quickEntry.bounds, shortcut: ctx.quickShortcutStatus(), probe: ctx.quickProbe, focused: ctx.quickEntry.webContents?.isFocused() ?? false, mode: ctx.quickEntry.mode, agentId: ctx.quickEntry.agentId, pinned: ctx.quickEntry.pinned, resizable: ctx.quickEntry.resizable, zoom: ctx.quickEntry.webContents?.getZoomFactor() ?? null, url: ctx.quickEntry.webContents?.getURL() ?? null, saved: ctx.quickEntry.readSaved(), displays: screen.getAllDisplays().map((d) => d.workArea) };
      case "quickBlur": {
        await new Promise((r) => setTimeout(r, Number(request.waitMs ?? 300)));
        return ctx.quickEntry.handleBlur(true);
      }
      case "quickSetBounds":
        ctx.quickEntry.setBoundsForTest(request.bounds as Electron.Rectangle);
        await new Promise((r) => setTimeout(r, 700));
        return ctx.quickEntry.readSaved();
      case "quickConfigure":
        return ctx.applyQuickConfig({ enabled: request.enabled !== false, accelerator: String(request.accelerator ?? "Alt+C") });
      case "quickEval": {
        const quick = ctx.quickEntry.webContents;
        if (!quick) throw new Error("no quick entry window");
        return quick.executeJavaScript(String(request.js));
      }
      case "quickKey": {
        const quick = ctx.quickEntry.webContents;
        if (!quick) throw new Error("no quick entry window");
        const keyCode = String(request.key);
        const modifiers = (request.modifiers as Electron.InputEvent["modifiers"]) ?? [];
        quick.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        const typed = !modifiers.some((m) => m === "meta" || m === "cmd" || m === "control" || m === "ctrl");
        if (keyCode.length === 1) quick.sendInputEvent({ type: "char", keyCode, modifiers });
        else if (typed && (keyCode === "Enter" || keyCode === "Return")) quick.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
        quick.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        await new Promise((r) => setTimeout(r, 300));
        return null;
      }
      case "quickType": {
        const quick = ctx.quickEntry.webContents;
        if (!quick) throw new Error("no quick entry window");
        for (const ch of String(request.text)) {
          quick.sendInputEvent({ type: "keyDown", keyCode: ch });
          quick.sendInputEvent({ type: "char", keyCode: ch });
          quick.sendInputEvent({ type: "keyUp", keyCode: ch });
        }
        await new Promise((r) => setTimeout(r, 200));
        return null;
      }
      case "quickShot": {
        const quick = ctx.quickEntry.webContents;
        if (!quick) throw new Error("no quick entry window");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(String(request.path), (await quick.capturePage()).toPNG());
        return String(request.path);
      }
      default:
        throw new Error(S.electronUnknownAction(String(request.action)));
    }
  };
}

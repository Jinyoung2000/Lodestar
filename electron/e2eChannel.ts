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

// 검증용 조작 창구. AGENT_NAV_E2E_PORT 가 있을 때만 127.0.0.1 에 열린다.
// {action:"key"} 는 실제 입력 이벤트를 창에 넣으므로 메뉴 단축키(⌘W, ⌘N)까지 그대로 탄다.
export function startE2E(port: number, handleE2E: (request: E2ERequest) => Promise<unknown>) {
  const server = createServer((req, res) => {
    // 이 창구는 eval, cdp, 파일 쓰기를 받는다. 웹 페이지도 사전 확인 없는 POST(text/plain)로 여기 닿으므로 Origin 이 붙은 요청(브라우저)과 다른 Host(DNS rebinding)는 거절한다. curl 과 node 시험 스크립트는 Origin 을 보내지 않는다.
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

// 창 없이도 도는 시험 창구 동작. 나머지는 대상 창이 있어야 한다.
const WINDOWLESS_E2E = new Set(["openPath", "openOutcomes", "windows", "newWindow", "activate", "registry", "quitState", "menu", "notifications", "notificationClick", "realNotifications", "notificationEmit", "notificationClear", "notificationRoutes", "badgeCount", "deviceRequest", "deviceAdd", "deviceRemove", "deviceResults", "quickToggle", "quickOpen", "quickHide", "quickDestroy", "quickState", "quickBlur", "quickSetBounds", "quickConfigure", "quickEval", "quickKey", "quickType", "quickShot", "procInfo"]);

// 창 id(request.window)로 대상 창을 고른다. 없으면 포커스된 창, 마지막 활성 창 순이다(예전 시험 스크립트가 그대로 돈다).
export function createE2EHandler<W extends E2EWindow, P extends { agentId: string }>(ctx: E2EContext<W, P>) {
  return async (request: E2ERequest): Promise<unknown> => {
    const wanted = request.window === undefined ? null : String(request.window);
    const target = wanted ? ctx.windowById(wanted) : ctx.currentWindow();
    if (wanted && !target && !WINDOWLESS_E2E.has(request.action)) throw new Error(`no such window: ${wanted}`);
    if (!target && !WINDOWLESS_E2E.has(request.action)) throw new Error(S.electronNoWindow);
    const win = target?.win as BrowserWindow;
    const contents = win?.webContents as Electron.WebContents;
    switch (request.action) {
      // 여러 창 시험: 창 목록, 새 창, 창 닫기, 명령 대상 창 바꾸기(OS 포커스는 건드리지 않는다), Dock 클릭(activate)
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
      // OPENFOLDER: open-file 이 온 것처럼 같은 처리 함수를 부른다(open -g -a 는 설치 앱을 부르게 되어 쓰지 않는다). cwd 는 상대 경로를 풀 작업 폴더. 처리 결과를 돌려준다.
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
        // phase 가 있으면 키를 누르기만(down) 또는 떼기만(up) 한다. 수정키를 누른 채 마우스를 움직이는 시험(⌘ hover)용.
        if (request.phase !== "up") contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        if (!request.phase && keyCode.length === 1) contents.sendInputEvent({ type: "char", keyCode, modifiers });
        if (request.phase !== "down") contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        await new Promise((r) => setTimeout(r, 300));
        return null;
      }
      // 앱 이름 점검용: 창 제목, 앱 메뉴 항목 이름, 데이터 폴더 경로
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
      // 실제 마우스 입력(창을 앞으로 가져오지 않는다). type: mouseDown | mouseUp | mouseMove, 좌표는 CSS px.
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
      // 창 크기 변경(창을 앞으로 가져오지 않는다). 떠 있는 창의 화면 안 보정과 좁은 폭 시험용.
      case "setSize":
        win.setSize(Number(request.width), Number(request.height));
        await new Promise((r) => setTimeout(r, 300));
        return win.getSize();
      // 메뉴 가속키(⌘Z, ⇧⌘Z, ⌘X, ⌘C, ⌘V, ⌘A)가 창이 포커스를 가졌을 때 하는 일을 그대로 부른다(앱 메뉴 항목의 click 은 포커스 창이 없으면 아무것도 안 한다).
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
      // 앱 메뉴 조회(path 가 없으면 최상위 이름과 그 아래 항목)와 클릭. path 는 ["Developer", "Restart Daemon"] 처럼 메뉴 이름에서 항목 이름까지다.
      case "menu": {
        const top = Menu.getApplicationMenu()?.items ?? [];
        if (!Array.isArray(request.path)) return top.map((item) => ({ label: item.label, items: item.submenu?.items.map((sub) => ({ label: sub.label || sub.role || "-", accelerator: sub.accelerator ?? null })) }));
        const [menuName, itemName] = request.path.map(String);
        const target = top.find((item) => item.label === menuName)?.submenu?.items.find((sub) => sub.label === itemName);
        if (!target) throw new Error("no such menu item");
        target.click();
        return null;
      }
      // 가로챈 알림 인자(AGENT_NAV_NOTIFY_STUB=1). index 번째 알림을 누른 것처럼 처리하는 click 도 있다(button: body 또는 action).
      case "notifications":
        return ctx.notifier.stubbed;
      case "notificationClick": {
        const entry = ctx.notifier.stubbed[Number(request.index)];
        if (!entry) throw new Error("no such notification");
        ctx.notifier.used(entry.payload, request.button === "action" ? "action" : "body");
        return null;
      }
      // 실제 알림 기록과 이벤트. notificationEmit 은 사람이 누르는 것 대신 그 알림에 click 또는 action 을 낸다(창은 앞으로 오지 않는다).
      case "realNotifications":
        return ctx.notifier.realShown;
      case "notificationEmit": {
        const notification = ctx.notifier.shown.get(String(request.agentId));
        if (!notification) throw new Error("no such notification");
        notification.emit(request.event === "action" ? "action" : "click", {}, 0);
        // 사람이 누르면 macOS 가 알림을 치우지만 emit 은 그러지 않으므로 직접 닫는다.
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
      // 첫 Browser 탭(guest)에 직접 입력을 넣고 화면을 찍는다(요소 선택 화면과 에뮬레이션을 시험한다). guest 좌표는 CSS px 이다.
      // 창에 CDP 로 마우스 이벤트를 넣는다. 이 Electron 에서는 mousePressed 가 응답하지 않고 멈춰서 쓰지 않는다. 끌기는 합성 PointerEvent 로 시험한다.
      // 시험 전용(창구가 열린 실행에서만): 창의 CDP 명령을 그대로 보낸다. 파일 끌어다 놓기(Input.dispatchDragEvent)와 파일 선택(DOM.setFileInputFiles)처럼 디스크 경로를 가진 File 이 필요한 시험이 쓴다.
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
      // 가짜 기기 요청(실제 USB 나 블루투스 없이 선택창을 시험한다). deviceResults 가 응답을 돌려준다.
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
      // QUICKENTRY 시험 창구. 단축키 대신 이 동작으로 연다(시험 인스턴스는 단축키를 등록하지 않는다). 창은 showInactive 라 포커스를 뺏지 않는다.
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
      // MINICHAT 시험 창구: 포커스가 없는 시험 인스턴스에서 blur 판정(핀, 입력 막대)을 강제로 돌린다. 끌기와 크기 조절은 OS 가 하는 일이라 setBounds 로 같은 이벤트 경로를 태운다.
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
        // 글자 입력은 keyDown 뒤의 char 이벤트가 넣는다. Enter 의 줄바꿈도 \r char 가 넣는다(⌘ 와 Ctrl 이 눌렸으면 실제 키보드도 글자를 만들지 않는다).
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

import { watch, type FSWatcher } from "node:fs";
import { ipcMain, session, webContents } from "electron";
import { BROWSER_PARTITION, filePathOf, isBrowserPartition } from "../web/browserUrl";
import type { DeviceRequest } from "../web/browserDevices";
import { DeviceRequests } from "./browserDevices";
import { answerDialog, applyTouch, fullPageScreenshot, onDialogChange, pendingDialog } from "./guestDebugger";
import { consoleLogs, formatConsole, runGuestTool } from "./browserTools";
import { PICK_READ_SCRIPT, PICK_STOP_SCRIPT, pickScript, type PickMode, type PickTheme } from "./pickScript";

// --- Browser 탭 guest 조작 ---
// 요청은 우리 페이지(데몬 주소)에서 온 것만, 대상은 이 창에 붙은 webview 뿐이다. guest 에는 preload 도 데몬 토큰도 닿지 않고, 요소 선택 스크립트는 격리된 세계에서 돈다.
const PICK_WORLD = 1000;

const PICK_TIMEOUT_MS = 120_000;

const PICK_POLL_MS = 120;

const MAX_CAPTURE_WIDTH = 1600;

const picking = new Map<number, () => void>();

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

// 영역(CSS px)을 PNG base64 로. 쪽 확대 배율을 곱해 화면 좌표로 맞추고 너무 넓으면 줄인다.
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

// 기기 에뮬레이션: 화면 크기, 배율(dpr 0 은 기본값), 모바일 여부, 사용자 에이전트. params 가 null 이면 끈다.
// 모바일이 아닐 때 "desktop" 위치를 쓰는 이유: "mobile" 위치는 메타 뷰포트가 없는 페이지를 980px 로 그리므로 고른 폭이 그대로 보이지 않는다.
type EmulationParams = { width: number; height: number; dpr: number; mobile?: boolean; userAgent?: string | null };

const defaultUserAgents = new Map<number, string>();

const mobileApplied = new Set<number>();

// 설정 Auto Reload On File Change: file: 주소를 보여 주는 탭은 그 파일이 바뀌면 다시 읽는다. enabled 가 false 이거나 file: 이 아니면 지켜보지 않는다.
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

  // 요소 선택(element), 요소 댓글(comment), 영역 선택(area). 사용자가 끝낼 때까지(클릭, Esc, 페이지 이동, 시간 초과) 기다렸다가 결과를 돌려준다.
  // element 와 area 는 결과 하나(취소는 null), comment 는 댓글이 달릴 때마다 화면에 agent-nav:browser-comment 를 보내고 끝나면 댓글 수를 돌려준다.
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

  // 페이지 스크린샷(PNG base64)과 주소, 제목. 너무 넓으면 줄인다.
  ipcMain.handle("agent-nav:browser-capture", async (event, id: unknown) => {
    const guest = guestContents(event, id);
    let image = await guest.capturePage();
    if (image.isEmpty()) return null;
    if (image.getSize().width > MAX_CAPTURE_WIDTH) image = image.resize({ width: MAX_CAPTURE_WIDTH });
    return { png: image.toPNG().toString("base64"), url: clip(guest.getURL(), 2000), title: clip(guest.getTitle(), 300) };
  });

  // Browser 탭 전용 partition 의 쿠키, 저장소, 캐시를 모두 지운다(Clear Storage (Global)).
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
    // 모바일이면 터치 이벤트, 거친 포인터 미디어 질의, 마우스를 터치로 보내기를 켠다
    void applyTouch(guest, true, params.mobile === true).catch(() => undefined);
  });

  // 에이전트의 Browser 도구. 데몬이 공유된 탭에 보낸 요청을 화면이 여기로 넘긴다. 대상은 이 창의 webview 뿐이고, 이동은 Browser 탭이 여는 주소와 같은 기준으로 거른다.
  ipcMain.handle("agent-nav:browser-tool", async (event, id: unknown, tool: unknown, args: unknown) => {
    const guest = guestContents(event, id);
    return runGuestTool(guest, String(tool), args && typeof args === "object" ? (args as Record<string, unknown>) : {}, (url) => deps.browsable(url));
  });

  // Add Console Logs to Chat: 페이지의 최근 console 출력을 글로.
  ipcMain.handle("agent-nav:browser-console", (event, id: unknown) => {
    const guest = guestContents(event, id);
    return { url: clip(guest.getURL(), 2000), title: clip(guest.getTitle(), 300), text: formatConsole(consoleLogs(guest.id, 100)) };
  });

  // 공유 중인 탭에서 페이지가 띄운 대화상자(alert, confirm, prompt, beforeunload)는 사용자도 답할 수 있게 화면에 알린다(에이전트는 handle_dialog 로 답한다).
  onDialogChange((id, dialog) => deps.hostContents(webContents.fromId(id))?.send("agent-nav:browser-dialog", { id, dialog }));

  ipcMain.handle("agent-nav:browser-dialog-answer", async (event, id: unknown, accept: unknown, text: unknown) => {
    const guest = guestContents(event, id);
    if (!pendingDialog(guest)) return;
    await answerDialog(guest, accept === true, typeof text === "string" ? text : undefined);
  });

  // Add Full Page Screenshot to Chat (Experimental): 스크롤 밖까지 담은 페이지 전체
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
      // 파일을 지켜볼 수 없으면(삭제됨 등) 자동 새로고침은 꺼진 채로 둔다
    }
  });

  // 기기 선택창(USB, 시리얼, HID, 블루투스): 화면이 고른 기기(취소는 null)를 요청에 돌려준다.
  const deviceRequests = new DeviceRequests(
    (request: DeviceRequest, guest) => {
      // 기기 선택창은 요청한 <webview> 가 있는 창에 띄운다
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

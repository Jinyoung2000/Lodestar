import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, Menu, app, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, session, shell, webContents } from "electron";
import { categoriesFor, isAlwaysAllowed, permissionOrigin } from "../web/browserPermissions";
import { BROWSER_PARTITION, isBrowserPartition, isOwnOrigin, parseBrowsable, parseOpenable } from "../web/browserUrl";
import { bindBluetooth, bindDeviceSession } from "./browserDevices";
import { bindBeforeUnload } from "./guestDebugger";
import { closeRunners, closeRunnersFor } from "./pwRunner";
import { strokeOf } from "../web/keymap";
import { buildAppMenu, completesChord, keymapKey, keymapStateOf, registeredMenuStrokes, type AppMenuActions } from "./appMenu";
import { recordConsole } from "./browserTools";
import { logDirFor } from "./logDir";
import { dataHome, savedSettings, settingsFile } from "./dataHome";
import { stampLine } from "./logStamp";
import { DaemonConnection } from "./daemonConnection";
import { QuitFlow } from "./quitFlow";
import { createE2EHandler, startE2E, type E2EContext } from "./e2eChannel";
import { registerBrowserGuestIpc } from "./browserGuestIpc";
import { loadPermissions, permissions, registerSitePermissions } from "./sitePermissions";
import { NOTIFY_FOCUSED, NOTIFY_STUB, Notifier, validNotify, type NotifyAction, type NotifyMode, type NotifyPayload } from "./notifications";
import type { PickTheme } from "./pickScript";
import { externalOpenUrl } from "../shared/slackLink";
import { notionOpenPlan } from "../shared/notionLink";
import { parsePrUrl } from "../shared/prUrl";
import { normalizeQuickEntryConfig, QuickShortcutController, quickShortcutBlocked, type QuickShortcutStatus } from "../shared/quickEntry";
import { QuickEntryWindow } from "./quickEntry";
import { notificationTarget, pinnedFromSetting } from "../shared/miniChat";
import { chromeLikeUserAgent, guestPopupDecision } from "./guestPopup";
import { S } from "../web/strings";
import tokens from "../design-system/tokens.json";
import { addNewWindow, applyClose, cascade, closePolicy, EMPTY_REGISTRY, fitBounds, launchPlan, newWindowPlan, quitWhenAllWindowsClosed, targetWindow, updateRecord, windowForAgent, windowUrl, type Registry, type WindowRecord } from "../shared/windows";
import { loadRegistry, saveRegistry } from "./windowRegistry";
import { argvOpenPaths, classifyOpenPath, containingDir, fileUnder, OpenQueue, planOpenWindow, type OpenTarget, type PathFs } from "../shared/openPath";
import type { LayoutMode } from "../web/floatLayout";
import type { OpenFolderRequest, OpenFolderResult } from "../web/openFolder";

const startupMarks: [string, number][] = [];
const startupMark = (name: string) => startupMarks.push([name, Math.round(process.uptime() * 1000)]);
startupMark("main-eval");
const PORT = Number(process.env.AGENT_NAV_PORT ?? 7788);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const OWN_ORIGIN = new URL(URL_BASE).origin;
function isOwnPageUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === OWN_ORIGIN;
  } catch {
    return false;
  }
}
const APP_ROOT = join(import.meta.dirname, "..");
const E2E_PORT = process.env.AGENT_NAV_E2E_PORT ? Number(process.env.AGENT_NAV_E2E_PORT) : null;
const INACTIVE = process.env.AGENT_NAV_INACTIVE === "1" || E2E_PORT !== null;
const INVISIBLE = INACTIVE && process.env.AGENT_NAV_VISIBLE !== "1";
if (INVISIBLE) {
  process.on("uncaughtException", (error) => {
    console.error("[test instance] uncaught exception, exiting:", error);
    app.exit(1);
  });
}

const SRC_ROOT = process.env.AGENT_NAV_SRC ?? join(homedir(), "Repository", "agent-nav");


type AppWindow = { id: string; win: BrowserWindow; initialChat: boolean; layoutMode: LayoutMode | null; hung: boolean; hungTimer: ReturnType<typeof setTimeout> | null; loadRecovery: boolean; reloads: number[]; loadCount: number; boundsTimer?: ReturnType<typeof setTimeout> | null };
const appWindows = new Map<string, AppWindow>();
let registry: Registry = EMPTY_REGISTRY;
let lastActiveId: string | null = null;
const openAgents = new Map<string, Set<string>>();

function liveWindows(): AppWindow[] {
  return [...appWindows.values()].filter((w) => !w.win.isDestroyed());
}

function focusedWindowId(): string | null {
  return liveWindows().find((w) => w.win.isFocused())?.id ?? null;
}

function currentWindow(): AppWindow | null {
  const live = liveWindows();
  const id = targetWindow({ ids: live.map((w) => w.id), focusedId: focusedWindowId(), lastActiveId });
  return live.find((w) => w.id === id) ?? null;
}

function windowByContents(contents: Electron.WebContents | null | undefined): AppWindow | null {
  if (!contents || contents.isDestroyed()) return null;
  const host = contents.getType() === "webview" ? contents.hostWebContents : contents;
  return liveWindows().find((w) => w.win.webContents === host) ?? null;
}

const quitFlow = new QuitFlow({
  now: Date.now,
  log: logLine,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  closeWindows: closeAllWindows,
  closeHelpers: closeRunners,
  finishQuit: () => app.quit(),
  forceExit: () => {
    try {
      session.defaultSession.flushStorageData();
    } catch {
    }
    app.exit(0);
  },
});

app.setName("Lodestar");
const LEGACY_DATA_NAME = "agent-nav";
app.setPath("userData", process.env.AGENT_NAV_USER_DATA || join(app.getPath("appData"), LEGACY_DATA_NAME));
app.setPath("logs", logDirFor(process.env.AGENT_NAV_HOME, homedir(), LEGACY_DATA_NAME));

const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) app.exit(0);

type OpenSource = "open-file" | "argv" | "second-instance" | "e2e";
type OpenRequest = { raw: string; source: OpenSource; cwd: string };
const openQueue = new OpenQueue<OpenRequest, OpenOutcome>(handleOpenRequest);
const requestOpen = (raw: string, source: OpenSource, cwd = process.cwd()) => openQueue.push({ raw, source, cwd });
const openPathOptions = (cwd: string) => ({ defaultApp: process.defaultApp === true, cwd, home: homedir() });

if (gotInstanceLock) {
  app.on("open-file", (event, path) => {
    event.preventDefault();
    void requestOpen(path, "open-file");
  });
  app.on("second-instance", (_event, argv, workingDirectory) => {
    const paths = argvOpenPaths(argv, openPathOptions(workingDirectory));
    logLine(`[electron] second-instance argv=${JSON.stringify(argv)} cwd=${workingDirectory}`);
    for (const path of paths) void requestOpen(path, "second-instance", workingDirectory);
    if (paths.length === 0 && openQueue.isReady && !quitFlow.quitting) raiseForOpen(currentWindow() ?? openNewWindow());
  });
  for (const path of argvOpenPaths(process.argv, openPathOptions(process.cwd()))) void requestOpen(path, "argv");
}

const daemon = process.env.AGENT_NAV_NO_DAEMON === "1" ? null : new DaemonConnection({
  home: dataHome(),
  appRoot: APP_ROOT,
  srcRoot: SRC_ROOT,
  logDir: app.getPath("logs"),
  port: PORT,
  packaged: app.isPackaged,
  onState: ({ state, attempt, maxAttempts, reload }) => {
    for (const w of liveWindows()) w.win.webContents.send("agent-nav:daemon-state", { state, attempt, maxAttempts });
    if (reload && !quitFlow.quitting) reloadAppWindow();
  },
  log: logLine,
});

function electronLogFile() {
  const logDir = app.getPath("logs");
  mkdirSync(logDir, { recursive: true });
  return join(logDir, "electron.log");
}

let electronLogBytes = -1;

function logLine(message: string) {
  const text = stampLine(message);
  try {
    const file = electronLogFile();
    if (electronLogBytes < 0) electronLogBytes = existsSync(file) ? statSync(file).size : 0;
    if (electronLogBytes >= 20 * 1024 * 1024) {
      renameSync(file, `${file}.1`);
      electronLogBytes = 0;
    }
    appendFileSync(file, text);
    electronLogBytes += Buffer.byteLength(text);
  } catch {
    electronLogBytes = -1;
  }
}

function closeAllWindows(): Promise<void> {
  const open = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (open.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let left = open.length;
    for (const w of open) {
      w.once("closed", () => {
        if (--left === 0) resolve();
      });
      w.close();
    }
  });
}

function reloadAppWindow() {
  quickEntry.destroy();
  for (const entry of liveWindows()) reloadEntry(entry);
}

function reloadEntry(entry: AppWindow) {
  const contents = entry.win.webContents;
  if (contents.getURL().startsWith(URL_BASE)) contents.reload();
  else void contents.loadURL(pageUrl(entry)).catch(() => undefined);
}

const DAEMON_POLL_MS = 25;
const DAEMON_WAIT_MS = 20_000;
async function waitForDaemon() {
  const deadline = Date.now() + DAEMON_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL_BASE, { headers: { host: `127.0.0.1:${PORT}` }, signal: AbortSignal.timeout(1000) });
      if (res.ok && (!daemon || daemon.state.state === "running")) return;
    } catch {
    }
    await new Promise((r) => setTimeout(r, DAEMON_POLL_MS));
  }
  throw new Error(S.electronDaemonNotStarted);
}

function dispatchToPage(contents: Electron.WebContents, type: string, detail: unknown) {
  return contents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(type)}, { detail: ${JSON.stringify(detail)} }))`);
}

function send(command: string) {
  const target = currentWindow();
  if (!target) {
    openNewWindow();
    return;
  }
  void dispatchToPage(target.win.webContents, "agent-nav:command", command);
}

let keymapState = keymapStateOf(savedSettings());

let builtBoardMenu = false;
let builtKeymap = "";
const boardMenuWanted = () => savedSettings().showBoard === true;

const menuActions: AppMenuActions = {
  send,
  openNewWindow: () => void openNewWindow(),
  closeCurrentWindow: () => closeWindowEntry(currentWindow()),
  reloadCurrentWindow: () => void reloadWindowCommand(currentWindow(), () => send("reloadWindow")),
};

function buildMenu() {
  const boardMenuShown = boardMenuWanted();
  builtBoardMenu = boardMenuShown;
  builtKeymap = keymapKey(keymapState);
  const menu = buildAppMenu(keymapState, boardMenuShown, menuActions);
  Menu.setApplicationMenu(menu);
  menuStrokes = registeredMenuStrokes(menu);
}

let menuStrokes: ReadonlySet<string> = new Set();

function windowBackground() {
  const { theme, style } = savedLook();
  return styledTokenColor("chrome-bg", theme, style);
}

function savedLook(): { theme: "dark" | "light"; style: string } {
  let theme: "dark" | "light" = "dark";
  let style = "lodestar";
  try {
    const saved = JSON.parse(readFileSync(settingsFile(), "utf8")) as { theme?: string; themeStyle?: string };
    theme = saved.theme === "light" || (saved.theme === "system" && !nativeTheme.shouldUseDarkColors) ? "light" : "dark";
    style = saved.themeStyle ?? style;
  } catch {
  }
  return { theme, style };
}

type StyledColor = { dark: string; light: string } & Partial<Record<"webstorm-dark" | "webstorm-light", string>>;
function styledTokenColor(name: string, theme: "dark" | "light", style: string | undefined): string {
  const value = tokens.color.tokens.find((t) => t.name === name)!.value as StyledColor;
  return (style === "webstorm" ? value[`webstorm-${theme}`] : undefined) ?? value[theme];
}

function pickTheme(): PickTheme {
  const { theme, style } = savedLook();
  const pick = (name: string) => styledTokenColor(name, theme, style);
  return { focus: pick("accent"), buttonBg: pick("accent"), buttonFg: pick("accent-fg"), widgetBg: pick("pick-widget-bg"), widgetFg: pick("fg"), widgetBorder: pick("pick-widget-border"), widgetShadow: pick("pick-widget-shadow"), placeholder: pick("fg-muted"), hover: pick("surface-hover"), font: `-apple-system, "system-ui", sans-serif` };
}

const ZOOM_MIN = -8;
const ZOOM_MAX = 8;
const zoomFile = () => join(dataHome(), "window-zoom.json");

function savedZoom(): number {
  try {
    const level = (JSON.parse(readFileSync(zoomFile(), "utf8")) as { level?: unknown }).level;
    return typeof level === "number" && Number.isFinite(level) ? Math.min(Math.max(Math.round(level), ZOOM_MIN), ZOOM_MAX) : 0;
  } catch {
    return 0;
  }
}

function applyZoomTo(win: BrowserWindow, level: number) {
  if (win.isDestroyed()) return;
  win.webContents.setZoomLevel(level);
  void win.webContents.executeJavaScript(`document.documentElement.style.setProperty("--window-zoom", ${JSON.stringify(String(1.2 ** level))})`);
}

function changeZoom(action: "in" | "out" | "reset", from: Electron.WebContents): number {
  const current = from.getZoomLevel();
  const next = action === "reset" ? 0 : Math.min(Math.max(Math.round(current) + (action === "in" ? 1 : -1), ZOOM_MIN), ZOOM_MAX);
  for (const w of liveWindows()) applyZoomTo(w.win, next);
  try {
    mkdirSync(join(zoomFile(), ".."), { recursive: true });
    writeFileSync(zoomFile(), JSON.stringify({ level: next }));
  } catch {
  }
  return next;
}

function createWindow(record: WindowRecord, options: { deferLoad?: boolean; initialChat?: boolean } = {}): AppWindow {
  const id = record.id;
  const bounds = fitBounds(record.bounds, screen.getAllDisplays().map((d) => d.workArea));
  const win = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    title: "Lodestar",
    show: false,
    backgroundColor: windowBackground(),
    titleBarStyle: "hiddenInset",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, preload: join(import.meta.dirname, "preload.cjs") },
  });
  const entry: AppWindow = { id, win, initialChat: options.initialChat ?? false, layoutMode: null, hung: false, hungTimer: null, loadRecovery: false, reloads: [], loadCount: 0 };
  appWindows.set(id, entry);
  lastActiveId = id;
  win.on("focus", () => {
    lastActiveId = id;
  });
  win.webContents.on("before-input-event", (event, input) => forwardKey(event, input, keymapState.intercept, win.webContents));
  win.webContents.on("dom-ready", () => applyZoomTo(win, savedZoom()));
  if (E2E_PORT) win.webContents.on("did-start-loading", () => entry.loadCount++);
  win.webContents.on("did-start-loading", () => {
    settledWindows.delete(id);
    entry.layoutMode = null;
  });
  win.webContents.on("will-prevent-unload", (event) => {
    logLine(`[electron] window ${id}: will-prevent-unload, leaving without a dialog`);
    event.preventDefault();
  });
  watchRenderer(entry);
  win.on("close", () => {
    logLine(`[electron] window ${id}: close`);
    saveWindowBounds(entry);
  });
  win.on("closed", () => handleWindowClosed(entry));
  trackWindowBounds(entry);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url, entry);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isOwnPageUrl(url)) return;
    event.preventDefault();
    logLine(`[electron] window ${id}: blocked navigation away from the app to ${url.slice(0, 200)}`);
    openExternalLink(url, entry);
  });
  win.webContents.on("will-attach-webview", lockDownWebview);
  if (INVISIBLE) {
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
  }
  win.once("ready-to-show", () => {
    if (record.maximized && !INVISIBLE) win.maximize();
    if (record.fullScreen && !INVISIBLE) win.setFullScreen(true);
    if (INACTIVE) win.showInactive();
    else win.show();
  });
  if (!options.deferLoad) loadAppPage(entry);
  broadcastWindowIds();
  return entry;
}

function lockDownWebview(event: Electron.Event, webPreferences: Electron.WebPreferences, params: Record<string, string>) {
  delete webPreferences.preload;
  delete (webPreferences as { preloadURL?: string }).preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webviewTag = false;
  webPreferences.nodeIntegrationInWorker = false;
  params.partition = isBrowserPartition(params.partition) ? params.partition : BROWSER_PARTITION;
  webPreferences.partition = params.partition;
  configureBrowserSession(session.fromPartition(params.partition));
  if (!isBrowsableInGuest(params.src)) event.preventDefault();
}

function loadAppPage(entry: AppWindow) {
  void entry.win.loadURL(pageUrl(entry));
}

function openNewWindow(initialChat = false): AppWindow {
  const alive = new Set(liveWindows().map((w) => w.id));
  const from = currentWindow();
  const area = from ? screen.getDisplayMatching(from.win.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
  const bounds = from ? cascade(from.win.getNormalBounds(), area) : null;
  const plan = initialChat ? { ...addNewWindow(registry, bounds), reused: false } : newWindowPlan(registry, alive, bounds);
  registry = plan.registry;
  persistRegistry();
  logLine(`[electron] new window ${plan.record.id}${plan.reused ? " (reopened the last closed window)" : ""}`);
  return createWindow(plan.record, { initialChat });
}

function closeWindowEntry(entry: AppWindow | null) {
  if (entry && !entry.win.isDestroyed()) entry.win.close();
}

function handleWindowClosed(entry: AppWindow) {
  if (entry.hungTimer) clearTimeout(entry.hungTimer);
  entry.hungTimer = null;
  if (entry.boundsTimer) clearTimeout(entry.boundsTimer);
  entry.boundsTimer = null;
  appWindows.delete(entry.id);
  openAgents.delete(entry.id);
  settledWindows.delete(entry.id);
  if (lastActiveId === entry.id) lastActiveId = null;
  const policy = closePolicy({ quitting: quitFlow.quitting, registryCount: registry.windows.length });
  registry = applyClose(registry, entry.id, policy);
  persistRegistry();
  logLine(`[electron] window ${entry.id}: closed (list: ${policy}, ${registry.windows.length} in list, ${appWindows.size} open)`);
  broadcastWindowIds();
  if (appWindows.size === 0 && quitWhenAllWindowsClosed(process.platform)) quickEntry.destroy();
}

function registryFile() {
  return join(app.getPath("userData"), "windows.json");
}

function persistRegistry() {
  saveRegistry(registryFile(), registry);
}

function saveWindowBounds(entry: AppWindow) {
  if (entry.win.isDestroyed()) return;
  registry = updateRecord(registry, entry.id, { bounds: entry.win.getNormalBounds(), maximized: entry.win.isMaximized(), fullScreen: entry.win.isFullScreen() });
  persistRegistry();
}

function trackWindowBounds(entry: AppWindow) {
  const schedule = () => {
    if (entry.boundsTimer) clearTimeout(entry.boundsTimer);
    entry.boundsTimer = setTimeout(() => {
      entry.boundsTimer = null;
      saveWindowBounds(entry);
    }, BOUNDS_SAVE_MS);
  };
  entry.win.on("resize", schedule);
  entry.win.on("move", schedule);
  entry.win.on("maximize", schedule);
  entry.win.on("unmaximize", schedule);
  entry.win.on("enter-full-screen", schedule);
  entry.win.on("leave-full-screen", schedule);
}

function broadcastWindowIds() {
  const ids = registry.windows.map((w) => w.id);
  for (const w of liveWindows()) w.win.webContents.send("agent-nav:windows-changed", ids);
}

const RELOAD_STROKE = "Meta+KeyR";
const HUNG_RELOAD_MS = 15_000;
const RENDERER_RELOADS_PER_MIN = 3;
const BOUNDS_SAVE_MS = 500;

const pageUrl = (entry: AppWindow) => windowUrl(URL_BASE, entry.id, entry.initialChat);

function watchRenderer(entry: AppWindow) {
  const contents = entry.win.webContents;
  const tag = `window ${entry.id}`;
  contents.on("unresponsive", () => {
    entry.hung = true;
    logLine(`[electron] ${tag}: renderer unresponsive url=${contents.getURL()}`);
    if (entry.hungTimer) clearTimeout(entry.hungTimer);
    entry.hungTimer = setTimeout(() => {
      entry.hungTimer = null;
      if (entry.hung) forceReloadAppWindow(entry, "renderer unresponsive for 15s", true);
    }, HUNG_RELOAD_MS);
  });
  contents.on("responsive", () => {
    entry.hung = false;
    if (entry.hungTimer) clearTimeout(entry.hungTimer);
    entry.hungTimer = null;
    logLine(`[electron] ${tag}: renderer responsive again`);
  });
  contents.on("render-process-gone", (_event, details) => {
    entry.hung = false;
    if (entry.hungTimer) clearTimeout(entry.hungTimer);
    entry.hungTimer = null;
    logLine(`[electron] ${tag}: render process gone reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason === "clean-exit" || quitFlow.quitting) return;
    const now = Date.now();
    while (entry.reloads.length && now - entry.reloads[0] > 60_000) entry.reloads.shift();
    if (entry.reloads.length >= RENDERER_RELOADS_PER_MIN) {
      logLine(`[electron] ${tag}: render process keeps dying, not reloading again`);
      return;
    }
    entry.reloads.push(now);
    void contents.loadURL(pageUrl(entry)).catch(() => undefined);
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    logLine(`[electron] ${tag}: load failed code=${code} ${description} url=${url}`);
    void recoverLoad(entry);
  });
}

async function recoverLoad(entry: AppWindow) {
  if (entry.loadRecovery) return;
  entry.loadRecovery = true;
  const contents = entry.win.webContents;
  try {
    for (let attempt = 1; attempt <= 3 && !contents.isDestroyed() && !quitFlow.quitting; attempt++) {
      const ready = await waitForDaemon().then(
        () => true,
        () => false,
      );
      if (!ready) continue;
      logLine(`[electron] window ${entry.id}: reopening ${pageUrl(entry)} (attempt ${attempt})`);
      if (await contents.loadURL(pageUrl(entry)).then(() => true, () => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    logLine(`[electron] window ${entry.id}: could not reopen the page, use Reload Window after the daemon is back`);
  } finally {
    entry.loadRecovery = false;
  }
}

async function pageState(entry: AppWindow | null): Promise<"app" | "elsewhere" | "hung"> {
  if (!entry || entry.win.isDestroyed()) return "elsewhere";
  if (entry.hung) return "hung";
  const contents = entry.win.webContents;
  if (!contents.getURL().startsWith(URL_BASE)) return "elsewhere";
  const ping = contents.executeJavaScript("typeof window.__agentNav?.runCommand === 'function'").catch(() => false);
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000));
  const answer = await Promise.race([ping, timeout]);
  return answer === "timeout" ? "hung" : answer ? "app" : "elsewhere";
}

async function reloadWindowCommand(entry: AppWindow | null, viaPage: () => void) {
  if (!entry) return;
  const state = await pageState(entry);
  if (state === "app") viaPage();
  else forceReloadAppWindow(entry, state === "hung" ? "Reload Window while the renderer does not answer" : "Reload Window while the page is not the app", state === "hung");
}

function forceReloadAppWindow(entry: AppWindow, reason: string, hung = entry.hung) {
  if (entry.win.isDestroyed()) return;
  logLine(`[electron] window ${entry.id}: forcing a reload (${reason})`);
  const contents = entry.win.webContents;
  if (hung) contents.forcefullyCrashRenderer();
  else void contents.loadURL(pageUrl(entry)).catch(() => undefined);
}

async function whenAppReady(entry: AppWindow, isReady: () => boolean | Promise<boolean> = async () => (await pageState(entry)) === "app"): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !entry.win.isDestroyed()) {
    if (await isReady()) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function forwardKey(event: Electron.Event, input: Electron.Input, strokes: ReadonlySet<string>, source: Electron.WebContents) {
  if (input.type !== "keyDown" || input.isComposing) return;
  const key = { code: input.code, key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift };
  const stroke = strokeOf(key);
  if (!stroke) return;
  if (!completesChord(source, stroke, keymapState.bindings, menuStrokes) && !strokes.has(stroke)) return;
  event.preventDefault();
  const target = windowByContents(source);
  if (!target) return;
  const toPage = () => void dispatchToPage(target.win.webContents, "agent-nav:key", key);
  if (stroke === RELOAD_STROKE) void reloadWindowCommand(target, toPage);
  else toPage();
}

function openExternalLink(url: string, from?: AppWindow | null) {
  let saved: { slackLinkTarget?: unknown; slackTeamId?: unknown; notionLinkTarget?: unknown } = {};
  try {
    saved = JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
  }
  const notion = notionOpenPlan(url, saved);
  if (notion?.via === "tab" || notion?.via === "screen") {
    if (process.env.AGENT_NAV_OPEN_LOG) appendFileSync(process.env.AGENT_NAV_OPEN_LOG, `${notion.via}:${notion.url}\n`);
    const host = from ?? currentWindow();
    if (host) void dispatchToPage(host.win.webContents, "agent-nav:open-notion", notion.url);
    return;
  }
  const target = notion ? notion.url : externalOpenUrl(url, saved);
  if (!externalOpenAllowed(target)) {
    logLine(`[electron] refused to open an external link with this scheme: ${target.slice(0, 200)}`);
    return;
  }
  if (process.env.AGENT_NAV_OPEN_LOG) appendFileSync(process.env.AGENT_NAV_OPEN_LOG, `${target}\n`);
  else void shell.openExternal(target);
}

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:", "slack:", "notion:"]);
const EXTERNAL_FILE_TYPES = /\.(html?|xhtml|svg|pdf|png|jpe?g|gif|webp|txt|md|json)$/i;
function externalOpenAllowed(url: string) {
  try {
    const parsed = new URL(url);
    if (EXTERNAL_SCHEMES.has(parsed.protocol)) return true;
    return parsed.protocol === "file:" && parsed.hostname === "" && EXTERNAL_FILE_TYPES.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isBrowsableInGuest(url: string) {
  const target = parseOpenable(url);
  return target !== null && !isOwnOrigin(target.href, new URL(URL_BASE));
}

const GUEST_EXTERNAL_GAP_MS = 1000;
const lastGuestExternal = new Map<number, number>();

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const decision = guestPopupDecision({ openerUrl: contents.getURL(), targetUrl: url, disposition });
    if (decision === "popup" && !INVISIBLE) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, session: contents.session } } };
    }
    if (decision !== "deny" && parseBrowsable(url)) {
      const now = Date.now();
      if (now - (lastGuestExternal.get(contents.id) ?? 0) >= GUEST_EXTERNAL_GAP_MS) {
        lastGuestExternal.set(contents.id, now);
        openExternalLink(url, windowByContents(contents));
      } else logLine(`[electron] guest ${contents.id}: dropped a rapid window.open to ${url.slice(0, 200)}`);
    }
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => {
    const guard = (event: Electron.Event, target: string) => {
      if (!isBrowsableInGuest(target)) event.preventDefault();
    };
    child.webContents.on("will-navigate", (event, target) => guard(event, target));
    child.webContents.on("will-redirect", (event, target) => guard(event, target));
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
  contents.on("will-navigate", (event, url) => {
    if (!isBrowsableInGuest(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isBrowsableInGuest(url)) event.preventDefault();
  });
  recordConsole(contents);
  bindBluetooth(contents, deviceRequests);
  bindBeforeUnload(contents);
  contents.once("destroyed", () => {
    closeRunnersFor(contents.id);
    stopWatchingFile(contents.id);
    lastGuestExternal.delete(contents.id);
  });
  contents.on("before-input-event", (event, input) => forwardKey(event, input, keymapState.guest, contents));
});

ipcMain.handle("agent-nav:capture", async (event, rect: { x: number; y: number; width: number; height: number }) => {
  const source = appWindowOf(event);
  if (!source) throw new Error("capture refused");
  const zoom = source.win.webContents.getZoomFactor();
  const [x, y, width, height] = [rect.x * zoom, rect.y * zoom, rect.width * zoom, rect.height * zoom].map((n) => Math.round(Number(n)));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1 || width > 4000 || height > 4000) throw new Error("bad rect");
  const image = await source.win.webContents.capturePage({ x, y, width, height });
  return image.isEmpty() ? null : image.toPNG().toString("base64");
});

const hostContents = (contents: Electron.WebContents | null | undefined) => (windowByContents(contents) ?? currentWindow())?.win.webContents ?? null;
const { resolvePermission } = registerSitePermissions({ fromOurPage, hostContents });
const { deviceRequests, stopWatchingFile } = registerBrowserGuestIpc({ fromOurPage, hostContents, pickTheme, browsable: isBrowsableInGuest, devicesAllowed: (origin) => permissions.isAllowed(origin, "devices") });

const notifier = new Notifier(dispatchNotificationAction);

function windowForNotification(agentId: string, candidates = liveWindows()): AppWindow | null {
  const windows = candidates.map((w) => ({ id: w.id, agentIds: openAgents.get(w.id) ?? new Set<string>() }));
  const id = windowForAgent({ windows, agentId, focusedId: focusedWindowId(), lastActiveId });
  return candidates.find((w) => w.id === id) ?? null;
}

const notifyRoutes: { agentId: string; action: string; windowId: string; opened: boolean }[] = [];

async function dispatchNotificationAction(action: NotifyAction, mode: NotifyMode = "route") {
  if (action.agentId === quickEntry.agentId && quickEntry.webContents) {
    notifyRoutes.push({ agentId: action.agentId, action: action.action, windowId: "mini", opened: false });
    if (mode === "route-and-show" && !quickEntry.visible) quickEntry.show();
    void dispatchToPage(quickEntry.webContents, "agent-nav:notification", action);
    return;
  }
  if (action.action === "open") await routeOpenSession(action.agentId);
  else await routeToMainWindow(action, mode);
}

let sessionOpen = Promise.resolve();

function routeOpenSession(agentId: string) {
  sessionOpen = sessionOpen.then(() => openSessionInChat(agentId)).catch((error: unknown) => {
    logLine(`[electron] could not open notified session ${agentId}: ${String(error)}`);
  });
  return sessionOpen;
}

async function openSessionInChat(agentId: string) {
  const tried = new Set<string>();
  while (!quitFlow.quitting) {
    const target = windowForNotification(agentId, liveWindows().filter((w) => w.layoutMode === "chat" && !w.hung && !tried.has(w.id)));
    const entry = target ?? openNewWindow(true);
    if (!target && (!(await whenAppReady(entry, () => entry.layoutMode !== null)) || entry.win.isDestroyed())) {
      throw new Error(`Chat window ${entry.id} did not load`);
    }
    const accepted = await entry.win.webContents.executeJavaScript(`window.__agentNav?.openNotificationSession?.(${JSON.stringify(agentId)})`).catch(() => false);
    if (accepted) {
      notifyRoutes.push({ agentId, action: "open", windowId: entry.id, opened: !target });
      if (!NOTIFY_STUB) raiseForOpen(entry);
      return;
    }
    if (!target) throw new Error(`Chat window ${entry.id} did not accept the notification`);
    tried.add(entry.id);
  }
}

async function routeToMainWindow(action: NotifyAction, mode: NotifyMode = "route-and-show") {
  let target = windowForNotification(action.agentId);
  const opened = !target;
  if (!target) {
    target = openNewWindow();
    await whenAppReady(target);
  }
  notifyRoutes.push({ agentId: action.agentId, action: action.action, windowId: target.id, opened });
  if (mode === "route-and-show") bringToFront(target);
  void dispatchToPage(target.win.webContents, "agent-nav:notification", action);
}

function bringToFront(entry: AppWindow | null) {
  if (!entry || entry.win.isDestroyed() || NOTIFY_STUB || INACTIVE) return;
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.show();
  entry.win.focus();
}

type OpenOutcome = {
  input: string;
  source: OpenSource;
  result: "opened" | "focused" | "rejected" | "failed";
  kind: OpenTarget["kind"] | null;
  dir: string | null;
  file: string | null;
  plan: "existing" | "spare" | "new" | null;
  windowId: string | null;
  windowsBefore: string[];
  windowsAfter: string[];
  raised: boolean;
  page: OpenFolderResult | null;
  notice: { title: string; body: string } | null;
};

const openOutcomes: OpenOutcome[] = [];
const nodePathFs: PathFs = {
  kind: (path) => {
    try {
      const stat = statSync(path);
      return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
    } catch {
      return "missing";
    }
  },
  real: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
};
let launchSpareId: string | null = null;
const settledWindows = new Set<string>();
const OPEN_RUN_TIMEOUT_MS = 15_000;

async function handleOpenRequest(request: OpenRequest): Promise<OpenOutcome> {
  const outcome: OpenOutcome = { input: request.raw, source: request.source, result: "failed", kind: null, dir: null, file: null, plan: null, windowId: null, windowsBefore: liveWindows().map((w) => w.id), windowsAfter: [], raised: false, page: null, notice: null };
  const finish = () => {
    outcome.windowsAfter = liveWindows().map((w) => w.id);
    openOutcomes.push(outcome);
    logLine(`[electron] open ${request.source} ${JSON.stringify(request.raw)}: ${outcome.result}${outcome.plan ? ` (${outcome.plan} ${outcome.windowId})` : ""}${outcome.notice ? ` notice=${JSON.stringify(outcome.notice.body)}` : ""}`);
    return outcome;
  };
  try {
    if (quitFlow.quitting) return finish();
    const target = classifyOpenPath(request.raw, { home: homedir(), cwd: request.cwd }, nodePathFs);
    outcome.kind = target.kind;
    if (target.kind === "missing" || target.kind === "unsupported") {
      outcome.result = "rejected";
      outcome.notice = target.kind === "missing" ? { title: S.openPathMissingTitle, body: S.openPathMissing(target.path) } : { title: S.openPathUnsupportedTitle, body: S.openPathUnsupported(target.path) };
      notifier.showOpenNotice(outcome.notice);
      return finish();
    }
    const spareId = liveWindows().length === 0 ? openNewWindow().id : launchSpareId;
    const shown = await Promise.all(liveWindows().map(async (entry) => ({ id: entry.id, ...(await shownOf(entry)) })));
    const owner = target.kind === "file" ? containingDir(target.dir, shown.flatMap((w) => [...w.dirs])) : null;
    outcome.dir = owner ?? target.dir;
    outcome.file = target.kind === "file" ? (owner ? fileUnder(owner, target.dir, target.file) : target.file) : null;
    const plan = planOpenWindow({ windows: shown, dir: outcome.dir, focusedId: focusedWindowId(), lastActiveId, spareId, reuseLayout: "editor" });
    outcome.plan = plan.kind;
    let entry: AppWindow | undefined;
    if (plan.kind === "new") {
      entry = openNewWindow();
      if (!(await settle(entry))) throw new Error("the new window did not load");
    } else {
      entry = appWindows.get(plan.windowId);
      if (plan.kind === "spare" && plan.windowId === launchSpareId) launchSpareId = null;
    }
    if (!entry) throw new Error("the window closed");
    outcome.windowId = entry.id;
    const run: OpenFolderRequest = { dir: outcome.dir, file: outcome.file, startSession: plan.kind !== "existing", ...(target.kind === "file" && target.position ? { position: target.position } : {}) };
    outcome.page = await runInPage(entry, run);
    outcome.raised = raiseForOpen(entry);
    outcome.result = plan.kind === "existing" ? "focused" : "opened";
  } catch (error) {
    outcome.result = "failed";
    const reason = error instanceof Error ? error.message : String(error);
    outcome.notice = { title: S.openPathFailedTitle, body: S.openPathFailed(request.raw, reason) };
    notifier.showOpenNotice(outcome.notice);
  }
  return finish();
}

async function shownOf(entry: AppWindow): Promise<{ dirs: Set<string>; layout: string | null }> {
  if (!(await settle(entry))) return { dirs: new Set(), layout: null };
  try {
    const text = (await entry.win.webContents.executeJavaScript(`(() => { const api = window.__agentNav?.openFolder; return JSON.stringify(api ? { dirs: api.shownDirs(), layout: api.layout?.() ?? null } : { dirs: [], layout: null }); })()`)) as string;
    const parsed = JSON.parse(text) as { dirs: string[]; layout: string | null };
    return { dirs: new Set(parsed.dirs), layout: parsed.layout };
  } catch {
    return { dirs: new Set(), layout: null };
  }
}

async function settle(entry: AppWindow): Promise<boolean> {
  if (settledWindows.has(entry.id) && (await pageState(entry)) === "app") return true;
  const ready = await whenAppReady(entry);
  if (ready) settledWindows.add(entry.id);
  return ready;
}

async function runInPage(entry: AppWindow, request: OpenFolderRequest): Promise<OpenFolderResult> {
  const run = entry.win.webContents.executeJavaScript(`window.__agentNav.openFolder.run(${JSON.stringify(request)})`) as Promise<OpenFolderResult>;
  const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("the window did not answer")), OPEN_RUN_TIMEOUT_MS));
  return Promise.race([run, timeout]);
}

function raiseForOpen(entry: AppWindow | null): boolean {
  if (!entry || entry.win.isDestroyed() || INACTIVE) return false;
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.show();
  app.focus({ steal: true });
  entry.win.focus();
  return true;
}

function appWindowOf(event: Electron.IpcMainInvokeEvent): AppWindow | null {
  const entry = liveWindows().find((w) => w.win.webContents === event.sender) ?? null;
  return entry && isOwnPageUrl(event.senderFrame?.url) ? entry : null;
}

function fromOurPage(event: Electron.IpcMainInvokeEvent) {
  return appWindowOf(event) !== null;
}

const tokenPx = (group: "size" | "spacing", name: string) => parseInt(tokens[group].tokens.find((t) => t.name === name)!.value, 10);
const tokenColor = (name: string, theme: "dark" | "light") => styledTokenColor(name, theme, savedSettings().themeStyle as string | undefined);

function watchBoardMenu() {
  const file = settingsFile();
  unwatchFile(file);
  watchFile(file, { interval: 2000, persistent: false }, () => {
    const next = keymapStateOf(savedSettings());
    if (keymapKey(next) !== keymapKey(keymapState)) keymapState = next;
    if (boardMenuWanted() !== builtBoardMenu || keymapKey(keymapState) !== builtKeymap) buildMenu();
  });
}

function savedTheme(): "dark" | "light" {
  const theme = savedSettings().theme;
  return theme === "light" || (theme === "system" && !nativeTheme.shouldUseDarkColors) ? "light" : "dark";
}

const quickEntry = new QuickEntryWindow({
  urlBase: URL_BASE,
  preload: join(import.meta.dirname, "preload.cjs"),
  sizes: { cardWidth: tokenPx("size", "size-quick-entry-width"), pad: tokenPx("spacing", "space-8"), minCard: tokenPx("size", "size-control") + tokenPx("spacing", "space-4") * 2, maxCard: tokenPx("size", "size-quick-entry-max") },
  chat: { width: tokenPx("size", "size-float-width"), height: tokenPx("size", "size-float-height"), minWidth: tokenPx("size", "size-float-min-width"), minHeight: tokenPx("size", "size-float-min-height"), pad: 0 },
  savedFile: join(dataHome(), "mini-chat.json"),
  initialPinned: pinnedFromSetting(savedSettings().miniChatHideOnBlur as boolean | undefined),
  zoomFactor: () => currentWindow()?.win.webContents.getZoomFactor() ?? 1.2 ** savedZoom(),
  inactive: INACTIVE,
  invisible: INVISIBLE,
  theme: savedTheme,
  colors: (theme) => ({ background: tokenColor("quick-entry-bg", theme), foreground: tokenColor("fg", theme), border: tokenColor("quick-entry-border", theme) }),
  log: logLine,
  strings: { daemonDown: S.quickEntryDaemonDownStatic },
});

const quickShortcut = new QuickShortcutController(
  { register: (accelerator, onPress) => globalShortcut.register(accelerator, onPress), unregister: (accelerator) => globalShortcut.unregister(accelerator) },
  () => quickEntry.toggle(),
  quickShortcutBlocked(process.env, INACTIVE),
);

const quickProbe = { reveals: [] as string[], finishes: [] as { agentId: string; stay: boolean }[], hosts: [] as { type: string }[], prs: [] as string[] };
let lastQuickStatus = "";

function applyQuickConfig(config: { enabled: boolean; accelerator: string }): QuickShortcutStatus {
  const status = quickShortcut.apply(config);
  const key = JSON.stringify(status);
  if (key !== lastQuickStatus) {
    lastQuickStatus = key;
    logLine(`[electron] quick entry shortcut: ${key}`);
    for (const w of liveWindows()) w.win.webContents.send("agent-nav:quick-entry-status", status);
  }
  return status;
}

function startQuickEntry() {
  const saved = savedSettings();
  applyQuickConfig(normalizeQuickEntryConfig({ enabled: saved.quickEntryEnabled, accelerator: saved.quickEntryShortcut }));
}

function openSessionInMainWindow(agentId: string) {
  quickProbe.reveals.push(agentId);
  if (!INACTIVE) app.focus({ steal: true });
  void routeToMainWindow({ agentId, action: "open" });
}

async function openPrInMainWindow(url: string) {
  const agentId = quickEntry.agentId;
  quickProbe.prs.push(url);
  if (!INACTIVE) app.focus({ steal: true });
  let target = windowForNotification(quickEntry.agentId ?? "");
  if (!target) {
    target = openNewWindow();
    await whenAppReady(target);
  }
  bringToFront(target);
  void dispatchToPage(target.win.webContents, "agent-nav:open-pr", { url, agentId });
}

function fromQuickPage(event: Electron.IpcMainInvokeEvent) {
  const contents = quickEntry.webContents;
  return !!contents && event.sender === contents && isOwnPageUrl(event.senderFrame?.url);
}

ipcMain.handle("agent-nav:quick-configure", (event, config: unknown) => {
  const value = config as { enabled?: unknown; accelerator?: unknown } | null;
  if (!fromOurPage(event) || typeof value?.enabled !== "boolean" || typeof value.accelerator !== "string") throw new Error("quick entry configure refused");
  return applyQuickConfig({ enabled: value.enabled, accelerator: value.accelerator });
});

ipcMain.handle("agent-nav:quick-status", (event) => {
  if (!fromOurPage(event)) throw new Error("quick entry status refused");
  return quickShortcut.status;
});

ipcMain.handle("agent-nav:quick-close", (event) => {
  if (!fromQuickPage(event)) throw new Error("quick entry close refused");
  quickEntry.hide();
});

ipcMain.handle("agent-nav:quick-resize", (event, cardHeight: unknown) => {
  if (!fromQuickPage(event) || typeof cardHeight !== "number" || !Number.isFinite(cardHeight)) throw new Error("quick entry resize refused");
  quickEntry.resize(cardHeight);
});

ipcMain.handle("agent-nav:quick-finish", (event, result: unknown) => {
  const value = result as { agentId?: unknown; stay?: unknown } | null;
  if (!fromQuickPage(event) || typeof value?.agentId !== "string" || value.agentId === "") throw new Error("quick entry finish refused");
  const stay = value.stay === true;
  quickProbe.finishes.push({ agentId: value.agentId, stay });
  quickEntry.finishSend(value.agentId, stay);
});

ipcMain.handle("agent-nav:quick-switch", (event, agentId: unknown) => {
  if (!fromQuickPage(event) || !(agentId === null || (typeof agentId === "string" && agentId !== ""))) throw new Error("quick entry switch refused");
  if (agentId === null) quickEntry.startNew();
  else quickEntry.switchTo(agentId);
});

ipcMain.handle("agent-nav:quick-pinned", (event, pinned: unknown) => {
  if (!fromQuickPage(event) || typeof pinned !== "boolean") throw new Error("quick entry pinned refused");
  quickEntry.setPinned(pinned);
});

ipcMain.handle("agent-nav:quick-open-main", (event, agentId: unknown) => {
  if (!fromQuickPage(event) || typeof agentId !== "string" || agentId === "") throw new Error("quick entry open refused");
  quickEntry.hide();
  openSessionInMainWindow(agentId);
});

ipcMain.handle("agent-nav:quick-host", (event, message: unknown) => {
  const value = message as { type?: unknown; url?: unknown; agentId?: unknown } | null;
  if (!fromQuickPage(event) || typeof value?.type !== "string") throw new Error("quick entry host refused");
  quickProbe.hosts.push({ type: value.type });
  if (value.type === "agent-nav:openPr" && typeof value.url === "string" && parsePrUrl(value.url)) {
    quickEntry.hide();
    void openPrInMainWindow(value.url);
  } else if (value.type === "agent-nav:openExternal" && typeof value.url === "string" && /^https?:/.test(value.url)) openExternalLink(value.url);
  else if ((value.type === "agent-nav:openFile" || value.type === "agent-nav:openDiff" || value.type === "agent-nav:openChanges") && quickEntry.agentId) {
    quickEntry.hide();
    openSessionInMainWindow(quickEntry.agentId);
  }
});

const folderPicks = { answers: [] as (string | null)[], asked: 0 };

ipcMain.handle("agent-nav:pick-folder", async (event) => {
  const source = appWindowOf(event);
  if (!source) throw new Error("pick folder refused");
  if (E2E_PORT !== null) {
    folderPicks.asked += 1;
    return folderPicks.answers.shift() ?? null;
  }
  const result = await dialog.showOpenDialog(source.win, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("agent-nav:zoom", (event, action: unknown) => {
  if (!fromOurPage(event)) throw new Error("zoom refused");
  if (action !== "in" && action !== "out" && action !== "reset") throw new Error("bad zoom action");
  return changeZoom(action, event.sender);
});

ipcMain.handle("agent-nav:reload-window", (event) => {
  const source = appWindowOf(event);
  if (!source) throw new Error("reload refused");
  setImmediate(() => reloadEntry(source));
});

ipcMain.handle("agent-nav:new-window", (event) => {
  if (!fromOurPage(event)) throw new Error("new window refused");
  openNewWindow();
});

ipcMain.handle("agent-nav:close-window", (event) => {
  const source = appWindowOf(event);
  if (!source) throw new Error("close window refused");
  closeWindowEntry(source);
});

ipcMain.handle("agent-nav:open-agents", (event, agentIds: unknown, layoutMode: unknown) => {
  const source = appWindowOf(event);
  if (!source || !Array.isArray(agentIds)) throw new Error("open agents refused");
  openAgents.set(source.id, new Set(agentIds.filter((id): id is string => typeof id === "string").slice(0, 200)));
  source.layoutMode = layoutMode === "chat" || layoutMode === "editor" ? layoutMode : null;
});

ipcMain.handle("agent-nav:open-notification-session", (event, agentId: unknown) => {
  if (!fromOurPage(event) || typeof agentId !== "string" || agentId.length > 100) throw new Error("open notification session refused");
  return routeOpenSession(agentId);
});

ipcMain.handle("agent-nav:window-ids", (event) => {
  if (!fromOurPage(event)) throw new Error("window ids refused");
  return registry.windows.map((w) => w.id);
});

ipcMain.handle("agent-nav:restart-daemon", (event) => {
  if (!fromOurPage(event)) throw new Error("restart refused");
  if (quitFlow.quitting || !daemon) return false;
  return daemon.restart();
});

ipcMain.handle("agent-nav:daemon-state", (event) => {
  if (!fromOurPage(event)) throw new Error("daemon state refused");
  return daemon?.state ?? { state: "running", attempt: 0, maxAttempts: 0 };
});

const NOTIFY_DEDUPE_MS = 3000;
const recentNotify = new Map<string, { at: number; windowId: string }>();

ipcMain.handle("agent-nav:notify", (event, payload: unknown) => {
  const fromMini = fromQuickPage(event);
  if (!(fromMini || fromOurPage(event)) || !validNotify(payload)) throw new Error("notify refused");
  const miniRoute = notificationTarget({ agentId: payload.agentId, miniAgentId: quickEntry.agentId, miniVisible: quickEntry.visible });
  if (miniRoute === "suppress") return true;
  if (liveWindows().some((w) => w.win.isFocused()) || NOTIFY_FOCUSED) return false;
  const sourceId = fromMini ? "mini" : appWindowOf(event)!.id;
  const key = `${payload.agentId}:${payload.kind}:${payload.body}`;
  const previous = recentNotify.get(key);
  recentNotify.set(key, { at: Date.now(), windowId: sourceId });
  if (previous && previous.windowId !== sourceId && Date.now() - previous.at < NOTIFY_DEDUPE_MS) return true;
  return notifier.show(payload);
});

ipcMain.handle("agent-nav:badge", (event, count: unknown) => {
  if (!fromOurPage(event) || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 9999) throw new Error("badge refused");
  app.setBadgeCount(count);
});

ipcMain.handle("agent-nav:notify-clear", (event, agentId: unknown) => {
  if (!(fromQuickPage(event) || fromOurPage(event)) || typeof agentId !== "string") throw new Error("notify refused");
  notifier.clear(agentId);
});

const configured = new WeakSet<Electron.Session>();
function configureBrowserSession(browserSession: Electron.Session) {
  if (configured.has(browserSession)) return;
  configured.add(browserSession);
  browserSession.webRequest.onBeforeSendHeaders({ urls: ["https://accounts.google.com/*"] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    const key = Object.keys(headers).find((name) => name.toLowerCase() === "user-agent");
    if (key) headers[key] = chromeLikeUserAgent(headers[key]);
    callback({ requestHeaders: headers });
  });
  try {
    browserSession.webRequest.onBeforeRequest({ urls: [`http://127.0.0.1:${PORT}/*`, `http://localhost:${PORT}/*`] }, (_details, callback) => callback({ cancel: true }));
  } catch (error) {
    logLine(`[electron] could not block daemon requests from the browser session: ${String(error)}`);
  }
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    void resolvePermission(permission, details.requestingUrl || contents.getURL(), mediaTypes, contents).then(callback, () => callback(false));
  });
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (isAlwaysAllowed(permission)) return true;
    const origin = permissionOrigin((details as { requestingUrl?: string }).requestingUrl || requestingOrigin || contents?.getURL() || "");
    const categories = categoriesFor(permission, (details as { mediaType?: string }).mediaType ? [(details as { mediaType?: string }).mediaType as string] : undefined);
    return permissions.decide(origin, categories) === "allow";
  });
  bindDeviceSession(browserSession, deviceRequests, (frame) => {
    const url = frame?.url;
    return webContents.getAllWebContents().find((c) => c.getType() === "webview" && !c.isDestroyed() && c.session === browserSession && (!url || c.getURL() === url)) ?? null;
  });
}

function e2eContext(): E2EContext<AppWindow, NotifyPayload> {
  return {
    windowById: (id) => appWindows.get(id) ?? null,
    currentWindow,
    liveWindows,
    lastActiveId: () => lastActiveId,
    setLastActiveId: (id) => {
      lastActiveId = id;
    },
    openAgentsOf: (windowId) => openAgents.get(windowId) ?? [],
    openNewWindow,
    whenAppReady: (entry) => whenAppReady(entry),
    closeWindow: closeWindowEntry,
    requestOpen,
    openState: () => ({ queueReady: openQueue.isReady, pending: openQueue.pending, outcomes: openOutcomes }),
    registryState: () => ({ registry, file: registryFile() }),
    quitting: () => quitFlow.quitting,
    daemonPid: () => daemon?.state.pid ?? null,
    notifyRoutes,
    notifier,
    folderPicks,
    deviceRequests,
    quickEntry,
    quickShortcutStatus: () => quickShortcut.status,
    quickProbe,
    applyQuickConfig,
  };
}

function setDockIcon() {
  if (app.isPackaged) {
    console.log("[electron] dock icon: from the app bundle (Info.plist CFBundleIconFile)");
    return;
  }
  if (!app.dock) return;
  const image = nativeImage.createFromPath(join(APP_ROOT, "build", "icon.png"));
  if (image.isEmpty()) {
    console.log("[electron] dock icon: build/icon.png not found, keeping the default");
    return;
  }
  app.dock.setIcon(image);
  console.log(`[electron] dock icon set from build/icon.png (${image.getSize().width}x${image.getSize().height})`);
}

if (INVISIBLE && process.platform === "darwin") app.setActivationPolicy("accessory");

app.whenReady().then(async () => {
  if (!gotInstanceLock) return;
  startupMark("ready");
  const daemonUp = Promise.resolve(daemon?.connect()).then(waitForDaemon);
  startupMark("daemon-connecting");
  daemonUp.catch(() => undefined);
  console.log(`[electron] name=${app.getName()} userData=${app.getPath("userData")} logs=${app.getPath("logs")} packaged=${app.isPackaged} invisible=${INVISIBLE}`);
  if (INVISIBLE && process.platform === "darwin") {
    app.setActivationPolicy("accessory");
    app.dock?.hide();
  } else setDockIcon();
  loadPermissions();
  configureBrowserSession(session.fromPartition(BROWSER_PARTITION));
  buildMenu();
  watchBoardMenu();
  if (!INVISIBLE) app.dock?.setMenu(Menu.buildFromTemplate([{ label: S.menu.newWindow, click: () => void openNewWindow() }]));
  startupMark("menu-built");
  const saved = loadRegistry(registryFile());
  const plan = launchPlan(saved);
  launchSpareId = saved.windows.length === 0 ? (plan.open[0]?.id ?? null) : null;
  registry = plan.registry;
  persistRegistry();
  logLine(`[electron] restoring ${plan.open.length} window(s): ${plan.open.map((w) => w.id).join(", ")}`);
  const opened = plan.open.map((record) => createWindow(record, { deferLoad: true }));
  startupMark("windows-created");
  await daemonUp;
  startupMark("daemon-ready");
  for (const entry of opened) loadAppPage(entry);
  startupMark("pages-loading");
  logLine(`[electron] startup ms since process start: ${startupMarks.map(([name, ms]) => `${name}=${ms}`).join(" ")}`);
  startQuickEntry();
  if (E2E_PORT) startE2E(E2E_PORT, createE2EHandler(e2eContext()));
  void openQueue.ready().finally(() => {
    launchSpareId = null;
  });
  app.on("activate", () => {
    if (liveWindows().length === 0 && !quitFlow.quitting) openNewWindow();
  });
});

app.on("window-all-closed", () => {
  if (quitWhenAllWindowsClosed(process.platform)) app.quit();
});
app.on("before-quit", (event) => {
  const decision = quitFlow.onBeforeQuit();
  if (decision !== "pass") event.preventDefault();
});
app.on("will-quit", () => {
  daemon?.close();
  quickShortcut.release();
  globalShortcut.unregisterAll();
  quitFlow.onWillQuit();
});
app.on("quit", () => quitFlow.onQuit());

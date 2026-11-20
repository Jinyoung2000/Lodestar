import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, Menu, app, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, session, shell, utilityProcess, webContents, type UtilityProcess } from "electron";
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
import { LineStamper, stampLine } from "./logStamp";
import { QuitFlow } from "./quitFlow";
import { createE2EHandler, startE2E, type E2EContext } from "./e2eChannel";
import { registerBrowserGuestIpc } from "./browserGuestIpc";
import { loadPermissions, permissions, registerSitePermissions } from "./sitePermissions";
import { NOTIFY_FOCUSED, NOTIFY_STUB, Notifier, validNotify, type NotifyAction, type NotifyMode, type NotifyPayload } from "./notifications";
import { RestartScheduler, restartWaitMs } from "../shared/restartGate";
import type { PickTheme } from "./pickScript";
import { externalOpenUrl } from "../shared/slackLink";
import { notionOpenPlan } from "../shared/notionLink";
import { parsePrUrl } from "../shared/prUrl";
import { normalizeQuickEntryConfig, QuickShortcutController, quickShortcutBlocked, type QuickShortcutStatus } from "../shared/quickEntry"; // QUICKENTRY
import { QuickEntryWindow } from "./quickEntry"; // QUICKENTRY
import { notificationTarget, pinnedFromSetting } from "../shared/miniChat"; // MINICHAT
import { chromeLikeUserAgent, guestPopupDecision } from "./guestPopup";
import { S } from "../web/strings";
import tokens from "../design-system/tokens.json";
import { applyClose, cascade, closePolicy, EMPTY_REGISTRY, fitBounds, launchPlan, newWindowPlan, quitWhenAllWindowsClosed, targetWindow, updateRecord, windowForAgent, windowUrl, type Registry, type WindowRecord } from "../shared/windows";
import { loadRegistry, saveRegistry } from "./windowRegistry";
import { argvOpenPaths, classifyOpenPath, OpenQueue, planOpenWindow, type OpenTarget, type PathFs } from "../shared/openPath"; // OPENFOLDER
import type { OpenFolderRequest, OpenFolderResult } from "../web/openFolder"; // OPENFOLDER

// 데몬(server/index.ts 번들)을 utility process 로 띄우고, 같은 주소를 창에 연다.
// 브라우저 탭과 달리 ⌘W, ⌘N 같은 예약 키를 앱 메뉴가 받아 페이지로 넘긴다.
// 시작 단계 시각(프로세스 시작 뒤 ms). 첫 창이 뜬 뒤 한 줄로 로그에 남긴다(.verify/perf-startup 이 읽는다).
const startupMarks: [string, number][] = [];
const startupMark = (name: string) => startupMarks.push([name, Math.round(process.uptime() * 1000)]);
startupMark("main-eval");
const PORT = Number(process.env.AGENT_NAV_PORT ?? 7788);
const URL_BASE = `http://127.0.0.1:${PORT}`;
// 데몬 주소의 페이지인가. 문자열 앞부분만 보면 http://127.0.0.1:7788@evil.example/ (사용자 정보 자리에 데몬 주소)도 통과해서 origin 을 비교한다.
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
// AGENT_NAV_INACTIVE=1 이거나 검증 창구가 켜져 있으면 창을 앞으로 가져오지 않는다(포커스를 뺏지 않음). 알림을 눌러도 마찬가지다.
const INACTIVE = process.env.AGENT_NAV_INACTIVE === "1" || E2E_PORT !== null;
// 시험 인스턴스는 포커스뿐 아니라 화면에도 나타나지 않는다. showInactive 창도 사용자의 작업 화면을 덮고 Dock 에 아이콘이 생겨서,
// Dock 없는 accessory 앱으로 띄우고 창은 투명하게, 마우스는 통과시킨다. 렌더와 capturePage, sendInputEvent 는 그대로 동작한다.
// 설치 앱을 화면 없이 띄우려는 게 아니면 AGENT_NAV_VISIBLE=1 로 끌 수 있다.
const INVISIBLE = INACTIVE && process.env.AGENT_NAV_VISIBLE !== "1";
// 시험 인스턴스의 메인 프로세스 예외는 Electron 기본 처리대로면 사용자 화면에 네이티브 경고창으로 뜬다(예: E2E 포트 충돌). 로그만 남기고 끝낸다.
if (INVISIBLE) {
  process.on("uncaughtException", (error) => {
    console.error("[test instance] uncaught exception, exiting:", error);
    app.exit(1);
  });
}

// 소스 레포(피드백 기능이 고치는 곳). 여기에 빌드 결과가 있으면 앱 번들 대신 그것으로 뜬다.
const SRC_ROOT = process.env.AGENT_NAV_SRC ?? join(homedir(), "Repository", "agent-nav");

let daemon: UtilityProcess | null = null;
let daemonReady = false;

type AppWindow = { id: string; win: BrowserWindow; hung: boolean; hungTimer: ReturnType<typeof setTimeout> | null; loadRecovery: boolean; reloads: number[]; loadCount: number; boundsTimer?: ReturnType<typeof setTimeout> | null };
const appWindows = new Map<string, AppWindow>();
// 켜고 끌 때 되살릴 창 목록(창 id, 자리). 파일은 userData/windows.json
let registry: Registry = EMPTY_REGISTRY;
// 마지막으로 활성이던 창. AGENT_NAV_INACTIVE 시험 인스턴스는 창이 OS 포커스를 받지 않아 이것이 명령 대상 창을 정한다.
let lastActiveId: string | null = null;
// 창마다 칸에 열려 있는 세션(페이지가 알린다). 알림을 누르면 그 세션이 열린 창으로 보낸다.
const openAgents = new Map<string, Set<string>>();

function liveWindows(): AppWindow[] {
  return [...appWindows.values()].filter((w) => !w.win.isDestroyed());
}

function focusedWindowId(): string | null {
  return liveWindows().find((w) => w.win.isFocused())?.id ?? null;
}

// 메뉴 명령, 전역 단축키, 시험 창구가 향하는 창: OS 포커스를 가진 창, 없으면 마지막 활성 창, 없으면 가장 나중에 만든 창.
function currentWindow(): AppWindow | null {
  const live = liveWindows();
  const id = targetWindow({ ids: live.map((w) => w.id), focusedId: focusedWindowId(), lastActiveId });
  return live.find((w) => w.id === id) ?? null;
}

// 창 페이지나 그 안의 <webview>(guest)가 속한 앱 창
function windowByContents(contents: Electron.WebContents | null | undefined): AppWindow | null {
  if (!contents || contents.isDestroyed()) return null;
  const host = contents.getType() === "webview" ? contents.hostWebContents : contents;
  return liveWindows().find((w) => w.win.webContents === host) ?? null;
}

// FIX3-1: 데몬이 뜬 뒤에 죽으면 다시 띄운다. 연속으로 실패하면 간격을 늘리다가 멈추고, 화면(web/DaemonBanner.tsx)이 상태를 보여 준다.
// 한 번 뜬 데몬이 STABLE_MS 넘게 살았으면 그 뒤의 죽음은 새 사고로 보고 실패 횟수를 0 부터 센다.
export type DaemonState = { state: "running" | "restarting" | "stopped"; attempt: number; maxAttempts: number };
const RESPAWN_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const STABLE_MS = 30_000;
// 앞 두 번의 재시도는 지금 쓰던 런타임으로, 그래도 죽으면 앱 번들 데몬으로 띄운다(레포 빌드가 망가진 경우).
const BUNDLE_AFTER_ATTEMPTS = 3;
let daemonState: DaemonState = { state: "running", attempt: 0, maxAttempts: RESPAWN_DELAYS_MS.length };
let respawnAttempts = 0;
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let daemonStartedAt = 0;

// FIX6A: 종료 순서와 상한(electron/quitFlow.ts). 종료가 시작된 뒤에는 데몬을 새로 띄우지 않는다.
const quitFlow = new QuitFlow({
  now: Date.now,
  log: logLine,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  closeWindows: closeAllWindows,
  closeHelpers: closeRunners,
  requestDaemonShutdown: () => {
    if (!daemon || daemon.pid === undefined) return false;
    daemon.postMessage({ type: "shutdown" });
    return true;
  },
  // 상한까지 안 끝난 데몬은 멈춘 것이다. SIGTERM 은 멈춘 프로세스에 안 먹어서 app.exit 이 Chromium 의 자식 종료 대기(약 2초)에 걸리므로 바로 끈다. CLI 정리는 데몬 자체 상한(4초)이 이미 시도했다.
  killDaemon: () => {
    if (daemon?.pid === undefined) return;
    try {
      process.kill(daemon.pid, "SIGKILL");
    } catch {
      // 이미 끝났다
    }
  },
  finishQuit: () => app.quit(),
  forceExit: () => {
    // app.exit 은 렌더러 unload 도 저장소 flush 도 거치지 않는다. 마지막 창 상태가 디스크에 닿도록 flush 를 요청하고 끝낸다.
    try {
      session.defaultSession.flushStorageData();
    } catch {
      // 종료 중이라 실패해도 그대로 끝낸다
    }
    app.exit(0);
  },
  restoreAfterCancel: () => {
    if (!daemon && process.env.AGENT_NAV_NO_DAEMON !== "1") {
      resetRespawn();
      startDaemon();
      void waitForDaemon()
        .then(() => setDaemonState("running"))
        .catch(() => undefined);
    } else setDaemonState("running");
  },
});

app.setName("Lodestar");
// 표시 이름만 바뀌었다. userData 와 로그 폴더는 앱 이름에서 정해지므로, 그대로 두면 새 폴더로 옮겨가 창 상태와 localStorage 가 사라진다. 옛 이름 폴더를 직접 가리킨다.
const LEGACY_DATA_NAME = "agent-nav";
// 검증용: AGENT_NAV_USER_DATA 가 있으면 설치된 앱과 프로필이 겹치지 않게 그 폴더를 쓴다.
app.setPath("userData", process.env.AGENT_NAV_USER_DATA || join(app.getPath("appData"), LEGACY_DATA_NAME));
app.setPath("logs", logDirFor(process.env.AGENT_NAV_HOME, homedir(), LEGACY_DATA_NAME));

const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) app.exit(0);

// 데몬이 뜨고 창이 만들어진 뒤에야 처리한다(whenReady 끝의 openQueue.ready()). 그 전에 온 요청은 순서대로 쌓인다.
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
    // 경로 없이 한 번 더 띄웠으면 이미 떠 있는 앱의 창을 앞으로 가져온다
    if (paths.length === 0 && openQueue.isReady && !quitFlow.quitting) raiseForOpen(currentWindow() ?? openNewWindow());
  });
  for (const path of argvOpenPaths(process.argv, openPathOptions(process.cwd()))) void requestOpen(path, "argv");
}

type Runtime = { kind: "repo" | "bundle"; root: string; daemon: string; note: string | null };

// 레포의 빌드 결과(웹 dist 와 데몬 번들)가 다 있고 깨져 있지 않으면 레포를, 아니면 번들을 쓴다.
// 데몬을 다시 띄울 때마다 새로 판단하므로, 피드백이 반영한 빌드가 재시작 뒤에 바로 쓰인다.
function pickRuntime(): Runtime {
  const bundle: Runtime = { kind: "bundle", root: APP_ROOT, daemon: join(import.meta.dirname, "daemon.mjs"), note: null };
  if (APP_ROOT === SRC_ROOT) return bundle;
  const problem = repoBuildProblem(SRC_ROOT);
  if (problem) return { ...bundle, note: problem };
  return { kind: "repo", root: SRC_ROOT, daemon: join(SRC_ROOT, "dist-electron", "daemon.mjs"), note: null };
}

function repoBuildProblem(root: string): string | null {
  if (!existsSync(root)) return "source folder not found";
  const index = join(root, "dist", "index.html");
  const daemonFile = join(root, "dist-electron", "daemon.mjs");
  if (!existsSync(index) || !existsSync(daemonFile)) return "repo build missing";
  try {
    // index.html 이 가리키는 자산이 비어 있으면 빌드가 도중에 끊긴 것이다.
    if (!readdirSync(join(root, "dist", "assets")).length || readFileSync(daemonFile, "utf8").length < 1000) return "repo build incomplete";
  } catch {
    return "repo build incomplete";
  }
  if (!existsSync(join(root, "node_modules"))) return "repo dependencies missing";
  return null;
}

function setDaemonState(state: DaemonState["state"]) {
  daemonState = { state, attempt: respawnAttempts, maxAttempts: RESPAWN_DELAYS_MS.length };
  for (const w of liveWindows()) w.win.webContents.send("agent-nav:daemon-state", daemonState);
}

// 예상 못 한 종료 뒤에 부른다. 간격은 RESPAWN_DELAYS_MS 순서이고, 다 쓰면 멈춘다(화면의 Restart Daemon 단추가 사람이 다시 시작하는 길이다).
function scheduleRespawn() {
  if (!quitFlow.mayStartDaemon() || respawnTimer) return;
  if (Date.now() - daemonStartedAt >= STABLE_MS) respawnAttempts = 0;
  if (respawnAttempts >= RESPAWN_DELAYS_MS.length) {
    console.error(`[electron] daemon keeps exiting, giving up after ${respawnAttempts} restarts`);
    setDaemonState("stopped");
    return;
  }
  const delay = RESPAWN_DELAYS_MS[respawnAttempts++];
  setDaemonState("restarting");
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    if (!quitFlow.mayStartDaemon() || daemon) return;
    startDaemon(respawnAttempts >= BUNDLE_AFTER_ATTEMPTS);
    void waitForDaemon()
      .then(() => setDaemonState("running"))
      .catch(() => undefined);
  }, delay);
}

// 사람이 시작한 재시작(Restart Daemon, 데몬이 요청한 재시작)은 자동 재시도 상태를 처음으로 되돌린다.
function resetRespawn() {
  if (respawnTimer) clearTimeout(respawnTimer);
  respawnTimer = null;
  respawnAttempts = 0;
}

// daemon.log 에 한 줄 더한다. 앱이 곧 끝나도 줄이 남도록 동기로 쓰고, 줄마다 ISO 시각을 붙인다.
function daemonLogFile() {
  const logDir = app.getPath("logs");
  mkdirSync(logDir, { recursive: true });
  return join(logDir, "daemon.log");
}

function logLine(message: string) {
  appendDaemonOutput(stampLine(message));
}

// daemon.log 는 데몬 stdout, stderr 를 모두 받아 계속 자란다. 이 크기를 넘으면 daemon.log.1 로 옮기고(이전 .1 은 지운다) 새로 쓴다.
const DAEMON_LOG_MAX_BYTES = 20 * 1024 * 1024;
let daemonLogBytes = -1;

function appendDaemonOutput(text: string) {
  if (!text) return;
  try {
    const file = daemonLogFile();
    if (daemonLogBytes < 0) daemonLogBytes = existsSync(file) ? statSync(file).size : 0;
    if (daemonLogBytes >= DAEMON_LOG_MAX_BYTES) {
      renameSync(file, `${file}.1`);
      daemonLogBytes = 0;
    }
    appendFileSync(file, text);
    daemonLogBytes += Buffer.byteLength(text);
  } catch {
    // 로그를 못 써도 앱 동작은 그대로다. 크기는 다음 줄에서 파일을 다시 재서 정한다(누가 파일을 지웠어도 옮기기를 되풀이하지 않는다).
    daemonLogBytes = -1;
  }
}

// 열려 있는 창을 모두 닫고 닫힐 때까지 기다린다. close 가 beforeunload 를 부르면 페이지가 창 상태와 저장 안 한 내용을 남긴다(web/windowState.ts).
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

function startDaemon(forceBundle = false) {
  if (!quitFlow.mayStartDaemon()) {
    logLine("[electron] daemon start skipped: app is quitting");
    return;
  }
  daemonReady = false;
  daemonStartedAt = Date.now();
  // 새 데몬이 떴으니 기다리던 재시작 요청은 이뤄진 것이다(자동 재시작이 대기 중인 재시작을 흡수한다). 다음 요청은 이 데몬의 시작 시각부터 쿨다운을 센다.
  restartGate.reset();
  let runtime = pickRuntime();
  if (forceBundle && runtime.kind === "repo") runtime = { kind: "bundle", root: APP_ROOT, daemon: join(import.meta.dirname, "daemon.mjs"), note: "repo build failed to start" };
  // 파이프로 들고 있지 않고 파일로 보낸다. 파이프를 읽지 않으면 데몬이 EPIPE 로 멈춘다. stdout 과 stderr 는 줄마다 시각을 붙인다.
  const outStamp = new LineStamper();
  const errStamp = new LineStamper();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.AGENT_NAV_ROOT = runtime.root;
  env.AGENT_NAV_PORT = String(PORT);
  env.AGENT_NAV_RUNTIME = runtime.kind;
  // IDLEUPDATE: 설치된 앱이 띄운 데몬만 자리를 비운 사이 자동 업데이트를 돈다(server/idleUpdate.ts).
  env.AGENT_NAV_PACKAGED = app.isPackaged ? "1" : "";
  if (runtime.note) env.AGENT_NAV_RUNTIME_NOTE = runtime.note;
  else delete env.AGENT_NAV_RUNTIME_NOTE;
  logLine(`[electron] starting daemon from ${runtime.kind} (${runtime.root})${runtime.note ? `: ${runtime.note}` : ""}`);
  const child = utilityProcess.fork(runtime.daemon, [], { env, stdio: "pipe", serviceName: "agent-nav-daemon" });
  daemon = child;
  child.stdout?.on("data", (chunk) => appendDaemonOutput(outStamp.feed(chunk)));
  child.stderr?.on("data", (chunk) => appendDaemonOutput(errStamp.feed(chunk)));
  child.on("exit", (code) => {
    logLine(`[electron] daemon exited code=${code}`);
    if (daemon === child) quitFlow.onDaemonExit(code);
    if (daemon === child && !quitFlow.mayStartDaemon()) {
      // 종료 중: 아무것도 다시 띄우지 않는다
      daemon = null;
    } else if (daemon === child && !daemonReady && runtime.kind === "repo") {
      // 레포 빌드가 뜨기도 전에 죽으면(깨진 번들 등) 앱 번들로 다시 띄운다.
      daemon = null;
      startDaemon(true);
    } else if (daemon === child) {
      // relaunchDaemon 이 끈 데몬은 daemon 이 이미 바뀌어 여기로 오지 않는다. 여기는 아무도 끄지 않았는데 죽은 경우다.
      daemon = null;
      scheduleRespawn();
    }
  });
  // 데몬이 스스로 재시작을 요청하면(피드백 반영 중 server/ 변경) 끄고 다시 띄운다. 페이지는 소켓을 다시 연결한다.
  child.on("message", (message: { type?: string }) => {
    if (message?.type === "shutdown-flushed") quitFlow.onDaemonMessage(message.type);
    // 이미 교체된 옛 데몬이 늦게 보낸 요청은 무시한다(진행 중인 재시작 위에 또 띄우면 자식이 둘 남는다).
    if (message?.type !== "restart" || daemon !== child || !quitFlow.mayStartDaemon()) return;
    // 데몬이 합류점(server/index.ts restartScheduler)에서 쿨다운을 이미 거쳐 보낸 요청이라 바로 한다. 재시작한 레포 데몬이 뜨지 못하면 앱 번들로 되돌리려고, 뜰 때까지 지켜본다.
    void restartDaemonAndReload(false);
  });
}

// 떠 있는 데몬을 끄고 새로 띄운다(레포 빌드를 다시 고르므로 새 데몬 코드가 반영된다). 새 데몬이 응답할 때까지는 기다리지 않는다.
// graceful 이면 데몬에 shutdown 을 보내 저장과 CLI 프로세스 정리를 마치고 스스로 끝나게 하고, 시간이 지나도 안 끝나면 강제로 끈다. 이미 끝난 데몬이면 바로 띄운다.
const SHUTDOWN_GRACE_MS = 3000;
let relaunching: Promise<void> | null = null;
function relaunchDaemon(graceful: boolean): Promise<void> {
  if (!quitFlow.mayStartDaemon()) return Promise.resolve();
  if (relaunching) return relaunching;
  const old = daemon;
  daemon = null;
  resetRespawn();
  relaunching = new Promise<void>((resolve) => {
    const launch = () => {
      startDaemon();
      resolve();
    };
    if (!old || old.pid === undefined) return launch();
    const force = graceful ? setTimeout(() => old.kill(), SHUTDOWN_GRACE_MS) : null;
    old.once("exit", () => {
      if (force) clearTimeout(force);
      launch();
    });
    if (graceful) old.postMessage({ type: "shutdown" });
    else old.kill();
  });
  return relaunching.finally(() => (relaunching = null));
}

// 메뉴 Restart Daemon 의 요청 합류점. 직전 재시작으로 뜬 직후(RESTART_MIN_MS)에는 하지 않고 합쳐서 나중에 한다. 창 연결은 데몬 쪽 합류점이 따로 보므로 여기서는 시간만 센다.
const restartGate = new RestartScheduler({
  now: Date.now,
  wait: () => restartWaitMs({ now: Date.now(), startedAt: daemonStartedAt }),
  run: () => void restartDaemonAndReload(true),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

// 데몬을 다시 띄우고, 새 데몬이 응답하면 창을 다시 읽는다. 새 데몬이 뜨지 못했으면 창은 그대로 둔다(끊김 띠가 상태를 보인다).
// 창을 읽는 일을 페이지에 맡기지 않는 이유: 페이지가 옛 데몬이 응답하는 것만 보고 다시 읽으면, 옛 데몬이 끝나고 새 데몬이 listen 하기 전 틈에서 읽어 오류 페이지로 멈췄다.
async function restartDaemonAndReload(graceful: boolean): Promise<boolean> {
  await relaunchDaemon(graceful);
  const ready = await waitForDaemon().then(
    () => true,
    () => false,
  );
  if (!ready) {
    logLine("[electron] restart: the new daemon did not answer, leaving the window as it is");
    return false;
  }
  setDaemonState("running");
  reloadAppWindow();
  return true;
}

// 데몬이 다시 떴으면 모든 창을 다시 읽는다. 앱 화면이 떠 있으면 다시 읽고, 오류 페이지나 빈 화면이면 주소를 새로 연다.
function reloadAppWindow() {
  // 데몬이 다시 떴거나 창을 다시 읽는 중이면 빠른 입력창도 새 페이지로 다시 만든다(쓰던 글은 페이지가 localStorage 에도 둔다).
  quickEntry.destroy();
  for (const entry of liveWindows()) reloadEntry(entry);
}

function reloadEntry(entry: AppWindow) {
  const contents = entry.win.webContents;
  if (contents.getURL().startsWith(URL_BASE)) contents.reload();
  else void contents.loadURL(pageUrl(entry)).catch(() => undefined);
}

// 데몬은 뜨는 데 0.15초쯤 걸린다. 응답 사이 대기가 길면 그만큼 창이 늦게 열리므로 짧게 자주 묻는다.
const DAEMON_POLL_MS = 25;
const DAEMON_WAIT_MS = 20_000;
async function waitForDaemon() {
  const deadline = Date.now() + DAEMON_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL_BASE, { headers: { host: `127.0.0.1:${PORT}` } });
      if (res.ok) {
        daemonReady = true;
        return;
      }
    } catch {
      // 아직 안 떴다
    }
    await new Promise((r) => setTimeout(r, DAEMON_POLL_MS));
  }
  throw new Error(S.electronDaemonNotStarted);
}

function dispatchToPage(contents: Electron.WebContents, type: string, detail: unknown) {
  return contents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(type)}, { detail: ${JSON.stringify(detail)} }))`);
}

// 앱 메뉴 명령을 포커스된 창(없으면 마지막 활성 창)의 페이지로 보낸다. 창이 하나도 없을 때(macOS 는 창 없이 Dock 에 남는다)는 새 창만 연다.
function send(command: string) {
  const target = currentWindow();
  if (!target) {
    openNewWindow();
    return;
  }
  void dispatchToPage(target.win.webContents, "agent-nav:command", command);
}

let keymapState = keymapStateOf(savedSettings());

// 마지막으로 만든 메뉴가 Board 항목을 담았는지. 데몬이 쓰는 settings.json 의 showBoard 를 읽는다.
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

// 창 바탕색은 페이지가 뜨기 전 잠깐 보이는 색이라, 설정의 테마와 색 스타일에 맞춰 디자인 토큰 chrome-bg 를 쓴다 (esbuild 가 tokens.json 을 번들에 넣는다).
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
    // 설정 파일이 없으면 다크
  }
  return { theme, style };
}

// 토큰 색. 색 스타일(webstorm)의 값이 있으면 그것을, 없으면 기본 값을 쓴다. 빌드가 CSS 로 하는 폴백(build-tokens.mjs)과 같은 규칙이다.
type StyledColor = { dark: string; light: string } & Partial<Record<"webstorm-dark" | "webstorm-light", string>>;
function styledTokenColor(name: string, theme: "dark" | "light", style: string | undefined): string {
  const value = tokens.color.tokens.find((t) => t.name === name)!.value as StyledColor;
  return (style === "webstorm" ? value[`webstorm-${theme}`] : undefined) ?? value[theme];
}

// 요소 선택 화면(페이지 안에 그려지는 윤곽, 라벨, 댓글 입력줄)의 색. 앱 테마에 맞춰 디자인 토큰에서 읽는다.
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

// 확대 배율을 페이지에 알린다: 제목줄은 신호등 버튼(네이티브)과 같은 화면 크기를 지키도록 이 값으로 되돌려 그린다(web/styles.css).
function applyZoomTo(win: BrowserWindow, level: number) {
  if (win.isDestroyed()) return;
  win.webContents.setZoomLevel(level);
  void win.webContents.executeJavaScript(`document.documentElement.style.setProperty("--window-zoom", ${JSON.stringify(String(1.2 ** level))})`);
}

// 확대 배율은 모든 창에 같이 적용한다. 다음 단계는 이 요청을 보낸 창의 현재 배율에서 센다.
function changeZoom(action: "in" | "out" | "reset", from: Electron.WebContents): number {
  const current = from.getZoomLevel();
  const next = action === "reset" ? 0 : Math.min(Math.max(Math.round(current) + (action === "in" ? 1 : -1), ZOOM_MIN), ZOOM_MAX);
  for (const w of liveWindows()) applyZoomTo(w.win, next);
  try {
    mkdirSync(join(zoomFile(), ".."), { recursive: true });
    writeFileSync(zoomFile(), JSON.stringify({ level: next }));
  } catch {
    // 적지 못해도 이번 실행에서는 확대가 유지된다
  }
  return next;
}

// deferLoad 이면 창만 만들고 주소는 부르는 쪽이 loadAppPage 로 연다(데몬이 뜨는 동안 창 만들기를 겹치려고).
function createWindow(record: WindowRecord, options: { deferLoad?: boolean } = {}): AppWindow {
  const id = record.id;
  const bounds = fitBounds(record.bounds, screen.getAllDisplays().map((d) => d.workArea));
  const win = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    title: "Lodestar",
    show: false,
    backgroundColor: windowBackground(),
    // 제목줄은 페이지가 그린다 (신호등 자리만 비워 둔다).
    titleBarStyle: "hiddenInset",
    // webviewTag 는 Browser 탭(web/BrowserTab.tsx)의 <webview> 용이다. 붙는 guest 는 아래 will-attach-webview 가 권한을 모두 깎는다.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, preload: join(import.meta.dirname, "preload.cjs") },
  });
  const entry: AppWindow = { id, win, hung: false, hungTimer: null, loadRecovery: false, reloads: [], loadCount: 0 };
  appWindows.set(id, entry);
  lastActiveId = id;
  win.on("focus", () => {
    lastActiveId = id;
  });
  // 메뉴 가속키는 페이지보다 먼저 키를 먹는다. 그러면 ⌘K 뒤에 오는 ⌘\, ⌘W 가 chord 의 두 번째 키가 아니라 메뉴 명령으로 실행된다.
  // 단축키 표(web/keymap.ts)에 든 ⌘ 또는 ⌥ 조합은 여기서 가로채 날 키(code 와 수정키)로 페이지에 넘기고, 표와 chord 상태 기계는 페이지가 한 곳에서 돌린다.
  // preventDefault 는 페이지 keydown 과 메뉴 단축키를 둘 다 막으므로 같은 키가 두 번 실행되지 않는다. 합성 입력(검증 창구)도 이 단계를 지난다.
  // 창마다 따로 등록하고 키를 받은 창의 페이지로만 넘기므로, 단축키는 그 키가 들어온 창에만 적용된다.
  win.webContents.on("before-input-event", (event, input) => forwardKey(event, input, keymapState.intercept, win.webContents));
  win.webContents.on("dom-ready", () => applyZoomTo(win, savedZoom()));
  if (E2E_PORT) win.webContents.on("did-start-loading", () => entry.loadCount++);
  // 다시 읽는 중인 창은 배치가 복원될 때까지 폴더 열기가 기다린다(OPENFOLDER)
  win.webContents.on("did-start-loading", () => settledWindows.delete(id));
  // 페이지가 beforeunload 로 닫기를 막으면 Electron 은 조용히 창을 안 닫는다. 이 리스너가 없으면 종료가 멈추므로 항상 둔다.
  win.webContents.on("will-prevent-unload", (event) => {
    // FIX6A: 저장 안 한 내용은 페이지가 beforeunload 에서 창 상태 저장본에 보관했다가 다음 실행에서 복원한다(web/windowState.ts 의 hot exit). 여기서 동기 대화상자로 종료를 멈추지 않고 항상 닫기를 허용한다.
    logLine(`[electron] window ${id}: will-prevent-unload, leaving without a dialog`);
    event.preventDefault();
  });
  watchRenderer(entry);
  win.on("close", () => {
    logLine(`[electron] window ${id}: close`);
    // 닫히는 창의 마지막 자리를 목록에 남긴다(마지막 창이면 다음 실행 기본값이 된다)
    saveWindowBounds(entry);
  });
  win.on("closed", () => handleWindowClosed(entry));
  trackWindowBounds(entry);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url, entry);
    return { action: "deny" };
  });
  // 앱 창은 데몬 주소의 페이지만 띄운다. target 없는 링크(사용자 메시지, 곁대화, Notion 본문)를 누르면 창 전체가 바깥 페이지로 바뀌고 그 페이지가 preload 를 받는다. 바깥 주소는 외부 링크로 연다.
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
    // 저장해 둔 최대화와 전체 화면. 시험 인스턴스는 화면에 나타나지 않게 건드리지 않는다.
    if (record.maximized && !INVISIBLE) win.maximize();
    if (record.fullScreen && !INVISIBLE) win.setFullScreen(true);
    if (INACTIVE) win.showInactive();
    else win.show();
  });
  if (!options.deferLoad) loadAppPage(entry);
  broadcastWindowIds();
  return entry;
}

// Browser 탭의 guest 는 앱 페이지와 같은 권한이 아니다: preload 와 node 를 끄고 별도 partition 에 가두며, agent-nav 데몬 주소(토큰이 든 index.html)와 http, https 가 아닌 주소는 열지 않는다.
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
  // 탭이 고른 저장 범위(설정 Data Storage)의 partition 만 허락한다. 모양이 맞지 않으면 기본 partition 이다.
  // Electron 은 이 이벤트 전에 params.partition 을 webPreferences.partition 으로 옮겨 두고 guest 를 webPreferences 로 만든다. params 만 고치면 강제되지 않는다.
  params.partition = isBrowserPartition(params.partition) ? params.partition : BROWSER_PARTITION;
  webPreferences.partition = params.partition;
  configureBrowserSession(session.fromPartition(params.partition));
  if (!isBrowsableInGuest(params.src)) event.preventDefault();
}

function loadAppPage(entry: AppWindow) {
  void entry.win.loadURL(windowUrl(URL_BASE, entry.id));
}

// 새 창 요청(⇧⌘N, 메뉴 File > New Window, Dock 메뉴)과 Dock 클릭(activate). 열린 창이 없으면 목록에 남은 마지막 창(다음 실행 기본값)을 되살리고, 있으면 포커스된 창에서 비껴 선 빈 창을 연다.
function openNewWindow(): AppWindow {
  const alive = new Set(liveWindows().map((w) => w.id));
  const from = currentWindow();
  const area = from ? screen.getDisplayMatching(from.win.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
  const plan = newWindowPlan(registry, alive, from ? cascade(from.win.getNormalBounds(), area) : null);
  registry = plan.registry;
  persistRegistry();
  logLine(`[electron] new window ${plan.record.id}${plan.reused ? " (reopened the last closed window)" : ""}`);
  return createWindow(plan.record);
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
  // 종료 중에 닫히는 창은 목록에 남겨 다음 실행이 되살리고, 마지막 창도 남긴다. 그 밖에는 목록에서 빼고, 남은 창이 그 창의 저장본(localStorage)을 지운다.
  const policy = closePolicy({ quitting: quitFlow.quitting, registryCount: registry.windows.length });
  registry = applyClose(registry, entry.id, policy);
  persistRegistry();
  logLine(`[electron] window ${entry.id}: closed (list: ${policy}, ${registry.windows.length} in list, ${appWindows.size} open)`);
  broadcastWindowIds();
  // macOS 는 창이 없어도 앱이 남는다. 그 밖의 플랫폼은 숨겨 둔 빠른 입력창이 마지막 창이 닫혔다는 신호(window-all-closed)를 막지 않게 치운다.
  if (appWindows.size === 0 && quitWhenAllWindowsClosed(process.platform)) quickEntry.destroy();
}

function registryFile() {
  return join(app.getPath("userData"), "windows.json");
}

function persistRegistry() {
  saveRegistry(registryFile(), registry);
}

// 창을 옮기거나 키우면(지연 뒤) 목록의 자리를 고친다. 앱을 다시 켜면 그 자리에 그 크기로 열린다.
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

// 살아 있는 창 목록(목록 파일의 id)을 모든 창 페이지에 알린다. 페이지는 목록에 없는 창의 localStorage 범위를 지운다(web/windowSweep.ts).
function broadcastWindowIds() {
  const ids = registry.windows.map((w) => w.id);
  for (const w of liveWindows()) w.win.webContents.send("agent-nav:windows-changed", ids);
}

const RELOAD_STROKE = "Meta+KeyR";
// Electron 이 응답 없음(unresponsive)을 알린 뒤에도 이 시간 넘게 응답하지 않으면 사용자가 누르지 않아도 강제로 끝내고 다시 읽는다. 그 전이라도 ⌘R 은 바로 강제로 다시 읽는다.
const HUNG_RELOAD_MS = 15_000;
// 렌더러가 연달아 죽을 때 다시 읽기를 무한히 되풀이하지 않는 상한
const RENDERER_RELOADS_PER_MIN = 3;
const BOUNDS_SAVE_MS = 500;

const pageUrl = (entry: AppWindow) => windowUrl(URL_BASE, entry.id);

// 창 페이지가 죽거나 멈추거나 읽기에 실패했을 때의 복구. 창마다 따로 센다. 로그는 daemon.log 에 남는다.
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
    if (details.reason === "clean-exit" || !quitFlow.mayStartDaemon()) return;
    const now = Date.now();
    while (entry.reloads.length && now - entry.reloads[0] > 60_000) entry.reloads.shift();
    if (entry.reloads.length >= RENDERER_RELOADS_PER_MIN) {
      logLine(`[electron] ${tag}: render process keeps dying, not reloading again`);
      return;
    }
    entry.reloads.push(now);
    void contents.loadURL(pageUrl(entry)).catch(() => undefined);
  });
  // 읽기에 실패하면(데몬이 종료되는 틈에 읽은 경우 등) Chromium 오류 페이지가 남고, 그 페이지에는 앱의 단축키를 받을 곳이 없다. 데몬이 응답하면 주소를 다시 연다. -3 은 다른 이동이 덮어서 중단된 것이다.
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
    for (let attempt = 1; attempt <= 3 && !contents.isDestroyed() && quitFlow.mayStartDaemon(); attempt++) {
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

// 창 페이지 상태. app: 앱 화면이 떠서 1초 안에 스크립트에 답한다. elsewhere: 오류 페이지, 빈 페이지, 읽는 중이라 앱 화면이 아니다. hung: 렌더러가 답하지 않는다.
async function pageState(entry: AppWindow | null): Promise<"app" | "elsewhere" | "hung"> {
  if (!entry || entry.win.isDestroyed()) return "elsewhere";
  if (entry.hung) return "hung";
  const contents = entry.win.webContents;
  if (!contents.getURL().startsWith(URL_BASE)) return "elsewhere";
  // __agentNav 는 web/main.tsx 가 바로 만들고, 앱 창 시작점(web/appMain.tsx)이 runCommand 를 덧붙인다. 앱이 뜬 것은 후자로 본다.
  const ping = contents.executeJavaScript("typeof window.__agentNav?.runCommand === 'function'").catch(() => false);
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000));
  const answer = await Promise.race([ping, timeout]);
  return answer === "timeout" ? "hung" : answer ? "app" : "elsewhere";
}

// Reload Window(메뉴, ⌘R). 앱 화면이 살아 있으면 페이지의 명령으로 보내 저장 안 한 변경 확인을 거치고, 아니면 메인이 직접 강제로 다시 읽는다. 그 창 하나만 다시 읽는다.
async function reloadWindowCommand(entry: AppWindow | null, viaPage: () => void) {
  if (!entry) return;
  const state = await pageState(entry);
  if (state === "app") viaPage();
  else forceReloadAppWindow(entry, state === "hung" ? "Reload Window while the renderer does not answer" : "Reload Window while the page is not the app", state === "hung");
}

// 멈춘 렌더러는 끝내고 다시 읽는다(같은 주소를 다시 열어도 멈춘 렌더러가 이전 페이지를 놓아 주지 않는다. 끝나면 render-process-gone 이 다시 읽는다). 그 밖에는 주소를 새로 연다.
function forceReloadAppWindow(entry: AppWindow, reason: string, hung = entry.hung) {
  if (entry.win.isDestroyed()) return;
  logLine(`[electron] window ${entry.id}: forcing a reload (${reason})`);
  const contents = entry.win.webContents;
  if (hung) contents.forcefullyCrashRenderer();
  else void contents.loadURL(pageUrl(entry)).catch(() => undefined);
}

// 새로 연 창의 앱 화면이 뜰 때까지 기다린다(알림을 눌러 창을 새로 열었을 때 명령을 받을 곳이 생긴 뒤에 보낸다).
async function whenAppReady(entry: AppWindow, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !entry.win.isDestroyed()) {
    if ((await pageState(entry)) === "app") {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// 단축키 표의 키를 메뉴가 먹기 전에 가로채 날 키로 페이지에 넘긴다. strokes 는 가로챌 키 집합이고, source 는 키가 들어온 창 페이지(또는 그 안의 guest)다. 넘기는 곳은 그 창 하나다.
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
  // ⌘R 은 페이지가 처리하지만, 페이지가 오류 페이지거나 멈춰 있으면 들을 곳이 없다. 그때는 메인이 직접 다시 읽는다.
  if (stroke === RELOAD_STROKE) void reloadWindowCommand(target, toPage);
  else toPage();
}

// 앱 안에서 누른 외부 링크를 연다. Slack 메시지 링크는 설정(slackLinkTarget, slackTeamId)에 따라 Slack 앱(slack://)으로 보내고,
// Notion 링크는 설정 notionLinkTarget 에 따라 Lodestar 의 Browser 탭(화면에 알림), Notion 앱(notion://), 기본 브라우저로 보낸다.
// 설정은 데몬이 쓰는 settings.json 을 누를 때마다 읽는다(설정을 바꾸면 앱을 다시 띄우지 않아도 바로 적용된다).
function openExternalLink(url: string, from?: AppWindow | null) {
  let saved: { slackLinkTarget?: unknown; slackTeamId?: unknown; notionLinkTarget?: unknown } = {};
  try {
    saved = JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    // 설정 파일이 없거나 깨졌으면 기본 브라우저로 연다
  }
  const notion = notionOpenPlan(url, saved);
  if (notion?.via === "tab" || notion?.via === "screen") {
    // 같은 페이지가 이미 열린 탭이면 그 탭으로 가는 판단은 화면(web/notionStore.ts openNotionInApp)이 한다
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
  // 시험 인스턴스가 사용자의 브라우저나 Slack 을 띄우지 않도록, 열 주소를 파일에 적기만 한다.
  if (process.env.AGENT_NAV_OPEN_LOG) appendFileSync(process.env.AGENT_NAV_OPEN_LOG, `${target}\n`);
  else void shell.openExternal(target);
}

// shell.openExternal 로 넘길 수 있는 주소. Slack, GitHub check, Notion 에서 온 링크도 여기로 오므로, 받은 앱이 파일을 열거나 실행하는 스킴(smb:, ftp:, 다른 앱의 스킴)은 넘기지 않는다.
// file: 은 Browser 탭의 Open in External Browser 가 보던 문서만 허락한다(.app, .command 같은 실행 파일은 Finder 가 실행한다).
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

// Browser 탭 guest 의 이동과 새 창. 새 창은 앱 안에 만들지 않고 기본 브라우저로 보낸다.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const decision = guestPopupDecision({ openerUrl: contents.getURL(), targetUrl: url, disposition });
    // 로그인 창: Notion 페이지가 크기를 지정해 연 Notion 또는 로그인 제공자 창만 앱 안 작은 창으로 허락한다(근거는 electron/guestPopup.ts). 시험 인스턴스는 창을 만들지 않는다.
    if (decision === "popup" && !INVISIBLE) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, session: contents.session } } };
    }
    if (decision !== "deny" && parseBrowsable(url)) {
      // Electron 에는 Chrome 의 팝업 차단(사용자 입력 없는 window.open 거절)이 없다. 페이지가 window.open 을 되풀이하면 기본 브라우저 탭이 끝없이 열리므로 guest 마다 간격을 둔다.
      const now = Date.now();
      if (now - (lastGuestExternal.get(contents.id) ?? 0) >= GUEST_EXTERNAL_GAP_MS) {
        lastGuestExternal.set(contents.id, now);
        openExternalLink(url, windowByContents(contents));
      } else logLine(`[electron] guest ${contents.id}: dropped a rapid window.open to ${url.slice(0, 200)}`);
    }
    return { action: "deny" };
  });
  // 허락한 로그인 창도 guest 와 같은 이동 규칙을 따른다: http, https 만, 이 앱의 데몬 주소는 열지 않고, 이 창이 또 여는 창은 만들지 않는다.
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
  // 페이지의 console 출력(Add Console Logs to Chat 과 에이전트의 read_console_logs 가 읽는다)
  recordConsole(contents);
  // 블루투스 기기 요청은 세션이 아니라 이 webContents 의 이벤트다
  bindBluetooth(contents, deviceRequests);
  bindBeforeUnload(contents);
  contents.once("destroyed", () => {
    closeRunnersFor(contents.id);
    stopWatchingFile(contents.id);
    lastGuestExternal.delete(contents.id);
  });
  // 페이지(guest)에 포커스가 있어도 앱 단축키와 Browser 탭 전용 키(⌘T, ⌘F, ⌘Y 등)가 먹도록 같은 키를 앱 창으로 넘긴다.
  contents.on("before-input-event", (event, input) => forwardKey(event, input, keymapState.guest, contents));
});

// 요소 스크린샷: 우리 페이지(데몬 주소)에서 온 요청만, 창 안의 영역만 받는다. capturePage 는 창을 앞으로 가져오지 않는다.
ipcMain.handle("agent-nav:capture", async (event, rect: { x: number; y: number; width: number; height: number }) => {
  const source = appWindowOf(event);
  if (!source) throw new Error("capture refused");
  // 요청 사각형은 CSS px 이고 capturePage 는 확대가 반영된 화면 좌표(DIP)를 받는다. 창 확대(⌘=)가 켜져 있으면 배율을 곱해야 창 전체가 찍힌다(1.2배에서 안 곱하면 오른쪽과 아래 17% 가 잘린다).
  const zoom = source.win.webContents.getZoomFactor();
  const [x, y, width, height] = [rect.x * zoom, rect.y * zoom, rect.width * zoom, rect.height * zoom].map((n) => Math.round(Number(n)));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1 || width > 4000 || height > 4000) throw new Error("bad rect");
  // 요청을 보낸 창을 찍는다(피드백 스크린샷은 ⇧⌘X 를 받은 창의 화면이다)
  const image = await source.win.webContents.capturePage({ x, y, width, height });
  return image.isEmpty() ? null : image.toPNG().toString("base64");
});

const hostContents = (contents: Electron.WebContents | null | undefined) => (windowByContents(contents) ?? currentWindow())?.win.webContents ?? null;
const { resolvePermission } = registerSitePermissions({ fromOurPage, hostContents });
const { deviceRequests, stopWatchingFile } = registerBrowserGuestIpc({ fromOurPage, hostContents, pickTheme, browsable: isBrowsableInGuest, devicesAllowed: (origin) => permissions.isAllowed(origin, "devices") });

const notifier = new Notifier(dispatchNotificationAction);

// 알림이 향하는 창: 그 세션이 칸에 열려 있는 창(여럿이면 포커스, 마지막 활성 순), 어디에도 안 열려 있으면 명령 대상 창이다.
function windowForNotification(agentId: string): AppWindow | null {
  const windows = liveWindows().map((w) => ({ id: w.id, agentIds: openAgents.get(w.id) ?? new Set<string>() }));
  const id = windowForAgent({ windows, agentId, focusedId: focusedWindowId(), lastActiveId });
  return liveWindows().find((w) => w.id === id) ?? null;
}

// 기록: 알림이나 빠른 입력창이 어느 창으로 갔는지(시험 창구가 읽는다)
const notifyRoutes: { agentId: string; action: string; windowId: string; opened: boolean }[] = [];

async function dispatchNotificationAction(action: NotifyAction, mode: NotifyMode = "route") {
  // MINICHAT: 미니 대화의 세션이면 메인 창이 아니라 미니 패널로 간다. 열 때만 패널을 띄우고(Allow 는 띄우지 않는다), 미니 페이지가 같은 이벤트로 받는다.
  if (action.agentId === quickEntry.agentId && quickEntry.webContents) {
    notifyRoutes.push({ agentId: action.agentId, action: action.action, windowId: "mini", opened: false });
    if (mode === "route-and-show" && !quickEntry.visible) quickEntry.show();
    void dispatchToPage(quickEntry.webContents, "agent-nav:notification", action);
    return;
  }
  await routeToMainWindow(action, mode);
}

async function routeToMainWindow(action: NotifyAction, mode: NotifyMode = "route-and-show") {
  let target = windowForNotification(action.agentId);
  // 창이 하나도 없으면(macOS 는 창 없이 남는다) 새로 열고 앱 화면이 뜬 뒤에 보낸다
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
  // 검증 모드(스텁이거나 창을 앞으로 가져오지 않는 실행)에서는 창을 앞으로 가져오지 않는다. 시험이 사용자 포커스를 뺏지 않게.
  if (!entry || entry.win.isDestroyed() || NOTIFY_STUB || INACTIVE) return;
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.show();
  entry.win.focus();
}

// --- OPENFOLDER: 바깥에서 넘겨받은 폴더 열기 ---

// 처리 결과의 기록(시험 창구 openOutcomes 가 읽는다). 알림을 띄웠으면 notice 에 제목과 본문이 남는다.
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
// 첫 실행(저장된 창 목록이 비었음)에 launchPlan 이 만든 빈 창. 첫 요청이 이 창을 쓴다(빈 창을 두고 새 창을 하나 더 열지 않는다). 대기열을 비운 뒤에는 비운다.
let launchSpareId: string | null = null;
// 앱 화면이 뜨고 저장된 배치가 복원된 창. 이 창들은 shownDirs 를 바로 읽어도 된다.
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
    outcome.dir = target.dir;
    outcome.file = target.kind === "file" ? target.file : null;
    // 창이 하나도 없으면(macOS 는 창 없이 남는다) 새 창을 열어 그 창을 쓴다. 저장된 마지막 창이 살아나면 그 배치가 복원된다.
    const spareId = liveWindows().length === 0 ? openNewWindow().id : launchSpareId;
    const shown = await Promise.all(liveWindows().map(async (entry) => ({ id: entry.id, ...(await shownOf(entry)) })));
    // 바깥에서 연 폴더(Raycast, Finder 끌어 놓기, 실행 인자)는 그 폴더를 Editor 배치로 보던 창이 있으면 그 창을 앞으로 가져온다. Chat 배치로만 보던 창은 두고 새 창을 연다. 빈 창(spare)은 그대로 쓴다.
    const plan = planOpenWindow({ windows: shown, dir: target.dir, focusedId: focusedWindowId(), lastActiveId, spareId, reuseLayout: "editor" });
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
    // 이미 그 폴더를 보여 주는 창은 폴더만 등록하고(파일이면 그 파일을 열고) 보던 화면은 그대로 둔다. 그 밖의 창은 그 폴더가 골라진 새 세션 화면을 연다.
    const run: OpenFolderRequest = { dir: target.dir, file: outcome.file, startSession: plan.kind !== "existing" };
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

// 창 페이지가 칸에 보여 주는 폴더 목록과 배치(chat, editor). 페이지가 아직 안 떴으면 빈 목록이고, 배치를 알려 주지 않는 옛 페이지면 layout 이 null 이다.
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

// 앱 화면이 뜨고 저장된 배치가 복원될 때까지 기다린다(한 번 확인한 창은 다시 읽기 전까지 바로 통과한다).
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

// 사용자가 직접 부른 명령이라 창을 앞으로 가져온다(시험 인스턴스는 가져오지 않는다). 가져왔으면 true.
function raiseForOpen(entry: AppWindow | null): boolean {
  if (!entry || entry.win.isDestroyed() || INACTIVE) return false;
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.show();
  app.focus({ steal: true });
  entry.win.focus();
  return true;
}

// 이 IPC 를 보낸 앱 창. 앱 창의 데몬 주소 페이지가 아니면 null.
function appWindowOf(event: Electron.IpcMainInvokeEvent): AppWindow | null {
  const entry = liveWindows().find((w) => w.win.webContents === event.sender) ?? null;
  return entry && isOwnPageUrl(event.senderFrame?.url) ? entry : null;
}

function fromOurPage(event: Electron.IpcMainInvokeEvent) {
  return appWindowOf(event) !== null;
}

// --- QUICKENTRY: 어느 앱에서나 단축키로 띄우는 빠른 입력창 ---
// 창은 electron/quickEntry.ts, 단축키 등록 판단은 shared/quickEntry.ts, 화면은 web/QuickEntry.tsx(?view=quick)다.
// 시험 인스턴스(AGENT_NAV_INACTIVE=1, 창구가 켜진 실행, AGENT_NAV_NO_GLOBAL_SHORTCUT=1)는 전역 단축키를 절대 등록하지 않는다. 사용자의 실제 ⌥C 를 가로채기 때문이다.
const tokenPx = (group: "size" | "spacing", name: string) => parseInt(tokens[group].tokens.find((t) => t.name === name)!.value, 10);
const tokenColor = (name: string, theme: "dark" | "light") => styledTokenColor(name, theme, savedSettings().themeStyle as string | undefined);

// 설정을 바꾸면 앱을 다시 띄우지 않아도 Session 메뉴의 Board 항목이 나타나거나 사라지게(단축키 프리셋도 같다), 설정 파일이 바뀌면 메뉴를 다시 만든다. 파일 이름을 바꿔 쓰는 저장에도 견디도록 감시 대신 2초 간격 stat 이다.
function watchBoardMenu() {
  const file = settingsFile();
  unwatchFile(file);
  watchFile(file, { interval: 2000, persistent: false }, () => {
    // 프리셋이 바뀌면 가로챌 키와 메뉴 가속키를 다시 정한다
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
  // 앱을 숨기면 macOS 가 직전에 쓰던 앱을 다시 활성화한다. 미니 창을 숨긴 뒤 앱을 포커스 없이 다시 보여서 메인 창은 제자리에 남긴다.
  yieldFocus: (hideWindow) => {
    if (process.platform !== "darwin") return hideWindow();
    app.hide();
    hideWindow();
    app.show();
  },
});

const quickShortcut = new QuickShortcutController(
  { register: (accelerator, onPress) => globalShortcut.register(accelerator, onPress), unregister: (accelerator) => globalShortcut.unregister(accelerator) },
  () => quickEntry.toggle(),
  quickShortcutBlocked(process.env, INACTIVE),
);

// 시험이 읽는 기록: 메인 창을 앞으로 가져오려 한 횟수와 대상, 입력창이 끝난 방식. 시험 인스턴스에서는 실제로 앞으로 가져오지 않는다.
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

// 시작할 때는 데몬이 쓰는 settings.json 에서 읽어 등록한다. 설정이 바뀌면 메인 창 페이지가 quickEntryConfigure 로 알린다(web/quickEntrySync.ts).
function startQuickEntry() {
  const saved = savedSettings();
  applyQuickConfig(normalizeQuickEntryConfig({ enabled: saved.quickEntryEnabled, accelerator: saved.quickEntryShortcut }));
}

// 빠른 입력창에서 보낸 뒤 메인 창을 앞으로 가져와 그 세션을 연다. 시험 인스턴스에서는 bringToFront 가 아무것도 안 하고 호출만 기록된다.
function openSessionInMainWindow(agentId: string) {
  quickProbe.reveals.push(agentId);
  if (!INACTIVE) app.focus({ steal: true });
  // 미니 대화의 세션이어도 이번에는 메인 창으로 보낸다
  void routeToMainWindow({ agentId, action: "open" });
}

// MINICHAT: 미니 대화 속 PR 링크. 메인 창(없으면 새 창)이 그 PR 을 옆 칸 탭으로 열게 하고 창을 앞으로 가져온다.
async function openPrInMainWindow(url: string) {
  // PRTABSESSION: 미니 패널이 보여 주던 세션의 id 도 같이 보내서 메인 창이 그 세션에 PR 탭을 붙이게 한다
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
  quickEntry.dismiss();
});

ipcMain.handle("agent-nav:quick-resize", (event, cardHeight: unknown) => {
  if (!fromQuickPage(event) || typeof cardHeight !== "number" || !Number.isFinite(cardHeight)) throw new Error("quick entry resize refused");
  quickEntry.resize(cardHeight);
});

// MINICHAT: 런처에서 보냈다. Enter(stay false)면 패널이 그 자리에서 대화로 커지고, ⌘Enter(stay true)면 대화를 묶고 숨긴다. 메인 창은 건드리지 않는다.
ipcMain.handle("agent-nav:quick-finish", (event, result: unknown) => {
  const value = result as { agentId?: unknown; stay?: unknown } | null;
  if (!fromQuickPage(event) || typeof value?.agentId !== "string" || value.agentId === "") throw new Error("quick entry finish refused");
  const stay = value.stay === true;
  quickProbe.finishes.push({ agentId: value.agentId, stay });
  quickEntry.finishSend(value.agentId, stay);
});

// MINICHAT: 대화 머리. agentId 가 문자열이면 그 세션으로 바꾸고, null 이면 새 미니 대화(입력 막대)로 돌아간다.
ipcMain.handle("agent-nav:quick-switch", (event, agentId: unknown) => {
  if (!fromQuickPage(event) || !(agentId === null || (typeof agentId === "string" && agentId !== ""))) throw new Error("quick entry switch refused");
  if (agentId === null) quickEntry.startNew();
  else quickEntry.switchTo(agentId);
});

// MINICHAT: 핀 상태. 설정 Hide on outside click 의 반대이고, 대화 화면이 설정을 읽어 알려 준다.
ipcMain.handle("agent-nav:quick-pinned", (event, pinned: unknown) => {
  if (!fromQuickPage(event) || typeof pinned !== "boolean") throw new Error("quick entry pinned refused");
  quickEntry.setPinned(pinned);
});

// MINICHAT: Lodestar 에서 열기. 메인 창(없으면 새 창)을 앞으로 가져와 그 세션을 열고 미니 패널은 숨긴다. 대화는 묶인 채 남는다.
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
  const result = await dialog.showOpenDialog(source.win, { properties: ["openDirectory"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// 창 확대와 축소. 확대 단계(-8 에서 8)를 돌려준다.
ipcMain.handle("agent-nav:zoom", (event, action: unknown) => {
  if (!fromOurPage(event)) throw new Error("zoom refused");
  if (action !== "in" && action !== "out" && action !== "reset") throw new Error("bad zoom action");
  return changeZoom(action, event.sender);
});

// Developer: Reload Window. 답을 먼저 돌려준 뒤 다시 읽는다. 저장 안 한 변경 확인은 페이지가 이미 마쳤다.
ipcMain.handle("agent-nav:reload-window", (event) => {
  const source = appWindowOf(event);
  if (!source) throw new Error("reload refused");
  // 그 창 하나만 다시 읽는다(데몬을 다시 띄웠을 때만 모든 창을 읽는다)
  setImmediate(() => reloadEntry(source));
});

// 여러 창: 새 창(⇧⌘N), 이 창 닫기(⇧⌘W, 닫을 것이 없을 때의 ⌘W), 이 창 칸에 열린 세션 알림, 살아 있는 창 id 목록
ipcMain.handle("agent-nav:new-window", (event) => {
  if (!fromOurPage(event)) throw new Error("new window refused");
  openNewWindow();
});

ipcMain.handle("agent-nav:close-window", (event) => {
  const source = appWindowOf(event);
  if (!source) throw new Error("close window refused");
  closeWindowEntry(source);
});

ipcMain.handle("agent-nav:open-agents", (event, agentIds: unknown) => {
  const source = appWindowOf(event);
  if (!source || !Array.isArray(agentIds)) throw new Error("open agents refused");
  openAgents.set(source.id, new Set(agentIds.filter((id): id is string => typeof id === "string").slice(0, 200)));
});

ipcMain.handle("agent-nav:window-ids", (event) => {
  if (!fromOurPage(event)) throw new Error("window ids refused");
  return registry.windows.map((w) => w.id);
});

// Developer: Restart Daemon. 이 앱이 띄운 데몬만 다시 띄우고(AGENT_NAV_NO_DAEMON=1 로 붙기만 한 창은 false), 새 데몬이 응답하면 창을 다시 읽는다.
// 직전 재시작 뒤 쿨다운 안이면 지금 하지 않고 합쳐서 나중에 한다("deferred").
ipcMain.handle("agent-nav:restart-daemon", (event): boolean | "deferred" => {
  if (!fromOurPage(event)) throw new Error("restart refused");
  if (process.env.AGENT_NAV_NO_DAEMON === "1") return false;
  return restartGate.request().deferred ? "deferred" : true;
});

// 화면이 데몬이 끊긴 걸 알았을 때 자동 재시도 중인지 멈췄는지 묻는다.
ipcMain.handle("agent-nav:daemon-state", (event) => {
  if (!fromOurPage(event)) throw new Error("daemon state refused");
  return daemonState;
});

const NOTIFY_DEDUPE_MS = 3000;
const recentNotify = new Map<string, { at: number; windowId: string }>();

ipcMain.handle("agent-nav:notify", (event, payload: unknown) => {
  // MINICHAT: 미니 패널 페이지도 알린다(앱 창이 하나도 없어도 미니 대화의 답은 알려야 한다).
  const fromMini = fromQuickPage(event);
  if (!(fromMini || fromOurPage(event)) || !validNotify(payload)) throw new Error("notify refused");
  // 미니 대화의 세션: 미니 패널이 보이면 알리지 않는다(앱 안 토스트도 없이 true). 숨겨져 있으면 기존 경로(앱 창이 포커스이면 false 로 앱 안 토스트, 아니면 OS 알림)를 타고, 알림을 누르면 미니 패널로 간다.
  const miniRoute = notificationTarget({ agentId: payload.agentId, miniAgentId: quickEntry.agentId, miniVisible: quickEntry.visible });
  if (miniRoute === "suppress") return true;
  // 어느 앱 창이든 포커스가 있으면 OS 알림을 띄우지 않는다(앱 안 토스트가 대신한다)
  if (liveWindows().some((w) => w.win.isFocused()) || NOTIFY_FOCUSED) return false;
  // 같은 세션 이벤트를 열려 있는 창마다 알리므로, 다른 창이 방금 보낸 같은 알림은 한 번만 띄운다
  const sourceId = fromMini ? "mini" : appWindowOf(event)!.id;
  const key = `${payload.agentId}:${payload.kind}:${payload.body}`;
  const previous = recentNotify.get(key);
  recentNotify.set(key, { at: Date.now(), windowId: sourceId });
  if (previous && previous.windowId !== sourceId && Date.now() - previous.at < NOTIFY_DEDUPE_MS) return true;
  return notifier.show(payload);
});

// Dock 배지. 사람이 봐야 하는 세션(승인 대기)의 수를 화면이 계산해 보내 준다(web/useDockBadge.ts). 0 이면 지운다.
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
  // Google 로그인은 Electron 이 든 사용자 에이전트를 막는다. accounts.google.com 요청의 헤더에서만 Electron 과 앱 이름 조각을 뺀다.
  browserSession.webRequest.onBeforeSendHeaders({ urls: ["https://accounts.google.com/*"] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    const key = Object.keys(headers).find((name) => name.toLowerCase() === "user-agent");
    if (key) headers[key] = chromeLikeUserAgent(headers[key]);
    callback({ requestHeaders: headers });
  });
  // guest 의 하위 프레임과 fetch 도 데몬 주소에 닿지 않게 한다(이동 검사는 맨 위 프레임만 본다). 토큰이 든 앱 화면을 바깥 페이지가 iframe 으로 겹쳐 띄우면 사용자의 클릭(승인 등)을 가로챌 수 있다.
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
    daemonPid: () => daemon?.pid ?? null,
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

// 개발 실행(electron .)에서는 번들 아이콘이 없어 Dock 에 Electron 기본 아이콘이 뜬다. 패키징된 앱은 Info.plist 의 icns 를 쓴다.
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
  // 잠금에 걸린 두 번째 프로세스: 데몬도 창도 만들지 않는다(인자는 이미 떠 있는 앱의 second-instance 로 갔다)
  if (!gotInstanceLock) return;
  startupMark("ready");
  // 데몬을 가장 먼저 띄운다. 메뉴와 권한 읽기, 창 만들기가 데몬이 뜨는 시간과 겹친다.
  // AGENT_NAV_NO_DAEMON=1 이면 이미 떠 있는 데몬(AGENT_NAV_PORT)에 창만 붙인다 (검증용).
  if (process.env.AGENT_NAV_NO_DAEMON !== "1") startDaemon();
  startupMark("daemon-spawned");
  const daemonUp = waitForDaemon();
  // 데몬을 기다리는 동안 이 약속이 거절되어도(20초 안에 안 뜸) 아래 await 에서 한 번만 다룬다.
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
  // 마지막에 열려 있던 창들(개수, 자리, 각 창의 배치는 창 id 별 localStorage)을 되살린다
  const saved = loadRegistry(registryFile());
  const plan = launchPlan(saved);
  // 저장된 창이 없던 첫 실행이면 새로 만든 빈 창을 첫 폴더 열기 요청이 쓴다
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
  // OPENFOLDER: 데몬이 응답하고 창이 만들어졌다. 그 전에 온 폴더 열기 요청(open-file, 실행 인자)을 들어온 순서대로 처리한다.
  void openQueue.ready().finally(() => {
    launchSpareId = null;
  });
  // Dock 아이콘을 누르면(창이 하나도 없을 때) 새 창. 앱 창만 센다: 빠른 입력창과 Playwright 실행기의 숨은 창도 BrowserWindow 이다.
  app.on("activate", () => {
    if (liveWindows().length === 0 && !quitFlow.quitting) openNewWindow();
  });
});

// macOS 는 마지막 창을 닫아도 앱을 끝내지 않는다(세션과 백그라운드 에이전트가 이어진다). 리스너를 아예 빼면 Electron 기본이 끝내므로 비워 두지 않고 플랫폼으로 가른다.
app.on("window-all-closed", () => {
  if (quitWhenAllWindowsClosed(process.platform)) app.quit();
});
// FIX6A: 종료는 quitFlow 가 이끈다(창 닫기, 데몬 flush 와 정리, app.quit). 첫 before-quit 은 막고 단계를 마친 뒤 app.quit 을 다시 부른다.
app.on("before-quit", (event) => {
  const decision = quitFlow.onBeforeQuit();
  if (decision === "run") resetRespawn();
  if (decision !== "pass") event.preventDefault();
});
app.on("will-quit", () => {
  quickShortcut.release();
  globalShortcut.unregisterAll();
  quitFlow.onWillQuit();
});
app.on("quit", () => quitFlow.onQuit());

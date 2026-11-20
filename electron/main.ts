import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unwatchFile, watch, watchFile, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, Menu, Notification, app, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, session, shell, utilityProcess, webContents, type MenuItemConstructorOptions, type UtilityProcess } from "electron";
import { categoriesFor, isAlwaysAllowed, PERMISSION_CATEGORIES, PermissionStore, permissionOrigin, type PermissionCategory, type PermissionDecision } from "../web/browserPermissions";
import { BROWSER_PARTITION, filePathOf, isBrowserPartition, isOwnOrigin, parseBrowsable, parseOpenable } from "../web/browserUrl";
import { DEVICE_TYPES, type DeviceRequest, type DeviceType } from "../web/browserDevices";
import { bindBluetooth, bindDeviceSession, DeviceRequests } from "./browserDevices";
import { answerDialog, applyTouch, bindBeforeUnload, fullPageScreenshot, onDialogChange, pendingDialog } from "./guestDebugger";
import { closeRunners, closeRunnersFor } from "./pwRunner";
import { bindingsFor, browserStrokes, CHORD_TIMEOUT_MS, chordFollowersOf, interceptStrokes, keyupAwareStrokes, menuAccelerator, strokeOf, strokeOfAccelerator, type Binding } from "../web/keymap";
import { consoleLogs, formatConsole, recordConsole, runGuestTool } from "./browserTools";
import { logDirFor } from "./logDir";
import { LineStamper, stampLine } from "./logStamp";
import { QuitFlow } from "./quitFlow";
import { RestartScheduler, restartWaitMs } from "../shared/restartGate";
import { PICK_READ_SCRIPT, PICK_STOP_SCRIPT, pickScript, type PickMode, type PickTheme } from "./pickScript";
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

// 앱 메뉴 명령을 포커스된 창(없으면 마지막 활성 창)의 페이지로 보낸다. 창이 하나도 없을 때(macOS 는 창 없이 Dock 에 남는다)는 새 창만 연다.
function send(command: string) {
  const target = currentWindow();
  if (!target) {
    openNewWindow();
    return;
  }
  void target.win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("agent-nav:command", { detail: ${JSON.stringify(command)} }))`);
}

// 단축키 프리셋(settings.keymapPreset)이 정하는 표와 가로챌 키 집합. 데몬이 쓰는 settings.json 을 읽고, watchBoardMenu 가 2초마다 바뀐 것을 반영한다.
type KeymapState = { preset: "vscode" | "webstorm"; bindings: Binding[]; intercept: ReadonlySet<string>; guest: ReadonlySet<string> };

function keymapStateOf(value: unknown): KeymapState {
  const preset = value === "webstorm" ? "webstorm" : "vscode";
  const bindings = bindingsFor(preset);
  const intercept = interceptStrokes(bindings);
  return { preset, bindings, intercept, guest: new Set([...intercept, ...browserStrokes(bindings), ...keyupAwareStrokes(bindings)]) };
}

let keymapState = keymapStateOf(savedSettings().keymapPreset);

// 마지막으로 만든 메뉴가 Board 항목을 담았는지. 데몬이 쓰는 settings.json 의 showBoard 를 읽는다.
let builtBoardMenu = false;
let builtPreset: KeymapState["preset"] = "vscode";
const boardMenuWanted = () => savedSettings().showBoard === true;

function buildMenu() {
  const boardMenuShown = boardMenuWanted();
  builtBoardMenu = boardMenuShown;
  builtPreset = keymapState.preset;
  const accel = (command: string, literal?: string, registered = true): Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator"> => {
    if (keymapState.preset === "vscode") return { ...(literal ? { accelerator: literal } : {}), ...(literal && !registered ? { registerAccelerator: false } : {}) };
    const accelerator = menuAccelerator(keymapState.bindings, command);
    return { ...(accelerator ? { accelerator } : {}), registerAccelerator: false };
  };
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Lodestar",
      submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: S.menu.file,
      submenu: [
        // 가속키는 표시용이다: 같은 키를 INTERCEPT_STROKES 가 먼저 가로채 페이지의 newWindow, closeWindow 명령으로 보낸다(web/keymap.ts).
        { label: S.menu.newWindow, ...accel("newWindow", "Shift+Cmd+N", false), click: () => void openNewWindow() },
        { label: S.menu.closeWindow, ...accel("closeWindow", "Shift+Cmd+W", false), click: () => closeWindowEntry(currentWindow()) },
      ],
    },
    {
      label: S.menu.session,
      submenu: [
        { label: S.menu.newSession, ...accel("newSession", "Cmd+N"), click: () => send("newSession") },
        { label: S.menu.searchSessions, ...accel("sessions", "Ctrl+Alt+R"), click: () => send("sessions") },
        { label: S.menu.model, ...accel("models", "Shift+Cmd+M"), click: () => send("models") },
        { label: S.menu.effort, ...accel("cycleEffort", "Shift+Cmd+I"), click: () => send("cycleEffort") },
        { label: S.menu.splitChat, ...accel("split", "Cmd+\\"), click: () => send("split") },
        // B5: ⌘K 로 시작하는 chord 는 메뉴 가속키로 쓸 수 없어 키 표시 없이 둔다. 키는 web/keymap.ts 가 받는다.
        { label: S.menu.splitChatDown, click: () => send("splitDown") },
        { label: S.menu.reopenClosedChat, ...accel("reopenClosed", "Shift+Cmd+T"), click: () => send("reopenClosed") },
        { label: S.menu.closeAllChats, click: () => send("closeAllChats") },
        // ⌥⌘←→ 는 단축키 표에서 이전, 다음 에디터 탭이고 메인이 먼저 가로채 페이지로 넘긴다(web/keymap.ts). 메뉴에 그 키를 보이면 누른 키와 다른 일을 알리고,
        // 키를 페이지로 넘기지 않는 미니 채팅 창에서는 이 가속키가 그대로 먹어 메인 창의 세션을 바꿨다. 그래서 키 표시 없이 둔다.
        { label: S.menu.previousSession, ...accel("sessionPrev"), click: () => send("sessionPrev") },
        { label: S.menu.nextSession, ...accel("sessionNext"), click: () => send("sessionNext") },
        { label: S.menu.sideChat, ...accel("btw", "Shift+Cmd+B"), click: () => send("btw") },
        ...(boardMenuShown ? [{ label: S.menu.board, click: () => send("board") }] : []),
        { label: S.menu.feedback, click: () => send("feedback") },
        // ⌃C 는 메뉴에 두지 않는다. 터미널 안에서는 셸로 가야 하므로 페이지의 전역 키 처리가 맡는다.
      ],
    },
    {
      label: S.menu.edit,
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: S.menu.attach, ...accel("attach", "Alt+H"), click: () => send("attach") },
        { label: S.menu.askAboutSelection, ...accel("quickAsk", "Cmd+I"), click: () => send("quickAsk") },
      ],
    },
    {
      label: S.menu.code,
      submenu: [
        // QUICKOPEN: 표시용 가속키: ⌘P 는 가로채지 않고 페이지가 받는다(빠른 열기가 ⌘ 를 뗄 때 동작하려면 뒤따르는 keyup 이 페이지에 가야 한다. web/keymap.ts 의 KEYUP_AWARE_STROKES)
        { label: S.menu.openFile, ...accel("quickOpen", "Cmd+P", false), click: () => send("quickOpen") },
        { label: S.menu.gotoLine, ...accel("gotoLine", "Ctrl+G", false), click: () => send("gotoLine") },
        { label: S.menu.gotoSymbol, ...accel("gotoSymbol", "Shift+Cmd+O"), click: () => send("gotoSymbol") },
        { label: S.menu.searchSymbols, ...accel("symbols", "Cmd+T"), click: () => send("symbols") },
        { label: S.menu.closeFocused, ...accel("close", "Cmd+W"), click: () => send("close") },
      ],
    },
    {
      label: S.menu.view,
      submenu: [
        // 가속키는 표시용이다: 같은 키를 INTERCEPT_STROKES 가 먼저 가로채 페이지가 포커스를 보고(Browser 탭이면 페이지 확대) 처리한다. 클릭은 창 확대다.
        { label: S.menu.zoomIn, ...accel("zoomIn", "Cmd+="), click: () => send("zoomIn") },
        { label: S.menu.zoomOut, ...accel("zoomOut", "Cmd+-"), click: () => send("zoomOut") },
        { label: S.menu.zoomReset, ...accel("zoomReset", "Cmd+0"), click: () => send("zoomReset") },
      ],
    },
    {
      label: S.menu.window,
      submenu: [
        { label: S.menu.sidebar, ...accel("toggleSidebar", "Cmd+B"), click: () => send("toggleSidebar") },
        { label: S.menu.bottomPanel, ...accel("toggleBottom", "Cmd+J"), click: () => send("toggleBottom") },
        { label: S.menu.rightPanel, ...accel("toggleRight", "Alt+Cmd+B"), click: () => send("toggleRight") },
        { type: "separator" },
        { label: S.menu.toggleLayout, ...accel("toggleLayout", "Ctrl+Alt+L"), click: () => send("toggleLayout") },
        { label: S.menu.toggleFloat, ...accel("toggleFloat", "Ctrl+Cmd+J"), click: () => send("toggleFloat") },
        { label: S.menu.focusSession, ...accel("focusSession", "Ctrl+Cmd+I"), click: () => send("focusSession") },
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
    {
      label: S.menu.developer,
      submenu: [
        // 클릭은 페이지의 명령으로 넘어가 저장 안 한 변경 확인과 진행 중인 세션 확인을 거친다. ⌘R 은 web/keymap.ts 표에도 있어 메인이 가로채 같은 길로 보낸다.
        { label: S.menu.reloadWindow, ...accel("reloadWindow", "Cmd+R"), click: () => void reloadWindowCommand(currentWindow(), () => send("reloadWindow")) },
        { label: S.menu.restartDaemon, click: () => send("restartDaemon") },
        { type: "separator" },
        { role: "toggleDevTools", label: S.menu.toggleDevTools },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  menuStrokes = registeredMenuStrokes(menu);
}

let menuStrokes: ReadonlySet<string> = new Set();

function registeredMenuStrokes(menu: Electron.Menu): ReadonlySet<string> {
  const strokes = new Set<string>();
  const visit = (items: Electron.MenuItem[]) => {
    for (const item of items) {
      if (item.submenu) visit(item.submenu.items);
      const accelerator = item.accelerator;
      const stroke = item.registerAccelerator !== false && accelerator ? strokeOfAccelerator(accelerator) : null;
      if (stroke) strokes.add(stroke);
    }
  };
  visit(menu.items);
  return strokes;
}

// 창 바탕색은 페이지가 뜨기 전 잠깐 보이는 색이라, 설정의 테마와 색 스타일에 맞춰 디자인 토큰 chrome-bg 를 쓴다 (esbuild 가 tokens.json 을 번들에 넣는다).
function windowBackground() {
  const home = process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav");
  let theme: "dark" | "light" = "dark";
  let style = "lodestar";
  try {
    const saved = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { theme?: string; themeStyle?: string };
    theme = saved.theme === "light" || (saved.theme === "system" && !nativeTheme.shouldUseDarkColors) ? "light" : "dark";
    style = saved.themeStyle ?? style;
  } catch {
    // 설정 파일이 없으면 다크
  }
  return styledTokenColor("chrome-bg", theme, style);
}

// 토큰 색. 색 스타일(webstorm)의 값이 있으면 그것을, 없으면 기본 값을 쓴다. 빌드가 CSS 로 하는 폴백(build-tokens.mjs)과 같은 규칙이다.
type StyledColor = { dark: string; light: string } & Partial<Record<"webstorm-dark" | "webstorm-light", string>>;
function styledTokenColor(name: string, theme: "dark" | "light", style: string | undefined): string {
  const value = tokens.color.tokens.find((t) => t.name === name)!.value as StyledColor;
  return (style === "webstorm" ? value[`webstorm-${theme}`] : undefined) ?? value[theme];
}

// 요소 선택 화면(페이지 안에 그려지는 윤곽, 라벨, 댓글 입력줄)의 색. 앱 테마에 맞춰 디자인 토큰에서 읽는다.
function pickTheme(): PickTheme {
  const home = process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav");
  let theme: "dark" | "light" = "dark";
  let style = "lodestar";
  try {
    const saved = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { theme?: string; themeStyle?: string };
    theme = saved.theme === "light" || (saved.theme === "system" && !nativeTheme.shouldUseDarkColors) ? "light" : "dark";
    style = saved.themeStyle ?? style;
  } catch {
    // 설정 파일이 없으면 다크
  }
  const pick = (name: string) => styledTokenColor(name, theme, style);
  return { focus: pick("accent"), buttonBg: pick("accent"), buttonFg: pick("accent-fg"), widgetBg: pick("pick-widget-bg"), widgetFg: pick("fg"), widgetBorder: pick("pick-widget-border"), widgetShadow: pick("pick-widget-shadow"), placeholder: pick("fg-muted"), hover: pick("surface-hover"), font: `-apple-system, "system-ui", sans-serif` };
}

const ZOOM_MIN = -8;
const ZOOM_MAX = 8;
const zoomFile = () => join(process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav"), "window-zoom.json");

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
  // Browser 탭의 guest 는 앱 페이지와 같은 권한이 아니다: preload 와 node 를 끄고 별도 partition 에 가두며, agent-nav 데몬 주소(토큰이 든 index.html)와 http, https 가 아닌 주소는 열지 않는다.
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
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
  });
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
const chordStarts = new WeakMap<Electron.WebContents, { prefix: string; at: number }>();

function completesChord(source: Electron.WebContents, stroke: string) {
  const started = chordStarts.get(source);
  chordStarts.delete(source);
  if (keymapState.bindings.some((b) => b.keys.length === 2 && b.keys[0] === stroke)) chordStarts.set(source, { prefix: stroke, at: Date.now() });
  return !!started && Date.now() - started.at <= CHORD_TIMEOUT_MS && chordFollowersOf(keymapState.bindings, started.prefix, menuStrokes).has(stroke);
}

function forwardKey(event: Electron.Event, input: Electron.Input, strokes: ReadonlySet<string>, source: Electron.WebContents) {
  if (input.type !== "keyDown" || input.isComposing) return;
  const key = { code: input.code, key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift };
  const stroke = strokeOf(key);
  if (!stroke) return;
  if (!completesChord(source, stroke) && !strokes.has(stroke)) return;
  event.preventDefault();
  const target = windowByContents(source);
  if (!target) return;
  const toPage = () => void target.win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("agent-nav:key", { detail: ${JSON.stringify(key)} }))`);
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
    saved = JSON.parse(readFileSync(join(process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav"), "settings.json"), "utf8"));
  } catch {
    // 설정 파일이 없거나 깨졌으면 기본 브라우저로 연다
  }
  const notion = notionOpenPlan(url, saved);
  if (notion?.via === "tab" || notion?.via === "screen") {
    // 같은 페이지가 이미 열린 탭이면 그 탭으로 가는 판단은 화면(web/notionStore.ts openNotionInApp)이 한다
    if (process.env.AGENT_NAV_OPEN_LOG) appendFileSync(process.env.AGENT_NAV_OPEN_LOG, `${notion.via}:${notion.url}\n`);
    void (from ?? currentWindow())?.win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("agent-nav:open-notion", { detail: ${JSON.stringify(notion.url)} }))`);
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

// 검증용 조작 창구. AGENT_NAV_E2E_PORT 가 있을 때만 127.0.0.1 에 열린다.
// {action:"key"} 는 실제 입력 이벤트를 창에 넣으므로 메뉴 단축키(⌘W, ⌘N)까지 그대로 탄다.
function startE2E(port: number) {
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
        const request = JSON.parse(body || "{}") as { action: string; [key: string]: unknown };
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
async function handleE2E(request: { action: string; [key: string]: unknown }) {
  const wanted = request.window === undefined ? null : String(request.window);
  const target = wanted ? (appWindows.get(wanted) ?? null) : currentWindow();
  if (wanted && !target && !WINDOWLESS_E2E.has(request.action)) throw new Error(`no such window: ${wanted}`);
  if (!target && !WINDOWLESS_E2E.has(request.action)) throw new Error(S.electronNoWindow);
  const win = target?.win as BrowserWindow;
  const contents = win?.webContents as Electron.WebContents;
  switch (request.action) {
    // 여러 창 시험: 창 목록, 새 창, 창 닫기, 명령 대상 창 바꾸기(OS 포커스는 건드리지 않는다), Dock 클릭(activate)
    case "windows":
      return {
        target: currentWindow()?.id ?? null,
        lastActive: lastActiveId,
        windows: liveWindows().map((w) => ({ id: w.id, title: w.win.getTitle(), url: w.win.webContents.getURL(), bounds: w.win.getBounds(), focused: w.win.isFocused(), openAgents: [...(openAgents.get(w.id) ?? [])], loads: w.loadCount })),
      };
    case "newWindow": {
      const entry = openNewWindow();
      await whenAppReady(entry);
      return { id: entry.id };
    }
    case "closeWindow": {
      closeWindowEntry(target);
      await new Promise((r) => setTimeout(r, 500));
      return { open: liveWindows().map((w) => w.id) };
    }
    case "focusWindow": {
      lastActiveId = target!.id;
      return lastActiveId;
    }
    case "activate": {
      app.emit("activate");
      await new Promise((r) => setTimeout(r, 500));
      const entry = currentWindow();
      if (entry) await whenAppReady(entry);
      return { open: liveWindows().map((w) => w.id) };
    }
    // OPENFOLDER: open-file 이 온 것처럼 같은 처리 함수를 부른다(open -g -a 는 설치 앱을 부르게 되어 쓰지 않는다). cwd 는 상대 경로를 풀 작업 폴더. 처리 결과를 돌려준다.
    case "openPath":
      return requestOpen(String(request.path), request.source === "argv" ? "argv" : "e2e", typeof request.cwd === "string" ? request.cwd : process.cwd());
    case "openOutcomes":
      return { queueReady: openQueue.isReady, pending: openQueue.pending, outcomes: openOutcomes };
    case "registry":
      return { registry, file: registryFile() };
    case "quitState":
      return { quitting: quitFlow.quitting, windows: liveWindows().length, daemonPid: daemon?.pid ?? null };
    case "procInfo":
      return { mainPid: process.pid, daemonPid: daemon?.pid ?? null };
    case "notificationRoutes":
      return notifyRoutes;
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
      return stubbed;
    case "notificationClick": {
      const entry = stubbed[Number(request.index)];
      if (!entry) throw new Error("no such notification");
      onNotificationUsed(entry.payload, request.button === "action" ? "action" : "body");
      return null;
    }
    // 실제 알림 기록과 이벤트. notificationEmit 은 사람이 누르는 것 대신 그 알림에 click 또는 action 을 낸다(창은 앞으로 오지 않는다).
    case "realNotifications":
      return realShown;
    case "notificationEmit": {
      const notification = shownNotifications.get(String(request.agentId));
      if (!notification) throw new Error("no such notification");
      notification.emit(request.event === "action" ? "action" : "click", {}, 0);
      // 사람이 누르면 macOS 가 알림을 치우지만 emit 은 그러지 않으므로 직접 닫는다.
      notification.close();
      return null;
    }
    case "notificationClear":
      clearNotification(String(request.agentId));
      return null;
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
      return deviceRequests.begin({ guest: null, origin: String(request.origin ?? "http://localhost:7801"), deviceType, devices: request.devices as never, invoke: (deviceId) => fakeDeviceResults.push({ deviceType, deviceId }) });
    }
    case "deviceAdd":
      deviceRequests.add(null, String(request.deviceType) as DeviceType, request.device as never);
      return null;
    case "deviceRemove":
      deviceRequests.remove(null, String(request.deviceType) as DeviceType, String(request.deviceId));
      return null;
    case "deviceResults":
      return fakeDeviceResults;
    // QUICKENTRY 시험 창구. 단축키 대신 이 동작으로 연다(시험 인스턴스는 단축키를 등록하지 않는다). 창은 showInactive 라 포커스를 뺏지 않는다.
    case "quickToggle":
      quickEntry.toggle();
      await new Promise((r) => setTimeout(r, 400));
      return quickEntry.visible;
    case "quickOpen":
      quickEntry.show();
      await new Promise((r) => setTimeout(r, 600));
      return quickEntry.bounds;
    case "quickHide":
      quickEntry.hide();
      return null;
    case "quickDestroy":
      quickEntry.destroy();
      return null;
    case "quickState":
      return { visible: quickEntry.visible, bounds: quickEntry.bounds, shortcut: quickShortcut.status, probe: quickProbe, focused: quickEntry.webContents?.isFocused() ?? false, mode: quickEntry.mode, agentId: quickEntry.agentId, pinned: quickEntry.pinned, resizable: quickEntry.resizable, zoom: quickEntry.webContents?.getZoomFactor() ?? null, url: quickEntry.webContents?.getURL() ?? null, saved: quickEntry.readSaved(), displays: screen.getAllDisplays().map((d) => d.workArea) };
    // MINICHAT 시험 창구: 포커스가 없는 시험 인스턴스에서 blur 판정(핀, 입력 막대)을 강제로 돌린다. 끌기와 크기 조절은 OS 가 하는 일이라 setBounds 로 같은 이벤트 경로를 태운다.
    case "quickBlur": {
      await new Promise((r) => setTimeout(r, Number(request.waitMs ?? 300)));
      return quickEntry.handleBlur(true);
    }
    case "quickSetBounds":
      quickEntry.setBoundsForTest(request.bounds as Electron.Rectangle);
      await new Promise((r) => setTimeout(r, 700));
      return quickEntry.readSaved();
    case "quickConfigure":
      return applyQuickConfig({ enabled: request.enabled !== false, accelerator: String(request.accelerator ?? "Alt+C") });
    case "quickEval": {
      const quick = quickEntry.webContents;
      if (!quick) throw new Error("no quick entry window");
      return quick.executeJavaScript(String(request.js));
    }
    case "quickKey": {
      const quick = quickEntry.webContents;
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
      const quick = quickEntry.webContents;
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
      const quick = quickEntry.webContents;
      if (!quick) throw new Error("no quick entry window");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(String(request.path), (await quick.capturePage()).toPNG());
      return String(request.path);
    }
    default:
      throw new Error(S.electronUnknownAction(String(request.action)));
  }
}

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

// --- Browser 탭 guest 조작 ---
// 요청은 우리 페이지(데몬 주소)에서 온 것만, 대상은 이 창에 붙은 webview 뿐이다. guest 에는 preload 도 데몬 토큰도 닿지 않고, 요소 선택 스크립트는 격리된 세계에서 돈다.
const PICK_WORLD = 1000;
const PICK_TIMEOUT_MS = 120_000;
const PICK_POLL_MS = 120;
const MAX_CAPTURE_WIDTH = 1600;
const picking = new Map<number, () => void>();

function guestContents(event: Electron.IpcMainInvokeEvent, id: unknown) {
  if (!fromOurPage(event) || typeof id !== "number") throw new Error("browser request refused");
  const contents = webContents.fromId(id);
  if (!contents || contents.isDestroyed() || contents.getType() !== "webview" || contents.hostWebContents !== event.sender) throw new Error("not a browser tab");
  return contents;
}

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
    await guest.executeJavaScriptInIsolatedWorld(PICK_WORLD, [{ code: pickScript(pickMode, pickTheme()) }]);
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
  if (!fromOurPage(event)) throw new Error("browser request refused");
  const browserSession = session.fromPartition(isBrowserPartition(partition) ? partition : BROWSER_PARTITION);
  await browserSession.clearStorageData();
  await browserSession.clearCache();
});

// 기기 에뮬레이션: 화면 크기, 배율(dpr 0 은 기본값), 모바일 여부, 사용자 에이전트. params 가 null 이면 끈다.
// 모바일이 아닐 때 "desktop" 위치를 쓰는 이유: "mobile" 위치는 메타 뷰포트가 없는 페이지를 980px 로 그리므로 고른 폭이 그대로 보이지 않는다.
type EmulationParams = { width: number; height: number; dpr: number; mobile?: boolean; userAgent?: string | null };
const defaultUserAgents = new Map<number, string>();

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
const mobileApplied = new Set<number>();

// 에이전트의 Browser 도구. 데몬이 공유된 탭에 보낸 요청을 화면이 여기로 넘긴다. 대상은 이 창의 webview 뿐이고, 이동은 Browser 탭이 여는 주소와 같은 기준으로 거른다.
ipcMain.handle("agent-nav:browser-tool", async (event, id: unknown, tool: unknown, args: unknown) => {
  const guest = guestContents(event, id);
  return runGuestTool(guest, String(tool), args && typeof args === "object" ? (args as Record<string, unknown>) : {}, (url) => isBrowsableInGuest(url));
});

// Add Console Logs to Chat: 페이지의 최근 console 출력을 글로.
ipcMain.handle("agent-nav:browser-console", (event, id: unknown) => {
  const guest = guestContents(event, id);
  return { url: clip(guest.getURL(), 2000), title: clip(guest.getTitle(), 300), text: formatConsole(consoleLogs(guest.id, 100)) };
});

// 공유 중인 탭에서 페이지가 띄운 대화상자(alert, confirm, prompt, beforeunload)는 사용자도 답할 수 있게 화면에 알린다(에이전트는 handle_dialog 로 답한다).
onDialogChange((id, dialog) => (windowByContents(webContents.fromId(id)) ?? currentWindow())?.win.webContents.send("agent-nav:browser-dialog", { id, dialog }));
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
      entry.timer = setTimeout(() => (windowByContents(guest) ?? currentWindow())?.win.webContents.send("agent-nav:browser-file-changed", { id: guest.id }), FILE_RELOAD_DEBOUNCE_MS);
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
    const host = windowByContents(guest) ?? currentWindow();
    if (!host) return false;
    host.win.webContents.send("agent-nav:browser-device", request);
    return true;
  },
  (origin) => permissions.isAllowed(origin, "devices"),
);
ipcMain.handle("agent-nav:browser-device-answer", (event, requestId: unknown, deviceId: unknown) => {
  if (!fromOurPage(event) || typeof requestId !== "string") throw new Error("device refused");
  deviceRequests.resolve(requestId, typeof deviceId === "string" ? deviceId : null);
});

// --- 사이트 권한 ---
// 판정은 web/browserPermissions.ts. 기록은 $AGENT_NAV_HOME/browser-permissions.json 에 둔다. 묻는 요청은 화면에 보내 확인 창으로 받는다(30초 안에 답이 없으면 허용하지 않는다).
const permissions = new PermissionStore();
const PERMISSIONS_FILE = join(process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav"), "browser-permissions.json");
const PERMISSION_ASK_MS = 30_000;
const permissionAsks = new Map<string, (answer: PermissionDecision | null) => void>();

function loadPermissions() {
  try {
    permissions.hydrate(JSON.parse(readFileSync(PERMISSIONS_FILE, "utf8")));
  } catch {
    // 기록이 없으면 기본값
  }
}

function savePermissions() {
  try {
    mkdirSync(join(PERMISSIONS_FILE, ".."), { recursive: true });
    writeFileSync(PERMISSIONS_FILE, JSON.stringify(permissions.serialize(), null, 2));
  } catch (error) {
    console.error("[permissions] save failed", error);
  }
}

function askPermission(origin: string, category: PermissionCategory, requester: Electron.WebContents | null): Promise<PermissionDecision | null> {
  return new Promise((resolve) => {
    const host = windowByContents(requester) ?? currentWindow();
    if (!host) return resolve(null);
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => finish(null), PERMISSION_ASK_MS);
    const finish = (answer: PermissionDecision | null) => {
      clearTimeout(timer);
      permissionAsks.delete(requestId);
      resolve(answer);
    };
    permissionAsks.set(requestId, finish);
    host.win.webContents.send("agent-nav:browser-permission", { requestId, origin, category });
  });
}

// 권한 요청 하나. 사용자가 답하지 않은 범주를 하나씩 묻고, 끝나면 다시 판정한다(허용은 모든 범주가 허용일 때뿐).
async function resolvePermission(permission: string, url: string, mediaTypes: readonly string[] | undefined, requester: Electron.WebContents | null): Promise<boolean> {
  if (isAlwaysAllowed(permission)) return true;
  const origin = permissionOrigin(url);
  const categories = categoriesFor(permission, mediaTypes);
  let verdict = permissions.decide(origin, categories);
  if (verdict === "ask") {
    for (const category of categories) {
      if (permissions.getDecision(origin, category) || permissions.isAllowed(origin, category)) continue;
      const answer = await askPermission(origin, category, requester);
      if (answer) permissions.set(origin, category, answer);
      if (answer === "deny") break;
    }
    savePermissions();
    verdict = permissions.decide(origin, categories);
  }
  return verdict === "allow";
}

ipcMain.handle("agent-nav:browser-permission-answer", (event, requestId: unknown, answer: unknown) => {
  if (!fromOurPage(event) || typeof requestId !== "string") throw new Error("permission refused");
  permissionAsks.get(requestId)?.(answer === "allow" || answer === "deny" ? answer : null);
});

// Site Permissions 선택창이 읽고 쓰는 목록. url 은 Browser 탭의 주소.
ipcMain.handle("agent-nav:browser-permissions-get", (event, url: unknown) => {
  if (!fromOurPage(event)) throw new Error("permission refused");
  const origin = permissionOrigin(String(url));
  return { origin, items: PERMISSION_CATEGORIES.map((category) => ({ category, decision: permissions.getDecision(origin, category) ?? null, state: permissions.stateOf(origin, category) })) };
});

ipcMain.handle("agent-nav:browser-permissions-set", (event, url: unknown, changes: unknown) => {
  if (!fromOurPage(event) || !Array.isArray(changes)) throw new Error("permission refused");
  const origin = permissionOrigin(String(url));
  for (const change of changes as { category?: unknown; state?: unknown }[]) {
    if (!(PERMISSION_CATEGORIES as readonly string[]).includes(String(change.category))) continue;
    permissions.set(origin, change.category as PermissionCategory, change.state === "allow" || change.state === "deny" ? change.state : null);
  }
  savePermissions();
});

type NotifyPayload = { agentId: string; kind: "response" | "approval"; title: string; body: string; itemId?: string; actionLabel?: string };
type NotifyAction = { agentId: string; action: "open" | "allow"; itemId?: string };

const shownNotifications = new Map<string, Notification>();
// AGENT_NAV_NOTIFY_STUB=1 이면 실제 OS 알림을 만들지 않고 인자만 기록한다(검증 창구가 읽는다).
const NOTIFY_STUB = process.env.AGENT_NAV_NOTIFY_STUB === "1";
// AGENT_NAV_NOTIFY_FOCUSED=1 이면 창이 포커스인 것처럼 OS 알림을 띄우지 않는다(앱 안 토스트 대체 경로 시험용. 창 포커스는 건드리지 않는다).
const NOTIFY_FOCUSED = process.env.AGENT_NAV_NOTIFY_FOCUSED === "1";
// 시험 알림임을 알 수 있게 제목 앞에 붙일 문구(AGENT_NAV_NOTIFY_PREFIX). 없으면 그대로.
const NOTIFY_PREFIX = process.env.AGENT_NAV_NOTIFY_PREFIX ?? "";
// 실제로 띄운 알림의 기록(검증 창구가 읽는다). 받은 이벤트(click, action, close, failed)도 쌓는다.
const realShown: { agentId: string; title: string; body: string; actions: string[]; events: string[] }[] = [];
const stubbed: { payload: NotifyPayload; options: { title: string; body: string; silent: boolean; actions: string[] }; bounce: boolean; closed: boolean }[] = [];

function notificationOptions(payload: NotifyPayload) {
  return { title: payload.title, body: payload.body, silent: true, actions: payload.actionLabel ? [payload.actionLabel] : [] };
}

function validNotify(value: unknown): value is NotifyPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const text = (x: unknown, max: number) => typeof x === "string" && x.length <= max;
  return text(v.agentId, 100) && (v.kind === "response" || v.kind === "approval") && text(v.title, 500) && text(v.body, 1000) && (v.itemId === undefined || text(v.itemId, 100)) && (v.actionLabel === undefined || text(v.actionLabel, 50));
}

// 알림이 향하는 창: 그 세션이 칸에 열려 있는 창(여럿이면 포커스, 마지막 활성 순), 어디에도 안 열려 있으면 명령 대상 창이다.
function windowForNotification(agentId: string): AppWindow | null {
  const windows = liveWindows().map((w) => ({ id: w.id, agentIds: openAgents.get(w.id) ?? new Set<string>() }));
  const id = windowForAgent({ windows, agentId, focusedId: focusedWindowId(), lastActiveId });
  return liveWindows().find((w) => w.id === id) ?? null;
}

// 기록: 알림이나 빠른 입력창이 어느 창으로 갔는지(시험 창구가 읽는다)
const notifyRoutes: { agentId: string; action: string; windowId: string; opened: boolean }[] = [];

async function dispatchNotificationAction(action: NotifyAction, mode: "route" | "route-and-show" = "route") {
  // MINICHAT: 미니 대화의 세션이면 메인 창이 아니라 미니 패널로 간다. 열 때만 패널을 띄우고(Allow 는 띄우지 않는다), 미니 페이지가 같은 이벤트로 받는다.
  if (action.agentId === quickEntry.agentId && quickEntry.webContents) {
    notifyRoutes.push({ agentId: action.agentId, action: action.action, windowId: "mini", opened: false });
    if (mode === "route-and-show" && !quickEntry.visible) quickEntry.show();
    void quickEntry.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("agent-nav:notification", { detail: ${JSON.stringify(action)} }))`);
    return;
  }
  await routeToMainWindow(action, mode);
}

async function routeToMainWindow(action: NotifyAction, mode: "route" | "route-and-show" = "route-and-show") {
  let target = windowForNotification(action.agentId);
  // 창이 하나도 없으면(macOS 는 창 없이 남는다) 새로 열고 앱 화면이 뜬 뒤에 보낸다
  const opened = !target;
  if (!target) {
    target = openNewWindow();
    await whenAppReady(target);
  }
  notifyRoutes.push({ agentId: action.agentId, action: action.action, windowId: target.id, opened });
  if (mode === "route-and-show") bringToFront(target);
  void target.win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("agent-nav:notification", { detail: ${JSON.stringify(action)} }))`);
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
      showOpenNotice(outcome.notice);
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
    showOpenNotice(outcome.notice);
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

// 열지 못한 이유는 OS 알림으로 보인다. 창이 하나도 없어도 보이고, 시험 알림 스텁(AGENT_NAV_NOTIFY_STUB)일 때는 띄우지 않고 outcome.notice 에만 남는다.
function showOpenNotice(notice: { title: string; body: string }) {
  if (NOTIFY_STUB || !Notification.isSupported()) return;
  new Notification({ title: `${NOTIFY_PREFIX}${notice.title}`, body: notice.body, silent: true }).show();
}

function onNotificationUsed(payload: NotifyPayload, button: "body" | "action") {
  shownNotifications.delete(payload.agentId);
  if (button === "action" && payload.itemId) {
    void dispatchNotificationAction({ agentId: payload.agentId, action: "allow", itemId: payload.itemId });
    return;
  }
  void dispatchNotificationAction({ agentId: payload.agentId, action: "open" }, "route-and-show");
}

function showNotification(payload: NotifyPayload) {
  clearNotification(payload.agentId);
  const bounce = payload.kind === "approval";
  if (NOTIFY_STUB) {
    stubbed.push({ payload, options: notificationOptions(payload), bounce, closed: false });
    return true;
  }
  if (!Notification.isSupported()) return false;
  const title = `${NOTIFY_PREFIX}${payload.title}`;
  const notification = new Notification({ title, body: payload.body, silent: true, ...(payload.actionLabel ? { actions: [{ type: "button", text: payload.actionLabel }] } : {}) });
  const record = { agentId: payload.agentId, title, body: payload.body, actions: payload.actionLabel ? [payload.actionLabel] : [], events: [] as string[] };
  realShown.push(record);
  notification.on("show", () => record.events.push("show"));
  notification.on("failed", (_event, error) => record.events.push(`failed: ${error}`));
  notification.on("click", () => {
    record.events.push("click");
    onNotificationUsed(payload, "body");
  });
  notification.on("action", () => {
    record.events.push("action");
    onNotificationUsed(payload, "action");
  });
  notification.on("close", () => {
    record.events.push("close");
    if (shownNotifications.get(payload.agentId) === notification) shownNotifications.delete(payload.agentId);
  });
  shownNotifications.set(payload.agentId, notification);
  notification.show();
  if (bounce) app.dock?.bounce("informational");
  return true;
}

function clearNotification(agentId: string) {
  shownNotifications.get(agentId)?.close();
  shownNotifications.delete(agentId);
  for (const entry of stubbed) if (entry.payload.agentId === agentId) entry.closed = true;
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

function savedSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav"), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// 설정을 바꾸면 앱을 다시 띄우지 않아도 Session 메뉴의 Board 항목이 나타나거나 사라지게(단축키 프리셋도 같다), 설정 파일이 바뀌면 메뉴를 다시 만든다. 파일 이름을 바꿔 쓰는 저장에도 견디도록 감시 대신 2초 간격 stat 이다.
function watchBoardMenu() {
  const file = join(process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav"), "settings.json");
  unwatchFile(file);
  watchFile(file, { interval: 2000, persistent: false }, () => {
    // 프리셋이 바뀌면 가로챌 키와 메뉴 가속키를 다시 정한다
    const next = keymapStateOf(savedSettings().keymapPreset);
    if (next.preset !== keymapState.preset) keymapState = next;
    if (boardMenuWanted() !== builtBoardMenu || keymapState.preset !== builtPreset) buildMenu();
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
  savedFile: join(process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav"), "mini-chat.json"),
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
  void target.win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("agent-nav:open-pr", { detail: ${JSON.stringify({ url, agentId })} }))`);
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
  return showNotification(payload);
});

// Dock 배지. 사람이 봐야 하는 세션(승인 대기)의 수를 화면이 계산해 보내 준다(web/useDockBadge.ts). 0 이면 지운다.
ipcMain.handle("agent-nav:badge", (event, count: unknown) => {
  if (!fromOurPage(event) || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 9999) throw new Error("badge refused");
  app.setBadgeCount(count);
});

ipcMain.handle("agent-nav:notify-clear", (event, agentId: unknown) => {
  if (!(fromQuickPage(event) || fromOurPage(event)) || typeof agentId !== "string") throw new Error("notify refused");
  clearNotification(agentId);
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
  if (E2E_PORT) startE2E(E2E_PORT);
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

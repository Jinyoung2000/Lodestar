import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { dialogSummary, dragBetween, fullPageScreenshot, pendingDialog } from "./guestDebugger";
import { mouseEvent, pressKey, settle, sleep, type MouseKind } from "./guestInput";
import { describeChain, locateScript, parseSelector, type LocateRequest } from "./pwEngine";
import { runtimeMain } from "./pwRuntime";

const AGENT_WORLD = 1001;
const DEFERRED_KEEP_MS = 5 * 60_000;
const READY_WAIT_MS = 5000;

type Run = { id: string; win: BrowserWindow; guest: WebContents; canOpen: (url: string) => boolean; promise: Promise<string>; finished: boolean; timer: ReturnType<typeof setTimeout> | null };
const byRunner = new Map<number, Run>();
const deferred = new Map<string, Run>();
let registered = false;

export type PlaywrightOutput = { result?: unknown; hasResult?: boolean; error?: string; deferredResultId?: string };

export async function runPlaywright(guest: WebContents, input: { code?: string; deferredResultId?: string; timeoutMs: number }, canOpen: (url: string) => boolean): Promise<PlaywrightOutput> {
  register();
  let run: Run;
  if (input.deferredResultId) {
    const found = deferred.get(input.deferredResultId);
    if (!found || found.guest.id !== guest.id) throw new Error("No code execution is waiting under that deferredResultId.");
    run = found;
  } else {
    if (!input.code) throw new Error('Either "code" or "deferredResultId" must be provided.');
    run = await start(guest, input.code, canOpen);
  }
  const outcome = await Promise.race([run.promise, sleep(input.timeoutMs).then(() => null)]);
  if (outcome === null) {
    if (!deferred.has(run.id)) {
      deferred.set(run.id, run);
      run.timer = setTimeout(() => dispose(run), DEFERRED_KEEP_MS);
    }
    return { deferredResultId: run.id };
  }
  dispose(run);
  const parsed = JSON.parse(outcome) as { result?: unknown; has?: boolean; error?: string };
  return parsed.error !== undefined ? { error: parsed.error } : { result: parsed.result, hasResult: parsed.has === true };
}

async function start(guest: WebContents, code: string, canOpen: (url: string) => boolean): Promise<Run> {
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
      partition: `pw-runner-${randomUUID()}`,
      preload: join(import.meta.dirname, "pw-preload.cjs"),
    },
  });
  const contents = win.webContents;
  contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
  contents.session.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  const html = encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval' 'unsafe-inline'"><title>runner</title>`);
  await Promise.race([contents.loadURL(`data:text/html,${html}`), sleep(READY_WAIT_MS).then(() => Promise.reject(new Error("The code runner did not start.")))]).catch((error) => {
    win.destroy();
    throw error;
  });
  const id = randomUUID();
  const run: Run = { id, win, guest, canOpen, promise: Promise.resolve(""), finished: false, timer: null };
  byRunner.set(contents.id, run);
  run.promise = contents.executeJavaScript(`(${runtimeMain.toString()})(${JSON.stringify(code)}, ${parseSelector.toString()}, ${describeChain.toString()})`).then(
    (text: string) => text,
    (error: Error) => JSON.stringify({ error: error.message }),
  );
  void run.promise.then(() => (run.finished = true));
  return run;
}

function dispose(run: Run) {
  if (run.timer) clearTimeout(run.timer);
  deferred.delete(run.id);
  if (!run.win.isDestroyed()) {
    byRunner.delete(run.win.webContents.id);
    run.win.destroy();
  }
}

export function closeRunners() {
  for (const run of [...byRunner.values()]) dispose(run);
}

export function closeRunnersFor(guestId: number) {
  for (const run of [...byRunner.values()]) if (run.guest.id === guestId) dispose(run);
}

function register() {
  if (registered) return;
  registered = true;
  ipcMain.handle("agent-nav:pw-op", async (event, op: unknown, args: unknown) => {
    const run = byRunner.get(event.sender.id);
    if (!run || run.win.isDestroyed() || run.guest.isDestroyed()) throw new Error("The page is gone.");
    return pwOp(run, String(op), args && typeof args === "object" ? (args as Record<string, unknown>) : {});
  });
}

type Point = { x: number; y: number };
const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const point = (value: unknown): Point => {
  const p = (value ?? {}) as Record<string, unknown>;
  return { x: num(p.x), y: num(p.y) };
};

async function pwOp(run: Run, op: string, args: Record<string, unknown>): Promise<unknown> {
  const guest = run.guest;
  const dialog = pendingDialog(guest);
  if (dialog && !["mouse", "key"].includes(op)) throw new Error(dialogSummary(dialog));
  switch (op) {
    case "locate": {
      const req = args.req as LocateRequest;
      const raw = (await guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: locateScript(String(args.describe ?? "locator"), req) }])) as string;
      return JSON.parse(raw);
    }
    case "mouse": {
      const kind = String(args.type) as MouseKind;
      if (!["move", "down", "up", "click", "wheel"].includes(kind)) throw new Error("Unknown mouse action.");
      mouseEvent(guest, kind, { x: args.x === undefined ? undefined : num(args.x), y: args.y === undefined ? undefined : num(args.y), button: String(args.button ?? "left"), clickCount: num(args.clickCount, 1), deltaX: num(args.deltaX), deltaY: num(args.deltaY) });
      if (kind === "click") await settle(guest);
      return null;
    }
    case "key":
      pressKey(guest, String(args.key), args.phase === "down" ? "down" : args.phase === "up" ? "up" : "press");
      await settle(guest);
      return null;
    case "insert":
      await guest.insertText(String(args.text ?? ""));
      return null;
    case "typeChars": {
      const text = String(args.text ?? "");
      const delay = Math.min(1000, Math.max(0, num(args.delay)));
      for (const char of text) {
        pressKey(guest, char === "\n" ? "Enter" : char);
        if (delay) await sleep(delay);
      }
      await settle(guest);
      return null;
    }
    case "goto": {
      const url = String(args.url ?? "");
      const href = run.canOpen(url) ? new URL(url).href : "";
      if (!href || href.startsWith("file:")) throw new Error("Only http and https addresses can be opened from code, and not Lodestar itself.");
      await guest.loadURL(href).catch((error: Error) => {
        if (!/ERR_ABORTED|\(-3\)/.test(error.message)) throw error;
      });
      return null;
    }
    case "nav": {
      const history = guest.navigationHistory;
      if (args.action === "back") {
        if (!history.canGoBack()) throw new Error("There is no earlier page to go back to.");
        history.goBack();
      } else if (args.action === "forward") {
        if (!history.canGoForward()) throw new Error("There is no later page to go forward to.");
        history.goForward();
      } else guest.reload();
      await settle(guest);
      return null;
    }
    case "info": {
      if (args.what === "url") return guest.getURL();
      if (args.what === "title") return guest.getTitle();
      if (args.what === "viewport") return (await guest.executeJavaScript("({width: innerWidth, height: innerHeight})")) as { width: number; height: number };
      return (await guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: "document.documentElement.outerHTML" }])) as string;
    }
    case "waitLoad":
      await settle(guest);
      return null;
    case "evaluate": {
      const source = String(args.source ?? "");
      const raw = (await guest.executeJavaScript(`(async () => { const fn = (${source}); const value = await fn(${JSON.stringify(args.arg ?? null)}); return value === undefined ? null : JSON.stringify(value); })()`)) as string | null;
      return raw === null ? null : JSON.parse(raw);
    }
    case "screenshot": {
      if (args.fullPage === true) return fullPageScreenshot(guest);
      const zoom = guest.getZoomFactor();
      const rect = args.rect as { x: number; y: number; width: number; height: number } | undefined;
      let image = await Promise.race([rect ? guest.capturePage({ x: Math.max(0, Math.round(rect.x * zoom)), y: Math.max(0, Math.round(rect.y * zoom)), width: Math.max(1, Math.round(rect.width * zoom)), height: Math.max(1, Math.round(rect.height * zoom)) }) : guest.capturePage(), sleep(2500).then(() => null)]);
      if (image === null || image.isEmpty()) throw new Error("The page cannot be captured right now. Its Browser tab may be hidden: ask the user to bring it to the front.");
      if (image.getSize().width > 1280) image = image.resize({ width: 1280 });
      return image.toPNG().toString("base64");
    }
    case "drag":
      await dragBetween(guest, scaled(guest, point(args.from)), scaled(guest, point(args.to)));
      await settle(guest);
      return null;
    default:
      throw new Error(`Unknown operation: ${op}`);
  }
}

const scaled = (guest: WebContents, p: Point): Point => ({ x: Math.round(p.x * guest.getZoomFactor()), y: Math.round(p.y * guest.getZoomFactor()) });

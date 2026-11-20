import type { WebContents } from "electron";
import { answerChooser, answerDialog, dialogSummary, dragBetween, pendingChooser, pendingDialog, rememberAction, unwatchDialogs, watchDialogs } from "./guestDebugger";
import { CLICK_SCRIPT, FOCUS_SCRIPT, resolveScript, snapshotScript } from "./guestScripts";
import { mouseEvent, pressKey, settle, sleep } from "./guestInput";
import { closeRunnersFor, runPlaywright } from "./pwRunner";

// 에이전트의 Browser 도구를 공유된 <webview> 의 webContents 에서 실행한다. 데몬(server/browserTools.ts)이 도구 이름과 인자를 보내고, 화면이 이 함수를 메인 프로세스에서 부른다.
// 페이지로 들어가는 스크립트는 격리된 세계에서 돌고, 클릭과 입력은 실제 입력 이벤트(sendInputEvent)라 페이지가 사용자 입력으로 받는다.
const AGENT_WORLD = 1001;
const MAX_SHOT_WIDTH = 1280;
const CAPTURE_WAIT_MS = 2500;

export type ToolOutput = { text?: string; image?: string };
type Args = Record<string, unknown>;

// 페이지의 console 출력을 최근 것부터 MAX 개만 들고 있는다. Add Console Logs to Chat 과 read_console_logs 가 읽는다.
export type ConsoleEntry = { level: string; message: string; source: string; line: number; at: number };
const MAX_CONSOLE = 300;
const consoles = new Map<number, ConsoleEntry[]>();

const LEVELS = ["verbose", "info", "warning", "error"];

// Electron 은 console-message 를 (event, level, message, line, sourceId) 로 주다가 하나의 details 객체로 바꿨다. 둘 다 받는다.
export function recordConsole(guest: WebContents) {
  const id = guest.id;
  consoles.set(id, []);
  guest.on("console-message", ((...args: unknown[]) => {
    const first = args[0] as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown } | undefined;
    const details = first && typeof first === "object" && "message" in first ? first : null;
    const level = details ? details.level : args[1];
    const message = String(details ? details.message : args[2]);
    const line = Number(details ? details.lineNumber : args[3]) || 0;
    const source = String(details ? details.sourceId : args[4] ?? "");
    // 개발 모드의 Electron 보안 경고는 페이지가 낸 글이 아니다
    if (message.startsWith("%cElectron Security Warning") || message.startsWith("Electron Security Warning")) return;
    const entry: ConsoleEntry = { level: typeof level === "number" ? (LEVELS[level] ?? "info") : String(level ?? "info"), message: message.slice(0, 2000), source: source.slice(0, 300), line, at: Date.now() };
    const list = consoles.get(id);
    if (!list) return;
    list.push(entry);
    if (list.length > MAX_CONSOLE) list.splice(0, list.length - MAX_CONSOLE);
  }) as never);
  guest.once("destroyed", () => consoles.delete(id));
}

export function consoleLogs(id: number, limit = 100): ConsoleEntry[] {
  return (consoles.get(id) ?? []).slice(-Math.max(1, Math.min(limit, MAX_CONSOLE)));
}

export function formatConsole(entries: ConsoleEntry[]): string {
  if (entries.length === 0) return "No console messages.";
  return entries.map((e) => `[${e.level}] ${e.message}${e.source ? ` (${e.source}:${e.line})` : ""}`).join("\n");
}

const str = (value: unknown) => (typeof value === "string" && value ? value : null);
const DEFAULT_PLAYWRIGHT_TIMEOUT_MS = 5000;

export async function runGuestTool(guest: WebContents, tool: string, args: Args, canOpen: (url: string) => boolean): Promise<ToolOutput> {
  const header = () => `Page: ${guest.getTitle() || "(untitled)"}\nURL: ${guest.getURL()}`;
  if (tool === "wait_loaded") {
    await settle(guest);
    return {};
  }
  if (tool === "release") {
    closeRunnersFor(guest.id);
    await unwatchDialogs(guest);
    return {};
  }
  // 공유된 동안 대화상자와 파일 선택창을 가로챈다. 그러지 않으면 페이지의 alert 가 사용자 화면에만 뜨고 에이전트는 멈춘 페이지를 본다.
  await watchDialogs(guest);
  const dialog = pendingDialog(guest);
  if (dialog && tool !== "handle_dialog" && tool !== "read_console_logs") throw new Error(dialogSummary(dialog));
  const afterAction = () => {
    const opened = pendingDialog(guest);
    return opened ? `\n${dialogSummary(opened)}` : "";
  };
  switch (tool) {
    case "read_page": {
      const mode = args.mode === "text" ? "text" : "snapshot";
      const read = JSON.parse((await guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: snapshotScript(mode) }])) as string) as { title: string; url: string; text: string };
      return { text: `Page: ${read.title || "(untitled)"}\nURL: ${read.url}\n\n${read.text || "(empty page)"}` };
    }
    case "screenshot_page": {
      // 요소를 지정하면 그 요소만, 아니면 보이는 영역 전체. 가려진 탭(display: none)의 capturePage 는 끝나지 않고 매달려서 잠깐만 기다린다.
      let rect: { x: number; y: number; width: number; height: number } | undefined;
      if (args.ref || args.selector) {
        const target = await resolve(guest, args);
        rect = { x: target.x - target.width / 2, y: target.y - target.height / 2, width: target.width, height: target.height };
      }
      const zoom = guest.getZoomFactor();
      const clip = rect ? { x: Math.max(0, Math.round(rect.x * zoom)), y: Math.max(0, Math.round(rect.y * zoom)), width: Math.max(1, Math.round(rect.width * zoom)), height: Math.max(1, Math.round(rect.height * zoom)) } : undefined;
      let image = await Promise.race([clip ? guest.capturePage(clip) : guest.capturePage(), sleep(CAPTURE_WAIT_MS).then(() => null)]);
      if (image === null || image.isEmpty()) throw new Error("The page cannot be captured right now. Its Browser tab may be hidden: ask the user to bring it to the front.");
      if (image.getSize().width > MAX_SHOT_WIDTH) image = image.resize({ width: MAX_SHOT_WIDTH });
      return { image: image.toPNG().toString("base64"), text: header() };
    }
    case "click_element":
    case "hover_element": {
      const target = await resolve(guest, args);
      const hover = tool === "hover_element";
      const button = args.button === "right" ? "right" : args.button === "middle" ? "middle" : "left";
      await pointAt(guest, target, hover ? "hover" : args.dblClick === true ? "double" : button);
      await settle(guest);
      return { text: `${hover ? "Hovered over" : "Clicked"} ${describe(target)}.\n${header()}${afterAction()}` };
    }
    case "drag_element": {
      const from = await resolve(guest, { ref: args.fromRef, selector: args.fromSelector });
      const to = await resolve(guest, { ref: args.toRef, selector: args.toSelector });
      if (from.width <= 0 || to.width <= 0) throw new Error("The page is not visible, so elements cannot be dragged. Ask the user to bring the Browser tab to the front.");
      const zoom = guest.getZoomFactor();
      const html5 = await dragBetween(guest, { x: Math.round(from.x * zoom), y: Math.round(from.y * zoom) }, { x: Math.round(to.x * zoom), y: Math.round(to.y * zoom) });
      await settle(guest);
      return { text: `Dragged ${describe(from)} to ${describe(to)}${html5 ? " (drag and drop)" : ""}.\n${header()}${afterAction()}` };
    }
    case "handle_dialog": {
      const files = args.selectFiles;
      if (files !== undefined && (args.acceptModal !== undefined || args.promptText !== undefined)) throw new Error("Invalid parameters. 'selectFiles' cannot be used with 'acceptModal' or 'promptText'.");
      if (!Array.isArray(files) && (args.acceptModal === undefined || args.acceptModal === null)) throw new Error("Invalid parameters. Either 'selectFiles' or 'acceptModal' must be provided.");
      if (Array.isArray(files)) {
        if (!pendingChooser(guest)) throw new Error("There is no open file chooser on this page.");
        const picked = files.filter((f): f is string => typeof f === "string");
        const allowed = picked.filter((f) => canPickFile(f));
        if (allowed.length !== picked.length) throw new Error("Only files inside the session's folder can be selected.");
        await answerChooser(guest, allowed);
        return { text: allowed.length ? `Selected ${allowed.length} file${allowed.length === 1 ? "" : "s"} in the file chooser.` : "Dismissed the file chooser." };
      }
      const accept = args.acceptModal === true;
      const handled = await answerDialog(guest, accept, typeof args.promptText === "string" ? args.promptText : undefined);
      await settle(guest);
      return { text: `${accept ? "Accepted" : "Dismissed"} the ${handled.type} dialog${handled.message ? ` ${JSON.stringify(handled.message.slice(0, 200))}` : ""}.\n${header()}${afterAction()}` };
    }
    case "type_in_page": {
      const text = typeof args.text === "string" ? args.text : null;
      const key = str(args.key);
      if (text === null && !key) throw new Error('Either a "text" or "key" parameter is required.');
      let where = "the page";
      if (args.ref || args.selector) {
        const target = await resolve(guest, args);
        where = describe(target);
        if (!(await pointAt(guest, target, "left"))) await guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: CLICK_SCRIPT }]);
        await guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: FOCUS_SCRIPT }]);
      }
      if (key) pressKey(guest, key);
      else {
        if (text !== null) await guest.insertText(text);
        if (args.submit === true) pressKey(guest, "Enter");
      }
      await settle(guest);
      return { text: `${key ? `Pressed key ${key}` : `Typed ${JSON.stringify((text ?? "").slice(0, 80))}${args.submit === true ? " and pressed Enter" : ""}`} in ${where}.\n${header()}${afterAction()}` };
    }
    case "navigate_page": {
      const action = str(args.type) ?? str(args.action) ?? "url";
      const history = guest.navigationHistory;
      if (action === "back") {
        if (!history.canGoBack()) throw new Error("There is no earlier page to go back to.");
        history.goBack();
      } else if (action === "forward") {
        if (!history.canGoForward()) throw new Error("There is no later page to go forward to.");
        history.goForward();
      } else if (action === "reload") {
        rememberAction(guest, () => guest.reload());
        guest.reload();
      } else {
        const url = str(args.url);
        if (!url) throw new Error('The "url" parameter is required when type is "url".');
        if (!canOpen(url)) throw new Error("Only http and https addresses (and local files) can be opened, and not Lodestar itself.");
        // file: 은 데몬이 허락된 폴더 안인지 확인한 호출(fileOk)에만 연다. 스킴은 해석한 주소로 본다: " file:///..." 나 탭이 낀 "fi\tle:" 도 URL 해석과 loadURL 은 file: 로 읽는다.
        const href = new URL(url).href;
        if (href.startsWith("file:") && args.fileOk !== true) throw new Error("Local files can only be opened from inside this session's folder.");
        rememberAction(guest, () => void guest.loadURL(href).catch(() => undefined));
        await guest.loadURL(href).catch((error: Error) => {
          // 다른 이동이 앞서 취소된 경우(ERR_ABORTED)는 오류가 아니다
          if (!/ERR_ABORTED|\(-3\)/.test(error.message)) throw error;
        });
      }
      await settle(guest);
      return { text: `Navigated (${action}).\n${header()}${afterAction()}` };
    }
    case "run_playwright_code": {
      const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? Math.min(args.timeoutMs, 120_000) : DEFAULT_PLAYWRIGHT_TIMEOUT_MS;
      const out = await runPlaywright(guest, { code: str(args.code) ?? undefined, deferredResultId: str(args.deferredResultId) ?? undefined, timeoutMs }, canOpen);
      if (out.error !== undefined) throw new Error(`Code execution failed: ${out.error}`);
      const lines: string[] = [];
      if (out.hasResult) lines.push(`Result: ${JSON.stringify(out.result)}`);
      if (out.deferredResultId) lines.push(`[deferredResultId=${out.deferredResultId}] The code has not finished executing yet. Call run_playwright_code again with this deferredResultId and the same pageId (no code) to continue waiting.`);
      return { text: `${lines.join("\n")}${lines.length ? "\n" : ""}${header()}${afterAction()}` };
    }
    case "read_console_logs":
      return { text: formatConsole(consoleLogs(guest.id, typeof args.limit === "number" ? args.limit : 100)) };
    default:
      throw new Error(`Unknown browser tool: ${tool}`);
  }
}

// 파일 선택창에 고를 파일은 절대 경로뿐이다. 어느 폴더 안인지는 데몬이 도구를 받을 때 이미 확인했다(세션 작업 폴더와 스크린샷 폴더).
const canPickFile = (file: string) => file.startsWith("/") && !file.split("/").includes("..");

type Target = { ok: boolean; reason?: string; label: string; tag: string; x: number; y: number; width: number; height: number };

async function resolve(guest: WebContents, args: Args): Promise<Target> {
  const code = resolveScript(str(args.ref), str(args.selector));
  if (!code) throw new Error('Either a "ref" or "selector" parameter is required.');
  const target = JSON.parse((await guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }])) as string) as Target;
  if (!target.ok) throw new Error(target.reason ?? "Element not found.");
  return target;
}

const describe = (target: Target) => `${target.tag} "${target.label}"`;

// 요소 가운데에 마우스를 둔다. 탭이 숨겨져 크기가 0 이면 좌표 입력이 닿지 않으므로 false 를 돌려 준다.
async function pointAt(guest: WebContents, target: Target, kind: "hover" | "left" | "right" | "middle" | "double"): Promise<boolean> {
  if (target.width <= 0 || target.height <= 0) {
    if (kind === "hover") throw new Error("The page is not visible, so the pointer cannot be moved over it. Ask the user to bring the Browser tab to the front.");
    await guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: CLICK_SCRIPT }]);
    return false;
  }
  if (kind === "hover") mouseEvent(guest, "move", { x: target.x, y: target.y });
  else mouseEvent(guest, "click", { x: target.x, y: target.y, button: kind === "double" ? "left" : kind, clickCount: kind === "double" ? 2 : 1 });
  return true;
}

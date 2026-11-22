import { realpathSync } from "node:fs";
import { version as APP_VERSION } from "../package.json";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { BrowserToolName } from "../shared/protocol";
import type { BrowserBridge } from "./browserBridge";
import { BROWSER_SERVER_NAME, BROWSER_TOOL_PREFIX } from "./browserToolNames";
import { T } from "./strings";

export { BROWSER_SERVER_NAME, BROWSER_TOOL_PREFIX };

export const isBrowserToolName = (name: string) => name.startsWith(BROWSER_TOOL_PREFIX);
export const browserToolId = (name: string) => name.slice(BROWSER_TOOL_PREFIX.length);

export function browserToolNeedsApproval(name: string, input: Record<string, unknown>): boolean {
  if (!isBrowserToolName(name)) return false;
  const id = browserToolId(name);
  if (id === "open_browser_page") return typeof input.url === "string" && input.url !== "";
  if (id === "run_playwright_code") return typeof input.code === "string" && input.code !== "";
  if (id === "navigate_page") return (input.type ?? input.action ?? "url") === "url";
  return false;
}

type Args = Record<string, unknown>;
type CallToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

export function fileUrlInside(url: string, roots: string[]): boolean {
  let path: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:" || parsed.hostname !== "") return false;
    path = fileURLToPath(parsed);
  } catch {
    return false;
  }
  return filePathInside(path, roots);
}

export function filePathInside(path: string, roots: string[]): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolvePath(p);
    }
  };
  const target = real(path);
  return roots.some((root) => {
    const base = real(root);
    return target === base || target.startsWith(base.endsWith("/") ? base : `${base}/`);
  });
}

function isFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

export async function runBrowserTool(bridge: BrowserBridge, enabled: () => boolean, agentId: string, tool: BrowserToolName, args: Args, allowedFileRoots: () => string[] = () => []): Promise<CallToolResult> {
  if (!enabled()) return failure(T.errBrowserOff);
  try {
    const url = typeof args.url === "string" ? args.url : "";
    const isFile = tool === "navigate_page" && isFileUrl(url);
    if (isFile && !fileUrlInside(url, allowedFileRoots())) return failure(T.errBrowserFileOutside);
    const sent = { ...args, fileOk: isFile };
    const { page, output } = await bridge.call(agentId, typeof args.pageId === "string" ? args.pageId : undefined, tool, sent);
    const content: CallToolResult["content"] = [];
    if (output.text) content.push({ type: "text", text: `${T.browserUntrusted(page.url)}\n\n${output.text}` });
    if (output.image) content.push({ type: "image", data: output.image, mimeType: "image/png" });
    if (content.length === 0) content.push({ type: "text", text: "Done." });
    return { content };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export function listBrowserPages(bridge: BrowserBridge, enabled: () => boolean, agentId: string): CallToolResult {
  if (!enabled()) return failure(T.errBrowserOff);
  const shared = bridge.pagesFor(agentId).map((m) => m.page);
  const open = bridge.unsharedCount();
  if (shared.length === 0 && open === 0) return { content: [{ type: "text", text: "No browser pages are currently open." }] };
  let text = "";
  if (shared.length > 0) {
    const lines = shared.map((p) => `- [${p.pageId}] ${p.title || "Untitled"} (${p.url || "about:blank"}) (${p.visible === "active" ? "active" : "not visible"})`);
    text = `${T.browserUntrusted("(page titles and addresses)")}\n\nThe following browser pages are currently shared with you and can be interacted with using the browser tools:\n${lines.join("\n")}`;
  } else text = "No browser pages are currently shared with you.";
  if (open > 0) text += `\n\n${open} ${open === 1 ? "page is" : "pages are"} open but not shared.\nUse the 'open_browser_page' tool to open a new page or to help the user share an existing page.`;
  return { content: [{ type: "text", text }] };
}

export async function openBrowserPage(bridge: BrowserBridge, enabled: () => boolean, agentId: string, args: Args, allowedFileRoots: () => string[] = () => []): Promise<CallToolResult> {
  if (!enabled()) return failure(T.errBrowserOff);
  const url = typeof args.url === "string" && args.url ? args.url : null;
  if (url && !parseUrl(url)) return failure(T.errBrowserBadUrl);
  if (url && isFileUrl(url) && !fileUrlInside(url, allowedFileRoots())) return failure(T.errBrowserFileOutside);
  try {
    const output = await bridge.open(agentId, url, args.forceNew === true);
    const content: CallToolResult["content"] = [];
    const text = output.text ?? "Done.";
    content.push({ type: "text", text: text.startsWith("Page ID:") ? `${T.browserUntrusted(url ?? "the page")}\n\n${text}` : text });
    return { content };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

const parseUrl = (value: string) => {
  try {
    const u = new URL(value);
    return ["http:", "https:", "file:"].includes(u.protocol) ? u : null;
  } catch {
    return null;
  }
};

const failure = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

const pageId = z.string().optional().describe("The browser page ID, acquired from context or the open tool.");
const ref = (what: string) => z.string().optional().describe(`Element reference ${what}.`);
const selector = (what: string, refName = "ref") => z.string().optional().describe(`Playwright selector of ${what} when "${refName}" is not available.`);
const element = (example: string, what: string) => z.string().optional().describe(`Human-readable description of the element ${what} (e.g., ${example}).`);

export function browserMcpServer(bridge: BrowserBridge, enabled: () => boolean, agentId: string, allowedFileRoots: () => string[] = () => []) {
  const run = (name: BrowserToolName) => (args: Args) => runBrowserTool(bridge, enabled, agentId, name, args, allowedFileRoots);
  return createSdkMcpServer({
    name: BROWSER_SERVER_NAME,
    version: APP_VERSION,
    tools: [
      tool(
        "open_browser_page",
        `Open a new browser page in the integrated browser at the given URL.\nMay prompt the user to share a page if there is a similar one already open, unless "forceNew" is true.\nReturns a page ID that must be used with other browser tools to interact with the page, as well as an accessibility snapshot of the page.\n\nImportant: Prefer to reuse existing pages whenever possible and only call this tool if you do not already have access to a tab you can reuse.`,
        {
          url: z.string().optional().describe("The URL to open in the browser. Must be an absolute URI with a scheme such as file:, http:, or https:. For local files, use the canonical absolute form, for example file:///path/to/file."),
          forceNew: z.boolean().optional().describe("Whether to force opening a new page even if a page with the same host already exists. Default is false."),
        },
        async (args) => openBrowserPage(bridge, enabled, agentId, args as Args, allowedFileRoots),
      ),
      tool("list_browser_pages", "Lists the browser pages that are currently shared with the agent.", {}, async () => listBrowserPages(bridge, enabled, agentId)),
      tool("read_page", "Get a snapshot of the current browser page state. This is better than screenshot.", { pageId, mode: z.enum(["snapshot", "text"]).optional().describe("Optional. Use 'text' for the plain visible text instead of the snapshot.") }, async (args) => run("read_page")(args as Args)),
      tool(
        "screenshot_page",
        "Capture a screenshot of the current browser page. You can't perform actions based on the screenshot; use read_page for actions.",
        { pageId, ref: ref("to capture. If omitted, captures the whole viewport"), selector: selector("an element to capture", "ref"), element: element('"chart diagram", "product image"', "to capture"), scrollIntoViewIfNeeded: z.boolean().optional().describe("Whether to scroll the element into view before capturing. Defaults to false.") },
        async (args) => run("screenshot_page")(args as Args),
      ),
      tool(
        "click_element",
        "Click on an element in a browser page.",
        { pageId, ref: ref("to click"), selector: selector("the element to click"), element: element('"submit button", "search icon"', "to click"), dblClick: z.boolean().optional().describe("Set to true for double clicks. Default is false."), button: z.enum(["left", "right", "middle"]).optional().describe('Mouse button to click with. Default is "left".') },
        async (args) => run("click_element")(args as Args),
      ),
      tool(
        "drag_element",
        "Drag an element over another element in a browser page.",
        {
          pageId,
          fromRef: ref("of the element to drag"),
          fromSelector: selector("the element to drag", "fromRef"),
          fromElement: element('"file item", "draggable card"', "to drag"),
          toRef: ref("of the element to drop onto"),
          toSelector: selector("the element to drop onto", "toRef"),
          toElement: element('"drop zone", "target folder"', "to drop onto"),
        },
        async (args) => run("drag_element")(args as Args),
      ),
      tool(
        "handle_dialog",
        "Respond to a pending modal (alert, confirm, prompt) or file chooser dialog on a browser page.",
        {
          pageId,
          acceptModal: z.boolean().optional().describe("Whether to accept (true) or dismiss (false) a modal dialog."),
          promptText: z.string().optional().describe("Text to enter into a prompt dialog."),
          selectFiles: z.array(z.string()).optional().describe("Absolute paths of files to select, or empty to dismiss. Required for file chooser dialogs."),
        },
        async (args) => {
          const files = (args as { selectFiles?: string[] }).selectFiles;
          if (files?.length) {
            const roots = allowedFileRoots();
            const outside = files.some((f) => !f.startsWith("/") || !filePathInside(f, roots));
            if (outside) return failure(T.errBrowserFilesOutside);
          }
          return run("handle_dialog")(args as Args);
        },
      ),
      tool("hover_element", "Hover over an element in a browser page. Provide either a Playwright selector or an element reference.", { pageId, ref: ref("to hover over"), selector: selector("the element to hover over"), element: element('"navigation menu", "tooltip trigger"', "to hover over") }, async (args) => run("hover_element")(args as Args)),
      tool(
        "navigate_page",
        "Navigate a browser page by URL, history, or reload.",
        {
          pageId,
          type: z.enum(["url", "back", "forward", "reload"]).optional().describe('Navigation type: "url" to navigate to a URL (default, requires "url" param), "back" or "forward" for history, "reload" to refresh.'),
          url: z.string().optional().describe('The URL to navigate to. Required when type is "url".'),
        },
        async (args) => run("navigate_page")(args as Args),
      ),
      tool(
        "run_playwright_code",
        "Run a Playwright code snippet to control a browser page. Only use this if other browser tools are insufficient.",
        {
          pageId,
          code: z
            .string()
            .optional()
            .describe('The Playwright code to execute. The code must be concise, serve one clear purpose, and be self-contained. You **must not** directly access `document` or `window` using this tool. You must access it via the provided `page` object, e.g. "return page.evaluate(() => document.title)". Omit this when resuming a deferred execution via deferredResultId.'),
          deferredResultId: z.string().optional().describe("If a previous call returned a deferredResultId, pass it here to continue waiting for that execution to complete."),
          timeoutMs: z.number().optional().describe("Maximum time in milliseconds to wait for the code to complete. Defaults to 5000 (5 seconds)."),
        },
        async (args) => run("run_playwright_code")(args as Args),
      ),
      tool(
        "type_in_page",
        "Type text or press keys in a browser page.",
        {
          pageId,
          text: z.string().optional().describe('The text to type. One of "text" or "key" must be provided.'),
          submit: z.boolean().optional().describe('Whether to press Enter after typing text. Ignored when "key" is provided. Default is false.'),
          key: z.string().optional().describe('A key or key combination to press (e.g., "Enter", "Tab", "Control+c"). One of "text" or "key" must be provided.'),
          ref: ref("to focus and type into. If omitted, types into the focused element"),
          selector: selector("element to focus and type into. Use if \"ref\" is not available. If omitted, types into the focused element", "ref").describe('Playwright selector of element to focus and type into. Use if "ref" is not available. If omitted, types into the focused element.'),
          element: element('"search box", "comment field"', "to type into. Required when \"ref\" or \"selector\" is specified"),
        },
        async (args) => run("type_in_page")(args as Args),
      ),
      tool("read_console_logs", "Read the most recent console messages (log, warn, error) of a shared browser page. (Lodestar only: VS Code attaches console logs through Add Console Logs to Chat.)", { pageId, limit: z.number().int().min(1).max(200).optional() }, async (args) => run("read_console_logs")(args as Args)),
    ],
  });
}

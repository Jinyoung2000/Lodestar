import { BROWSER_TOOL_PREFIX } from "../server/browserToolNames";

export type BrowserToolLabel = { verb: string; page: string | null; after?: string };

export function browserToolLabel(name: string, input: Record<string, unknown>, pageTitle: string | null, phase: "running" | "done" = "done"): BrowserToolLabel | null {
  if (!name.startsWith(BROWSER_TOOL_PREFIX)) return null;
  const str = (key: string) => (typeof input[key] === "string" && input[key] ? (input[key] as string) : null);
  const done = phase === "done";
  const el = (prefix = "") => {
    const cap = (word: string) => (prefix ? `${prefix}${word[0].toUpperCase()}${word.slice(1)}` : word);
    return str(cap("element")) ?? str(cap("ref")) ?? str(cap("selector")) ?? "element";
  };
  const page = pageTitle;
  switch (name.slice(BROWSER_TOOL_PREFIX.length)) {
    case "list_browser_pages":
      return { verb: done ? "Listed browser pages" : "Listing browser pages", page: null };
    case "open_browser_page": {
      const url = str("url");
      if (!url) return { verb: done ? "Prompted user to share a browser tab" : "Prompting user to share a browser tab", page: null };
      return { verb: done ? "Opened" : `Opening browser page at ${url}`, page: done ? page : null };
    }
    case "read_page":
      return { verb: done ? "Read" : "Reading", page };
    case "screenshot_page":
      return str("element") ? { verb: `${done ? "Captured" : "Capturing"} screenshot of ${el()}`, page: null } : { verb: done ? "Captured browser screenshot" : "Capturing browser screenshot", page: null };
    case "click_element": {
      const kind = input.dblClick === true ? "dbl" : input.button === "right" ? "right" : input.button === "middle" ? "middle" : "left";
      const verbs = { dbl: ["Double-clicking", "Double-clicked"], right: ["Right-clicking", "Right-clicked"], middle: ["Middle-clicking", "Middle-clicked"], left: ["Clicking", "Clicked"] }[kind];
      return { verb: `${verbs[done ? 1 : 0]} ${el()} in`, page };
    }
    case "drag_element":
      return { verb: `${done ? "Dragged" : "Dragging"} ${el("from")} to ${el("to")} in`, page };
    case "handle_dialog":
      return { verb: done ? "Handled dialog in" : "Handling dialog in", page };
    case "hover_element":
      return { verb: `${done ? "Hovered over" : "Hovering over"} ${el()} in`, page };
    case "type_in_page": {
      const key = str("key");
      const target = str("ref") || str("selector") ? el() : null;
      if (key) return { verb: `${done ? "Pressed" : "Pressing"} key \`${key}\` in${target ? ` ${target} in` : ""}`, page };
      const enter = input.submit === true;
      return { verb: `${done ? "Typed" : "Typing"} text in${target ? ` ${target} in` : ""}`, page, after: enter ? (done ? " and pressed Enter" : " and pressing Enter") : undefined };
    }
    case "navigate_page": {
      const type = str("type") ?? str("action") ?? "url";
      if (type === "back") return { verb: done ? "Navigated backward in" : "Navigating backward in", page };
      if (type === "forward") return { verb: done ? "Navigated forward in" : "Navigating forward in", page };
      if (type === "reload") return { verb: done ? "Reloaded" : "Reloading", page };
      return { verb: `${done ? "Navigated to" : "Navigating to"} ${str("url") ?? "page"} in`, page };
    }
    case "run_playwright_code":
      return str("deferredResultId") ? { verb: done ? "Waited for Playwright code" : "Waiting for Playwright code to complete...", page: null } : { verb: done ? "Ran Playwright code" : "Running Playwright code...", page: null };
    case "read_console_logs":
      return { verb: done ? "Read console logs of" : "Reading console logs of", page };
    default:
      return null;
  }
}

export type BrowserApproval = { title: string; message: string; code?: string; disclaimer?: string };

export function browserApproval(name: string, input: Record<string, unknown>): BrowserApproval | null {
  if (!name.startsWith(BROWSER_TOOL_PREFIX)) return null;
  const url = typeof input.url === "string" ? input.url : "";
  switch (name.slice(BROWSER_TOOL_PREFIX.length)) {
    case "open_browser_page":
      return url ? { title: "Open Browser Page?", message: `This will open ${url} in the integrated browser. The agent will be able to read and interact with its contents.` } : null;
    case "navigate_page":
      return (input.type ?? input.action ?? "url") === "url" && url ? { title: "Navigate Browser?", message: `This will navigate the browser to ${url} and allow the agent to access its contents.` } : null;
    case "run_playwright_code":
      return typeof input.code === "string" && input.code ? { title: "Run Playwright Code?", message: "", code: input.code.trim(), disclaimer: "Make sure you trust the code before continuing." } : null;
    default:
      return null;
  }
}

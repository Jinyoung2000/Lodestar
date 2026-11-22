import { EMBED_PREFIX, isHostOrigin, type EmbedFromHost, type EmbedTheme, type EmbedToHost } from "../shared/embed";

export type EmbedParams = { agentId: string | null; workspaceId: string | null; theme: EmbedTheme; mini: boolean };

function readParams(): EmbedParams | null {
  const query = new URLSearchParams(location.search);
  if (query.get("embed") !== "session") return null;
  return { agentId: query.get("agent"), workspaceId: query.get("workspace"), theme: query.get("theme") === "light" ? "light" : "dark", mini: query.get("mini") === "1" };
}

export const EMBED = readParams();

let hostOrigin: string | null = null;
const outbox: EmbedToHost[] = [];
const hasHost = () => window.parent !== window;

export function postToHost(message: EmbedToHost) {
  if (!EMBED) return;
  if (EMBED.mini) {
    if (message.type !== "agent-nav:session" && message.type !== "agent-nav:ready") void window.agentNavNative?.quickEntryHost?.(message)?.catch(() => undefined);
    return;
  }
  if (!hasHost()) return;
  if (hostOrigin) window.parent.postMessage(message, hostOrigin);
  else outbox.push(message);
}

export function listenToHost(handler: (message: EmbedFromHost) => void) {
  if (!hasHost()) return;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !isHostOrigin(event.origin)) return;
    const data = event.data as EmbedFromHost | null;
    if (!data || typeof data.type !== "string" || !data.type.startsWith(EMBED_PREFIX)) return;
    if (!hostOrigin) {
      hostOrigin = event.origin;
      for (const message of outbox.splice(0)) window.parent.postMessage(message, hostOrigin);
    }
    handler(data);
  });
  window.parent.postMessage({ type: "agent-nav:ready" } satisfies EmbedToHost, "*");
}

export function absolutePath(dir: string, path: string) {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${dir}/${path}`).split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

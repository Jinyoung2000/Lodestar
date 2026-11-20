import { EMBED_PREFIX, isHostOrigin, type EmbedFromHost, type EmbedTheme, type EmbedToHost } from "../shared/embed";

export type EmbedParams = { agentId: string | null; workspaceId: string | null; theme: EmbedTheme; mini: boolean };

function readParams(): EmbedParams | null {
  const query = new URLSearchParams(location.search);
  if (query.get("embed") !== "session") return null;
  return { agentId: query.get("agent"), workspaceId: query.get("workspace"), theme: query.get("theme") === "light" ? "light" : "dark", mini: query.get("mini") === "1" };
}

export const EMBED = readParams();

// 부모가 없는 탭에서 열렸으면(시험용) 보낼 곳이 없다. 부모가 있어도 hello 를 받기 전에는 출처를 모르니 쌓아 둔다.
let hostOrigin: string | null = null;
const outbox: EmbedToHost[] = [];
const hasHost = () => window.parent !== window;

export function postToHost(message: EmbedToHost) {
  if (!EMBED) return;
  // 미니 패널: 확장이 파일 열기, diff, 변경, 링크로 받던 메시지만 메인으로 보낸다(세션 알림과 ready 는 받을 곳이 없다).
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
  // 확장은 이 메시지에 hello 로 답한다. 내용이 없어서 출처를 모르는 채로 보내도 된다.
  window.parent.postMessage({ type: "agent-nav:ready" } satisfies EmbedToHost, "*");
}

// 작업 폴더 기준 경로를 절대 경로로. 절대 경로는 그대로, ../ 는 접는다.
export function absolutePath(dir: string, path: string) {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${dir}/${path}`).split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

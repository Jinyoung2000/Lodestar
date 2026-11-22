import { EMBED_COLORS, type EmbedTheme } from "../../shared/embed";

export type PanelPage = { nonce: string; origin: string; src: string; theme: EmbedTheme };

export function panelHtml({ nonce, origin, src, theme }: PanelPage): string {
  const colorVars = Object.fromEntries(Object.entries(EMBED_COLORS).map(([role, { vscode }]) => [role, vscode]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
  #offline { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; box-sizing: border-box; text-align: center; background: var(--vscode-editor-background); color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
  #offline[hidden] { display: none; }
  #offline button { padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; cursor: pointer; }
  #offline button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<iframe id="app" src="${escapeAttr(src)}" title="Lodestar session" allow="clipboard-read; clipboard-write"></iframe>
<div id="offline" hidden role="status"><div id="offline-text"></div><button id="open-app" type="button">Open Lodestar</button></div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById("app");
  const overlay = document.getElementById("offline");
  const ORIGIN = ${JSON.stringify(origin)};
  const SRC = ${JSON.stringify(src)};
  let theme = ${JSON.stringify(theme)};
  const COLOR_VARS = ${JSON.stringify(colorVars)};
  let ready = false;
  let online = true;
  let sentColors = "";
  const queue = [];
  const toFrame = (message) => frame.contentWindow.postMessage(message, ORIGIN);

  const sendColors = (force) => {
    if (!ready) return;
    const style = getComputedStyle(document.documentElement);
    const colors = {};
    for (const [role, name] of Object.entries(COLOR_VARS)) {
      const value = style.getPropertyValue(name).trim();
      if (value) colors[role] = value;
    }
    const key = JSON.stringify(colors);
    if (!force && key === sentColors) return;
    sentColors = key;
    toFrame({ type: "agent-nav:colors", colors });
  };
  new MutationObserver(() => sendColors(false)).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  new MutationObserver(() => sendColors(false)).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === frame.contentWindow) {
      if (event.origin !== ORIGIN || !data || typeof data.type !== "string" || !data.type.startsWith("agent-nav:")) return;
      if (data.type === "agent-nav:ready") {
        ready = true;
        toFrame({ type: "agent-nav:hello", theme });
        sendColors(true);
        for (const message of queue.splice(0)) toFrame(message);
      }
      vscode.postMessage(data);
      return;
    }
    if (!data || typeof data.kind !== "string") return;
    if (data.kind === "relay") {
      if (data.message.type === "agent-nav:theme") theme = data.message.theme;
      if (ready) toFrame(data.message);
      else queue.push(data.message);
    } else if (data.kind === "bind") {
      vscode.setState(data.state);
    } else if (data.kind === "daemon") {
      document.getElementById("offline-text").textContent = data.message;
      overlay.hidden = data.online;
      if (data.online && !online) {
        ready = false;
        frame.src = SRC;
      }
      online = data.online;
    }
  });
  document.getElementById("open-app").addEventListener("click", () => vscode.postMessage({ type: "ext:openApp" }));
})();
</script>
</body>
</html>`;
}

function escapeAttr(text: string) {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function embedUrl(port: number, target: { agentId: string } | { workspaceId: string }, theme: EmbedTheme): string {
  const query = new URLSearchParams({ embed: "session", theme });
  if ("agentId" in target) query.set("agent", target.agentId);
  else query.set("workspace", target.workspaceId);
  return `http://127.0.0.1:${port}/?${query}`;
}

export type ChatPage = { nonce: string; origin: string; theme: EmbedTheme };

export function chatHtml({ nonce, origin, theme }: ChatPage): string {
  const colorVars = Object.fromEntries(Object.entries(EMBED_COLORS).map(([role, { vscode }]) => [role, role === "editorBackground" ? "--vscode-sideBar-background" : vscode]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--vscode-sideBar-background); }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
  iframe[hidden] { display: none; }
  .cover { position: fixed; inset: 0; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; box-sizing: border-box; text-align: center; background: var(--vscode-sideBar-background); color: var(--vscode-sideBar-foreground, var(--vscode-foreground)); font: var(--vscode-font-size) var(--vscode-font-family); }
  .cover[hidden] { display: none; }
  .cover p { margin: 0; color: var(--vscode-descriptionForeground); }
  .cover button { padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; cursor: pointer; }
  .cover button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<div id="empty" class="cover" role="status"><p>Pick a session from the list, or start a new one.</p><button id="new-session" type="button">New Session</button></div>
<div id="offline" class="cover" hidden role="status"><div id="offline-text"></div><button id="open-app" type="button">Open Lodestar</button></div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const ORIGIN = ${JSON.stringify(origin)};
  const COLOR_VARS = ${JSON.stringify(colorVars)};
  const empty = document.getElementById("empty");
  const overlay = document.getElementById("offline");
  let theme = ${JSON.stringify(theme)};
  let online = true;
  let active = null;

  const frames = new Map();
  const toFrame = (frame, message) => frame.el.contentWindow.postMessage(message, ORIGIN);
  const readColors = () => {
    const style = getComputedStyle(document.documentElement);
    const colors = {};
    for (const [role, name] of Object.entries(COLOR_VARS)) {
      const value = style.getPropertyValue(name).trim();
      if (value) colors[role] = value;
    }
    return colors;
  };
  const sendColors = (frame, force) => {
    if (!frame.ready) return;
    const colors = readColors();
    const key = JSON.stringify(colors);
    if (!force && key === frame.sent) return;
    frame.sent = key;
    toFrame(frame, { type: "agent-nav:colors", colors });
  };
  const sendAllColors = () => frames.forEach((frame) => sendColors(frame, false));
  new MutationObserver(sendAllColors).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  new MutationObserver(sendAllColors).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const load = (frame) => {
    frame.ready = false;
    frame.stale = false;
    frame.sent = "";
    frame.el.src = frame.src;
  };
  const create = (key, src) => {
    const el = document.createElement("iframe");
    el.title = "Lodestar session";
    el.allow = "clipboard-read; clipboard-write";
    el.hidden = true;
    el.src = src;
    document.body.appendChild(el);
    frames.set(key, { el, src, ready: false, sent: "", queue: [], stale: false });
  };
  const render = (list, activeKey) => {
    const keys = new Set(list.map((item) => item.key));
    for (const [key, frame] of [...frames]) {
      if (keys.has(key)) continue;
      frame.el.remove();
      frames.delete(key);
    }
    for (const item of list) {
      const frame = frames.get(item.key);
      if (frame) frame.src = item.src;
      else create(item.key, item.src);
    }
    active = frames.has(activeKey) ? activeKey : null;
    for (const [key, frame] of frames) frame.el.hidden = key !== active;
    const current = active && frames.get(active);

    if (current && current.stale && online) load(current);
    empty.hidden = !!current;
  };
  const fromFrame = (frame, event) => {
    const data = event.data;
    if (event.origin !== ORIGIN || !data || typeof data.type !== "string" || !data.type.startsWith("agent-nav:")) return;
    if (data.type === "agent-nav:ready") {
      frame.ready = true;
      toFrame(frame, { type: "agent-nav:hello", theme });
      sendColors(frame, true);
      for (const message of frame.queue.splice(0)) toFrame(frame, message);
    }
    for (const [key, candidate] of frames) if (candidate === frame) vscode.postMessage({ kind: "embed", frame: key, message: data });
  };
  window.addEventListener("message", (event) => {
    for (const frame of frames.values()) {
      if (event.source === frame.el.contentWindow) {
        fromFrame(frame, event);
        return;
      }
    }
    const data = event.data;
    if (!data || typeof data.kind !== "string") return;
    if (data.kind === "frames") {
      render(data.frames, data.active);
    } else if (data.kind === "relay") {
      if (data.message.type === "agent-nav:theme") theme = data.message.theme;
      const targets = data.frame ? [frames.get(data.frame)].filter(Boolean) : [...frames.values()];
      for (const frame of targets) {
        if (frame.ready) toFrame(frame, data.message);
        else if (data.message.type !== "agent-nav:theme") frame.queue.push(data.message);
      }
      if (data.message.type === "agent-nav:focus" && data.frame) frames.get(data.frame)?.el.focus();
    } else if (data.kind === "daemon") {
      document.getElementById("offline-text").textContent = data.message;
      overlay.hidden = data.online;
      if (data.online && !online) {
        for (const [key, frame] of frames) {
          if (key === active) load(frame);
          else frame.stale = true;
        }
      }
      online = data.online;
    }
  });
  document.getElementById("open-app").addEventListener("click", () => vscode.postMessage({ kind: "openApp" }));
  document.getElementById("new-session").addEventListener("click", () => vscode.postMessage({ kind: "command", command: "lodestar.newSession" }));
  vscode.postMessage({ kind: "ready" });
})();
</script>
</body>
</html>`;
}

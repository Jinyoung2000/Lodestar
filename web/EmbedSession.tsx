import { createRoot } from "react-dom/client";
import { PaneView } from "./AgentView";
import { ConfirmHost } from "./ConfirmDialog";
import { hint } from "./hint";
import { HintLayer } from "./HintLayer";
import { EMBED, listenToHost, postToHost, type EmbedParams } from "./embed";
import { parsePrUrl } from "../shared/prUrl";
import { toTarget } from "./lsp";
import { MiniFrame } from "./MiniChat";
import { handleNotificationAction, type NotificationAction } from "./notifications";
import { Overlays } from "./lazyViews";
import { EffortPicker, ModelPicker } from "./ModelPopover";
import { addAttachment, getState, initStore, setState, subscribe, useStore, type Pane } from "./store";
import { initScrollbars } from "./scrollbars";
import { applyHostColors, type EmbedFromHost } from "../shared/embed";

export function startEmbed(params: EmbedParams) {
  const pane: Pane = params.agentId ? { id: "embed", kind: "agent", agentId: params.agentId } : { id: "embed", kind: "draft", workspaceId: params.workspaceId ?? "" };
  setState({ panes: [pane], activePaneId: pane.id, centerView: "sessions", sidebarOpen: false, rightOpen: false, bottomOpen: false, ...(pane.kind === "draft" || params.mini ? { focusComposer: { paneId: pane.id, nonce: Date.now() } } : {}) });
  document.documentElement.dataset.embed = "session";
  document.documentElement.dataset.theme = params.theme;
  if (params.mini) document.documentElement.dataset.mini = "1";
  initStore();
  initScrollbars();
  watchSession();
  interceptExternalLinks();
  listenToHost(onHostMessage);
  if (params.mini) startMini();
  createRoot(document.getElementById("root")!).render(<EmbedSession mini={params.mini} />);
}

function startMini() {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const applyTheme = () => {
    const theme = getState().settings?.theme;
    if (!theme) return;
    document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "light" : "dark") : theme === "black" ? "dark" : theme;
    if (theme === "black") document.documentElement.dataset.black = "true";
    else delete document.documentElement.dataset.black;
  };
  media.addEventListener("change", applyTheme);
  subscribe(applyTheme);
  window.agentNavNative?.onQuickEntryShow?.(() => {
    const pane = getState().panes[0];
    if (pane) setState({ focusComposer: { paneId: pane.id, nonce: Date.now() } });
  });
  window.addEventListener("agent-nav:notification", (event) => handleNotificationAction((event as CustomEvent<NotificationAction>).detail));
}

function EmbedSession({ mini }: { mini: boolean }) {
  if (mini) {
    return (
      <MiniFrame>
        <EmbedBody />
      </MiniFrame>
    );
  }
  return <EmbedBody />;
}

function EmbedBody() {
  const toast = useStore((s) => s.toast);
  const overlay = useStore((s) => s.overlay);
  const pane = useStore((s) => s.panes[0]);
  return (
    <div className="app">
      <div className="body">
        <div className="center-and-bottom">
          <div className="center" data-columns="one" data-pane-id={pane?.id}>
            {pane && <PaneView pane={pane} />}
          </div>
        </div>
      </div>
      <Overlays />
      <ConfirmHost />
      {overlay?.kind === "models" && <ModelPicker />}
      {overlay?.kind === "effort" && <EffortPicker />}
      <div className="toast-stack">
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
      <HintLayer />
    </div>
  );
}

function watchSession() {
  let announced: string | null = null;
  const announce = () => {
    const pane = getState().panes[0];
    if (pane?.kind !== "agent" || pane.agentId === announced) return;
    announced = pane.agentId;
    postToHost({ type: "agent-nav:session", agentId: pane.agentId });
  };
  announce();
  subscribe(announce);
}

function interceptExternalLinks() {
  document.addEventListener(
    "click",
    (event) => {
      const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
      const href = anchor?.href ?? "";
      if (!anchor || anchor.dataset.file || !/^https?:/.test(href)) return;
      event.preventDefault();
      const plain = !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
      if (EMBED?.mini && plain && event.button === 0 && parsePrUrl(href)) postToHost({ type: "agent-nav:openPr", url: href });
      else postToHost({ type: "agent-nav:openExternal", url: href });
    },
    true,
  );
}

function onHostMessage(message: EmbedFromHost) {
  if (message.type === "agent-nav:hello" || message.type === "agent-nav:theme") {
    document.documentElement.dataset.theme = message.theme;
    return;
  }
  if (message.type === "agent-nav:colors") {
    applyHostColors(document.documentElement, message.colors);
    return;
  }
  const pane = getState().panes[0];
  if (!pane) return;
  if (message.type === "agent-nav:focus") {
    setState({ focusComposer: { paneId: pane.id, nonce: Date.now() } });
    return;
  }
  const workspaceId = pane.kind === "agent" ? getState().agents.find((a) => a.id === pane.agentId)?.workspaceId : pane.workspaceId;
  if (!workspaceId || !getState().workspaces.some((w) => w.id === workspaceId)) {
    hint("Open a session in a folder to attach code.");
    return;
  }
  const target = toTarget(message.file, workspaceId);
  addAttachment(pane.id, { workspaceId: target.workspaceId, path: target.path, startLine: message.startLine, endLine: message.endLine, text: message.text });
}

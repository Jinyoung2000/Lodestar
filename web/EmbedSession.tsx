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
import { EffortPicker, ModelPicker } from "./Pickers";
import { addAttachment, getState, initStore, setState, subscribe, useStore, type Pane } from "./store";
import { initScrollbars } from "./scrollbars";
import { applyHostColors, type EmbedFromHost } from "../shared/embed";

// 세션 하나만 보이는 화면. 사이드바, 제목줄, 오른쪽 패널, 아래 패널 없이 대화 칸 하나와 입력창이 전부다.
// params.mini 면 Electron 의 미니 채팅 패널이다(electron/quickEntry.ts): 같은 화면을 둥근 카드 틀(web/MiniChat.tsx)에 넣고, 테마는 설정을, 알림 클릭은 메인이 보내는 이벤트를 따른다.
// 보내기, 중단, 큐, 승인 카드, 체크포인트, 변경 칩은 PaneView 가 그대로 그린다. 파일 열기와 변경 보기는 store 의 openFile, openDiff, openChanges 가 확장으로 넘긴다.
export function startEmbed(params: EmbedParams) {
  const pane: Pane = params.agentId ? { id: "embed", kind: "agent", agentId: params.agentId } : { id: "embed", kind: "draft", workspaceId: params.workspaceId ?? "" };
  // 새 세션 입력창과 미니 패널은 열리자마자 글을 쓸 수 있게 입력창에 포커스를 준다.
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

// 미니 패널 전용: 테마는 설정(system 이면 OS)을 따르고, 패널을 다시 열 때 입력창에 포커스를 주고, 알림을 눌러 열렸을 때(메인이 CustomEvent 를 보낸다) 그 세션 처리를 한다.
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
          {/* 칸 id 를 달아야 모델과 생각 수준 팝업이 칩을 찾는다(anchorInActivePane). 없으면 팝업이 화면 가운데에 뜬다. */}
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

// 새 세션 입력창에서 첫 메시지를 보내면 칸이 세션으로 바뀐다. 확장이 패널을 그 세션에 묶도록 알린다.
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

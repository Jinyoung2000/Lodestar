import { useEffect, useRef } from "react";
import { AgentView, PaneMenu } from "./AgentView";
import { bindVirtualPane } from "./composerState";
import { EditorChatTabs } from "./EditorChatTabs";
import { Codicon } from "./icons";
import { ensureTimeline, openChatTab, revealChat, setChatDockOpen, useStore, type Pane } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import "./focusLayout.css";
import { useCommandKey } from "./commandKeys";

export function DockFrame({ pane }: { pane: Pane }) {
  const nonce = useStore((s) => (s.focusComposer?.paneId === pane.id ? s.focusComposer.nonce : 0));
  const seen = useRef(nonce);
  useEffect(() => {
    if (nonce !== seen.current) {
      seen.current = nonce;
      revealChat();
    }
  }, [nonce]);
  return <DockBar pane={pane} />;
}

function DockBar({ pane }: { pane: Pane }) {
  const agent = useStore((s) => (pane.kind === "agent" ? s.agents.find((a) => a.id === pane.agentId) : undefined));
  const hideKey = useCommandKey("toggleFocusChat");
  return (
    <div className="dock-bar" data-dock-bar>
      <EditorChatTabs pane={pane} />
      {agent && <PaneMenu agent={agent} paneId={pane.id} />}
      {agent && (
        <Button size="icon" aria-label={S.chatOpenInTab} title={S.chatOpenInTab} onClick={() => openChatTab(agent.id)}>
          <Codicon name="go-to-file" />
        </Button>
      )}
      <Button size="icon" aria-label={S.chatDockHideKey(hideKey)} title={S.chatDockHideKey(hideKey)} onClick={() => setChatDockOpen(false)}>
        <Codicon name="layout-sidebar-right-off" />
      </Button>
    </div>
  );
}

export function ChatTabView({ tabKey, agentId, active }: { tabKey: string; agentId: string; active: boolean }) {
  const paneId = tabKey;
  useEffect(() => ensureTimeline(agentId), [agentId]);
  useEffect(() => bindVirtualPane(paneId, agentId), [paneId, agentId]);
  return (
    <div className="pane chat-tab-pane" data-pane-id={paneId} data-active hidden={!active}>
      <AgentView paneId={paneId} agentId={agentId} closable={false} embedded />
    </div>
  );
}

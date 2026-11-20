import { useEffect, useRef } from "react";
import { AgentView, PaneMenu, PaneStatus } from "./AgentView";
import { bindVirtualPane } from "./composerState";
import { FloatSessionMenu } from "./FloatingAgent";
import { Branch, Codicon } from "./icons";
import { ensureTimeline, openChatTab, revealChat, setChatDockOpen, useStore, type Pane } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import "./focusLayout.css";

export function DockFrame({ pane }: { pane: Pane }) {
  // 닫힌 채로 입력창에 글을 넣거나(⌥H 첨부, 새 세션) 포커스를 요청하는 길은 패널을 연다. 칸은 닫혀 있어도 마운트되어 있어서 닫힌 채 요청을 받는다.
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
  const title = agent?.title ?? S.newSession;
  return (
    <div className="dock-bar" data-dock-bar>
      {agent ? <PaneStatus agent={agent} /> : <Codicon name="comment" size={14} />}
      {agent?.worktree && (
        <span className="muted small mono inline-flex items-center gap-1" title={S.worktreeTitle(agent.worktree.root)}>
          <Branch size={14} /> {agent.worktree.branch}
        </span>
      )}
      <FloatSessionMenu pane={pane} title={title} />
      <span className="spacer" />
      {agent && <PaneMenu agent={agent} paneId={pane.id} />}
      {agent && (
        <Button size="icon" aria-label={S.chatOpenInTab} title={S.chatOpenInTab} onClick={() => openChatTab(agent.id)}>
          <Codicon name="go-to-file" />
        </Button>
      )}
      <Button size="icon" aria-label={S.chatDockHideKey} title={S.chatDockHideKey} onClick={() => setChatDockOpen(false)}>
        <Codicon name="layout-sidebar-right-off" />
      </Button>
    </div>
  );
}

// 세션 대화를 에디터 탭으로 연 화면(store 의 openChatTab). 칸 목록에 없는 대화라 Notion 페이지 대화처럼 칸 머리 없이 대화와 입력창만 넣는다.
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

import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Agent } from "../shared/protocol";
import { PaneStatus } from "./AgentView";
import { attachSession } from "./attachments";
import { chatPaneWorkspace, chatPanelId, chatProject, chatTabId } from "./editorChat";
import { floatSessionChoices } from "./floatLayout";
import { Close, Codicon, LinkIcon, Plus } from "./icons";
import { RenameInput } from "./RenameInput";
import { useSessionList } from "./sessionListState";
import { closeFocusedPane, focusPane, moveChatTab, openEditorChatSession, setChatTabSticky, setState, startEditorChatDraft, useStore, type Pane } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

type ChatTab = { pane: Pane; agent: Agent | undefined; title: string };
type ChatTabDrag = { paneId: string; mark: { x: number; top: number; height: number } | null };
type ChatTabMenu = { paneId: string; x: number; y: number };

const DRAG_THRESHOLD = 4;

export function EditorChatTabs({ pane }: { pane: Pane }) {
  const panes = useStore((s) => s.panes);
  const agents = useStore((s) => s.agents);
  const workspaces = useStore((s) => s.workspaces);
  const recentIds = useStore((s) => s.recentAgentIds);
  const workspaceId = chatPaneWorkspace(pane, agents);
  const projectId = chatProject(workspaceId, workspaces);
  const project = workspaces.find((workspace) => workspace.id === projectId);
  const tabs = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const list = panes.flatMap((item): ChatTab[] => {
      const agent = item.kind === "agent" ? byId.get(item.agentId) : undefined;
      if (item.kind === "agent" && !agent && item.id !== pane.id) return [];
      const id = item.kind === "draft" ? item.workspaceId || null : agent?.workspaceId ?? null;
      if (chatProject(id, workspaces) !== projectId) return [];
      return [{ pane: item, agent, title: agent?.title ?? S.newSession }];
    });
    return [...list.filter((tab) => tab.pane.sticky), ...list.filter((tab) => !tab.pane.sticky)];
  }, [panes, agents, workspaces, projectId, pane.id]);
  const choices = useMemo(() => {
    const openIds = new Set(tabs.map((tab) => tab.agent?.id));
    const feedbackIds = new Set(workspaces.filter((workspace) => workspace.feedback).map((workspace) => workspace.id));
    const eligible = agents.filter((agent) => !openIds.has(agent.id) && chatProject(agent.workspaceId, workspaces) === projectId);
    const byId = new Map(eligible.map((agent) => [agent.id, agent]));
    const candidates = eligible.map((agent) => ({
      id: agent.id,
      title: agent.title,
      workspaceId: agent.workspaceId,
      done: !!agent.done,
      feedback: !!agent.feedbackId || (agent.workspaceId !== null && feedbackIds.has(agent.workspaceId)),
      updatedAt: Date.parse(agent.updatedAt) || 0,
    }));
    return floatSessionChoices(candidates, recentIds, null, projectId, (id) => chatProject(id, workspaces)).flatMap(({ id }) => byId.get(id) ?? []);
  }, [agents, recentIds, tabs, workspaces, projectId]);
  const references = tabs.flatMap((tab) => tab.pane.id !== pane.id && tab.agent ? [tab.agent] : []);
  const activeIndex = tabs.findIndex((tab) => tab.pane.id === pane.id);
  const canClose = (target: Pane) => tabs.length > 1 || target.kind !== "draft";
  const stripRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<ChatTabDrag | null>(null);
  const [menu, setMenu] = useState<ChatTabMenu | null>(null);
  const menuTab = menu ? tabs.find((tab) => tab.pane.id === menu.paneId) : undefined;

  function startDrag(event: ReactPointerEvent, paneId: string) {
    const dragged = tabs.find((tab) => tab.pane.id === paneId);
    if (event.button !== 0 || !dragged || tabs.length < 2) return;
    const peers = tabs.filter((tab) => !!tab.pane.sticky === !!dragged.pane.sticky);
    const startX = event.clientX;
    let moved = false;
    let beforeId: string | null = null;
    const boxOf = (id: string) => document.getElementById(chatTabId(id))?.closest(".editor-chat-tab")?.getBoundingClientRect();
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
      moved = true;
      const strip = stripRef.current?.getBoundingClientRect();
      if (!strip) return;
      const boxes = peers.flatMap((tab) => {
        const box = boxOf(tab.pane.id);
        return box ? [{ id: tab.pane.id, box }] : [];
      });
      const target = boxes.find(({ box }) => e.clientX < box.left + box.width / 2);
      const last = boxes[boxes.length - 1];
      beforeId = target?.id ?? null;
      const x = target ? target.box.left : last ? last.box.right : strip.left;
      setDrag({ paneId, mark: { x: Math.min(Math.max(x, strip.left), strip.right - 1), top: strip.top, height: strip.height } });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      setDrag(null);
      if (!moved) return;
      suppressClick.current = true;
      requestAnimationFrame(() => (suppressClick.current = false));
      if (commit) moveChatTab(paneId, beforeId);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !moved) return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }

  function selectTab(paneId: string) {
    if (suppressClick.current) return;
    focusPane(paneId);
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const index = step ? (activeIndex + step + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (index !== null && tabs[index]) {
      event.preventDefault();
      event.stopPropagation();
      focusPane(tabs[index].pane.id, false);
      requestAnimationFrame(() => document.getElementById(chatTabId(tabs[index].pane.id))?.focus());
    } else if (event.key === "Delete" && canClose(pane)) {
      event.preventDefault();
      event.stopPropagation();
      const next = tabs[activeIndex + 1] ?? tabs[activeIndex - 1];
      closeFocusedPane(pane.id);
      if (next) requestAnimationFrame(() => document.getElementById(chatTabId(next.pane.id))?.focus());
    }
  }

  return (
    <div className="editor-chat-switcher">
      <div className="editor-chat-tabs" ref={stripRef} role="tablist" aria-label={S.chatSessionTabs} onKeyDown={onTabKey}>
        {tabs.map((tab) => (
          <EditorChatTab
            key={tab.pane.id}
            tab={tab}
            active={tab.pane.id === pane.id}
            closable={canClose(tab.pane)}
            dragging={drag?.paneId === tab.pane.id && !!drag.mark}
            onSelect={() => selectTab(tab.pane.id)}
            onDragStart={(event) => startDrag(event, tab.pane.id)}
            onMenu={(x, y) => setMenu({ paneId: tab.pane.id, x, y })}
          />
        ))}
      </div>
      {drag?.mark && <div className="tab-drop-mark" style={{ left: drag.mark.x, top: drag.mark.top, height: drag.mark.height }} />}
      {menu && menuTab && (
        <DropdownMenu open onOpenChange={(open) => !open && setMenu(null)}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="menu-anchor" style={{ left: menu.x, top: menu.y }} tabIndex={-1} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => setChatTabSticky(menuTab.pane.id, !menuTab.pane.sticky)}>
              {menuTab.pane.sticky ? S.unpinTab : S.pinTab}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canClose(menuTab.pane)} onSelect={() => closeFocusedPane(menuTab.pane.id)}>
              {S.close}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" aria-label={S.chatAddTab} title={S.chatAddTab}>
            <Plus />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="float-session-menu">
          <DropdownMenuItem onSelect={() => startEditorChatDraft()}>
            <Plus />
            <span>{S.newSession}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>{project?.name ?? S.groupChats}</DropdownMenuItem>
          {choices.map((agent) => (
            <DropdownMenuItem key={agent.id} textValue={agent.title} onSelect={() => openEditorChatSession(agent.id)}>
              <PaneStatus agent={agent} />
              <span className="float-menu-title" title={agent.title}>{agent.title}</span>
            </DropdownMenuItem>
          ))}
          {choices.length === 0 && <DropdownMenuItem disabled>{S.chatNoOtherProjectSessions}</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setState({ overlay: { kind: "sessions" } })}>
            <Codicon name="search" />
            <span>{S.chatSearchAllSessions}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {references.length > 0 && <ReferenceSessionMenu agents={references} paneId={pane.id} workspaceId={workspaceId} />}
    </div>
  );
}

type EditorChatTabProps = {
  tab: ChatTab;
  active: boolean;
  closable: boolean;
  dragging: boolean;
  onSelect: () => void;
  onDragStart: (event: ReactPointerEvent) => void;
  onMenu: (x: number, y: number) => void;
};

function EditorChatTab({ tab, active, closable, dragging, onSelect, onDragStart, onMenu }: EditorChatTabProps) {
  const renaming = useSessionList((s) => active && tab.agent !== undefined && s.renaming === tab.agent.id);
  const reveal = useCallback((button: HTMLButtonElement | null) => {
    if (active) button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div
      className="tab editor-chat-tab"
      data-active={active || undefined}
      data-sticky={tab.pane.sticky || undefined}
      data-dragging={dragging || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
    >
      {renaming && tab.agent ? (
        <RenameInput agent={tab.agent} />
      ) : (
        <button
          type="button"
          className="tab-label editor-chat-tab-label"
          ref={reveal}
          role="tab"
          id={chatTabId(tab.pane.id)}
          aria-controls={chatPanelId(tab.pane.id)}
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          title={tab.agent?.worktree ? `${tab.title} (${tab.agent.worktree.branch})` : tab.title}
          onClick={onSelect}
          onPointerDown={onDragStart}
        >
          {tab.agent ? <PaneStatus agent={tab.agent} /> : <Codicon name="comment" size={14} />}
          <span className="editor-chat-tab-title">{tab.title}</span>
        </button>
      )}
      {tab.pane.sticky ? (
        <Button size="icon" className="editor-chat-tab-close tab-pin" aria-label={S.unpinTab} title={S.unpinTab} tabIndex={active ? 0 : -1} onClick={() => setChatTabSticky(tab.pane.id, false)}>
          <Codicon name="pinned" />
        </Button>
      ) : closable && (
        <Button size="icon" className="editor-chat-tab-close" aria-label={S.chatCloseTab(tab.title)} title={S.closePaneKeep} tabIndex={active ? 0 : -1} onClick={() => closeFocusedPane(tab.pane.id)}>
          <Close />
        </Button>
      )}
    </div>
  );
}

function ReferenceSessionMenu({ agents, paneId, workspaceId }: { agents: Agent[]; paneId: string; workspaceId: string | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" aria-label={S.chatReferenceSession} title={S.chatReferenceSession}>
          <LinkIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="float-session-menu editor-chat-reference-menu">
        {agents.map((agent) => (
          <DropdownMenuItem key={agent.id} textValue={agent.title} onSelect={() => void attachSession(paneId, workspaceId, agent)}>
            <PaneStatus agent={agent} />
            <span className="float-menu-title" title={agent.title}>{agent.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

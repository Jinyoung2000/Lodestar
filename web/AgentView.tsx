import { AssistantActions, AssistantStatus } from "./AssistantBar";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { harnessOf, type Agent, type Harness, type FileRef as ProtocolFileRef, type ImageRef, type PermissionMode } from "../shared/protocol";
import { checkpointLocked, isSwitchDivider } from "../shared/harnessSwitch";
import { TimelineContext, useCheckpointModes } from "./Checkpoint";
import { ChatFind } from "./ChatFind";
import { useChatFindOpen } from "./chatFindState";
import { Composer } from "./Composer";
import { ImportedNotice } from "./ImportedBadges";
import { chatWorkspaceFor, openFileRef, type FileRef } from "./fileRefs";
import { DockFrame } from "./ChatDock";
import { chatPanelId, chatTabId } from "./editorChat";
import { FloatFrame, isDockedPane, isFloatingPane, useFloatStyle } from "./FloatingAgent";
import { canHandOff, startHandoff } from "./handoffActions";
import { BoardIcon, Branch, ChevronDown, CircleFilled, CircleSmallFilled, Close, Codicon, DotSpinner, More, ProviderIcon } from "./icons";
import { NewAgentView } from "./NewSession";
import { QueuedMessages } from "./Queue";
import { rpc } from "./rpc";
import { copySessionLink, setDone, setPinned } from "./sessionActions";
import { startRename } from "./sessionListState";
import { ApprovalCard, PendingNotice, ThinkingIndicator, TurnView, reuseTurns, splitTurns } from "./Timeline";
import { turnGrouper } from "./timelineModel";
import type { Turn } from "./timelineModel";
import { TimelineMenus } from "./TimelineMenus";
import { followsBottom } from "./timelineScroll";
import { scrollToItem } from "./messageScroll";
import { MESSAGE_TARGET_TTL_MS, useMessageTarget } from "./toBoardState";
import { hint } from "./hint";
import { approvalFileTarget } from "./editApprovalFile";
import { closeFocusedPane, closePane, ensureTimeline, fileTabKey, flash, getState, openCard, openFile, rememberPick, setState, useStore, type Pane } from "./store";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { S } from "./strings";
import type { PermissionItem } from "./timelineModel";
import { applyChatAnchor, holdChatAnchor, readChatAnchor } from "./chatAnchor";
import { noteWindowChanged, registerChatReader, takeChatRestore, type ChatScroll } from "./windowState";
import { registerReveal } from "./timelineReveal";
import { retainTimeline } from "./timelineCache";
import { beginSessionDrag } from "./sessionDrag";

export function PaneView({ pane }: { pane: Pane }) {
  const active = useStore((s) => s.activePaneId === pane.id);
  const multiple = useStore((s) => s.panes.length > 1);
  const floating = useStore((s) => isFloatingPane(s, pane.id));
  const docked = useStore((s) => isDockedPane(s, pane.id));
  const collapsed = useStore((s) => s.floatCollapsed);
  const floatStyle = useFloatStyle(floating);
  const closable = multiple && !floating && !docked;
  const tabPanel = docked || (floating && !collapsed);
  return (
    <div
      className="pane"
      data-active={active || undefined}
      data-floating={floating || undefined}
      data-docked={docked || undefined}
      data-collapsed={(floating && collapsed) || undefined}
      style={floatStyle}
      role={floating || docked ? "group" : undefined}
      aria-label={floating ? S.floatAria : docked ? S.chatDockAria : undefined}
      onMouseDownCapture={() => {
        if (!active) setState({ activePaneId: pane.id });
      }}
    >
      {floating && <FloatFrame pane={pane} />}
      {docked && <DockFrame pane={pane} />}
      <div className="pane-body" id={chatPanelId(pane.id)} role={tabPanel ? "tabpanel" : undefined} aria-labelledby={tabPanel ? chatTabId(pane.id) : undefined}>
        {pane.kind === "agent" ? (
          <AgentView key={pane.agentId} paneId={pane.id} agentId={pane.agentId} closable={closable} />
        ) : (
          <NewAgentView key={`${pane.workspaceId}:${pane.seed?.nonce ?? 0}:${pane.handoff?.agentId ?? ""}`} paneId={pane.id} workspaceId={pane.workspaceId} extraWorkspaceIds={pane.extraWorkspaceIds} seed={pane.seed} handoff={pane.handoff} closable={closable} />
        )}
      </div>
    </div>
  );
}

export function AgentView({ paneId, agentId, closable, embedded = false }: { paneId: string; agentId: string; closable: boolean; embedded?: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const items = useStore((s) => s.timelines[agentId]);
  const board = useStore((s) => s.board);
  const cards = useMemo(() => board?.cards.filter((c) => c.agentIds.includes(agentId) && c.title.trim() !== agent?.title.trim()).sort((a, b) => Number(a.source?.agentId === agentId) - Number(b.source?.agentId === agentId)), [board, agentId, agent?.title]);
  const multiPane = useStore((s) => s.panes.length > 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const lastScrollHeight = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const replying = agent?.status === "running" || agent?.status === "waiting";
  const [wasReplying, setWasReplying] = useState(replying);
  const [finishedAway, setFinishedAway] = useState(false);
  if (replying !== wasReplying) {
    setWasReplying(replying);
    setFinishedAway(!replying && !atBottom);
  }
  const unpinFromBottom = () => {
    stickToBottom.current = false;
    setAtBottom(false);
  };
  const findOpen = useChatFindOpen(paneId);
  const [revealed, setRevealed] = useState(false);
  const revealAll = revealed || findOpen;
  useEffect(() => registerReveal(paneId, () => setRevealed(true)), [paneId]);
  useEffect(() => {
    ensureTimeline(agentId);
    return retainTimeline(agentId);
  }, [agentId]);

  const queuedCount = (agent?.queue?.length ?? 0) + (agent?.steering?.length ?? 0);
  const restoreRef = useRef<ChatScroll | null | undefined>(undefined);
  const lastScroll = useRef<ChatScroll | null>(null);
  if (restoreRef.current === undefined) {
    restoreRef.current = takeChatRestore(agentId);
    lastScroll.current = restoreRef.current;
  }
  useEffect(
    () =>
      registerChatReader(agentId, () => {
        const el = scrollRef.current;
        if (el && el.clientHeight > 0 && restoreRef.current === null) lastScroll.current = { top: el.scrollTop, atBottom: stickToBottom.current, anchor: readChatAnchor(el) ?? undefined };
        return lastScroll.current;
      }),
    [agentId],
  );
  const stopHold = useRef<(() => void) | null>(null);
  useEffect(() => () => stopHold.current?.(), []);
  const messageTarget = useMessageTarget();
  const handledTarget = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!messageTarget || messageTarget.agentId !== agentId || handledTarget.current === messageTarget.nonce || !el || !items?.length) return;
    if (Date.now() - messageTarget.at > MESSAGE_TARGET_TTL_MS) {
      handledTarget.current = messageTarget.nonce;
      return;
    }
    stopHold.current?.();
    if (scrollToItem(el, messageTarget.itemId)) {
      handledTarget.current = messageTarget.nonce;
      stickToBottom.current = false;
      setAtBottom(false);
    } else if (!revealAll) {
      setRevealed(true);
    } else {
      handledTarget.current = messageTarget.nonce;
      hint(S.cardMessageGone, el);
    }
  }, [messageTarget, agentId, items, revealAll]);
  const hasItems = !!items?.length;
  const hasAgentNow = !!agent;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const restore = restoreRef.current;
    if (el && restore && hasItems) {
      restoreRef.current = null;
      if (!restore.atBottom) {
        stickToBottom.current = false;
        if (!restore.anchor || !applyChatAnchor(el, restore.anchor)) el.scrollTop = restore.top;
        if (restore.anchor) stopHold.current = holdChatAnchor(el, restore.anchor);
        setAtBottom(false);
        return;
      }
    }
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, queuedCount, hasItems, hasAgentNow]);

  const lastHeight = useRef(0);
  const hasAgent = !!agent;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastHeight.current = el.clientHeight;
    const observer = new ResizeObserver(() => {
      lastHeight.current = el.clientHeight;
      noteWindowChanged();
      if (!stickToBottom.current) return;
      el.scrollTop = el.scrollHeight;
      setAtBottom(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasAgent]);

  const lastTurns = useRef<Turn[]>([]);
  const grouper = useMemo(() => turnGrouper(), [agentId]);
  const turns = useMemo(() => {
    lastTurns.current = reuseTurns(lastTurns.current, splitTurns(items ? grouper(items) : []));
    return lastTurns.current;
  }, [items, grouper]);
  const harness = agent ? harnessOf(agent) : "claude";
  const codex = harness !== "claude";
  const lockedKey = useMemo(() => (items?.some(isSwitchDivider) ? [...checkpointLocked(items, harness)].join("\n") : ""), [items, harness]);
  const locked = useMemo(() => new Set(lockedKey ? lockedKey.split("\n") : []), [lockedKey]);
  const checkpointModes = useCheckpointModes(agentId, codex ? undefined : items, agent?.status === "running" || agent?.status === "waiting");
  const workspaceId = agent?.workspaceId ?? null;
  const improvement = !!agent?.feedbackId;
  const context = useMemo(() => ({ agentId, paneId, busy: agent?.status === "running" || agent?.status === "waiting", modes: checkpointModes, revealAll, codex, locked, workspaceId, improvement }), [agentId, paneId, agent?.status, checkpointModes, revealAll, codex, locked, workspaceId, improvement]);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stopHold.current?.();
    stickToBottom.current = true;
    setAtBottom(true);
    setFinishedAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, []);
  const onPermissionMode = useCallback(
    (mode: PermissionMode) => {
      void rpc.call("agents.setPermissionMode", { agentId, mode }).then(
        () => rememberPick({ permissionMode: mode }),
        (error: Error) => flash(error.message),
      );
    },
    [agentId],
  );
  const onSubmit = useCallback(
    (prompt: string, { steer, images, files }: { steer: boolean; images?: ImageRef[]; files?: ProtocolFileRef[] }) => {
      jumpToBottom();
      return rpc.call("agents.send", { agentId, prompt, steer, ...(images?.length ? { images } : {}), ...(files?.length ? { files } : {}) });
    },
    [agentId, jumpToBottom],
  );
  const firstPending = items?.find((i): i is PermissionItem => i.kind === "permission" && i.status === "pending");
  const editTarget = approvalFileTarget(firstPending, agent?.workspaceId ?? null);
  const editTabKey = editTarget ? fileTabKey(editTarget.workspaceId, editTarget.path) : null;
  const approvalOnRight = useStore((s) => editTabKey !== null && s.layoutMode !== "editor" && s.rightOpen && s.activeTabKey === editTabKey);
  const editApprovalId = editTarget ? firstPending?.id : undefined;
  useEffect(() => {
    if (embedded || !editTarget || getState().activePaneId !== paneId) return;
    openFile(editTarget, { preview: true, preserveFocus: true });
  }, [editApprovalId]);
  const approval = useMemo(() => firstPending && !approvalOnRight && <ApprovalCard key={firstPending.id} agentId={agentId} item={firstPending} />, [firstPending, agentId, approvalOnRight]);

  if (!agent) return null;
  const busy = agent.status === "running" || agent.status === "waiting";
  const pendingPermissions = (items ?? []).filter((i): i is PermissionItem => i.kind === "permission" && i.status === "pending");
  const lastItem = items?.at(-1);
  const waitingForModel = agent.status === "running" && lastItem?.kind !== "result" && !pendingPermissions.length && !(lastItem?.kind === "assistant" && lastItem.streaming) && !items?.some((i) => i.kind === "tool" && i.status === "running");
  const firstTurnWithUser = turns.findIndex((t) => t.user);

  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest<HTMLElement>("[data-file]");
    if (!anchor) return;
    event.preventDefault();
    if (anchor.dataset.remote) {
      window.open(anchor.dataset.remote, "_blank", "noopener");
      if (anchor.dataset.remoteRepo) void rpc.call("repos.mirrorDir", { repo: anchor.dataset.remoteRepo, request: true }).catch(() => undefined);
      return;
    }
    const ref = JSON.parse(anchor.dataset.file!) as FileRef & { search?: string };
    const workspaceId = agent.workspaceId ?? chatWorkspaceFor(agentId, ref);
    if (workspaceId) void openFileRef(workspaceId, ref, ref.search ? { search: ref.search } : {}, event.altKey);
    else if (agent.workspaceId === null) void rpc.call("agents.openChatFile", { agentId, path: ref.raw }).catch((error: Error) => flash(error.message));
  };

  return (
    <section className="agent" aria-label={S.sessionAria(agent.title)}>
      {!embedded && <div
        className="pane-header"
        data-assistant={agent.assistant || undefined}
        onPointerDown={
          closable
            ? (e) => {
                if ((e.target as HTMLElement).closest("button, a, input")) return;
                beginSessionDrag(e, agentId, agent.title, null);
              }
            : undefined
        }
      >
        <PaneStatus agent={agent} />
        {agent.worktree && multiPane && (
          <span className="muted small mono inline-flex items-center gap-1" title={S.worktreeTitle(agent.worktree.root)}>
            <Branch size={14} /> {agent.worktree.branch}
          </span>
        )}
        {codex && <HarnessBadge harness={harness} />}
        <span className="agent-title" title={agent.title}>
          {agent.title}
        </span>
        {agent.assistant && <AssistantStatus />}
        {agent.backgroundTasks > 0 && <span className="faint xs">{S.backgroundTasks(agent.backgroundTasks)}</span>}
        {cards && cards.length > 0 && (
          <button type="button" className="chip card-chip" title={S.linkedCard(cards[0].title)} onClick={() => openCard(cards[0].id)}>
            <BoardIcon size={14} />
            <span className="chip-main">{cards[0].title}</span>
            {cards.length > 1 && <span className="faint">+{cards.length - 1}</span>}
          </button>
        )}
        <span className="spacer" />
        {agent.assistant && <AssistantActions agent={agent} />}
        {closable && (
          <Button size="icon" aria-label={S.closePane} title={S.closePaneKeep} onClick={() => closePane(paneId)}>
            <Close />
          </Button>
        )}
        <PaneMenu agent={agent} paneId={paneId} />
      </div>}
      <TimelineContext.Provider value={context}>
        <div className="timeline-wrap">
          <div
            className="timeline"
            ref={scrollRef}
            tabIndex={-1}
            onClick={onClick}
            onWheel={(e) => {
              if (e.deltaY < 0) unpinFromBottom();
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              const resized = el.clientHeight !== lastHeight.current;
              lastHeight.current = el.clientHeight;
              const movedUp = el.scrollTop < lastScrollTop.current && el.scrollHeight >= lastScrollHeight.current;
              lastScrollTop.current = el.scrollTop;
              lastScrollHeight.current = el.scrollHeight;
              const follow = followsBottom(stickToBottom.current, el.scrollHeight - el.scrollTop - el.clientHeight, resized, movedUp);
              stickToBottom.current = follow;
              setAtBottom(follow);
              if (follow) setFinishedAway(false);
              noteWindowChanged();
            }}
          >
            {turns.map((turn, index) => (
              <TurnView key={turn.key} turn={turn} first={index === firstTurnWithUser} last={index === turns.length - 1} live={busy && index === turns.length - 1} />
            ))}
            {pendingPermissions.length > 0 && <PendingNotice count={pendingPermissions.length} />}
            {waitingForModel && <ThinkingIndicator />}
            <QueuedMessages agent={agent} paneId={paneId} />
          </div>
          {findOpen && <ChatFind paneId={paneId} scrollRef={scrollRef} />}
          {!atBottom && (
            <button
              type="button"
              className="scroll-bottom"
              data-finished={finishedAway || undefined}
              aria-label={finishedAway ? S.replyFinishedBelow : S.scrollToBottom}
              title={S.scrollToBottom}
              onClick={jumpToBottom}
            >
              {finishedAway && <span className="scroll-bottom-label">{S.replyFinished}</span>}
              <ChevronDown />
            </button>
          )}
          <TimelineMenus containerRef={scrollRef} agent={agent} paneId={paneId} />
        </div>
      </TimelineContext.Provider>
      {agent.imported && <ImportedNotice agent={agent} />}
      <Composer
        paneId={paneId}
        agent={agent}
        workspaceId={agent.workspaceId}
        busy={busy}
        permissionMode={agent.permissionMode}
        onPermissionMode={onPermissionMode}
        model={agent.model}
        activeModel={agent.activeModel}
        effort={agent.effort}
        onSubmit={onSubmit}
        approval={approval}
      />
    </section>
  );
}

export function HarnessBadge({ harness = "codex" }: { harness?: Harness }) {
  return (
    <span className="harness-badge" data-harness={harness} title={S.harnessSessionTip(S.harnessNames[harness])} aria-label={S.harnessNames[harness]}>
      <ProviderIcon harness={harness} size={14} />
    </span>
  );
}

export const PaneStatus = memo(function PaneStatus({ agent }: { agent: Agent }) {
  const label = S.status[agent.status];
  if (agent.status === "running" || agent.status === "waiting") {
    return (
      <span className="pane-status" title={label}>
        <DotSpinner state={agent.status} />
      </span>
    );
  }
  const kind = agent.status === "error" ? "error" : agent.unread ? "unread" : "read";
  return (
    <span className="pane-status" title={label}>
      <span className="session-dot" data-kind={kind}>
        {kind === "error" && <Codicon name="error" />}
        {kind === "read" && <CircleSmallFilled />}
        {kind === "unread" && <CircleFilled />}
      </span>
    </span>
  );
});

export const PaneMenu = memo(function PaneMenu({ agent, paneId }: { agent: Agent; paneId: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="icon-button" aria-label={S.paneMenuAria} title={S.paneMenuAria}>
          <More />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="session-menu" data-menu="row">
        <DropdownMenuItem
          onSelect={() => {
            if (getState().layoutMode !== "editor") setState({ sidebarOpen: true });
            startRename(agent.id);
          }}
        >
          <span>{S.rename}</span>
          <span className="faint xs menu-hint">F2</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDone(agent, !agent.done)}>
          <span>{agent.done ? S.markNotDone : S.markDone}</span>
          <span className="faint xs menu-hint">⌘⌫</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPinned(agent, !agent.pinned)}>
          <span>{agent.pinned ? S.unpin : S.pin}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copySessionLink(agent)}>
          <span>{S.copyLink}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canHandOff(agent)} onSelect={() => startHandoff(agent.id)}>
          <span>{S.handoffMenu}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => closeFocusedPane(paneId)}>
          <span>{S.closeChat}</span>
          <span className="faint xs menu-hint">⌘W</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

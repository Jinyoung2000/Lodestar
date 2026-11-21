import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { harnessOf, type Agent, type FileRef as ProtocolFileRef, type ImageRef, type PermissionMode } from "../shared/protocol";
import { checkpointLocked, isSwitchDivider } from "../shared/harnessSwitch";
import { TimelineContext, useCheckpointModes } from "./Checkpoint";
import { ChatFind } from "./ChatFind";
import { useChatFindOpen } from "./chatFindState";
import { Composer } from "./Composer";
import { ImportedNotice } from "./ImportedBadges";
import { chatWorkspaceFor, openFileRef, type FileRef } from "./fileRefs";
import { DockFrame } from "./ChatDock";
import { FloatFrame, isDockedPane, isFloatingPane, useFloatStyle } from "./FloatingAgent";
import { canHandOff, startHandoff } from "./handoffActions";
import { BoardIcon, Branch, ChevronDown, CircleFilled, CircleSmallFilled, Close, Codicon, DotSpinner, More } from "./icons";
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

// 격자의 칸 하나. 세션이 있으면 대화, 없으면 새 세션 입력.
export function PaneView({ pane }: { pane: Pane }) {
  const active = useStore((s) => s.activePaneId === pane.id);
  const multiple = useStore((s) => s.panes.length > 1);
  // Editor 배치에서는 활성 칸이 오른쪽 아래 떠 있는 창(Floating)이나 오른쪽 대화 패널(Docked)이 된다(같은 칸, 같은 컴포넌트). 창과 패널의 머리가 칸 머리를 대신하므로 칸 닫기는 숨긴다.
  const floating = useStore((s) => isFloatingPane(s, pane.id));
  const docked = useStore((s) => isDockedPane(s, pane.id));
  const collapsed = useStore((s) => s.floatCollapsed);
  const floatStyle = useFloatStyle(floating);
  const closable = multiple && !floating && !docked;
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
      {pane.kind === "agent" ? (
        <AgentView key={pane.agentId} paneId={pane.id} agentId={pane.agentId} closable={closable} />
      ) : (
        <NewAgentView key={`${pane.workspaceId}:${pane.seed?.nonce ?? 0}:${pane.handoff?.agentId ?? ""}`} paneId={pane.id} workspaceId={pane.workspaceId} seed={pane.seed} handoff={pane.handoff} closable={closable} />
      )}
    </div>
  );
}

// embedded: 다른 화면(Notion 페이지 전용 대화)이 칸 머리 없이 대화와 입력창만 넣어 쓴다.
export function AgentView({ paneId, agentId, closable, embedded = false }: { paneId: string; agentId: string; closable: boolean; embedded?: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const items = useStore((s) => s.timelines[agentId]);
  const board = useStore((s) => s.board);
  // 머리의 카드 칩은 세션 자체의 카드를 앞에 둔다. 이 대화에서 따로 담은 카드(TOBOARD)는 뒤로 가서 "+N" 에 든다.
  // 제목이 세션 제목과 같은 카드는 머리에 같은 글이 두 번 뜨므로 칩을 달지 않는다.
  const cards = useMemo(() => board?.cards.filter((c) => c.agentIds.includes(agentId) && c.title.trim() !== agent?.title.trim()).sort((a, b) => Number(a.source?.agentId === agentId) - Number(b.source?.agentId === agentId)), [board, agentId, agent?.title]);
  const multiPane = useStore((s) => s.panes.length > 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const findOpen = useChatFindOpen(paneId);
  // 접힌 단계 묶음은 열기 전에는 안쪽 줄이 없다. 찾기가 열렸거나 아래 이동 요청이 있으면 모두 만든다.
  const [revealed, setRevealed] = useState(false);
  const revealAll = revealed || findOpen;
  useEffect(() => registerReveal(paneId, () => setRevealed(true)), [paneId]);
  // 이 화면이 붙어 있는 동안 타임라인을 메모리에 둔다. 떨어진 뒤에는 최근 몇 개만 남는다.
  useEffect(() => {
    ensureTimeline(agentId);
    return retainTimeline(agentId);
  }, [agentId]);

  const queuedCount = (agent?.queue?.length ?? 0) + (agent?.steering?.length ?? 0);
  // 앱을 다시 켰을 때 저장해 둔 스크롤 위치(web/windowState.ts). 바닥에 있던 대화는 복원하지 않고 늘 하던 대로 바닥을 따라간다.
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
  // 카드의 "Go to Message" (web/toBoardState.ts showMessage). 타임라인이 아직 안 왔으면 items 가 올 때 다시 시도한다.
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
      // 접힌 단계 묶음 안의 항목일 수 있다. 묶음을 모두 만든 뒤 이 효과가 다시 돌아 찾는다.
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
        // 기준 메시지가 있으면 그 자리로, 없으면(옛 저장본, 사라진 메시지) 픽셀 값으로. 내용 높이가 나중에 정해져도 같은 메시지에 머물도록 한동안 다시 맞춘다.
        if (!restore.anchor || !applyChatAnchor(el, restore.anchor)) el.scrollTop = restore.top;
        if (restore.anchor) stopHold.current = holdChatAnchor(el, restore.anchor);
        setAtBottom(false);
        return;
      }
    }
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, queuedCount, hasItems, hasAgentNow]);

  // 터미널을 열거나 창과 입력창 크기가 바뀌어 대화 영역 높이가 달라져도, 바닥에 붙어 있던 대화는 바닥에 붙은 채로 둔다(dogfood 18).
  // 높이가 줄면 스크롤 이벤트 없이 바닥과의 거리만 커지므로 크기 변화를 따로 본다.
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

  // 항목이 안 바뀐 턴은 이전 객체를 그대로 써서 TurnView 의 memo 가 건너뛴다.
  // 묶기도 턴마다 지난 결과를 다시 써서, 응답이 흐를 때 마지막 턴만 다시 묶는다(web/timelineModel.ts turnGrouper). 칸이 다른 세션으로 바뀌면 새로 만든다.
  const lastTurns = useRef<Turn[]>([]);
  const grouper = useMemo(() => turnGrouper(), [agentId]);
  const turns = useMemo(() => {
    lastTurns.current = reuseTurns(lastTurns.current, splitTurns(items ? grouper(items) : []));
    return lastTurns.current;
  }, [items, grouper]);
  const codex = agent ? harnessOf(agent) === "codex" : false;
  const lockedKey = useMemo(() => (items?.some(isSwitchDivider) ? [...checkpointLocked(items, codex ? "codex" : "claude")].join("\n") : ""), [items, codex]);
  const locked = useMemo(() => new Set(lockedKey ? lockedKey.split("\n") : []), [lockedKey]);
  const checkpointModes = useCheckpointModes(agentId, codex ? undefined : items, agent?.status === "running" || agent?.status === "waiting");
  const workspaceId = agent?.workspaceId ?? null;
  const improvement = !!agent?.feedbackId;
  const context = useMemo(() => ({ agentId, paneId, busy: agent?.status === "running" || agent?.status === "waiting", modes: checkpointModes, revealAll, codex, locked, workspaceId, improvement }), [agentId, paneId, agent?.status, checkpointModes, revealAll, codex, locked, workspaceId, improvement]);

  // 바닥으로 내리고 이후 새 글도 따라간다. 아래 화살표 버튼과 메시지 보내기가 같이 쓴다(위로 올려 읽던 중에 보내도 보낸 글과 답이 보이게).
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stopHold.current?.();
    stickToBottom.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, []);
  // 입력창(Composer)은 응답이 흐르는 동안 다시 그릴 일이 없다. 넘기는 콜백과 승인 카드를 고정해 memo 가 이벤트마다 건너뛰게 한다(PERF2).
  const onPermissionMode = useCallback(
    (mode: PermissionMode) => {
      // 프로세스가 그 모드를 거절하면(폴더 설정이 막은 모드 등) 칩은 그대로 두고 이유를 알린다. 마지막으로 고른 값은 적용된 뒤에만 기억한다.
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
  // 편집 승인은 그 파일을 오른쪽 패널에 열어 거기서 답한다(web/EditorApproval.tsx). 파일 탭이 보이는 동안 입력창 위 카드는 감춘다.
  const editTarget = approvalFileTarget(firstPending, agent?.workspaceId ?? null);
  const editTabKey = editTarget ? fileTabKey(editTarget.workspaceId, editTarget.path) : null;
  const approvalOnRight = useStore((s) => editTabKey !== null && s.layoutMode !== "editor" && s.rightOpen && s.activeTabKey === editTabKey);
  const editApprovalId = editTarget ? firstPending?.id : undefined;
  useEffect(() => {
    if (embedded || !editTarget || getState().activePaneId !== paneId) return;
    openFile(editTarget, { preview: true, preserveFocus: true });
    // 새 승인 요청이 올 때만 연다. 사용자가 탭을 닫아도 같은 요청으로 다시 열지 않는다.
  }, [editApprovalId]);
  const approval = useMemo(() => firstPending && !approvalOnRight && <ApprovalCard key={firstPending.id} agentId={agentId} item={firstPending} />, [firstPending, agentId, approvalOnRight]);

  if (!agent) return null;
  const busy = agent.status === "running" || agent.status === "waiting";
  const pendingPermissions = (items ?? []).filter((i): i is PermissionItem => i.kind === "permission" && i.status === "pending");
  const lastItem = items?.at(-1);
  // 응답을 기다리는 중인데 보여 줄 글, 도구 진행, 승인 대기가 없을 때만 "Thinking" 한 줄
  const waitingForModel = agent.status === "running" && lastItem?.kind !== "result" && !pendingPermissions.length && !(lastItem?.kind === "assistant" && lastItem.streaming) && !items?.some((i) => i.kind === "tool" && i.status === "running");
  const firstTurnWithUser = turns.findIndex((t) => t.user);

  // 타임라인 안의 파일 링크 클릭을 한 곳에서 받는다.
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest<HTMLElement>("[data-file]");
    if (!anchor) return;
    event.preventDefault();
    // 로컬에 없고 대화가 GitHub 에서 읽은 파일(web/fileRefMark.ts)은 GitHub 에서 열고, 다음부터 로컬에서 열리게 그 저장소 클론을 시작한다
    if (anchor.dataset.remote) {
      window.open(anchor.dataset.remote, "_blank", "noopener");
      if (anchor.dataset.remoteRepo) void rpc.call("repos.mirrorDir", { repo: anchor.dataset.remoteRepo, request: true }).catch(() => undefined);
      return;
    }
    const ref = JSON.parse(anchor.dataset.file!) as FileRef & { search?: string };
    // 폴더 없는 세션(Chats)은 대화가 읽은 워크스페이스에서 연다
    const workspaceId = agent.workspaceId ?? chatWorkspaceFor(agentId, ref);
    if (workspaceId) void openFileRef(workspaceId, ref, ref.search ? { search: ref.search } : {}, event.altKey);
  };

  return (
    <section className="agent" aria-label={S.sessionAria(agent.title)}>
      {!embedded && <div
        className="pane-header"
        onPointerDown={
          closable
            ? (e) => {
                // 칸 머리를 잡고 다른 칸 위로 끌면 사이드바 세션 행을 끌 때와 같이 자리를 바꾸거나 옆에 붙는다(planSessionDrop 이 이미 열린 세션은 옮긴다). 단추는 그대로 눌린다.
                if ((e.target as HTMLElement).closest("button, a, input")) return;
                beginSessionDrag(e, agentId, agent.title, null);
              }
            : undefined
        }
      >
        <PaneStatus agent={agent} />
        {/* 칸이 하나일 때 브랜치는 제목줄 명령 센터가 이미 보인다. 칸이 여럿이면 어느 칸이 어느 브랜치인지 가르려고 칸마다 보인다(round-4 발견 15). */}
        {agent.worktree && multiPane && (
          <span className="muted small mono inline-flex items-center gap-1" title={S.worktreeTitle(agent.worktree.root)}>
            <Branch size={14} /> {agent.worktree.branch}
          </span>
        )}
        <span className="agent-title" title={agent.title}>
          {agent.title}
        </span>
        {codex && <HarnessBadge />}
        {agent.backgroundTasks > 0 && <span className="faint xs">{S.backgroundTasks(agent.backgroundTasks)}</span>}
        {cards && cards.length > 0 && (
          <button type="button" className="chip card-chip" title={S.linkedCard(cards[0].title)} onClick={() => openCard(cards[0].id)}>
            <BoardIcon size={14} />
            <span className="chip-main">{cards[0].title}</span>
            {cards.length > 1 && <span className="faint">+{cards.length - 1}</span>}
          </button>
        )}
        <span className="spacer" />
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
            onScroll={(e) => {
              const el = e.currentTarget;
              const resized = el.clientHeight !== lastHeight.current;
              lastHeight.current = el.clientHeight;
              const follow = followsBottom(stickToBottom.current, el.scrollHeight - el.scrollTop - el.clientHeight, resized);
              stickToBottom.current = follow;
              setAtBottom(follow);
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
              aria-label={S.scrollToBottom}
              title={S.scrollToBottom}
              onClick={jumpToBottom}
            >
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

// CODEX: Codex 세션임을 알리는 작은 표시(칸 머리와 사이드바 행이 같이 쓴다). 장식 없이 이름만 둔다.
export function HarnessBadge() {
  return (
    <span className="harness-badge" data-harness="codex" title={S.codexSessionTip}>
      {S.harnessBadgeCodex}
    </span>
  );
}

// 칸 머리의 상태 점 하나(상태 문구는 사이드바 행이 맡는다): 진행 중과 입력 필요는 스피너, 그 밖은 오류, 안 읽음, 읽음 점.
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

// 칸 머리 오른쪽 `...` 메뉴. 이름 바꾸기, 완료, 고정은 사이드바 행 메뉴와 같은 동작이다.
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

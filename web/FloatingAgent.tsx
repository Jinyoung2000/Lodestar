import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { needsReview, QUESTION_TOOL } from "../shared/interactive";
import { PaneMenu, PaneStatus } from "./AgentView";
import { EMBED } from "./embed";
import { clampRect, defaultRect, FLOAT_EDGES, floatSessionChoices, moveRect, pillAnchor, resizeRect, type FloatEdge, type FloatLimits, type FloatRect, type Viewport } from "./floatLayout";
import { Branch, ChevronDown, Codicon } from "./icons";
import { RenameInput } from "./RenameInput";
import { useSessionList } from "./sessionListState";
import { allowPermission } from "./sessionActions";
import { ensureTimeline, focusPane, getState, openAgent, setFloatCollapsed, setFloatRect, setState, startDraft, topWorkspaceId, useStore, isTopWorkspace, type Pane, type State } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

// Editor 배치에서 활성 칸의 대화를 담는 떠 있는 창. 칸(PaneView)은 격자에 그대로 있고 CSS 로 창이 되므로 입력창, 큐, 승인 카드, 체크포인트는 같은 컴포넌트다.
// 이 파일은 창의 머리, 가장자리 크기 조절 띠, 접힌 알약, 자리 계산(web/floatLayout.ts)을 맡는다.

export function isFloatingPane(s: Pick<State, "layoutMode" | "activePaneId" | "chatDock">, paneId: string) {
  return !EMBED && s.layoutMode === "editor" && s.chatDock === "floating" && s.activePaneId === paneId;
}

// Editor 배치에서 Chat in editor layout 이 Docked 이면 활성 칸이 오른쪽 대화 패널을 채운다(web/ChatDock.tsx).
export function isDockedPane(s: Pick<State, "layoutMode" | "activePaneId" | "chatDock">, paneId: string) {
  return !EMBED && s.layoutMode === "editor" && s.chatDock === "docked" && s.activePaneId === paneId;
}

// 창 자리의 한계와 기본 크기는 디자인 토큰(CSS 변수)에서 읽는다.
function cssNumber(name: string, fallback: number) {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function readGeometry(): { vp: Viewport; limits: FloatLimits; size: { w: number; h: number } } {
  return {
    vp: { width: window.innerWidth, height: window.innerHeight, top: cssNumber("--size-titlebar", 35) },
    limits: { minW: cssNumber("--size-float-min-width", 320), minH: cssNumber("--size-float-min-height", 240), margin: cssNumber("--space-4", 16) },
    size: { w: cssNumber("--size-float-width", 420), h: cssNumber("--size-float-height", 560) },
  };
}

// 지금 화면에 그려지는 창의 자리: 저장된 자리(없으면 오른쪽 아래)를 현재 창 크기 안으로 보정한 값.
function effectiveRect(stored: FloatRect | null) {
  const { vp, limits, size } = readGeometry();
  return { rect: clampRect(stored ?? defaultRect(size, vp, limits), vp, limits), vp, limits };
}

// 떠 있는 칸의 위치 스타일. 접히면 창의 오른쪽 아래 모서리에 알약이 붙는다. 창 크기가 바뀌면 다시 계산해 화면 안으로 들어온다.
export function useFloatStyle(floating: boolean): CSSProperties | undefined {
  const stored = useStore((s) => s.floatRect);
  const collapsed = useStore((s) => s.floatCollapsed);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!floating) return;
    const onResize = () => setTick((n) => n + 1);
    // resize 이벤트는 창 크기(innerWidth)가 아직 이전 값일 때 올 수 있어서(보이지 않는 창), 레이아웃이 끝난 뒤에 오는 ResizeObserver 로도 다시 계산한다.
    const observer = new ResizeObserver(onResize);
    observer.observe(document.documentElement);
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [floating]);
  if (!floating) return undefined;
  const { rect, vp } = effectiveRect(stored);
  if (collapsed) {
    const anchor = pillAnchor(rect, vp);
    return { left: "auto", top: "auto", width: "auto", height: "auto", right: anchor.right, bottom: anchor.bottom };
  }
  return { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
}

export function FloatFrame({ pane }: { pane: Pane }) {
  const collapsed = useStore((s) => s.floatCollapsed);
  // 접힌 채로 입력창에 글을 넣거나(⌥H 첨부, 새 세션) 포커스를 요청하는 길은 창을 펼친다.
  const nonce = useStore((s) => (s.focusComposer?.paneId === pane.id ? s.focusComposer.nonce : 0));
  const seen = useRef(nonce);
  useEffect(() => {
    if (nonce !== seen.current) {
      seen.current = nonce;
      if (getState().floatCollapsed) setFloatCollapsed(false);
    }
  }, [nonce]);
  if (collapsed) return <FloatPill pane={pane} />;
  return (
    <>
      <FloatBar pane={pane} />
      {FLOAT_EDGES.map((edge) => (
        <div key={edge} className="float-grip" data-edge={edge} aria-hidden="true" onPointerDown={(e) => startGesture(e, edge)} />
      ))}
    </>
  );
}

// --- 끌어서 옮기기와 크기 조절 ---

// 포인터를 누른 자리의 자리/크기에서 출발해 움직인 만큼 더한다. 끄는 동안은 저장하지 않고 놓을 때 한 번 저장한다.
function startGesture(event: ReactPointerEvent<HTMLElement>, mode: "move" | FloatEdge) {
  if (event.button !== 0) return;
  event.preventDefault();
  const { rect: start, vp, limits } = effectiveRect(getState().floatRect);
  const startX = event.clientX;
  const startY = event.clientY;
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // 합성 PointerEvent(검증 창구)는 활성 포인터가 아니라 캡처가 거절된다. window 리스너로 끝까지 따라가므로 없어도 된다.
  }
  const move = (e: PointerEvent) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    setFloatRect(mode === "move" ? moveRect(start, dx, dy, vp, limits) : resizeRect(start, mode, dx, dy, vp, limits), false);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    setFloatRect(getState().floatRect, true);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// --- 머리 ---

function FloatBar({ pane }: { pane: Pane }) {
  const agent = useStore((s) => (pane.kind === "agent" ? s.agents.find((a) => a.id === pane.agentId) : undefined));
  const title = agent?.title ?? S.newSession;
  return (
    <div
      className="float-bar"
      data-float-bar
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input, [role='menuitem']")) return;
        startGesture(e, "move");
      }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("button, a, input")) setFloatRect(null);
      }}
    >
      {agent ? <PaneStatus agent={agent} /> : <Codicon name="comment" size={14} />}
      {agent?.worktree && (
        <span className="muted small mono inline-flex items-center gap-1" title={S.worktreeTitle(agent.worktree.root)}>
          <Branch size={14} /> {agent.worktree.branch}
        </span>
      )}
      <FloatSessionMenu pane={pane} title={title} />
      <span className="spacer" />
      {agent && <PaneMenu agent={agent} paneId={pane.id} />}
      <Button size="icon" aria-label={S.floatCollapseKey} title={S.floatCollapseKey} onClick={() => setFloatCollapsed(true)}>
        <Codicon name="chrome-minimize" />
      </Button>
    </div>
  );
}

// 제목이 곧 세션 드롭다운이다: 같은 작업 폴더의 세션을 먼저, 그 안에서 최근에 연 순서. 고르면 이 창(활성 칸)에 열린다.
// 떠 있는 창 머리와 오른쪽 대화 패널 머리가 같이 쓴다. 앱 사이드바가 없는 Editor 배치라서 이름 바꾸기 입력도 여기서 제목 자리에 뜬다.
export function FloatSessionMenu({ pane, title }: { pane: Pane; title: string }) {
  const agents = useStore((s) => s.agents);
  const recent = useStore((s) => s.recentAgentIds);
  const workspaces = useStore((s) => s.workspaces);
  const currentId = pane.kind === "agent" ? pane.agentId : null;
  const current = agents.find((a) => a.id === currentId);
  const renaming = useSessionList((s) => currentId !== null && s.renaming === currentId);
  const currentWorkspace = topWorkspaceId(current ? current.workspaceId : pane.kind === "draft" ? pane.workspaceId || null : null);
  const feedbackWorkspaces = new Set(workspaces.filter((w) => w.feedback).map((w) => w.id));
  const choices = floatSessionChoices(
    agents.map((a) => ({ id: a.id, title: a.title, workspaceId: a.workspaceId, done: !!a.done, feedback: !!a.feedbackId || (a.workspaceId !== null && feedbackWorkspaces.has(a.workspaceId)), updatedAt: new Date(a.updatedAt).getTime() || 0 })),
    recent,
    currentId,
    currentWorkspace,
    topWorkspaceId,
  );
  if (renaming && current) return <RenameInput agent={current} />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="float-title" title={title} aria-label={`${S.floatSwitchSession}: ${title}`}>
          <span className="float-title-text">{title}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="float-session-menu" data-menu="float-sessions">
        <DropdownMenuItem disabled>{S.floatRecentSessions}</DropdownMenuItem>
        {choices.map((choice) => {
          const agent = agents.find((a) => a.id === choice.id)!;
          return (
            <DropdownMenuItem key={choice.id} onSelect={() => openAgent(choice.id)}>
              <PaneStatus agent={agent} />
              <span className="float-menu-title">{choice.title}</span>
            </DropdownMenuItem>
          );
        })}
        {choices.length === 0 && <DropdownMenuItem disabled>{S.floatNoOtherSessions}</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            const workspaceId = getState().activeWorkspaceId ?? getState().workspaces.find(isTopWorkspace)?.id;
            if (workspaceId) startDraft(workspaceId);
          }}
        >
          <span>{S.floatNewSession}</span>
          <span className="faint xs menu-hint">⌘N</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setState({ overlay: { kind: "sessions" } })}>
          <span>{S.floatSearchSessions}</span>
          <span className="faint xs menu-hint">⌃⌥R</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- 접힌 알약 ---

function FloatPill({ pane }: { pane: Pane }) {
  const agent = useStore((s) => (pane.kind === "agent" ? s.agents.find((a) => a.id === pane.agentId) : undefined));
  const pending = useStore((s) => (agent ? s.timelines[agent.id]?.find((i) => i.kind === "permission" && i.status === "pending") : undefined));
  const agentId = agent?.id;
  useEffect(() => {
    if (agentId) ensureTimeline(agentId);
  }, [agentId]);
  const title = agent?.title ?? S.newSession;
  const status = agent?.status === "running" ? S.working : agent?.status === "waiting" ? S.inputNeeded : agent?.status === "error" ? S.rowError : null;
  const expand = () => {
    setFloatCollapsed(false);
    focusPane(pane.id);
  };
  // fixB: 질문과 계획 승인은 허용으로 답할 수 없어 알약을 펼친다
  const toolName = pending?.kind === "permission" ? pending.toolName : "";
  const asks = needsReview(toolName);
  return (
    <div className="float-pill" role="group" data-state={agent?.status} data-unread={agent?.unread || undefined}>
      <button type="button" className="float-pill-main" aria-label={S.floatPillAria(title)} title={S.floatExpandKey} onClick={expand}>
        {agent ? <PaneStatus agent={agent} /> : <Codicon name="comment" size={14} />}
        <span className="float-pill-title">{title}</span>
        {status && <span className="float-pill-status">{status}</span>}
      </button>
      {agent && pending && (
        <button
          type="button"
          className="session-approval-allow float-pill-allow"
          aria-label={asks ? S.approvalAnswerAria(S.approvalTitle(toolName)) : S.allowAria(S.approvalTitle(toolName))}
          onClick={() => (asks ? expand() : allowPermission(agent.id, pending.id))}
        >
          {asks ? (toolName === QUESTION_TOOL ? S.approvalAnswerRow : S.approvalReviewRow) : S.allowOnce}
        </button>
      )}
    </div>
  );
}

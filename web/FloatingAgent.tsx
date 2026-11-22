import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { needsReview, QUESTION_TOOL } from "../shared/interactive";
import { PaneMenu, PaneStatus } from "./AgentView";
import { EMBED } from "./embed";
import { clampRect, defaultRect, FLOAT_EDGES, moveRect, pillAnchor, resizeRect, type FloatEdge, type FloatLimits, type FloatRect, type Viewport } from "./floatLayout";
import { Codicon } from "./icons";
import { EditorChatTabs } from "./EditorChatTabs";
import { allowPermission } from "./sessionActions";
import { ensureTimeline, focusPane, getState, setFloatCollapsed, setFloatRect, useStore, type Pane, type State } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { useCommandKey } from "./commandKeys";

export function isFloatingPane(s: Pick<State, "layoutMode" | "activePaneId" | "chatDock">, paneId: string) {
  return !EMBED && s.layoutMode === "editor" && s.chatDock === "floating" && s.activePaneId === paneId;
}

export function isDockedPane(s: Pick<State, "layoutMode" | "activePaneId" | "chatDock">, paneId: string) {
  return !EMBED && s.layoutMode === "editor" && s.chatDock === "docked" && s.activePaneId === paneId;
}

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

function effectiveRect(stored: FloatRect | null) {
  const { vp, limits, size } = readGeometry();
  return { rect: clampRect(stored ?? defaultRect(size, vp, limits), vp, limits), vp, limits };
}

export function useFloatStyle(floating: boolean): CSSProperties | undefined {
  const stored = useStore((s) => s.floatRect);
  const collapsed = useStore((s) => s.floatCollapsed);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!floating) return;
    const onResize = () => setTick((n) => n + 1);
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

function startGesture(event: ReactPointerEvent<HTMLElement>, mode: "move" | FloatEdge) {
  if (event.button !== 0) return;
  event.preventDefault();
  const { rect: start, vp, limits } = effectiveRect(getState().floatRect);
  const startX = event.clientX;
  const startY = event.clientY;
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
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

function FloatBar({ pane }: { pane: Pane }) {
  const agent = useStore((s) => (pane.kind === "agent" ? s.agents.find((a) => a.id === pane.agentId) : undefined));
  const floatKey = useCommandKey("toggleFloat");
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
      <EditorChatTabs pane={pane} />
      {agent && <PaneMenu agent={agent} paneId={pane.id} />}
      <Button size="icon" aria-label={S.floatCollapseKey(floatKey)} title={S.floatCollapseKey(floatKey)} onClick={() => setFloatCollapsed(true)}>
        <Codicon name="chrome-minimize" />
      </Button>
    </div>
  );
}

function FloatPill({ pane }: { pane: Pane }) {
  const agent = useStore((s) => (pane.kind === "agent" ? s.agents.find((a) => a.id === pane.agentId) : undefined));
  const floatKey = useCommandKey("toggleFloat");
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
  const toolName = pending?.kind === "permission" ? pending.toolName : "";
  const asks = needsReview(toolName);
  return (
    <div className="float-pill" role="group" data-state={agent?.status} data-unread={agent?.unread || undefined}>
      <button type="button" className="float-pill-main" aria-label={S.floatPillAria(title)} title={S.floatExpandKey(floatKey)} onClick={expand}>
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

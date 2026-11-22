import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { Sidebar } from "./Sidebar";
import { PEEK_CLOSE_DELAY_MS, peekHooks, sidebarPeek, usePeekOpen } from "./peekController";
import { useStore } from "./store";
import { S } from "./strings";

export function SidebarPeek() {
  const pinned = useStore((s) => s.sidebarOpen);
  const width = useStore((s) => s.layout.sidebarWidth);
  const viewKey = useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return `${s.activePaneId}|${pane?.kind}|${pane?.kind === "agent" ? pane.agentId : ""}|${s.centerView}|${s.overlay?.kind ?? ""}`;
  });
  const open = usePeekOpen();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    peekHooks.pinned = () => pinned;
    if (pinned) sidebarPeek.close();
  }, [pinned]);

  useEffect(() => {
    sidebarPeek.close();
  }, [viewKey]);

  return (
    <>
      {!pinned && <div className="sidebar-peek-edge" data-peek-zone="edge" aria-hidden="true" onPointerEnter={(e) => e.pointerType === "mouse" && sidebarPeek.enter("edge")} onPointerLeave={() => sidebarPeek.leave("edge")} />}
      <PeekPanel open={open && !pinned} width={width} panelRef={panelRef} />
    </>
  );
}

function PeekPanel({ open, width, panelRef }: { open: boolean; width: number | null; panelRef: RefObject<HTMLDivElement | null> }) {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), PEEK_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    peekHooks.panel = mounted ? panelRef.current : null;
    return () => {
      peekHooks.panel = null;
    };
  }, [mounted, panelRef]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => sidebarPeek.refresh(), PEEK_CLOSE_DELAY_MS / 3);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && panelRef.current?.contains(target) && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      event.preventDefault();
      sidebarPeek.close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, panelRef]);

  if (!mounted) return null;
  return (
    <div
      ref={panelRef}
      className="sidebar-peek"
      data-peek-zone="panel"
      data-shown={shown || undefined}
      role="complementary"
      aria-label={S.sidebarPeek}
      style={width == null ? undefined : { width }}
      onPointerEnter={() => sidebarPeek.enter("panel")}
      onPointerLeave={() => sidebarPeek.leave("panel")}
      onClick={closeOnSessionClick}
    >
      <Sidebar width={null} />
    </div>
  );
}

const PEEK_EXIT_MS = 160;

function closeOnSessionClick(event: MouseEvent<HTMLElement>) {
  const target = event.target;
  if (target instanceof Element && target.closest("button.session-item")) sidebarPeek.close();
}

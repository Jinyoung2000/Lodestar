import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { Sidebar } from "./Sidebar";
import { PEEK_CLOSE_DELAY_MS, peekHooks, sidebarPeek, usePeekOpen } from "./peekController";
import { useStore } from "./store";
import { S } from "./strings";

// 닫힌 사이드바의 hover 미리보기. 왼쪽 가장자리 띠(edge)와 떠 있는 패널을 그린다. 토글 버튼 쪽 trigger 는 TitleBar 가 sidebarPeek 에 알린다.
// 패널은 대화 칸 배치를 밀지 않는 fixed 오버레이다.
export function SidebarPeek() {
  const pinned = useStore((s) => s.sidebarOpen);
  const width = useStore((s) => s.layout.sidebarWidth);
  // 칸이나 화면이 바뀌면(세션 열기, 새 세션, Board, Inbox) 닫는다
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

// 열릴 때 마운트하고 한 프레임 뒤에 shown 으로 바꿔 전환을 태운다. 닫히면 전환이 끝난 뒤 내린다(움직임 줄이기면 바로).
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

  // 붙잡힘(메뉴, 대화상자, 키보드 포커스)이 풀리는 순간을 잡는다. 열려 있는 동안만 돈다.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => sidebarPeek.refresh(), PEEK_CLOSE_DELAY_MS / 3);
    return () => clearInterval(id);
  }, [open]);

  // Esc 로 닫는다. 메뉴나 대화상자가 떠 있으면 그것이 먼저 닫히게 두고, 이름 바꾸기 입력의 Esc 도 입력이 처리한다.
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

// 이미 열려 있는 세션을 다시 눌러도 활성 칸이 안 바뀌므로 클릭으로도 닫는다. 이름 바꾸기 중인 행은 버튼이 아니라 눌러도 닫히지 않는다.
function closeOnSessionClick(event: MouseEvent<HTMLElement>) {
  const target = event.target;
  if (target instanceof Element && target.closest("button.session-item")) sidebarPeek.close();
}

import { useSyncExternalStore } from "react";

// 사이드바를 닫아 둔 채 토글 버튼이나 왼쪽 가장자리에 마우스를 올리면 사이드바가 대화 위에 떠서 잠깐 열린다.
// 여기는 DOM 을 모르는 상태 기계다. 타이머와 "붙잡힘" 판정은 밖에서 주입해서 시험에서 가짜로 바꾼다.

export const PEEK_OPEN_DELAY_MS = 180;
export const PEEK_CLOSE_DELAY_MS = 300;

export type PeekZone = "button" | "edge" | "panel";

export type PeekTimers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export type PeekOptions = {
  timers: PeekTimers;
  // 사이드바가 이미 고정으로 열려 있으면 떠 있는 패널은 열지 않는다
  canOpen: () => boolean;
  // 패널 안에 키보드 포커스가 있거나, 패널에서 연 메뉴와 대화상자가 떠 있으면 true
  isHeld: () => boolean;
  openDelay?: number;
  closeDelay?: number;
};

export type PeekController = {
  isOpen: () => boolean;
  enter: (zone: PeekZone) => void;
  leave: (zone: PeekZone) => void;
  // 붙잡힘 상태가 바뀌었을 수 있을 때 부른다(포커스 이동, 메뉴 닫힘)
  refresh: () => void;
  close: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createPeekController(options: PeekOptions): PeekController {
  const { timers, canOpen, isHeld } = options;
  const openDelay = options.openDelay ?? PEEK_OPEN_DELAY_MS;
  const closeDelay = options.closeDelay ?? PEEK_CLOSE_DELAY_MS;
  const zones = new Set<PeekZone>();
  const listeners = new Set<() => void>();
  let open = false;
  let openTimer: unknown = null;
  let closeTimer: unknown = null;

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const cancelOpen = () => {
    if (openTimer !== null) timers.clear(openTimer);
    openTimer = null;
  };
  const cancelClose = () => {
    if (closeTimer !== null) timers.clear(closeTimer);
    closeTimer = null;
  };

  const scheduleOpen = () => {
    if (open || openTimer !== null || !canOpen()) return;
    openTimer = timers.set(() => {
      openTimer = null;
      if (zones.size === 0 || !canOpen()) return;
      open = true;
      emit();
    }, openDelay);
  };

  const scheduleCloseIfIdle = () => {
    if (!open) return;
    if (zones.size > 0 || isHeld()) {
      cancelClose();
      return;
    }
    if (closeTimer !== null) return;
    closeTimer = timers.set(() => {
      closeTimer = null;
      if (zones.size > 0 || isHeld()) return;
      close();
    }, closeDelay);
  };

  const close = () => {
    cancelOpen();
    cancelClose();
    zones.clear();
    if (!open) return;
    open = false;
    emit();
  };

  return {
    isOpen: () => open,
    enter(zone) {
      zones.add(zone);
      cancelClose();
      scheduleOpen();
    },
    leave(zone) {
      zones.delete(zone);
      if (zones.size === 0) cancelOpen();
      scheduleCloseIfIdle();
    },
    refresh: scheduleCloseIfIdle,
    close,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// 패널 안이 붙잡혀 있는지. 마우스로 누른 단추가 받은 포커스는 세지 않는다(메뉴가 닫히며 트리거로 돌아온 포커스가 패널을 영원히 붙잡지 않게).
// 키보드로 옮긴 포커스(:focus-visible)와 입력창(이름 바꾸기)은 센다.
export function isPeekHeld(panel: HTMLElement | null, doc: Document = document): boolean {
  if (!panel) return false;
  const focused = doc.activeElement;
  if (focused && focused !== doc.body && panel.contains(focused) && focused.matches(":focus-visible")) return true;
  if (panel.querySelector('[aria-haspopup][aria-expanded="true"]')) return true;
  return doc.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]') !== null;
}

const browserTimers: PeekTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

// 화면에 하나뿐인 인스턴스. 패널 요소와 고정 여부는 SidebarPeek 이 연결한다.
export const peekHooks: { panel: HTMLElement | null; pinned: () => boolean } = { panel: null, pinned: () => false };

export const sidebarPeek = createPeekController({
  timers: browserTimers,
  canOpen: () => !peekHooks.pinned(),
  isHeld: () => isPeekHeld(peekHooks.panel),
});

export function usePeekOpen() {
  return useSyncExternalStore(sidebarPeek.subscribe, sidebarPeek.isOpen);
}

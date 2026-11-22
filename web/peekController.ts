import { useSyncExternalStore } from "react";

export const PEEK_OPEN_DELAY_MS = 180;
export const PEEK_CLOSE_DELAY_MS = 300;

export type PeekZone = "button" | "edge" | "panel";

export type PeekTimers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export type PeekOptions = {
  timers: PeekTimers;
  canOpen: () => boolean;
  isHeld: () => boolean;
  openDelay?: number;
  closeDelay?: number;
};

export type PeekController = {
  isOpen: () => boolean;
  enter: (zone: PeekZone) => void;
  leave: (zone: PeekZone) => void;
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

export function isPeekHeld(panel: HTMLElement | null, doc: Document = document): boolean {
  if (!panel) return false;
  const focused = doc.activeElement;
  if (focused && focused !== doc.body && panel.contains(focused) && focused.matches(":focus-visible")) return true;
  if (panel.querySelector('[aria-haspopup][aria-expanded="true"]')) return true;
  return doc.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]') !== null;
}

const browserTimers: PeekTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export const peekHooks: { panel: HTMLElement | null; pinned: () => boolean } = { panel: null, pinned: () => false };

export const sidebarPeek = createPeekController({
  timers: browserTimers,
  canOpen: () => !peekHooks.pinned(),
  isHeld: () => isPeekHeld(peekHooks.panel),
});

export function usePeekOpen() {
  return useSyncExternalStore(sidebarPeek.subscribe, sidebarPeek.isOpen);
}

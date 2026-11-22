import { useSyncExternalStore } from "react";
import { isPinnedSide, parsePinnedWidth, type PinnedSide } from "./pinnedLayout";

const WIDTH_KEY = "agent-nav:pinned-width";
const COLLAPSED_KEY = "agent-nav:pinned-collapsed";
const SIDE_KEY = "agent-nav:pinned-side";

type PinnedState = { width: number | null; collapsed: boolean; drawerOpen: boolean; side: PinnedSide };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
  }
}

const savedSide = read(SIDE_KEY);
let state: PinnedState = { width: parsePinnedWidth(read(WIDTH_KEY)), collapsed: read(COLLAPSED_KEY) !== "0", drawerOpen: false, side: isPinnedSide(savedSide) ? savedSide : "right" };
const listeners = new Set<() => void>();

function set(patch: Partial<PinnedState>) {
  const next = { ...state, ...patch };
  if (next.width === state.width && next.collapsed === state.collapsed && next.drawerOpen === state.drawerOpen && next.side === state.side) return;
  state = next;
  listeners.forEach((l) => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function usePinned<T>(select: (s: PinnedState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export function setPinnedWidth(width: number | null) {
  write(WIDTH_KEY, width === null ? null : String(width));
  set({ width });
}

export function setPinnedCollapsed(collapsed: boolean) {
  write(COLLAPSED_KEY, collapsed ? "1" : "0");
  set({ collapsed, drawerOpen: false });
}

export const setPinnedDrawer = (drawerOpen: boolean) => set({ drawerOpen });

export function setPinnedSide(value: unknown) {
  const side = isPinnedSide(value) ? value : "right";
  write(SIDE_KEY, side === "right" ? null : side);
  set({ side });
}

export function revealPinned() {
  if (state.collapsed) write(COLLAPSED_KEY, "0");
  set({ collapsed: false, drawerOpen: true });
}

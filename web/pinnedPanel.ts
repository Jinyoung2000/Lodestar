import { useSyncExternalStore } from "react";
import { isPinnedSide, parsePinnedWidth, type PinnedSide } from "./pinnedLayout";

// 고정 칸(Changes, Files)의 폭과 접힘. 처음에는 접혀 있고(저장값 없음), 펼치면 "0", 접으면 "1" 로 남는다. 사용자가 끌고 접은 값은 다음 실행에도 남도록 localStorage 에 두고, 서랍이 열려 있는지는 이번 화면에서만 의미가 있어 저장하지 않는다.
// 위치(Left, Right)는 Settings 의 pinnedPanelSide 가 정본이고, 첫 그림이 번쩍이지 않도록 마지막으로 받은 값을 여기에 캐시한다.
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
    // 저장이 막혀도 이번 실행에서는 그대로 동작한다
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

export const getPinned = () => state;

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

// Settings 에서 받은 위치. 모르는 값이면 right.
export function setPinnedSide(value: unknown) {
  const side = isPinnedSide(value) ? value : "right";
  write(SIDE_KEY, side === "right" ? null : side);
  set({ side });
}

// Changes 나 Files 를 열라는 요청(상태 줄의 칩, 명령, 탭 누르기)이 오면 접혀 있던 고정 칸을 편다. 서랍이면 연다.
export function revealPinned() {
  if (state.collapsed) write(COLLAPSED_KEY, "0");
  set({ collapsed: false, drawerOpen: true });
}

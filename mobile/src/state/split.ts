import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

export const PANE_MIN = 360;
export const MAX_PANES = 4;

export type DropZone = "before" | "after" | "center";
export type DropTarget = { index: number; zone: DropZone };

type SplitState = { panes: readonly string[]; recent: readonly string[]; drawerOpen: boolean; railHidden: boolean };

const RAIL_HIDDEN_KEY = "pref:railHidden";
let state: SplitState = { panes: [], recent: [], drawerOpen: false, railHidden: false };
const listeners = new Set<() => void>();

function set(next: Partial<SplitState>) {
  state = { ...state, ...next };
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function useSplitState() {
  return useSyncExternalStore(subscribe, () => state);
}

export function commitPanes(panes: readonly string[], active: string) {
  set({ panes, recent: [active, ...state.recent.filter((id) => id !== active && panes.includes(id))] });
}

export function setDrawerOpen(open: boolean) {
  if (state.drawerOpen !== open) set({ drawerOpen: open });
}

export function setRailHidden(hidden: boolean) {
  if (state.railHidden === hidden) return;
  set({ railHidden: hidden, drawerOpen: false });
  void AsyncStorage.setItem(RAIL_HIDDEN_KEY, hidden ? "1" : "0").catch(() => {});
}

void AsyncStorage.getItem(RAIL_HIDDEN_KEY).then((saved) => {
  if (saved === "1" && !state.railHidden) set({ railHidden: true });
}).catch(() => {});

export function isDrawerOpen() {
  return state.drawerOpen;
}

export function paneCapacity(width: number, fontScale: number) {
  const min = fontScale >= 1.3 ? PANE_MIN + 40 : PANE_MIN;
  return Math.max(1, Math.min(MAX_PANES, Math.floor(width / min)));
}

export function shownPanes(split: Pick<SplitState, "panes" | "recent">, activeId: string | undefined, capacity: number, exists: (id: string) => boolean): string[] {
  if (!activeId) return [];
  const stored = split.panes.filter((id) => id === activeId || exists(id));
  const base = stored.includes(activeId) ? stored : [activeId];
  if (base.length <= capacity) return base;
  const keep = new Set([activeId, ...split.recent.filter((id) => id !== activeId && base.includes(id))].slice(0, capacity));
  return base.filter((id) => keep.has(id));
}

export function canInsert(panes: readonly string[], agentId: string, capacity: number) {
  return panes.includes(agentId) || panes.length < capacity;
}

export function dropTargetAt(x: number, left: number, width: number, panes: readonly string[], agentId: string, capacity: number): DropTarget | null {
  if (panes.length === 0 || x < left || x > left + width) return null;
  const paneWidth = width / panes.length;
  const index = Math.min(panes.length - 1, Math.floor((x - left) / paneWidth));
  const within = x - left - index * paneWidth;
  const edge = Math.min(paneWidth * 0.3, 140);
  const insert = canInsert(panes, agentId, capacity) && !(panes.length === 1 && panes[0] === agentId);
  if (insert && within < edge) return { index, zone: "before" };
  if (insert && within > paneWidth - edge) return { index, zone: "after" };
  if (panes[index] === agentId) return null;
  return { index, zone: "center" };
}

export function applyDrop(panes: readonly string[], agentId: string, target: DropTarget): string[] {
  const from = panes.indexOf(agentId);
  if (target.zone === "center") {
    const next = [...panes];
    const replaced = next[target.index];
    next[target.index] = agentId;
    if (from >= 0) next[from] = replaced;
    return next;
  }
  const at = target.index + (target.zone === "after" ? 1 : 0);
  const without = panes.filter((id) => id !== agentId);
  without.splice(from >= 0 && from < at ? at - 1 : at, 0, agentId);
  return without;
}

export function closePane(panes: readonly string[], id: string, active: string): { panes: string[]; active: string | null } {
  const index = panes.indexOf(id);
  const next = panes.filter((pane) => pane !== id);
  if (next.length === 0) return { panes: next, active: null };
  if (id !== active) return { panes: next, active };
  return { panes: next, active: next[Math.max(0, index - 1)] };
}

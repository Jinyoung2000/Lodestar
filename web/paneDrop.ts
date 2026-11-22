import { paneOrder, placeBeside, swapPanes, withoutPane, type Grid, type PlaceSide, type PlaceSizes } from "./gridLayout";
import type { Pane } from "./store";

export type Rect = { left: number; top: number; width: number; height: number };
export type DropZone = PlaceSide | "center";

export const PANE_MIN = 360;
export const ROW_MIN = 160;

export const EDGE = 0.25;

export type ZoneAllow = { horizontal: boolean; vertical: boolean };

export function zoneAt(rect: Rect, x: number, y: number, allow: ZoneAllow): DropZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const candidates: { zone: PlaceSide; distance: number }[] = [];
  if (allow.horizontal && fx < EDGE) candidates.push({ zone: "left", distance: fx });
  if (allow.horizontal && fx > 1 - EDGE) candidates.push({ zone: "right", distance: 1 - fx });
  if (allow.vertical && fy < EDGE) candidates.push({ zone: "top", distance: fy });
  if (allow.vertical && fy > 1 - EDGE) candidates.push({ zone: "bottom", distance: 1 - fy });
  if (!candidates.length) return "center";
  return candidates.reduce((best, c) => (c.distance < best.distance ? c : best)).zone;
}

export function allowedEdges(floating: boolean): ZoneAllow {
  return { horizontal: !floating, vertical: !floating };
}

export function previewRect(zone: DropZone, pane: Rect, row: Rect): Rect {
  switch (zone) {
    case "center":
      return pane;
    case "left":
      return { ...pane, width: pane.width / 2 };
    case "right":
      return { ...pane, left: pane.left + pane.width / 2, width: pane.width / 2 };
    case "top":
      return { ...row, height: row.height / 2 };
    case "bottom":
      return { ...row, top: row.top + row.height / 2, height: row.height / 2 };
  }
}

export type DropState = { panes: Pane[]; grid: Grid; activePaneId: string };
export type DropPlan = DropState;

export function planSessionDrop(state: DropState, agentId: string, targetId: string, zone: DropZone, newPaneId: () => string, sizes?: PlaceSizes): DropPlan | null {
  const target = state.panes.find((p) => p.id === targetId);
  if (!target) return null;
  const source = state.panes.find((p) => p.kind === "agent" && p.agentId === agentId);
  if (source?.id === targetId) return null;
  if (zone === "center") {
    if (source) return { ...state, grid: swapPanes(state.grid, source.id, targetId), activePaneId: source.id };
    return { ...state, panes: state.panes.map((p) => (p.id === targetId ? { id: targetId, kind: "agent" as const, agentId } : p)), activePaneId: targetId };
  }
  const moving: Pane = source ?? { id: newPaneId(), kind: "agent", agentId };
  const base = source ? withoutPane(state.grid, source.id) : state.grid;
  const grid = placeBeside(base, moving.id, targetId, zone, sizes);
  if (paneOrder(grid).length !== state.panes.length + (source ? 0 : 1)) return null;
  return { panes: source ? state.panes : [...state.panes, moving], grid, activePaneId: moving.id };
}

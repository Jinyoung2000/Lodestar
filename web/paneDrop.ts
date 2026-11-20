import { paneOrder, placeBeside, swapPanes, withoutPane, type Grid, type PlaceSide, type PlaceSizes } from "./gridLayout";
import type { Pane } from "./store";

// SESSIONDRAG: 사이드바 세션 행을 가운데 칸에 끌어 놓는 규칙의 순수 로직. DOM 과 store 값을 모르고 값만 받아서 단위 시험이 그대로 가져다 쓴다.

export type Rect = { left: number; top: number; width: number; height: number };
export type DropZone = PlaceSide | "center";

// 칸 최소 폭과 행 최소 높이. 경계를 끌어 줄일 때의 하한이다(PaneGrid).
export const PANE_MIN = 360;
export const ROW_MIN = 160;

// 칸 가장자리로 치는 비율(탭 끌기의 본문 가장자리와 같다). 가운데 절반은 그 칸의 세션을 바꾸는 자리다.
export const EDGE = 0.25;

export type ZoneAllow = { horizontal: boolean; vertical: boolean };

// 포인터가 칸 사각형 안 어디인지. 사각형 밖이면 null. 모서리처럼 두 가장자리에 걸치면 칸 크기로 정규화한 거리가 더 가까운 쪽을 고른다.
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

// 가장자리를 열지 여부. 떠 있는 창(Editor 배치)은 하나뿐인 창이라 나눌 수 없어 가운데 바꾸기만 허용한다.
// 칸 수 상한도 최소 크기 조건도 두지 않는다: 칸 나누기(⌘\, ⌘K ⌘\)에도 없는 제한이라 같은 규칙을 따른다.
export function allowedEdges(floating: boolean): ZoneAllow {
  return { horizontal: !floating, vertical: !floating };
}

// 놓으면 채워질 자리. 왼쪽, 오른쪽은 칸의 그 절반이다. 위, 아래는 새 행이 행 전체 폭을 쓰므로 칸이 속한 행의 그 절반이다(칸이 행에 혼자면 칸 절반과 같다).
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

// 세션을 targetId 칸의 zone 에 놓았을 때의 새 칸 목록과 격자. 바꿀 것이 없으면 null.
// 이미 다른 칸에 열린 세션이면 복제하지 않고 옮긴다(한 세션에 채팅이 하나뿐이다):
//   가운데는 두 칸의 자리를 맞바꾸고(movePane 과 같다), 가장자리는 그 칸 자체를 새 자리로 옮긴다. 칸 수는 그대로다.
// 열려 있지 않은 세션은 가운데면 그 칸의 세션을 바꾸고, 가장자리면 새 칸을 만든다.
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

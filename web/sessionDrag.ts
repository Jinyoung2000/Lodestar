import type { PointerEvent as ReactPointerEvent } from "react";
import { useSyncExternalStore } from "react";
import type { PlaceSizes } from "./gridLayout";
import { allowedEdges, previewRect, zoneAt, type DropZone, type Rect } from "./paneDrop";
import { FOLDERS_SCOPE, moveInOrder } from "../shared/sessionOrder";
import { pickSlot, type SlotBlock } from "./sessionDropSlot";
import { moveFolder, moveSession, sessionListOf } from "./sessionReorder";
import { dropSessionOnPane, getState } from "./store";

// SESSIONDRAG: 사이드바 세션 행을 끌어 가운데 칸에 놓거나(SESSIONORDER 이후로는) 사이드바 목록 위에서 같은 묶음 안의 자리를 바꾼다. tabDrag.ts 와 같은 방식으로 HTML 끌어놓기가 아니라 포인터 이벤트로 직접 만든다.
// 창구의 합성 마우스 입력(sendInputEvent)으로도 같게 움직이고, 놓을 자리를 직접 그려야 해서다. 판정은 web/paneDrop.ts 의 순수 함수가 한다.

export type SessionDropTarget = { paneId: string; zone: DropZone; rect: Rect };
// 순서 바꾸기: 포인터가 사이드바 목록 위일 때 놓을 자리. line 은 삽입선(가로 2px)의 화면 좌표다.
export type SessionReorderTarget = { scope: string; targetId: string; edge: "before" | "after"; line: Rect };
export type SessionDrag = { agentId: string; label: string; x: number; y: number; target: SessionDropTarget | null; reorder: SessionReorderTarget | null };

// 이만큼(px) 움직여야 끌기가 시작된다. 그 전에 떼면 평범한 클릭이라 행 클릭, 더블클릭 이름 바꾸기가 그대로 먹는다.
export const DRAG_THRESHOLD = 5;

let drag: SessionDrag | null = null;
const listeners = new Set<() => void>();

function set(next: SessionDrag | null) {
  drag = next;
  // 끄는 동안 글자 선택과 webview 가 포인터를 가로채지 않게 한다(styles.css 의 data-session-dragging)
  document.body.toggleAttribute("data-session-dragging", next !== null);
  for (const listener of listeners) listener();
}

export function useSessionDrag() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => drag,
  );
}

// scope 는 이 행이 순서를 바꿀 수 있는 목록(SessionRow.scope). null 이면 목록 위에서 놓아도 아무 일도 없다.
// kind 가 folder 면 사이드바 폴더 묶음 머리를 끄는 것이다: agentId 는 워크스페이스 id 이고, 칸에 놓기는 없이 폴더 묶음 사이의 순서 바꾸기만 한다.
export function beginSessionDrag(event: ReactPointerEvent, agentId: string, label: string, scope: string | null, kind: "session" | "folder" = "session") {
  if (event.button !== 0 || !event.isPrimary) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let started = false;
  const move = (e: PointerEvent) => {
    if (!started) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      started = true;
    }
    // 사이드바 목록 위에서는 순서 바꾸기, 그 밖에서는 에디터 칸에 놓기다. 목록 위는 칸이 아니라서 칸 판정은 어차피 null 이다.
    if (kind === "folder") {
      set({ agentId, label, x: e.clientX, y: e.clientY, target: null, reorder: folderReorderTargetAt(e.clientX, e.clientY, agentId) });
      return;
    }
    set({ agentId, label, x: e.clientX, y: e.clientY, target: sessionDropTargetAt(e.clientX, e.clientY, agentId), reorder: scope ? reorderTargetAt(e.clientX, e.clientY, agentId, scope) : null });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", onKey, true);
    if (!started) return;
    const target = drag?.target ?? null;
    const reorder = drag?.reorder ?? null;
    set(null);
    // 끌기 끝에 따라오는 click 은 행을 누른 것으로 치지 않는다
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (commit && reorder && kind === "folder") moveFolder(agentId, reorder.targetId, reorder.edge);
    else if (commit && reorder) moveSession(reorder.scope, agentId, reorder.targetId, reorder.edge);
    else if (commit && target) dropSessionOnPane(agentId, target.paneId, target.zone, measureSizes());
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      finish(false);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", onKey, true);
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

// 포인터 아래의 칸과 그 칸 안의 놓을 자리. .pane-cell 은 display: contents 라 자기 상자가 없어서 첫 자식(.pane)의 사각형을 쓴다.
// 이미 그 칸에 열린 세션이면 바꿀 것이 없으므로 자리를 보이지 않는다.
export function sessionDropTargetAt(x: number, y: number, agentId: string): SessionDropTarget | null {
  const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane-id]");
  const pane = cell?.firstElementChild;
  const paneId = cell?.dataset.paneId;
  if (!cell || !pane || !paneId) return null;
  const s = getState();
  const open = s.panes.find((p) => p.id === paneId);
  if (!open || (open.kind === "agent" && open.agentId === agentId)) return null;
  const paneRect = rectOf(pane);
  const rowRect = rectOf(cell.closest(".pane-row") ?? pane);
  const zone = zoneAt(paneRect, x, y, allowedEdges(s.layoutMode === "editor"));
  return zone ? { paneId, zone, rect: previewRect(zone, paneRect, rowRect) } : null;
}

const LINE_HEIGHT = 2;

// 포인터 아래의 같은 목록 안 자리. 같은 .session-group 안에서 scope 가 같은 형제 행만 후보다(다른 묶음, 다른 부모의 자식, 고정과 비고정은 scope 가 달라서 후보가 아니다).
// 후보의 단위 블록은 그 행과 아래 들여쓴 자손 행들이다. 옮겨도 순서가 그대로인 자리(자기 자리, 이웃의 맞붙은 쪽)는 선을 그리지 않는다.
export function reorderTargetAt(x: number, y: number, agentId: string, scope: string): SessionReorderTarget | null {
  const hit = document.elementFromPoint(x, y);
  const group = hit?.closest<HTMLElement>(".sidebar-list .session-group");
  const list = sessionListOf(scope);
  if (!group || !list) return null;
  const rows = [...group.querySelectorAll<HTMLElement>(":scope > .session-row[data-id]")];
  const siblings = rows.filter((row) => row.dataset.scope === scope);
  if (siblings.length === 0) return null;
  const blocks: (SlotBlock & { row: HTMLElement })[] = siblings.map((row) => {
    const depth = Number(row.dataset.depth);
    let last = row;
    for (let next = rows[rows.indexOf(row) + 1]; next && Number(next.dataset.depth) > depth; next = rows[rows.indexOf(next) + 1]) last = next;
    return { id: row.dataset.id!, row, top: row.getBoundingClientRect().top, bottom: last.getBoundingClientRect().bottom };
  });
  // 묶음의 최상위 목록은 머리부터 Show more 단추까지 묶음 전체가 범위이고, 갈래 목록은 형제 블록들이 차지한 구간이 범위다.
  const groupBox = group.getBoundingClientRect();
  const bounds = Number(siblings[0].dataset.depth) === 0 ? { top: groupBox.top, bottom: groupBox.bottom } : { top: blocks[0].top, bottom: blocks[blocks.length - 1].bottom };
  const slot = pickSlot(blocks, y, bounds);
  if (!slot || !moveInOrder(list.ids, agentId, slot.id, slot.edge)) return null;
  const block = blocks.find((b) => b.id === slot.id)!;
  const box = block.row.getBoundingClientRect();
  const edgeY = slot.edge === "before" ? block.top : block.bottom;
  return { scope, targetId: slot.id, edge: slot.edge, line: { left: box.left, top: edgeY - LINE_HEIGHT / 2, width: box.width, height: LINE_HEIGHT } };
}

// 폴더 묶음 머리를 끄는 중 포인터 아래의 자리. 최상위 폴더 묶음(.session-group[data-workspace-id])이 후보이고, 단위 블록은 묶음 전체(머리와 세션 행)다.
// 묶음 범위는 첫 폴더 묶음 위에서 마지막 폴더 묶음 아래까지라서, Pinned 나 Chats 위에서는 선이 없다. 삽입선은 블록의 위나 아래 가장자리에 머리와 같은 폭으로 그린다.
export function folderReorderTargetAt(x: number, y: number, workspaceId: string): SessionReorderTarget | null {
  const list = sessionListOf(FOLDERS_SCOPE);
  const groups = [...document.querySelectorAll<HTMLElement>(".sidebar-list > .session-group[data-workspace-id]")];
  if (!list || groups.length === 0) return null;
  const blocks = groups.map((group) => {
    const box = group.getBoundingClientRect();
    return { id: group.dataset.workspaceId!, group, top: box.top, bottom: box.bottom };
  });
  const slot = pickSlot(blocks, y, { top: blocks[0].top, bottom: blocks[blocks.length - 1].bottom });
  // 사이드바 가로 밖이면 목록 위가 아니다
  const sidebar = document.querySelector(".sidebar-list")?.getBoundingClientRect();
  if (!slot || !sidebar || x < sidebar.left || x > sidebar.right || !moveInOrder(list.ids, workspaceId, slot.id, slot.edge)) return null;
  const block = blocks.find((b) => b.id === slot.id)!;
  const head = block.group.querySelector(".session-group-head")?.getBoundingClientRect() ?? block.group.getBoundingClientRect();
  const edgeY = slot.edge === "before" ? block.top : block.bottom;
  return { scope: FOLDERS_SCOPE, targetId: slot.id, edge: slot.edge, line: { left: head.left, top: edgeY - LINE_HEIGHT / 2, width: head.width, height: LINE_HEIGHT } };
}

// 놓는 순간의 칸 폭과 행 높이(px). 가장자리에 놓을 때 대상 칸(행)을 정확히 반으로 가르는 데 쓴다.
function measureSizes(): PlaceSizes {
  const cols: Record<string, number> = {};
  const rows: Record<string, number> = {};
  for (const cell of document.querySelectorAll<HTMLElement>("[data-pane-id]")) {
    const pane = cell.firstElementChild;
    if (pane && cell.dataset.paneId) cols[cell.dataset.paneId] = pane.getBoundingClientRect().width;
  }
  for (const row of document.querySelectorAll<HTMLElement>(".pane-row[data-row-id]")) rows[row.dataset.rowId!] = row.getBoundingClientRect().height;
  return { cols, rows };
}

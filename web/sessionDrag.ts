import type { PointerEvent as ReactPointerEvent } from "react";
import { useSyncExternalStore } from "react";
import type { PlaceSizes } from "./gridLayout";
import { allowedEdges, previewRect, zoneAt, type DropZone, type Rect } from "./paneDrop";
import { FOLDERS_SCOPE, moveInOrder } from "../shared/sessionOrder";
import { pickSlot, type SlotBlock } from "./sessionDropSlot";
import { moveFolder, moveSession, sessionListOf } from "./sessionReorder";
import { dropSessionOnPane, getState } from "./store";

export type SessionDropTarget = { paneId: string; zone: DropZone; rect: Rect };
export type SessionReorderTarget = { scope: string; targetId: string; edge: "before" | "after"; line: Rect };
export type SessionDrag = { agentId: string; label: string; x: number; y: number; target: SessionDropTarget | null; reorder: SessionReorderTarget | null };

export const DRAG_THRESHOLD = 5;

let drag: SessionDrag | null = null;
const listeners = new Set<() => void>();

function set(next: SessionDrag | null) {
  drag = next;
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
  const groupBox = group.getBoundingClientRect();
  const bounds = Number(siblings[0].dataset.depth) === 0 ? { top: groupBox.top, bottom: groupBox.bottom } : { top: blocks[0].top, bottom: blocks[blocks.length - 1].bottom };
  const slot = pickSlot(blocks, y, bounds);
  if (!slot || !moveInOrder(list.ids, agentId, slot.id, slot.edge)) return null;
  const block = blocks.find((b) => b.id === slot.id)!;
  const box = block.row.getBoundingClientRect();
  const edgeY = slot.edge === "before" ? block.top : block.bottom;
  return { scope, targetId: slot.id, edge: slot.edge, line: { left: box.left, top: edgeY - LINE_HEIGHT / 2, width: box.width, height: LINE_HEIGHT } };
}

export function folderReorderTargetAt(x: number, y: number, workspaceId: string): SessionReorderTarget | null {
  const list = sessionListOf(FOLDERS_SCOPE);
  const groups = [...document.querySelectorAll<HTMLElement>(".sidebar-list > .session-group[data-workspace-id]")];
  if (!list || groups.length === 0) return null;
  const blocks = groups.map((group) => {
    const box = group.getBoundingClientRect();
    return { id: group.dataset.workspaceId!, group, top: box.top, bottom: box.bottom };
  });
  const slot = pickSlot(blocks, y, { top: blocks[0].top, bottom: blocks[blocks.length - 1].bottom });
  const sidebar = document.querySelector(".sidebar-list")?.getBoundingClientRect();
  if (!slot || !sidebar || x < sidebar.left || x > sidebar.right || !moveInOrder(list.ids, workspaceId, slot.id, slot.edge)) return null;
  const block = blocks.find((b) => b.id === slot.id)!;
  const head = block.group.querySelector(".session-group-head")?.getBoundingClientRect() ?? block.group.getBoundingClientRect();
  const edgeY = slot.edge === "before" ? block.top : block.bottom;
  return { scope: FOLDERS_SCOPE, targetId: slot.id, edge: slot.edge, line: { left: head.left, top: edgeY - LINE_HEIGHT / 2, width: head.width, height: LINE_HEIGHT } };
}

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

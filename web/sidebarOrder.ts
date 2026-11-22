import type { PointerEvent as ReactPointerEvent } from "react";
import { useSyncExternalStore } from "react";

export type SidebarSection = "pullRequests" | "notion" | "sessions";

const DEFAULT_ORDER: SidebarSection[] = ["pullRequests", "sessions"];
const KEY = "agent-nav.sidebarOrder";
const listeners = new Set<() => void>();
let cached: SidebarSection[] | null = null;

export function useSidebarOrder(): SidebarSection[] {
  return useSyncExternalStore(subscribe, readOrder, () => DEFAULT_ORDER);
}

export function moveSidebarSection(id: SidebarSection, delta: -1 | 1): void {
  placeSidebarSection(id, readOrder().indexOf(id) + delta);
}

function placeSidebarSection(id: SidebarSection, to: number): void {
  const next = [...readOrder()];
  const from = next.indexOf(id);
  if (from < 0 || to < 0 || to >= next.length || to === from) return;
  next.splice(from, 1);
  next.splice(to, 0, id);
  cached = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
  }
  for (const listener of listeners) listener();
}

function readOrder(): SidebarSection[] {
  if (cached) return cached;
  cached = parse(readStored());
  return cached;
}

function readStored(): unknown {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function parse(value: unknown): SidebarSection[] {
  if (!Array.isArray(value) || value.length !== DEFAULT_ORDER.length) return DEFAULT_ORDER;
  const valid = DEFAULT_ORDER.every((id) => value.includes(id));
  return valid ? (value as SidebarSection[]) : DEFAULT_ORDER;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type SectionDrag = { id: SidebarSection; over: SidebarSection; edge: "before" | "after" } | null;

const DRAG_THRESHOLD = 5;
let drag: SectionDrag = null;
const dragListeners = new Set<() => void>();

function setDrag(next: SectionDrag) {
  drag = next;
  document.body.toggleAttribute("data-session-dragging", next !== null);
  for (const listener of dragListeners) listener();
}

export function useSectionDrag(): SectionDrag {
  return useSyncExternalStore(
    (listener) => {
      dragListeners.add(listener);
      return () => dragListeners.delete(listener);
    },
    () => drag,
    () => null,
  );
}

export function beginSectionDrag(event: ReactPointerEvent, id: SidebarSection): void {
  if (event.button !== 0 || !event.isPrimary) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest(".sessions-header")) return;
  const button = target.closest("button");
  if (button && !button.matches(".pr-section-toggle")) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let started = false;
  const move = (e: PointerEvent) => {
    if (!started) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      started = true;
    }
    const block = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-section]");
    const over = block?.dataset.section as SidebarSection | undefined;
    if (!block || !over || over === id) {
      setDrag({ id, over: id, edge: "before" });
      return;
    }
    const box = block.getBoundingClientRect();
    setDrag({ id, over, edge: e.clientY < box.top + box.height / 2 ? "before" : "after" });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", onKey, true);
    if (!started) return;
    const last = drag;
    setDrag(null);
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (!commit || !last || last.over === id) return;
    const rest = readOrder().filter((section) => section !== id);
    placeSidebarSection(id, rest.indexOf(last.over) + (last.edge === "after" ? 1 : 0));
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

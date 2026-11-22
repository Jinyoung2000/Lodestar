import { useSyncExternalStore } from "react";
import { groupIdsOf } from "./editorGroups";
import { getState, mruOf, setState, shownTabsOf } from "./store";
import { ALL_GROUPS } from "./tabMru";
import { openingIndex, stepIndex, switcherRows, withoutRow, type SwitcherRow, type SwitcherScope } from "./tabSwitcherModel";


export type TabSwitcherState = { rows: SwitcherRow[]; index: number; scope: SwitcherScope; hold: boolean } | null;

let current: TabSwitcherState = null;
const listeners = new Set<() => void>();

function set(next: TabSwitcherState) {
  current = next;
  for (const listener of listeners) listener();
}

export function useTabSwitcher() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export function cycleTabSwitcher(step: 1 | -1, scope: SwitcherScope = "group", hold = true) {
  if (current) {
    set({ ...current, index: stepIndex(current.index, current.rows.length, step) });
    return;
  }
  const s = getState();
  const rows = switcherRows({
    scope,
    activeGroup: s.activeGroupId,
    activeKey: s.activeTabKey,
    tabs: shownTabsOf(s),
    groupOrder: groupIdsOf(s.editorLayout),
    mru: mruOf(scope === "group" ? s.activeGroupId : ALL_GROUPS),
  });
  if (!rows.length) return;
  const first = rows[0].key === s.activeTabKey ? openingIndex(rows.length, "second") : 0;
  set({ rows, index: step === 1 ? first : openingIndex(rows.length, "last"), scope, hold });
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("blur", closeTabSwitcher);
  if (hold) window.addEventListener("keyup", onKeyUp, true);
}

export function commitTabSwitcher(index?: number) {
  const open = current;
  if (!open) return;
  closeTabSwitcher();
  const row = open.rows[index ?? open.index];
  if (row && getState().tabs.some((t) => t.key === row.key)) setState({ activeTabKey: row.key });
}

export function closeTabSwitcher() {
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("blur", closeTabSwitcher);
  window.removeEventListener("keyup", onKeyUp, true);
  set(null);
}

export function dropTabSwitcherRow(key: string) {
  if (!current) return;
  const next = withoutRow(current.rows, current.index, key);
  if (!next.rows.length) closeTabSwitcher();
  else set({ ...current, ...next });
}

function onKeyUp(event: KeyboardEvent) {
  if (event.key === "Control") commitTabSwitcher();
}

function onPointerDown(event: PointerEvent) {
  if (event.target instanceof Element && event.target.closest("[data-tab-switcher]")) return;
  closeTabSwitcher();
}

function onKeyDown(event: KeyboardEvent) {
  if (!current) return;
  const swallow = () => {
    event.preventDefault();
    event.stopPropagation();
  };
  if (event.key === "Escape") {
    swallow();
    closeTabSwitcher();
  } else if (event.key === "Enter") {
    swallow();
    commitTabSwitcher();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    swallow();
    set({ ...current, index: stepIndex(current.index, current.rows.length, event.key === "ArrowDown" ? 1 : -1) });
  } else if (current.hold && !event.ctrlKey && !["Tab", "Shift", "Control"].includes(event.key)) {
    commitTabSwitcher();
  } else if (!current.hold && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== "Tab" && event.key.length === 1) {
    swallow();
  }
}

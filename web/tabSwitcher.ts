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

// 열려 있지 않으면 열고(앞으로 가기는 직전 에디터, 뒤로 가기는 가장 오래된 에디터를 고른다), 열려 있으면 step 만큼 고른 행을 옮긴다. hold 는 ⌃Tab 처럼 키를 누른 채 쓰는 호출이다.
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
  // 활성 에디터가 목록 맨 앞에 없으면(Changes, Files 가 보이는 중) 직전 에디터는 첫 행이다
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
    // Ctrl 을 이미 뗐는데 keyup 을 놓친 경우의 보험
    commitTabSwitcher();
  } else if (!current.hold && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== "Tab" && event.key.length === 1) {
    // 입력 상자가 없는 목록이라 글자는 어디에도 들어가지 않는다
    swallow();
  }
}

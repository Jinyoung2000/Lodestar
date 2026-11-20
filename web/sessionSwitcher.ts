import { useSyncExternalStore } from "react";
import { activeAgentOf } from "./activeAgentOf";
import { EMBED } from "./embed";
import { openSwitcher, reduceSwitcher, switcherSessions, type SwitcherAction, type SwitcherEvent, type SwitcherState } from "./sessionSwitcherModel";
import { getState, rememberRecentAgent, subscribe, switchToSession } from "./store";
import { closeTabSwitcher } from "./tabSwitcher";

// ⌃Tab 세션 전환 창(macOS ⌘Tab 과 같다). 에디터 안의 ⌃Tab 은 탭 전환(web/tabSwitcher.ts)이고, 그 밖의 ⌃Tab 이 이쪽이다.
// ⌃ 를 누른 채 Tab 을 누를 때마다 한 칸씩 가고 ⌃ 를 떼면 고른 세션으로 간다. 빨리 눌렀다 떼면 창이 뜨기 전에 직전 세션으로 간다.
// 목록과 키 규칙은 web/sessionSwitcherModel.ts, 화면은 web/SessionSwitcherView.tsx.

// 창이 뜨기까지 기다리는 시간. 이보다 빨리 ⌃ 를 떼면 창을 보이지 않고 바로 간다.
export const SESSION_SWITCHER_SHOW_MS = 200;

let current: SwitcherState | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(next: SwitcherState | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function useSessionSwitcher() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

// 열려 있지 않으면 열고(앞으로는 직전 세션, 뒤로는 가장 오래된 세션을 고른다), 열려 있으면 delta 만큼 고른 행을 옮긴다. hold 는 ⌃Tab 처럼 키를 누른 채 쓰는 호출이다.
export function cycleSessionSwitcher(delta: 1 | -1, hold = true) {
  if (current) {
    dispatch({ type: "step", delta });
    return;
  }
  const s = getState();
  // 다른 빠른 선택창이 떠 있으면 그 창이 키를 쓴다
  if (s.overlay) return;
  const openIds = s.panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : []));
  const rows = switcherSessions({ agents: s.agents, workspaces: s.workspaces, recentIds: s.recentAgentIds, openIds, activeAgentId: activeAgentOf(s.panes, s.activePaneId, s.agents)?.id ?? null });
  const opened = openSwitcher(rows, delta, hold);
  if (!opened) return;
  closeTabSwitcher();
  set(opened);
  showTimer = setTimeout(() => dispatch({ type: "show" }), SESSION_SWITCHER_SHOW_MS);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("blur", onBlur);
  if (hold) window.addEventListener("keyup", onKeyUp, true);
}

export function pickSessionSwitcherRow(index: number) {
  dispatch({ type: "pick", index });
}

export function closeSessionSwitcher() {
  dispatch({ type: "escape" });
}

function dispatch(event: SwitcherEvent) {
  const next = reduceSwitcher(current, event);
  if (next.state === current && !next.action) return;
  if (!next.state) teardown();
  set(next.state);
  run(next.action);
}

function run(action: SwitcherAction) {
  if (action?.kind === "commit" && action.id) switchToSession(action.id);
}

function teardown() {
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("blur", onBlur);
  window.removeEventListener("keyup", onKeyUp, true);
}

const onKeyUp = (event: KeyboardEvent) => {
  if (event.key === "Control") dispatch({ type: "controlUp" });
};

const onBlur = () => dispatch({ type: "blur" });

function onPointerDown(event: PointerEvent) {
  if (event.target instanceof Element && event.target.closest("[data-session-switcher]")) return;
  closeSessionSwitcher();
}

function onKeyDown(event: KeyboardEvent) {
  if (!current) return;
  // 열려 있는 동안 키는 입력창과 에디터에 들어가지 않는다. Tab 은 단축키 표(⌃Tab, ⌃⇧Tab)가 받아 다음, 이전으로 옮긴다.
  const swallow = () => {
    event.preventDefault();
    event.stopPropagation();
  };
  if (event.key === "Control" || event.key === "Shift") return;
  if (event.key === "Escape") {
    swallow();
    dispatch({ type: "escape" });
  } else if (event.key === "Enter") {
    swallow();
    dispatch({ type: "enter" });
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    swallow();
    dispatch({ type: "step", delta: event.key === "ArrowDown" ? 1 : -1 });
  } else if (event.key === "Tab" && event.ctrlKey) {
    return;
  } else if (event.metaKey || event.altKey) {
    // ⌘ 나 ⌥ 를 쓴 단축키는 창을 닫고 평소대로 동작한다
    dispatch({ type: "escape" });
  } else if (current.hold && !event.ctrlKey) {
    // ⌃ 를 이미 뗐는데 keyup 을 놓친 경우의 보험
    dispatch({ type: "keyDown", ctrlKey: false });
  } else {
    swallow();
  }
}

// 세션에 포커스가 갈 때마다 최근 순서(store 의 recentAgentIds)를 갱신한다. 사이드바 클릭, 검색, 칸 클릭, ⌃⌘←→, 단축키 어느 길로 가든 활성 칸의 세션이 바뀌는 순간을 듣는다.
// openAgent 는 스스로 기록하지만 칸을 눌러 옮기거나 칸 이동 키로 가는 길은 기록하지 않아서, 이 구독이 막는다.
let tracking = false;
export function startSessionTracking() {
  if (tracking || EMBED) return;
  tracking = true;
  let last: string | null = null;
  const note = () => {
    const s = getState();
    const id = activeAgentOf(s.panes, s.activePaneId, s.agents)?.id ?? null;
    if (id === last) return;
    last = id;
    if (id) rememberRecentAgent(id);
  };
  subscribe(note);
  note();
}

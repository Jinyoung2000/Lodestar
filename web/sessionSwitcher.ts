import { useSyncExternalStore } from "react";
import { activeAgentOf } from "./activeAgentOf";
import { EMBED } from "./embed";
import { chatPaneWorkspace, chatProject } from "./editorChat";
import { openSwitcher, reduceSwitcher, switcherSessions, type SwitcherAction, type SwitcherEvent, type SwitcherState } from "./sessionSwitcherModel";
import { getState, rememberRecentAgent, subscribe, switchToSession } from "./store";
import { closeTabSwitcher } from "./tabSwitcher";

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

export function cycleSessionSwitcher(delta: 1 | -1, hold = true) {
  if (current) {
    dispatch({ type: "step", delta });
    return;
  }
  const s = getState();
  if (s.overlay) return;
  const openIds = s.panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : []));
  const active = s.panes.find((pane) => pane.id === s.activePaneId);
  const project = chatProject(chatPaneWorkspace(active, s.agents), s.workspaces);
  const agents = s.layoutMode === "editor" ? s.agents.filter((agent) => chatProject(agent.workspaceId, s.workspaces) === project) : s.agents;
  const recentIds = s.layoutMode === "editor"
    ? [...s.recentAgentIds.filter((id) => openIds.includes(id)), ...openIds, ...s.recentAgentIds]
    : s.recentAgentIds;
  const rows = switcherSessions({ agents, workspaces: s.workspaces, recentIds, openIds, activeAgentId: activeAgentOf(s.panes, s.activePaneId, s.agents)?.id ?? null });
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
    dispatch({ type: "escape" });
  } else if (current.hold && !event.ctrlKey) {
    dispatch({ type: "keyDown", ctrlKey: false });
  } else {
    swallow();
  }
}

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

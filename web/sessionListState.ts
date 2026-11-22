import { useSyncExternalStore } from "react";
import { DEFAULT_VIEW, type SessionView } from "./sessionList";
import { sidebarPeek } from "./peekController";
import { getState, revealChat, setState } from "./store";

type ListState = { view: SessionView; expanded: string[]; collapsedGroups: string[]; collapsedParents: string[]; renaming: string | null };

const VIEW_KEY = "agent-nav:sessionView";
const EXPANDED_KEY = "agent-nav:sessionGroupsExpanded";

let state: ListState = { view: loadView(), expanded: loadList(EXPANDED_KEY), collapsedGroups: ["done", "chats"], collapsedParents: [], renaming: null };
const listeners = new Set<() => void>();

export function useSessionList<T>(selector: (s: ListState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => selector(state),
  );
}

export function getSessionList() {
  return state;
}

export function setSessionView(patch: Partial<SessionView>) {
  set({ view: { ...state.view, ...patch } });
  save(VIEW_KEY, state.view);
}

export function resetSessionView() {
  set({ view: { ...DEFAULT_VIEW } });
  save(VIEW_KEY, state.view);
}

export function toggleGroupExpanded(groupId: string) {
  set({ expanded: state.expanded.includes(groupId) ? state.expanded.filter((id) => id !== groupId) : [...state.expanded, groupId] });
  save(EXPANDED_KEY, state.expanded);
}

export function toggleGroupCollapsed(groupId: string) {
  set({ collapsedGroups: toggled(state.collapsedGroups, groupId) });
}

export function setCollapsedGroups(groupIds: string[]) {
  set({ collapsedGroups: groupIds });
}

export function expandGroup(groupId: string) {
  if (state.collapsedGroups.includes(groupId)) set({ collapsedGroups: state.collapsedGroups.filter((id) => id !== groupId) });
}

export function toggleParentCollapsed(agentId: string) {
  set({ collapsedParents: toggled(state.collapsedParents, agentId) });
}

function toggled(list: string[], id: string) {
  return list.includes(id) ? list.filter((v) => v !== id) : [...list, id];
}

export function startRename(agentId: string) {
  if (getState().layoutMode !== "editor" && !sidebarPeek.isOpen()) setState({ sidebarOpen: true });
  revealChat();
  set({ renaming: agentId });
}

export function stopRename() {
  set({ renaming: null });
}

function set(patch: Partial<ListState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function loadList(key: string): string[] {
  const value = read(key);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function loadView(): SessionView {
  const saved = (read(VIEW_KEY) ?? {}) as Partial<SessionView>;
  return {
    ordering: saved.ordering === "created" || saved.ordering === "updated" ? saved.ordering : DEFAULT_VIEW.ordering,
    grouping: saved.grouping === "time" || saved.grouping === "workspace" ? saved.grouping : DEFAULT_VIEW.grouping,
    show: saved.show === "recent" || saved.show === "all" ? saved.show : DEFAULT_VIEW.show,
    showDone: saved.showDone === true,
    folderOrder: saved.folderOrder === "name" || saved.folderOrder === "recent" || saved.folderOrder === "manual" ? saved.folderOrder : DEFAULT_VIEW.folderOrder,
  };
}

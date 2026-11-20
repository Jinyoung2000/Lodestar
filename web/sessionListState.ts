import { useSyncExternalStore } from "react";
import { DEFAULT_VIEW, type SessionView } from "./sessionList";
import { sidebarPeek } from "./peekController";
import { getState, revealChat, setState } from "./store";

// B1: 사이드바 세션 목록의 보기 상태. 필터 메뉴(정렬, 묶음, 범위, 완료 표시)와 Show more 로 펼친 묶음은
// 다시 열어도 남도록 localStorage 에 저장한다. 이름 바꾸는 중인 세션은 저장하지 않는다.

// collapsedGroups 와 collapsedParents 는 이 실행 동안만 유지한다(Done, Chats 묶음은 처음에 접혀 있다. Pinned 는 고정한 세션을 바로 보이도록 처음부터 펼쳐 둔다. Chats 는 퀵 챗이 생기면 Sidebar 가 펼친다).
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

// 모두 접기와 모두 펼치기. 접을 묶음 id 를 넘기면 그것만 접히고 빈 목록이면 모두 펼쳐진다.
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

// 사이드바 행의 이름 입력을 연다. 대화 머리의 Rename... 도 이 함수를 부른다. 사이드바가 닫혀 있으면 같이 연다.
// Editor 배치(포커스 모드)에서는 앱 사이드바가 없고 대화 패널 머리의 제목이 같은 입력으로 바뀐다.
export function startRename(agentId: string) {
  // 떠 있는 사이드바에서 시작한 이름 바꾸기는 고정하지 않고 그 자리에서 한다
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
    // 저장이 막힌 환경에서는 세션 동안만 유지
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

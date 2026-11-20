import { docView, refocusActiveEditor, requestCloseTabs } from "./editorDocs";
import { groupIdsOf, groupOf, hasGroup, MAIN_GROUP, mainTabs, moveToGroup, normalizeLayout, removeGroup, SINGLE_LAYOUT, splitGroup, tabsOfGroup } from "./editorGroups";
import { evenLayout, flipLayout, groupAtIndex, groupInDirection, moveGroup, nextToJoin, planPreset, splitSpec, type LayoutPreset, type Side } from "./editorLayoutOps";
import { closable, findInGroup, shiftTarget, stepTab, stickyAnchor } from "./editorTabs";
import {
  activeKeyOfGroup,
  focusGroup,
  getState,
  moveTabToGroup,
  newGroupId,
  newSplitId,
  openDiff,
  openFile,
  popClosedTab,
  setState,
  shownTabsOf,
  splitEditor,
  type Tab,
} from "./store";
import { S } from "./strings";
import { hint } from "./hint";


type State = ReturnType<typeof getState>;

// PRTABSESSION: 보이지 않는 세션의 PR 탭은 키 이동과 닫기 대상에서 뺀다
const groupKeys = (s: State, group: string) => (group === MAIN_GROUP ? mainTabs(shownTabsOf(s)) : tabsOfGroup(shownTabsOf(s), group)).map((t) => t.key);

// --- 포커스 ---

// ⌘1 ~ ⌘8: 읽는 순서의 n 번째 그룹(0부터)에 포커스. 그룹이 모자라면 아무 일도 없다.
export function focusGroupAt(index: number) {
  const id = groupAtIndex(getState().editorLayout, index);
  if (id) focusAndSettle(id);
}

// ⌘K ⌘←/→/↑/↓: 그 방향 이웃 그룹에 포커스
export function focusGroupSide(side: Side) {
  const s = getState();
  const id = groupInDirection(s.editorLayout, s.activeGroupId, side);
  if (id) focusAndSettle(id);
}

function focusAndSettle(id: string) {
  focusGroup(id);
  requestAnimationFrame(() => {
    const key = getState().activeTabKey;
    if (key) docView(key)?.focus();
  });
}

// ⌃⌘1, ⌃⌘9: 활성 탭을 첫, 마지막 그룹으로
export function moveEditorToEdgeGroup(edge: "first" | "last") {
  const s = getState();
  const ids = groupIdsOf(s.editorLayout);
  const target = edge === "first" ? ids[0] : ids[ids.length - 1];
  const key = s.activeTabKey;
  if (!key || !s.tabs.some((t) => t.key === key)) {
    hint(S.splitNeedsTab);
    return;
  }
  if (target && target !== s.activeGroupId) {
    moveTabToGroup(key, target, null);
    refocusActiveEditor();
  }
}

// --- 그룹 만들기, 닫기, 합치기 ---

// New Editor Group Right, Left, Above, Below: 활성 그룹 옆에 빈 그룹을 만들고 거기에 포커스를 준다.
export function newEmptyGroup(side: Side) {
  const id = newGroupId();
  const { dir, before } = splitSpec(side);
  const splitId = newSplitId();
  setState((cur) => ({ editorLayout: normalizeLayout(splitGroup(cur.editorLayout, cur.activeGroupId, dir, id, splitId, before)), rightOpen: true }));
  focusGroup(id);
}

// 탭 없는 그룹을 지운다. main 은 지우지 않는다. 활성 그룹이었으면 이웃으로 포커스가 간다.
export function removeEmptyGroup(id: string): boolean {
  const s = getState();
  if (id === MAIN_GROUP || !hasGroup(s.editorLayout, id) || tabsOfGroup(s.tabs, id).length) return false;
  const ids = groupIdsOf(s.editorLayout);
  const heir = ids[ids.indexOf(id) - 1] ?? ids[ids.indexOf(id) + 1] ?? MAIN_GROUP;
  const { [id]: _gone, ...groupActive } = s.groupActive;
  const patch: Partial<State> = { editorLayout: normalizeLayout(removeGroup(s.editorLayout, id)), groupActive, maximizedGroup: s.maximizedGroup === id ? null : s.maximizedGroup };
  if (s.activeGroupId === id) {
    patch.activeGroupId = heir;
    patch.activeTabKey = activeKeyOfGroup({ ...s, groupActive, activeGroupId: id, activeTabKey: null }, heir);
  }
  setState(patch);
  return true;
}

// Close Editor Group: 그 그룹의 탭을 모두 닫는다(저장 안 한 변경은 묻는다). 빈 그룹이 되면 닫히고, main 그룹은 탭만 닫힌다.
export async function closeGroup(id: string = getState().activeGroupId): Promise<boolean> {
  const s = getState();
  if (!hasGroup(s.editorLayout, id)) return false;
  const keys = groupKeys(s, id);
  if (!keys.length) return removeEmptyGroup(id);
  const closed = await requestCloseTabs(keys);
  if (closed) removeEmptyGroup(id);
  return closed;
}

// Close All Editor Groups(⌘K ⌘⇧W): 모든 탭을 닫고 그룹 하나만 남긴다.
export async function closeAllGroups(): Promise<boolean> {
  const closed = await requestCloseTabs(shownTabsOf(getState()).map((t) => t.key));
  if (!closed) return false;
  setState((s) => {
    const groupActive: State["groupActive"] = s.groupActive[MAIN_GROUP] === undefined ? {} : { [MAIN_GROUP]: s.groupActive[MAIN_GROUP] };
    return { editorLayout: SINGLE_LAYOUT, groupActive, activeGroupId: MAIN_GROUP, maximizedGroup: null };
  });
  return true;
}

// removed 그룹들의 탭을 into 그룹 끝으로 옮기고 그룹을 지운다. 같은 파일이 into 에 이미 있으면 그 탭이 대신 남는다. main 은 지워지는 쪽에 넣지 않는다.
function collapseGroups(s: State, removed: readonly string[], into: string): Partial<State> {
  let slots = { tabs: s.tabs, filesIndex: s.filesIndex };
  let activeKey = s.activeTabKey;
  for (const from of removed) {
    for (const tab of tabsOfGroup(slots.tabs, from)) {
      const twin = findInGroup(slots.tabs, into, tab);
      if (twin) {
        slots = { tabs: slots.tabs.filter((t) => t.key !== tab.key), filesIndex: slots.filesIndex };
        if (activeKey === tab.key) activeKey = twin.key;
      } else {
        slots = moveToGroup(slots, tab.key, into, null);
      }
    }
  }
  let layout = s.editorLayout;
  for (const id of removed) layout = removeGroup(layout, id);
  const groupActive = { ...s.groupActive };
  for (const id of removed) delete groupActive[id];
  const activeRemoved = removed.includes(s.activeGroupId);
  const patch: Partial<State> = { tabs: slots.tabs, filesIndex: slots.filesIndex, editorLayout: normalizeLayout(layout), groupActive, maximizedGroup: s.maximizedGroup && removed.includes(s.maximizedGroup) ? null : s.maximizedGroup };
  if (activeRemoved) {
    patch.activeGroupId = into;
    patch.activeTabKey = activeKey ?? activeKeyOfGroup({ ...s, tabs: slots.tabs, groupActive, activeGroupId: into, activeTabKey: null }, into);
  } else {
    patch.activeTabKey = activeKey;
  }
  return patch;
}

// Join Editor Group with Next Group: 활성 그룹의 탭을 읽는 순서로 다음 그룹에 합친다. main 이 끼면 main 이 남는다.
export function joinWithNext(id: string = getState().activeGroupId) {
  const s = getState();
  const next = nextToJoin(s.editorLayout, id);
  if (!next) return;
  const keep = id === MAIN_GROUP ? id : next;
  setState((cur) => collapseGroups(cur, [keep === id ? next : id], keep));
}

// Join All Editor Groups: 모든 탭을 main 그룹 하나로 합친다.
export function joinAll() {
  const s = getState();
  const others = groupIdsOf(s.editorLayout).filter((id) => id !== MAIN_GROUP);
  if (others.length) setState((cur) => collapseGroups(cur, others, MAIN_GROUP));
}

// Toggle Maximize Editor Group: 한 그룹이 에디터 영역을 다 쓰고 나머지는 접힌다. 한 번 더 누르면 되돌아온다.
export function toggleMaximizeGroup(id: string = getState().activeGroupId) {
  setState((s) => (groupIdsOf(s.editorLayout).length < 2 ? {} : { maximizedGroup: s.maximizedGroup === id ? null : id }));
}

// --- 배치 ---

// View: Editor Layout 의 프리셋. 기존 그룹을 읽는 순서대로 새 모양에 채우고, 남는 그룹의 탭은 마지막 그룹으로 합치며, 모자라는 자리는 빈 그룹으로 만든다.
export function applyLayoutPreset(preset: LayoutPreset) {
  setState((s) => {
    const plan = planPreset(s.editorLayout, preset, newGroupId, newSplitId);
    const collapsed = collapseGroups(s, plan.removed, plan.mergeInto);
    return { ...collapsed, editorLayout: plan.layout, maximizedGroup: null };
  });
}

// Flip Editor Group Layout(⌥⌘0): 가로로 나뉜 것을 세로로, 세로를 가로로.
export function flipGroupLayout() {
  setState((s) => ({ editorLayout: flipLayout(s.editorLayout) }));
}

// Reset Editor Group Sizes: 모든 그룹을 같은 크기로.
export function evenGroupSizes() {
  setState((s) => ({ editorLayout: evenLayout(s.editorLayout), maximizedGroup: null }));
}

// Move Editor Group Left, Right, Up, Down(⌘K ←/→/↑/↓): 활성 그룹을 그 방향 이웃과 맞바꾼다.
export function moveGroupSide(side: Side) {
  const s = getState();
  const next = moveGroup(s.editorLayout, s.activeGroupId, side);
  if (next) setState({ editorLayout: next });
}

// Split Editor Up, Down, Left, Right: 활성 탭을 그 방향의 새 그룹에 복사한다.
export function splitEditorSide(side: Side, key: string | null = getState().activeTabKey) {
  const { dir, before } = splitSpec(side);
  return splitEditor(dir, key, before);
}

// --- 그룹 안의 탭 ---

// ⌘K ⌥⌘←/→: 그룹 안 이전, 다음 탭(끝에서 끝으로 이어진다)
export function stepEditorInGroup(step: 1 | -1) {
  const s = getState();
  const next = stepTab(groupKeys(s, s.activeGroupId), s.activeTabKey, step);
  if (next) setState({ activeTabKey: next });
}

// ⌥⌘←/→: 이전, 다음 에디터. 그룹 순서대로 이어서 그룹을 넘어간다.
export function stepEditor(step: 1 | -1) {
  const s = getState();
  const keys = groupIdsOf(s.editorLayout).flatMap((id) => groupKeys(s, id));
  const next = stepTab(keys, s.activeTabKey, step);
  if (next) setState({ activeTabKey: next });
}

// ⌃1 ~ ⌃9, ⌃0: 활성 그룹의 n 번째 탭, 마지막 탭(index -1)
export function openEditorAtIndex(index: number) {
  const s = getState();
  const keys = groupKeys(s, s.activeGroupId);
  const key = index === -1 ? keys[keys.length - 1] : keys[index];
  if (key) setState({ activeTabKey: key });
}

// ⌘K ⇧⌘←/→: 활성 탭을 그룹 안에서 한 칸 옮긴다
export function moveTabInGroup(step: 1 | -1) {
  const s = getState();
  const key = s.activeTabKey;
  const tab = s.tabs.find((t) => t.key === key);
  if (!key || !tab) return;
  const group = groupOf(tab);
  const target = shiftTarget(shownTabsOf(s).filter((t) => groupOf(t) === group), key, step);
  if (target !== undefined) moveTabToGroup(key, group, target);
}

export function setSticky(key: string, sticky: boolean) {
  setState((s) => {
    const tab = s.tabs.find((t) => t.key === key);
    if (!tab || !!tab.sticky === sticky) return {};
    const group = groupOf(tab);
    const { sticky: _old, preview: _preview, ...rest } = tab as Tab & { preview?: boolean };
    const updated = s.tabs.map((t) => (t.key === key ? ({ ...rest, ...(sticky ? { sticky: true } : {}) } as Tab) : t));
    const peers = group === MAIN_GROUP ? mainTabs(updated) : tabsOfGroup(updated, group);
    const moved = moveToGroup({ tabs: updated, filesIndex: s.filesIndex }, key, group, stickyAnchor(peers, key));
    return { tabs: moved.tabs, filesIndex: moved.filesIndex };
  });
}

// --- 닫기 계열 ---

export type CloseMode = "all" | "saved" | "others" | "right";

export function closeInGroup(group: string, mode: CloseMode, anchor: string | null = null): Promise<boolean> {
  const s = getState();
  const inGroup = groupKeys(s, group);
  const at = anchor ? inGroup.indexOf(anchor) : -1;
  const picked =
    mode === "all" ? inGroup : mode === "saved" ? inGroup.filter((k) => !s.dirtyTabs[k]) : mode === "others" ? inGroup.filter((k) => k !== anchor) : at === -1 ? [] : inGroup.slice(at + 1);
  const keys = closable(s.tabs, picked);
  return keys.length ? requestCloseTabs(keys) : Promise.resolve(true);
}

// Reopen Closed Editor(⇧⌘T): 가장 최근에 닫은 파일, diff 탭을 닫았던 그룹(없어졌으면 활성 그룹)에 다시 연다.
export function reopenClosedEditor(): boolean {
  for (let tab = popClosedTab(); tab; tab = popClosedTab()) {
    const s = getState();
    if (tab.kind === "file") {
      if (s.tabs.some((t) => t.kind === "file" && t.workspaceId === tab.workspaceId && t.path === tab.path && groupOf(t) === (tab.group ?? MAIN_GROUP))) continue;
      if (tab.group && hasGroup(s.editorLayout, tab.group)) focusGroup(tab.group);
      openFile({ workspaceId: tab.workspaceId, path: tab.path });
      return true;
    }
    if (tab.kind === "diff") {
      if (tab.group && hasGroup(s.editorLayout, tab.group)) focusGroup(tab.group);
      openDiff(tab.agentId, tab.workspaceId, tab.path);
      return true;
    }
  }
  hint(S.noClosedEditor);
  return false;
}

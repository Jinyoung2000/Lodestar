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

const groupKeys = (s: State, group: string) => (group === MAIN_GROUP ? mainTabs(shownTabsOf(s)) : tabsOfGroup(shownTabsOf(s), group)).map((t) => t.key);

export function focusGroupAt(index: number) {
  const id = groupAtIndex(getState().editorLayout, index);
  if (id) focusAndSettle(id);
}

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

export function newEmptyGroup(side: Side) {
  const id = newGroupId();
  const { dir, before } = splitSpec(side);
  const splitId = newSplitId();
  setState((cur) => ({ editorLayout: normalizeLayout(splitGroup(cur.editorLayout, cur.activeGroupId, dir, id, splitId, before)), rightOpen: true }));
  focusGroup(id);
}

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

export async function closeGroup(id: string = getState().activeGroupId): Promise<boolean> {
  const s = getState();
  if (!hasGroup(s.editorLayout, id)) return false;
  const keys = groupKeys(s, id);
  if (!keys.length) return removeEmptyGroup(id);
  const closed = await requestCloseTabs(keys);
  if (closed) removeEmptyGroup(id);
  return closed;
}

export async function closeAllGroups(): Promise<boolean> {
  const closed = await requestCloseTabs(shownTabsOf(getState()).map((t) => t.key));
  if (!closed) return false;
  setState((s) => {
    const groupActive: State["groupActive"] = s.groupActive[MAIN_GROUP] === undefined ? {} : { [MAIN_GROUP]: s.groupActive[MAIN_GROUP] };
    return { editorLayout: SINGLE_LAYOUT, groupActive, activeGroupId: MAIN_GROUP, maximizedGroup: null };
  });
  return true;
}

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

export function joinWithNext(id: string = getState().activeGroupId) {
  const s = getState();
  const next = nextToJoin(s.editorLayout, id);
  if (!next) return;
  const keep = id === MAIN_GROUP ? id : next;
  setState((cur) => collapseGroups(cur, [keep === id ? next : id], keep));
}

export function joinAll() {
  const s = getState();
  const others = groupIdsOf(s.editorLayout).filter((id) => id !== MAIN_GROUP);
  if (others.length) setState((cur) => collapseGroups(cur, others, MAIN_GROUP));
}

export function toggleMaximizeGroup(id: string = getState().activeGroupId) {
  setState((s) => (groupIdsOf(s.editorLayout).length < 2 ? {} : { maximizedGroup: s.maximizedGroup === id ? null : id }));
}

export function applyLayoutPreset(preset: LayoutPreset) {
  setState((s) => {
    const plan = planPreset(s.editorLayout, preset, newGroupId, newSplitId);
    const collapsed = collapseGroups(s, plan.removed, plan.mergeInto);
    return { ...collapsed, editorLayout: plan.layout, maximizedGroup: null };
  });
}

export function flipGroupLayout() {
  setState((s) => ({ editorLayout: flipLayout(s.editorLayout) }));
}

export function evenGroupSizes() {
  setState((s) => ({ editorLayout: evenLayout(s.editorLayout), maximizedGroup: null }));
}

export function moveGroupSide(side: Side) {
  const s = getState();
  const next = moveGroup(s.editorLayout, s.activeGroupId, side);
  if (next) setState({ editorLayout: next });
}

export function splitEditorSide(side: Side, key: string | null = getState().activeTabKey) {
  const { dir, before } = splitSpec(side);
  return splitEditor(dir, key, before);
}

export function stepEditorInGroup(step: 1 | -1) {
  const s = getState();
  const next = stepTab(groupKeys(s, s.activeGroupId), s.activeTabKey, step);
  if (next) setState({ activeTabKey: next });
}

export function stepEditor(step: 1 | -1) {
  const s = getState();
  const keys = groupIdsOf(s.editorLayout).flatMap((id) => groupKeys(s, id));
  const next = stepTab(keys, s.activeTabKey, step);
  if (next) setState({ activeTabKey: next });
}

export function openEditorAtIndex(index: number) {
  const s = getState();
  const keys = groupKeys(s, s.activeGroupId);
  const key = index === -1 ? keys[keys.length - 1] : keys[index];
  if (key) setState({ activeTabKey: key });
}

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

export function reopenClosedEditor({ quiet = false }: { quiet?: boolean } = {}): boolean {
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
  if (!quiet) hint(S.noClosedEditor);
  return false;
}

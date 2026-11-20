import { insertTabBefore, removeTab, type TabSlots } from "./tabOrder";

export const MAIN_GROUP = "main";

export type EditorLayout = { type: "group"; id: string } | { type: "split"; id: string; dir: "row" | "column"; children: EditorLayout[]; sizes: number[] };

export const SINGLE_LAYOUT: EditorLayout = { type: "group", id: MAIN_GROUP };

export function groupIdsOf(layout: EditorLayout): string[] {
  return layout.type === "group" ? [layout.id] : layout.children.flatMap(groupIdsOf);
}

// 화면 순서(왼쪽 위에서 오른쪽 아래)로 이전, 다음 그룹. 끝에서 끝으로 이어지지는 않는다.
export function adjacentGroup(layout: EditorLayout, id: string, step: 1 | -1): string | null {
  const ids = groupIdsOf(layout);
  const index = ids.indexOf(id);
  return index === -1 ? null : (ids[index + step] ?? null);
}

// target 그룹을 dir 방향으로 나누고 새 그룹을 뒤(오른쪽, 아래)에 둔다. before 면 앞(왼쪽, 위)에 둔다. 부모가 같은 방향이면 형제로 끼워 넣어 같은 줄이 늘어난다.
export function splitGroup(layout: EditorLayout, target: string, dir: "row" | "column", newId: string, splitId: string, before = false): EditorLayout {
  const fresh: EditorLayout = { type: "group", id: newId };
  if (layout.type === "group") {
    if (layout.id !== target) return layout;
    return { type: "split", id: splitId, dir, children: before ? [fresh, layout] : [layout, fresh], sizes: [0.5, 0.5] };
  }
  const index = layout.children.findIndex((c) => c.type === "group" && c.id === target);
  if (index !== -1 && layout.dir === dir) {
    const share = layout.sizes[index] / 2;
    const at = before ? index : index + 1;
    const children = [...layout.children.slice(0, at), fresh, ...layout.children.slice(at)];
    const sizes = [...layout.sizes.slice(0, index), share, share, ...layout.sizes.slice(index + 1)];
    return { ...layout, children, sizes };
  }
  return { ...layout, children: layout.children.map((c) => splitGroup(c, target, dir, newId, splitId, before)) };
}

// 그룹을 지운다. 그 몫의 크기는 이웃이 가져가고, 자식이 하나 남은 분할은 그 자식으로 접는다. 마지막 그룹은 지우지 않는다.
export function removeGroup(layout: EditorLayout, id: string): EditorLayout {
  if (layout.type === "group") return layout;
  const index = layout.children.findIndex((c) => c.type === "group" && c.id === id);
  if (index !== -1) {
    const children = layout.children.filter((_, i) => i !== index);
    const gone = layout.sizes[index];
    const sizes = layout.sizes.filter((_, i) => i !== index);
    const heir = Math.min(index, sizes.length - 1);
    sizes[heir] += gone;
    return children.length === 1 ? children[0] : { ...layout, children, sizes };
  }
  const children = layout.children.map((c) => removeGroup(c, id));
  const flat = children.length === 1 ? children[0] : { ...layout, children };
  return flat;
}

// 같은 방향의 분할이 겹쳐 있으면 하나로 편다(자식 분할의 크기는 부모 몫만큼 줄여 이어 붙인다).
export function normalizeLayout(layout: EditorLayout): EditorLayout {
  if (layout.type === "group") return layout;
  const children: EditorLayout[] = [];
  const sizes: number[] = [];
  layout.children.forEach((raw, i) => {
    const child = normalizeLayout(raw);
    if (child.type === "split" && child.dir === layout.dir) {
      child.children.forEach((c, j) => {
        children.push(c);
        sizes.push(layout.sizes[i] * child.sizes[j]);
      });
    } else {
      children.push(child);
      sizes.push(layout.sizes[i]);
    }
  });
  return children.length === 1 ? children[0] : { ...layout, children, sizes };
}

export function setSplitSizes(layout: EditorLayout, splitId: string, sizes: number[]): EditorLayout {
  if (layout.type === "group") return layout;
  if (layout.id === splitId) return layout.sizes.length === sizes.length ? { ...layout, sizes } : layout;
  return { ...layout, children: layout.children.map((c) => setSplitSizes(c, splitId, sizes)) };
}

export function hasGroup(layout: EditorLayout, id: string): boolean {
  return groupIdsOf(layout).includes(id);
}

// --- 탭 배치 ---

export type GroupedTab = { key: string; group?: string };
export type TabState<T extends GroupedTab> = TabSlots<T>;

export const groupOf = (tab: GroupedTab | undefined) => tab?.group ?? MAIN_GROUP;
export const mainTabs = <T extends GroupedTab>(tabs: readonly T[]) => tabs.filter((t) => !t.group);
export const tabsOfGroup = <T extends GroupedTab>(tabs: readonly T[], group: string) => tabs.filter((t) => groupOf(t) === group);

// 탭을 다른 그룹(또는 같은 그룹 안 다른 자리)으로 옮긴다. filesIndex 는 main 그룹 탭 목록 기준이다.
// 반환하는 tabs 는 main 그룹 탭이 앞, 나머지가 뒤다(그룹 사이의 전체 순서는 뜻이 없고 그룹 안 상대 순서만 뜻이 있다).
export function moveToGroup<T extends GroupedTab>(state: TabState<T>, key: string, group: string, beforeKey: string | null): TabState<T> {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab) return state;
  const main = mainTabs(state.tabs);
  const others = state.tabs.filter((t) => t.group);
  const source = groupOf(tab);
  const moved: T = group === MAIN_GROUP ? withoutGroup(tab) : { ...tab, group };
  let nextMain = { tabs: main, filesIndex: state.filesIndex };
  let nextOthers = others;
  if (source === MAIN_GROUP) nextMain = removeTab(nextMain, key);
  else nextOthers = nextOthers.filter((t) => t.key !== key);
  if (group === MAIN_GROUP) nextMain = insertTabBefore(nextMain, moved, beforeKey);
  else {
    const list = tabsOfGroup(nextOthers, group);
    const rest = nextOthers.filter((t) => groupOf(t) !== group);
    const index = beforeKey === null ? list.length : list.findIndex((t) => t.key === beforeKey);
    const at = index === -1 ? list.length : index;
    nextOthers = [...rest, ...list.slice(0, at), moved, ...list.slice(at)];
  }
  return { tabs: [...nextMain.tabs, ...nextOthers], filesIndex: nextMain.filesIndex };
}

function withoutGroup<T extends GroupedTab>(tab: T): T {
  const { group: _gone, ...rest } = tab;
  return rest as T;
}

// 그룹 안에서 키 하나를 닫을 때 다음에 활성이 될 탭: 닫힌 자리의 오른쪽, 없으면 왼쪽. 그룹에 남은 게 없으면 null.
export function neighborAfterClose(groupKeys: readonly string[], closedKey: string): string | null {
  const index = groupKeys.indexOf(closedKey);
  const rest = groupKeys.filter((k) => k !== closedKey);
  return rest[Math.min(Math.max(index, 0), rest.length - 1)] ?? null;
}

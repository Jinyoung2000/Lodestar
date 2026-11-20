import { groupOf } from "./editorGroups";
import { mruOrder } from "./editorTabs";


export type SwitcherScope = "group" | "all";

export type SwitcherRow = { key: string; group: string; groupName: string | null; header: boolean };

export type SwitcherInput = {
  scope: SwitcherScope;
  activeGroup: string;
  activeKey: string | null;
  // 에디터 탭만(Changes, Files 같은 고정 탭은 뺀다)
  tabs: readonly { key: string; group?: string }[];
  // 격자에 나타나는 순서의 그룹 id (groupIdsOf). "Group N" 의 N 은 여기서 정한다.
  groupOrder: readonly string[];
  // 가장 최근이 뒤. 그룹 범위는 그 그룹의 목록, 전체 범위는 tabMru 의 ALL_GROUPS 목록.
  mru: readonly string[];
};

export const groupLabel = (n: number) => `Group ${n}`;

export function switcherRows({ scope, activeGroup, activeKey, tabs, groupOrder, mru }: SwitcherInput): SwitcherRow[] {
  const pool = scope === "group" ? tabs.filter((t) => groupOf(t) === activeGroup) : orderedByGroup(tabs, groupOrder);
  const keys = mruOrder(mru, pool.map((t) => t.key), activeKey);
  const groupByKey = new Map(pool.map((t) => [t.key, groupOf(t)]));
  const named = groupOrder.length > 1;
  return markHeaders(keys.map((key) => {
    const group = groupByKey.get(key) ?? activeGroup;
    return { key, group, groupName: named ? groupLabel(groupOrder.indexOf(group) + 1) : null, header: false };
  }));
}

function markHeaders(rows: SwitcherRow[]): SwitcherRow[] {
  return rows.map((row, i) => ({ ...row, header: row.groupName !== null && (i === 0 || rows[i - 1].group !== row.group) }));
}

// 최근 기록이 없는 탭이 뒤에 붙는 순서: 그룹 격자 순서, 그룹 안은 탭 순서
function orderedByGroup<T extends { key: string; group?: string }>(tabs: readonly T[], groupOrder: readonly string[]): T[] {
  const rank = (t: T) => {
    const at = groupOrder.indexOf(groupOf(t));
    return at === -1 ? groupOrder.length : at;
  };
  return tabs.map((tab, index) => ({ tab, index })).sort((a, b) => rank(a.tab) - rank(b.tab) || a.index - b.index).map((x) => x.tab);
}

// 열릴 때 고르는 행: ⌃Tab 은 둘째(직전 에디터), ⌃⇧Tab 은 마지막(itemActivation SECOND, LAST). 행이 하나뿐이면 그 행.
export function openingIndex(count: number, from: "second" | "last"): number {
  if (count <= 0) return 0;
  return from === "last" ? count - 1 : Math.min(1, count - 1);
}

// 목록 끝에서 처음으로 이어진다(quick input list 의 focusNext/Previous 는 loop)
export function stepIndex(index: number, count: number, step: number): number {
  if (count <= 0) return 0;
  return (((index + step) % count) + count) % count;
}

// 행의 닫기 단추로 탭을 닫은 뒤 목록: 닫은 행을 빼고(구분 행은 다시 매긴다) 고른 행은 같은 탭을 유지한다.
export function withoutRow(rows: readonly SwitcherRow[], index: number, key: string): { rows: SwitcherRow[]; index: number } {
  const at = rows.findIndex((r) => r.key === key);
  if (at === -1) return { rows: [...rows], index };
  const next = markHeaders(rows.filter((_, i) => i !== at));
  const kept = at < index ? index - 1 : index;
  return { rows: next, index: next.length ? Math.min(kept, next.length - 1) : 0 };
}

export function tabDescription(path: string | undefined): string {
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

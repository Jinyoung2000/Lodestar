import { groupOf } from "./editorGroups";
import { mruOrder } from "./editorTabs";


export type SwitcherScope = "group" | "all";

export type SwitcherRow = { key: string; group: string; groupName: string | null; header: boolean };

export type SwitcherInput = {
  scope: SwitcherScope;
  activeGroup: string;
  activeKey: string | null;
  tabs: readonly { key: string; group?: string }[];
  groupOrder: readonly string[];
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

function orderedByGroup<T extends { key: string; group?: string }>(tabs: readonly T[], groupOrder: readonly string[]): T[] {
  const rank = (t: T) => {
    const at = groupOrder.indexOf(groupOf(t));
    return at === -1 ? groupOrder.length : at;
  };
  return tabs.map((tab, index) => ({ tab, index })).sort((a, b) => rank(a.tab) - rank(b.tab) || a.index - b.index).map((x) => x.tab);
}

export function openingIndex(count: number, from: "second" | "last"): number {
  if (count <= 0) return 0;
  return from === "last" ? count - 1 : Math.min(1, count - 1);
}

export function stepIndex(index: number, count: number, step: number): number {
  if (count <= 0) return 0;
  return (((index + step) % count) + count) % count;
}

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

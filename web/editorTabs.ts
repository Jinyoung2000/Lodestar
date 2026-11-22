import { groupOf } from "./editorGroups";

export const baseKeyOf = (key: string) => key.replace(/#\d+$/, "");

export const renamedKey = (newBase: string, oldKey: string) => `${newBase}${oldKey.slice(baseKeyOf(oldKey).length)}`;

export function uniqueKey(existing: readonly string[], base: string): string {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}#${n}`)) return `${base}#${n}`;
}

type Keyed = { key: string; kind: string; group?: string; sticky?: boolean; preview?: boolean };

export function sameContent(a: Keyed, b: Keyed): boolean {
  return a.kind === b.kind && DUPLICABLE.has(a.kind) && baseKeyOf(a.key) === baseKeyOf(b.key);
}

const DUPLICABLE = new Set(["file", "diff", "scm", "replace"]);
export const isDuplicable = (tab: Pick<Keyed, "kind">) => DUPLICABLE.has(tab.kind);

export function findInGroup<T extends Keyed>(tabs: readonly T[], group: string, like: Keyed): T | undefined {
  return tabs.find((t) => groupOf(t) === group && sameContent(t, like));
}

export function clampDrop(groupTabs: readonly Keyed[], dragged: Keyed, beforeKey: string | null): string | null {
  const others = groupTabs.filter((t) => t.key !== dragged.key);
  const firstLoose = others.find((t) => !t.sticky)?.key ?? null;
  if (dragged.sticky) {
    const target = beforeKey === null ? undefined : others.find((t) => t.key === beforeKey);
    return !target || !target.sticky ? firstLoose : beforeKey;
  }
  const target = beforeKey === null ? undefined : others.find((t) => t.key === beforeKey);
  return target?.sticky ? firstLoose : beforeKey;
}

export function stickyAnchor(groupTabs: readonly Keyed[], key: string): string | null {
  return groupTabs.find((t) => t.key !== key && !t.sticky)?.key ?? null;
}

export function closable(tabs: readonly Keyed[], keys: readonly string[]): string[] {
  const sticky = new Set(tabs.filter((t) => t.sticky).map((t) => t.key));
  return keys.filter((k) => !sticky.has(k));
}

export function stepTab(keys: readonly string[], active: string | null, step: 1 | -1): string | null {
  if (keys.length < 2) return null;
  const index = active === null ? -1 : keys.indexOf(active);
  if (index === -1) return keys[step === 1 ? 0 : keys.length - 1];
  return keys[(index + step + keys.length) % keys.length];
}

export function shiftTarget(groupTabs: readonly Keyed[], key: string, step: 1 | -1): string | null | undefined {
  const index = groupTabs.findIndex((t) => t.key === key);
  if (index === -1) return undefined;
  const tab = groupTabs[index];
  const swapWith = groupTabs[index + step];
  if (!swapWith || !!swapWith.sticky !== !!tab.sticky) return undefined;
  if (step === -1) return swapWith.key;
  return groupTabs[index + 2]?.key ?? null;
}

export function mruOrder(mru: readonly string[], groupKeys: readonly string[], active: string | null): string[] {
  const live = new Set(groupKeys);
  const recent = [...mru].reverse().filter((k, i, all) => live.has(k) && all.indexOf(k) === i);
  const head = active && live.has(active) ? [active, ...recent.filter((k) => k !== active)] : recent;
  return [...head, ...groupKeys.filter((k) => !head.includes(k))];
}

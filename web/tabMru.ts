import { neighborAfterClose } from "./editorGroups";
export type TabMru = Record<string, readonly string[]>;

const MAX = 50;

export function touchTab(mru: TabMru, group: string, key: string): TabMru {
  const list = mru[group] ?? [];
  if (list[list.length - 1] === key) return mru;
  return { ...mru, [group]: [...list.filter((k) => k !== key), key].slice(-MAX) };
}

export function noteActive(mru: TabMru, prev: { group: string; key: string | null }, next: { group: string; key: string | null }): TabMru {
  let out = mru;
  if (prev.key && !(out[prev.group] ?? []).includes(prev.key)) out = touchTab(out, prev.group, prev.key);
  if (next.key) out = touchTab(out, next.group, next.key);
  if (prev.key && !(out[ALL_GROUPS] ?? []).includes(prev.key)) out = touchTab(out, ALL_GROUPS, prev.key);
  if (next.key) out = touchTab(out, ALL_GROUPS, next.key);
  return out;
}

export const ALL_GROUPS = "*";

export function recentAfterClose(mru: TabMru, group: string, closing: string, available: readonly string[]): string | null {
  const list = mru[group] ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] !== closing && available.includes(list[i])) return list[i];
  return null;
}

export function pickAfterClose(mru: TabMru, group: string, closing: string, siblings: readonly string[], fallback: string | null): string | null {
  return recentAfterClose(mru, group, closing, siblings) ?? neighborAfterClose(siblings, closing) ?? fallback;
}

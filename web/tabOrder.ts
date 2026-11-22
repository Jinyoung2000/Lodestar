export type TabSlots<T> = { tabs: T[]; filesIndex: number };

export function insertNextToActive<T extends { key: string }>({ tabs, filesIndex }: TabSlots<T>, activeKey: string, tab: T): TabSlots<T> {
  const index = tabs.findIndex((t) => t.key === activeKey);
  const at = activeKey === "changes" ? 0 : index === -1 ? filesIndex : index + 1;
  const before = activeKey === "changes" || (index !== -1 && index < filesIndex);
  return { tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], filesIndex: before ? filesIndex + 1 : filesIndex };
}

export function removedFilesIndex(tabs: readonly { key: string }[], filesIndex: number, closedKey: string): number {
  const index = tabs.findIndex((t) => t.key === closedKey);
  return index !== -1 && index < filesIndex ? filesIndex - 1 : filesIndex;
}

export function moveTab<T extends { key: string }>(slots: TabSlots<T>, key: string, beforeKey: string | null): TabSlots<T> {
  const tab = slots.tabs.find((t) => t.key === key);
  if (!tab) return slots;
  const removed = removeTab(slots, key);
  return insertTabBefore(removed, tab, beforeKey);
}

export function removeTab<T extends { key: string }>({ tabs, filesIndex }: TabSlots<T>, key: string): TabSlots<T> {
  const next = tabs.filter((t) => t.key !== key);
  return { tabs: next, filesIndex: Math.min(removedFilesIndex(tabs, filesIndex, key), next.length) };
}

export function insertTabBefore<T extends { key: string }>({ tabs, filesIndex }: TabSlots<T>, tab: T, beforeKey: string | null): TabSlots<T> {
  let at: number;
  let before: boolean;
  if (beforeKey === null) {
    at = tabs.length;
    before = false;
  } else if (beforeKey === "changes") {
    at = 0;
    before = true;
  } else if (beforeKey === "files") {
    at = filesIndex;
    before = true;
  } else if (beforeKey === "card" || beforeKey === "scm" || beforeKey === "search") {
    at = filesIndex;
    before = false;
  } else {
    const index = tabs.findIndex((t) => t.key === beforeKey);
    at = index === -1 ? tabs.length : index;
    before = at < filesIndex;
  }
  return { tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], filesIndex: before ? filesIndex + 1 : filesIndex };
}

export type TabSlots<T> = { tabs: T[]; filesIndex: number };

export function insertNextToActive<T extends { key: string }>({ tabs, filesIndex }: TabSlots<T>, activeKey: string, tab: T): TabSlots<T> {
  const index = tabs.findIndex((t) => t.key === activeKey);
  // 변경 탭이 활성이면 tabs 의 맨 앞(변경 바로 뒤). 그 밖의 고정 탭(파일, 카드, 인박스)이 활성이면 파일 탭 바로 뒤(filesIndex)다.
  const at = activeKey === "changes" ? 0 : index === -1 ? filesIndex : index + 1;
  const before = activeKey === "changes" || (index !== -1 && index < filesIndex);
  return { tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], filesIndex: before ? filesIndex + 1 : filesIndex };
}

// 탭을 닫을 때 파일 탭 앞에 있던 탭이면 filesIndex 도 하나 줄인다.
export function removedFilesIndex(tabs: readonly { key: string }[], filesIndex: number, closedKey: string): number {
  const index = tabs.findIndex((t) => t.key === closedKey);
  return index !== -1 && index < filesIndex ? filesIndex - 1 : filesIndex;
}

// 탭 하나를 끌어서 옮긴다. beforeKey 는 놓은 자리 바로 뒤에 오는 요소의 키이고 null 이면 줄 맨 끝이다.
// 줄 안의 요소는 changes | tabs[0..filesIndex) | files | card | tabs[filesIndex..) 순서다. 고정 요소(changes, files, card)는 움직이지 않고 놓을 자리의 기준만 된다:
// changes 앞은 첫 탭 자리, files 앞은 파일 탭 앞 구역의 끝, card 앞은 파일 탭 뒤 구역의 첫 자리다.
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

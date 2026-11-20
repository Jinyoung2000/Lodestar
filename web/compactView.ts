import { useSyncExternalStore } from "react";

// 사이드바 더보기 메뉴의 Compact View. 켜면 세션 행이 한 줄(제목과 오른쪽 끝 시간만)이 된다. 기본은 꺼짐이고 localStorage 에 저장한다.
// 행 모양은 styles.css 의 html[data-compact-view="true"] 규칙이 정하므로, 여기서는 <html> 속성만 맞춘다.

const KEY = "agent-nav.compactView";
const listeners = new Set<() => void>();

export function useCompactView(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, isCompactView, () => false);
  return [on, setCompactView];
}

export function isCompactView(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setCompactView(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // 저장이 막혀도 이번 실행 동안은 속성으로 유지한다.
  }
  document.documentElement.dataset.compactView = String(on);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

document.documentElement.dataset.compactView = String(isCompactView());

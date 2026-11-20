import { useSyncExternalStore } from "react";
import { parseFocusSideWidth } from "./focusLayout";

// 포커스 모드(Editor 중심)의 왼쪽 사이드바 폭. 끌어서 바꾼 값을 다음 실행에도 남기도록 localStorage 에 둔다(전역 하나, 세션별이 아니다).
// 대화 패널 폭은 세션별로 기억하므로 store 의 chatDockWidth 에 있다.
const WIDTH_KEY = "agent-nav:focus-side-width";

function read(): number | null {
  try {
    return parseFocusSideWidth(localStorage.getItem(WIDTH_KEY));
  } catch {
    return null;
  }
}

let width: number | null = read();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useFocusSideWidth = () => useSyncExternalStore(subscribe, () => width);

// null 은 기본 폭(더블클릭)
export function setFocusSideWidth(next: number | null) {
  if (next === width) return;
  width = next;
  try {
    if (next === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(next));
  } catch {
    // 저장이 막혀도 이번 실행에서는 그대로 동작한다
  }
  for (const listener of listeners) listener();
}

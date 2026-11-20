import { useSyncExternalStore } from "react";
import { DEFAULT_LAYOUT_CONFIG, isDefaultLayoutConfig, parseLayoutConfig, restoredLayoutConfig, type LayoutConfig } from "./layoutConfig";

// Customize Layout 의 값(Primary Side Bar 위치, Panel 정렬, Activity Bar). 창을 다시 열어도 남도록 localStorage 에 둔다.
// 사이드바와 Panel 의 열림 여부는 여기 없다: 세션별 배치 기억(web/sessionLayout.ts)과 창 상태 저장본이 맡는다.
// 저장이 막힌 환경(사생활 보호 창, 미리보기)에서는 이번 실행 동안만 유지한다.
const KEY = "agent-nav:layout-config";

function read(): LayoutConfig {
  try {
    return parseLayoutConfig(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_LAYOUT_CONFIG;
  }
}

function write(config: LayoutConfig) {
  try {
    // 기본값이면 키를 지운다(예전 실행과 같은 상태로 돌아간다)
    if (isDefaultLayoutConfig(config)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    // 저장이 막혀도 화면은 그대로 동작한다
  }
}

let state: LayoutConfig = read();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function replace(next: LayoutConfig) {
  if (next.sideBar === state.sideBar && next.panelAlignment === state.panelAlignment && next.activityBar === state.activityBar) return;
  state = next;
  for (const listener of listeners) listener();
}

export const getLayoutConfig = () => state;
export const useLayoutConfig = () => useSyncExternalStore(subscribe, () => state);

export function setLayoutConfig(patch: Partial<LayoutConfig>) {
  const next = { ...state, ...patch };
  write(next);
  replace(next);
}

export function resetLayoutConfig() {
  const next = restoredLayoutConfig();
  write(next);
  replace(next);
}

// 같은 앱의 다른 창이 바꾼 값을 따라간다(localStorage 는 창끼리 공유되고 storage 이벤트는 바꾼 창 밖에서만 온다).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) replace(read());
  });
}

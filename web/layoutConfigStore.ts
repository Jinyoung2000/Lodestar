import { useSyncExternalStore } from "react";
import { DEFAULT_LAYOUT_CONFIG, isDefaultLayoutConfig, parseLayoutConfig, restoredLayoutConfig, type LayoutConfig } from "./layoutConfig";

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
    if (isDefaultLayoutConfig(config)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
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

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) replace(read());
  });
}

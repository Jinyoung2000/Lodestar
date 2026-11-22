import { useSyncExternalStore } from "react";

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
  }
  document.documentElement.dataset.compactView = String(on);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

document.documentElement.dataset.compactView = String(isCompactView());

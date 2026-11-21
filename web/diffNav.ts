import { useSyncExternalStore } from "react";

export type DiffFileAction = { label: string; run: () => void };

export type DiffNav = {
  step: (direction: 1 | -1) => void;
  openFile: () => void;
  fileAction?: DiffFileAction;
};

const navs = new Map<string, DiffNav>();
const listeners = new Set<() => void>();

export function registerDiffNav(tabKey: string, nav: DiffNav): () => void {
  navs.set(tabKey, nav);
  listeners.forEach((listener) => listener());
  return () => {
    if (navs.get(tabKey) !== nav) return;
    navs.delete(tabKey);
    listeners.forEach((listener) => listener());
  };
}

export function useDiffNav(tabKey: string | null): DiffNav | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => (tabKey ? (navs.get(tabKey) ?? null) : null),
  );
}

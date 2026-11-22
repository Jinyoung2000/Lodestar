import { useSyncExternalStore } from "react";

let owner: string | null = null;
const listeners = new Set<() => void>();

export function expandPreview(id: string | null) {
  if (id === owner) return;
  owner = id;
  for (const notify of listeners) notify();
}

export function releasePreview(id: string) {
  if (owner === id) expandPreview(null);
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

export function useExpandedPreview() {
  return useSyncExternalStore(subscribe, () => owner);
}

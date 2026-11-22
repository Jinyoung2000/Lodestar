import { useSyncExternalStore } from "react";

export type ChordHintState = { kind: "waiting" | "miss"; text: string } | null;

let current: ChordHintState = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function setChordHint(next: ChordHintState, clearAfterMs?: number) {
  if (timer) clearTimeout(timer);
  timer = null;
  current = next;
  for (const listener of listeners) listener();
  if (next && clearAfterMs) timer = setTimeout(() => setChordHint(null), clearAfterMs);
}

export function useChordHint(): ChordHintState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

import { useSyncExternalStore } from "react";

export type Announcement = { polite: string; urgent: string; nonce: number };

let current: Announcement = { polite: "", urgent: "", nonce: 0 };
const listeners = new Set<() => void>();

export function announce(text: string, urgent = false) {
  current = { polite: urgent ? "" : text, urgent: urgent ? text : "", nonce: current.nonce + 1 };
  for (const listener of listeners) listener();
}

export function useAnnouncement(): Announcement {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

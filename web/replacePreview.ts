import { useSyncExternalStore } from "react";
import { openReplacePreviewTab } from "./store";
import type { SearchHit } from "./searchTree";


export type PreviewReveal = { line: number; start: number; end: number; nonce: number };

const reveals = new Map<string, PreviewReveal>();
const listeners = new Set<() => void>();
let nonce = 0;

export function openReplacePreview(workspaceId: string, hit: SearchHit, options: { pinned: boolean; preserveFocus: boolean; side?: boolean }) {
  const key = openReplacePreviewTab(workspaceId, hit.path, { preview: !options.pinned && !options.side, side: options.side, keepDrawer: true });
  if (!key) return;
  reveals.set(key, { line: hit.line, start: hit.start, end: hit.end, nonce: ++nonce });
  for (const listener of listeners) listener();
}

export function useReveal(key: string): PreviewReveal | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => reveals.get(key),
  );
}

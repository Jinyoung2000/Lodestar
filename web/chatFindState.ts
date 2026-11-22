import { useSyncExternalStore } from "react";
import type { ChatFindOptions } from "./chatFindModel";

export type ChatFindState = { paneId: string | null; nonce: number; query: string; options: ChatFindOptions };

let state: ChatFindState = { paneId: null, nonce: 0, query: "", options: { caseSensitive: false, wholeWord: false, regexp: false } };
const listeners = new Set<() => void>();

function set(next: Partial<ChatFindState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function useChatFind(): ChatFindState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

export function useChatFindOpen(paneId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state.paneId === paneId,
  );
}

export function openChatFind(paneId: string) {
  const selection = window.getSelection();
  const text = selection?.toString() ?? "";
  const inTimeline = !!selection?.anchorNode && !!(selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement)?.closest(".timeline");
  const seed = inTimeline && text && !text.includes("\n") && text.length <= 200 ? text : null;
  set({ paneId, nonce: state.nonce + 1, ...(seed === null ? {} : { query: seed }) });
}

export function closeChatFind() {
  if (state.paneId !== null) set({ paneId: null });
}

export const setChatFindQuery = (query: string) => set({ query });
export const toggleChatFindOption = (key: keyof ChatFindOptions) => set({ options: { ...state.options, [key]: !state.options[key] } });

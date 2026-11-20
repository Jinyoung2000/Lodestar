import { useSyncExternalStore } from "react";
import type { ChatFindOptions } from "./chatFindModel";

// Q2: 대화 안 찾기의 열림 상태. 한 번에 한 칸만 열려 있다(일치 강조가 문서 하나에 하나뿐이라서). 검색어와 옵션은 닫았다 열어도 남는다.
export type ChatFindState = { paneId: string | null; nonce: number; query: string; options: ChatFindOptions };

let state: ChatFindState = { paneId: null, nonce: 0, query: "", options: { caseSensitive: false, wholeWord: false, regexp: false } };
const listeners = new Set<() => void>();

function set(next: Partial<ChatFindState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export const getChatFind = () => state;

export function useChatFind(): ChatFindState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

// 이 칸에 찾기가 열려 있는지만 본다. 검색어가 바뀔 때마다 대화 전체가 다시 그려지지 않게 한다.
export function useChatFindOpen(paneId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state.paneId === paneId,
  );
}

// 대화 글에서 한 줄을 선택해 둔 채 열면 그 글이 검색어가 된다(편집기 찾기와 같다).
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

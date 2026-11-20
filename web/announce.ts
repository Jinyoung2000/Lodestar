import { useSyncExternalStore } from "react";

// 화면 낭독기에 읽어 줄 안내(응답 완료, 승인 요청). LiveAnnouncer 가 보이지 않는 aria-live 영역에 그린다.
// urgent 는 role="alert" 영역으로 가서 읽던 것을 끊고 바로 읽는다. 같은 문장이 다시 와도 nonce 가 바뀌어 다시 읽힌다.
export type Announcement = { polite: string; urgent: string; nonce: number };

let current: Announcement = { polite: "", urgent: "", nonce: 0 };
const listeners = new Set<() => void>();

export function announce(text: string, urgent = false) {
  current = { polite: urgent ? "" : text, urgent: urgent ? text : "", nonce: current.nonce + 1 };
  for (const listener of listeners) listener();
}

export function currentAnnouncement(): Announcement {
  return current;
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

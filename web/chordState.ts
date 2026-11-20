import { useSyncExternalStore } from "react";

// chord(⌘K 다음 키) 상태 안내. 알림 쌓임(토스트)이 아니라 창 아래 가운데에 잠깐 뜨는 한 줄 상태다(web/ChordHint.tsx).
// waiting 은 두 번째 키를 기다리는 중(1.5초 뒤 스스로 사라진다), miss 는 표에 없는 두 번째 키를 눌러 취소된 것을 알린다.
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

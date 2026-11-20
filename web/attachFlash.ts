import { useSyncExternalStore } from "react";

// 이미 붙어 있는 칩을 다시 붙이려 했을 때 그 칩을 잠깐 강조한다(토스트 없이). 칩 id 와 시각을 모듈 안에 두고 입력창이 구독한다.
// 애니메이션이 아니라 타이머로 끝내서, 동작 줄이기 설정에서 애니메이션이 꺼져 있어도 같은 시간 동안 강조 표시가 남았다가 사라진다.
export const ATTACH_FLASH_MS = 900;

let current: { id: string; nonce: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function flashAttachment(id: string) {
  current = { id, nonce: (current?.nonce ?? 0) + 1 };
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, ATTACH_FLASH_MS);
  emit();
}

// 지금 강조 중인 칩. 같은 칩을 다시 눌러도 nonce 가 달라져 강조가 처음부터 다시 시작한다.
export function useFlashingAttachment() {
  return useSyncExternalStore(subscribe, () => current);
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

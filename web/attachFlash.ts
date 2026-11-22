import { useSyncExternalStore } from "react";

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

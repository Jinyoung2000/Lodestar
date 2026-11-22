import { useSyncExternalStore } from "react";
import { parseFocusSideWidth } from "./focusLayout";

const WIDTH_KEY = "agent-nav:focus-side-width";

function read(): number | null {
  try {
    return parseFocusSideWidth(localStorage.getItem(WIDTH_KEY));
  } catch {
    return null;
  }
}

let width: number | null = read();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useFocusSideWidth = () => useSyncExternalStore(subscribe, () => width);

export function setFocusSideWidth(next: number | null) {
  if (next === width) return;
  width = next;
  try {
    if (next === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(next));
  } catch {
  }
  for (const listener of listeners) listener();
}

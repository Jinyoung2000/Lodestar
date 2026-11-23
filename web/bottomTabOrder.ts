import { useSyncExternalStore } from "react";

export type BottomTab = "output" | "problems" | "terminal";

const DEFAULT_ORDER: readonly BottomTab[] = ["output", "problems", "terminal"];
const ORDER_KEY = "agent-nav:bottomTabOrder";
const listeners = new Set<() => void>();
let order: readonly BottomTab[] = loadOrder();

function loadOrder(): readonly BottomTab[] {
  try {
    const saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as unknown;
    if (!Array.isArray(saved)) return DEFAULT_ORDER;
    const kept = saved.filter((tab): tab is BottomTab => DEFAULT_ORDER.includes(tab as BottomTab));
    const unique = [...new Set(kept)];
    return [...unique, ...DEFAULT_ORDER.filter((tab) => !unique.includes(tab))];
  } catch {
    return DEFAULT_ORDER;
  }
}

export function moveBottomTab(tab: BottomTab, before: BottomTab | null) {
  if (tab === before) return;
  const rest = order.filter((item) => item !== tab);
  const index = before ? rest.indexOf(before) : -1;
  const next = index < 0 ? [...rest, tab] : [...rest.slice(0, index), tab, ...rest.slice(index)];
  if (next.every((item, i) => item === order[i])) return;
  order = next;
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBottomTabOrder(): readonly BottomTab[] {
  return useSyncExternalStore(subscribe, () => order);
}

import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";
import { asyncCache, loadPref } from "./storage";

export type ThemeChoice = "system" | "light" | "dark" | "midnight";

let choice: ThemeChoice | null = null;
let loading: Promise<void> | undefined;
let writing = Promise.resolve();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function apply(next: ThemeChoice) {
  Appearance.setColorScheme(next === "midnight" ? "dark" : next === "system" ? "auto" : next);
  choice = next;
  for (const listener of listeners) listener();
}

export function loadThemeChoice() {
  loading ??= loadPref<unknown>("theme", "system").then((saved) => {
    if (choice === null) apply(saved === "light" || saved === "dark" || saved === "midnight" ? saved : "system");
  });
  return loading;
}

export function setThemeChoice(next: ThemeChoice) {
  if (choice === next) return;
  apply(next);
  writing = writing.then(() => asyncCache.set("pref:theme", JSON.stringify(next))).catch((error) => {
    console.warn("Could not save theme preference", error);
  });
}

export function useThemeChoice() {
  return useSyncExternalStore(subscribe, () => choice);
}

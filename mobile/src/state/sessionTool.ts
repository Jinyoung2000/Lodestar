import { useSyncExternalStore } from "react";
import { loadPref, savePref } from "./storage";

export const SESSION_TOOLS = ["claude", "codex"] as const;
export type SessionTool = (typeof SESSION_TOOLS)[number];

let tool: SessionTool | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function apply(next: SessionTool) {
  if (tool === next) return;
  tool = next;
  for (const listener of listeners) listener();
}

export async function loadSessionTool() {
  const saved = await loadPref<unknown>("sessionTool", "claude");
  if (tool === undefined) apply(saved === "codex" ? "codex" : "claude");
}

export function setSessionTool(next: SessionTool) {
  apply(next);
  savePref("sessionTool", next);
}

export function useSessionTool() {
  return useSyncExternalStore(subscribe, () => tool ?? "claude");
}

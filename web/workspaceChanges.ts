import { useEffect, useSyncExternalStore } from "react";
import type { ChangedFile } from "../shared/protocol";
import { rpc } from "./rpc";
import { useStore } from "./store";
import { onWorkspaceChanged } from "./workspaceEvents";

const cache = new Map<string, ChangedFile[]>();
const sequence = new Map<string, number>();
const listeners = new Set<() => void>();
const FOCUS_DEBOUNCE_MS = 400;

export async function reloadWorkspaceChanges(workspaceId: string) {
  const mine = (sequence.get(workspaceId) ?? 0) + 1;
  sequence.set(workspaceId, mine);
  try {
    const { files } = await rpc.call("git.workspaceChanges", { workspaceId });
    if (sequence.get(workspaceId) !== mine) return;
    cache.set(workspaceId, files);
    listeners.forEach((l) => l());
  } catch {
    if (!cache.has(workspaceId)) {
      cache.set(workspaceId, []);
      listeners.forEach((l) => l());
    }
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useWorkspaceChanges(workspaceId: string | null): ChangedFile[] | null {
  const files = useSyncExternalStore(subscribe, () => (workspaceId ? (cache.get(workspaceId) ?? null) : null));
  const list = useStore((s) => (workspaceId ? s.files[workspaceId] : undefined));
  useEffect(() => {
    if (workspaceId) void reloadWorkspaceChanges(workspaceId);
  }, [workspaceId, list]);
  useEffect(() => onWorkspaceChanged(workspaceId, () => void reloadWorkspaceChanges(workspaceId!)), [workspaceId]);
  useEffect(() => {
    if (!workspaceId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reloadWorkspaceChanges(workspaceId), FOCUS_DEBOUNCE_MS);
    };
    const visible = () => document.visibilityState === "visible" && soon();
    window.addEventListener("focus", soon);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", soon);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [workspaceId]);
  return files;
}

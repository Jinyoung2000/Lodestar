import { useEffect, useSyncExternalStore } from "react";
import { rpc } from "./rpc";
import { getState, isTopWorkspace, useStore } from "./store";

const POLL_MS = 20_000;

let missing: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function useMissingFolders(): ReadonlySet<string> {
  const workspaces = useStore((s) => s.workspaces);
  const connected = useStore((s) => s.connected);
  useEffect(() => {
    if (!connected) return;
    void refreshMissingFolders();
    const timer = setInterval(() => void refreshMissingFolders(), POLL_MS);
    const onFocus = () => void refreshMissingFolders();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [connected, workspaces]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => missing,
  );
}

export async function refreshMissingFolders() {
  const top = getState().workspaces.filter(isTopWorkspace);
  const next = new Set<string>();
  let failed = false;
  await Promise.all(
    top.map(async (workspace) => {
      try {
        const { mtimeMs } = await rpc.call("files.stat", { workspaceId: workspace.id, path: "." });
        if (mtimeMs === null) next.add(workspace.id);
      } catch {
        failed = true;
      }
    }),
  );
  if (failed) return;
  if (next.size === missing.size && [...next].every((id) => missing.has(id))) return;
  missing = next;
  for (const listener of listeners) listener();
}

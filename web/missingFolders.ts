import { useEffect, useSyncExternalStore } from "react";
import { rpc } from "./rpc";
import { getState, isTopWorkspace, useStore } from "./store";

// 디스크에서 사라진 폴더(round-5 발견 21). 사이드바가 그 폴더 묶음을 흐리게 보이고 메뉴를 줄이는 데 쓴다.
// 데몬이 폴더를 알려 주지 않으므로 files.stat 으로 폴더 자체를 확인한다(옛 데몬에서도 동작). 연결이 끊겨 확인이 실패하면 이전 값을 그대로 둔다.
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
    // 폴더 목록이 바뀔 때도 다시 확인한다
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

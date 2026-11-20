import { useEffect, useSyncExternalStore } from "react";
import type { ChangedFile } from "../shared/protocol";
import { rpc } from "./rpc";
import { useStore } from "./store";
import { onWorkspaceChanged } from "./workspaceEvents";

// R4FIX: 새 세션 화면(세션 없음)의 Changes 탭이 보이는 것: 고른 폴더의 커밋 안 된 변경(HEAD 기준, +N -N 포함). 세션의 변경 목록(store.gitChanges)과 따로 폴더별로 들고 있다.
// 읽는 때: 처음 쓸 때, 폴더 파일 목록이 다시 읽혔을 때(새 파일, 이름 바꾸기, 휴지통), 창이 다시 포커스를 받을 때, Source Control 에서 스테이지나 버리기를 한 뒤.
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
    // 옛 데몬이거나 폴더를 읽지 못하면 이전 값을 그대로 둔다(없으면 계속 "읽는 중" 이 아니라 빈 목록으로 본다)
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

// 아직 못 읽었으면 null
export function useWorkspaceChanges(workspaceId: string | null): ChangedFile[] | null {
  const files = useSyncExternalStore(subscribe, () => (workspaceId ? (cache.get(workspaceId) ?? null) : null));
  const list = useStore((s) => (workspaceId ? s.files[workspaceId] : undefined));
  useEffect(() => {
    if (workspaceId) void reloadWorkspaceChanges(workspaceId);
  }, [workspaceId, list]);
  // FIX4A: 포커스 없이도 바깥의 파일 변화를 데몬의 파일 감시가 알려 준다
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

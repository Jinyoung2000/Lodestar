import { useSyncExternalStore } from "react";

export type FilesSelected = { path: string; file: boolean } | null;
export type FilesView = { open: ReadonlySet<string>; rootOpen: boolean; selected: FilesSelected };

const EMPTY: FilesView = { open: new Set(), rootOpen: true, selected: null };
const views = new Map<string, FilesView>();
const listeners = new Set<() => void>();

export function useFilesView(workspaceId: string): FilesView {
  return useSyncExternalStore(subscribe, () => views.get(workspaceId) ?? EMPTY);
}

export function setFilesView(workspaceId: string, patch: Partial<FilesView>) {
  views.set(workspaceId, { ...(views.get(workspaceId) ?? EMPTY), ...patch });
  for (const listener of listeners) listener();
}

export function toggleFolder(workspaceId: string, path: string) {
  const open = new Set((views.get(workspaceId) ?? EMPTY).open);
  if (open.has(path)) open.delete(path);
  else open.add(path);
  setFilesView(workspaceId, { open });
}

// dir 와 그 위 폴더를 모두 펼친다("a/b" 면 "a" 와 "a/b")
export function expandFolders(workspaceId: string, dir: string) {
  if (!dir) return;
  const open = new Set((views.get(workspaceId) ?? EMPTY).open);
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i++) open.add(parts.slice(0, i).join("/"));
  setFilesView(workspaceId, { open });
}

// 탭 우클릭의 Reveal in Explorer View 가 쓰는 트리 쪽 절반: 그 파일까지 펼쳐 고른다. Files 탭을 앞으로 가져오는 건 부른 쪽이다.
export function revealFilePath(workspaceId: string, path: string) {
  expandFolders(workspaceId, path.slice(0, Math.max(path.lastIndexOf("/"), 0)));
  setFilesView(workspaceId, { rootOpen: true, selected: { path, file: true } });
}

export function filesViewOf(workspaceId: string): FilesView {
  return views.get(workspaceId) ?? EMPTY;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

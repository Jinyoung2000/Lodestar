import { useSyncExternalStore } from "react";

export type FilesSelected = { path: string; file: boolean } | null;
export type FilesPicked = { path: string; file: boolean };
export type FilesView = { open: ReadonlySet<string>; rootOpen: boolean; selected: FilesSelected; multi: readonly FilesPicked[] };

const EMPTY: FilesView = { open: new Set(), rootOpen: true, selected: null, multi: [] };
const views = new Map<string, FilesView>();
const listeners = new Set<() => void>();

export function useFilesView(workspaceId: string): FilesView {
  return useSyncExternalStore(subscribe, () => views.get(workspaceId) ?? EMPTY);
}

export function setFilesView(workspaceId: string, patch: Partial<FilesView>) {
  const reset = "selected" in patch && !("multi" in patch) ? { multi: [] } : {};
  views.set(workspaceId, { ...(views.get(workspaceId) ?? EMPTY), ...reset, ...patch });
  for (const listener of listeners) listener();
}

export function toggleFolder(workspaceId: string, path: string) {
  const open = new Set((views.get(workspaceId) ?? EMPTY).open);
  if (open.has(path)) open.delete(path);
  else open.add(path);
  setFilesView(workspaceId, { open });
}

export function expandFolders(workspaceId: string, dir: string) {
  if (!dir) return;
  const open = new Set((views.get(workspaceId) ?? EMPTY).open);
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i++) open.add(parts.slice(0, i).join("/"));
  setFilesView(workspaceId, { open });
}

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

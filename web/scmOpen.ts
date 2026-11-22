import type { ScmEntry, ScmTarget } from "../shared/scm";
import { getState, openFile, openScmDiff } from "./store";

export function workspaceFilePath(workspaceId: string, entry: ScmEntry): string {
  const dir = getState().workspaces.find((w) => w.id === workspaceId)?.dir ?? "";
  return dir && entry.path.startsWith(`${dir}/`) ? entry.path.slice(dir.length + 1) : entry.path;
}

export function openScmFile(workspaceId: string, entry: ScmEntry, side = false) {
  openFile({ workspaceId, path: workspaceFilePath(workspaceId, entry) }, { side });
}

export function openScmChanges(target: ScmTarget & { workspaceId: string }, entry: ScmEntry, group: "merge" | "staged" | "changes", side = false) {
  if (group === "merge") {
    openScmFile(target.workspaceId, entry, side);
    return;
  }
  openScmDiff({ workspaceId: target.workspaceId, agentId: target.agentId }, entry, group, { side });
}

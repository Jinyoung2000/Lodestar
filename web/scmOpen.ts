import type { ScmEntry, ScmTarget } from "../shared/scm";
import { getState, openFile, openScmDiff } from "./store";

// FIX6B: Source Control 행을 여는 길. Source Control 이 보여 주는 저장소가 기준이라 세션이 있든 없든 같은 길로 간다.

// 파일 탭 경로: 작업 폴더 안이면 작업 폴더 기준 상대 경로, 밖이면 절대 경로
export function workspaceFilePath(workspaceId: string, entry: ScmEntry): string {
  const dir = getState().workspaces.find((w) => w.id === workspaceId)?.dir ?? "";
  return dir && entry.path.startsWith(`${dir}/`) ? entry.path.slice(dir.length + 1) : entry.path;
}

export function openScmFile(workspaceId: string, entry: ScmEntry, side = false) {
  openFile({ workspaceId, path: workspaceFilePath(workspaceId, entry) }, { side });
}

// Open Changes: 충돌 파일은 충돌 해결 도구가 붙는 편집기로, 그 밖은 인덱스 기준 diff 탭(hunk 단위 stage)으로 연다.
export function openScmChanges(target: ScmTarget & { workspaceId: string }, entry: ScmEntry, group: "merge" | "staged" | "changes", side = false) {
  if (group === "merge") {
    openScmFile(target.workspaceId, entry, side);
    return;
  }
  openScmDiff({ workspaceId: target.workspaceId, agentId: target.agentId }, entry, group, { side });
}

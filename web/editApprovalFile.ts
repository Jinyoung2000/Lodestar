import { isEditApproval, targetPath } from "./approvalPreview";
import { toTarget } from "./lsp";
import { fileTabKey, type FileTarget } from "./store";
import type { PermissionItem } from "./timelineModel";

// 편집 승인(Edit, Write, MultiEdit)이 가리키는 파일의 에디터 탭 대상. 편집이 아니거나 경로가 없으면 null.
export function approvalFileTarget(item: PermissionItem | undefined, workspaceId: string | null): FileTarget | null {
  if (!item || !workspaceId || !isEditApproval(item.toolName)) return null;
  const path = targetPath(item.input);
  return path === null ? null : toTarget(path, workspaceId);
}

export function approvalTabKey(item: PermissionItem | undefined, workspaceId: string | null) {
  const target = approvalFileTarget(item, workspaceId);
  return target ? fileTabKey(target.workspaceId, target.path) : null;
}

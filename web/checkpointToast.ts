import { S } from "./strings";

export function restoreToastText(result: { files: number; reverted?: number; removed?: number }) {
  const removed = result.removed ?? 0;
  const reverted = result.reverted ?? Math.max(0, result.files - removed);
  if (removed === 0) return S.filesRestoredShell(reverted);
  return reverted === 0 ? S.filesTrashedOnly(removed) : S.filesRestoredTrash(reverted, removed);
}

import type { UndoSkip } from "../shared/protocol";
import { confirmAction } from "./ConfirmDialog";
import { notify } from "./notices";
import { rpc } from "./rpc";
import { flash, getState, openDiff, refreshGit } from "./store";
import { toTarget } from "./lsp";
import { S } from "./strings";

export async function keepFile(agentId: string, workspaceId: string, path: string) {
  const { text } = await rpc.call("files.read", { workspaceId, path });
  await rpc.call("changes.setOriginal", { agentId, path, original: text });
}

export async function undoFile(agentId: string, path: string, relative: string, original: string | null, wording: "undo" | "discard" = "undo") {
  const check = await rpc.call("changes.checkUndo", { agentId, paths: [path] }).catch((e: Error) => (flash(e.message, "error"), null));
  if (!check) return false;
  if (check.allowed.length === 0) {
    reportSkipped(agentId, check.skipped, (p) => (p === path ? relative : p));
    return false;
  }
  const ok = wording === "discard" ? await confirmAction(S.discardChangesConfirm(relative, original === null), S.discardChangesButton, undefined, "warning") : await confirmAction(S.undoAllConfirm(relative, original === null), S.undoAllButton, undefined, "warning");
  if (!ok) return false;
  const reverted = await revertFiles(agentId, [{ path, text: original }], (p) => (p === path ? relative : p));
  return reverted.includes(path);
}

export async function revertFiles(agentId: string, items: { path: string; text: string | null }[], relative: (path: string) => string): Promise<string[]> {
  const result = await rpc.call("changes.undo", { agentId, items }).catch((e: Error) => (flash(S.discardFailed(e.message), "error"), null));
  await refreshGit(agentId);
  if (!result) return [];
  reportSkipped(agentId, result.skipped, relative);
  return result.reverted;
}

export function skippedMessage(skipped: UndoSkip[]) {
  return new Set(skipped.map((s) => s.reason)).size === 1 ? S.undoSkipped(skipped.length, skipped[0].reason) : S.undoSkippedSeveral(skipped.length);
}

export function reportSkipped(agentId: string, skipped: UndoSkip[], relative: (path: string) => string) {
  if (skipped.length === 0) return;
  const message = skippedMessage(skipped);
  const first = skipped[0].path;
  const workspaceId = getState().agents.find((a) => a.id === agentId)?.workspaceId;
  notify({
    message,
    severity: "warning",
    detail: skipped.map((s) => relative(s.path)).join(", "),
    key: "undo-skipped",
    actions: workspaceId ? [{ label: S.compare, run: () => openDiff(agentId, toTarget(first, workspaceId).workspaceId, first) }] : [],
  });
}

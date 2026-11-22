import { useMemo } from "react";
import type { ChangedFile } from "../shared/protocol";
import { isGeneratedPath } from "../shared/generatedFiles";
import { confirmAction } from "./ConfirmDialog";
import { useChangesView } from "./changesState";
import { FileRow, FileTree, ScopeSummary, type RowActionHandlers } from "./ChangesPanel";
import { toTarget } from "./lsp";
import { rpc } from "./rpc";
import { refreshFileList } from "./editorDocs";
import { M } from "./scmStrings";
import { flash, openFile, openScmDiff } from "./store";
import { S } from "./strings";
import { reloadWorkspaceChanges, useWorkspaceChanges } from "./workspaceChanges";
import { hint } from "./hint";

export function DraftChanges({ workspaceId, openAsDiff = false }: { workspaceId: string; openAsDiff?: boolean }) {
  const files = useWorkspaceChanges(workspaceId);
  const treeView = useChangesView((s) => s.treeView);
  const list = useMemo(() => (files ?? []).filter((f) => !isGeneratedPath(f.path)), [files]);
  const actionsOf = (file: ChangedFile): RowActionHandlers => ({
    onOpenFile: file.status === "D" ? undefined : () => openFile(toTarget(file.path, workspaceId)),
    onDiscard: openAsDiff || file.outside ? undefined : () => void discardInFolder(workspaceId, file).catch((e: Error) => flash(S.discardFailed(e.message), "error")),
  });
  const pick = (file: ChangedFile, preview: boolean, side = false) => {
    const options = { preview: preview && !side, side };
    if (openAsDiff) openScmDiff({ workspaceId }, file, "uncommitted", options);
    else if (file.status !== "D") openFile(toTarget(file.path, workspaceId), options);
  };
  return (
    <div className="changes-view" aria-label={S.draftChangesAria}>
      <div className="changes-main">
        <div className="changes-head">
          <div className="scope-button">
            <ScopeSummary scope="uncommitted" files={list} />
          </div>
        </div>
        <div className="changes-list">
          {treeView ? <FileTree actionsOf={actionsOf} files={list} selectedPath={null} onPick={(file, e) => pick(file, true, !!e?.altKey)} onPin={(file) => pick(file, false)} /> : list.map((file) => <FileRow key={file.path} file={file} selected={false} feedbackAgentId={null} actions={actionsOf(file)} onPick={(e) => pick(file, true, !!e?.altKey)} onPin={() => pick(file, false)} />)}
          {files && list.length === 0 && (
            <div className="changes-empty">
              <strong>{S.changesEmptyTitle}</strong>
              <span>{S.noChangedFiles}</span>
            </div>
          )}
          {!files && <div className="empty-hint">{S.loading}</div>}
        </div>
      </div>
    </div>
  );
}

async function discardInFolder(workspaceId: string, file: ChangedFile) {
  const fresh = file.status === "A";
  const name = file.rel.slice(file.rel.lastIndexOf("/") + 1);
  const ok = await confirmAction(fresh ? M.trashFileTitle(name) : M.discardFileTitle(name), fresh ? M.trashFileButton : M.discardFileButton, fresh ? M.trashFileDetail : M.discardFileDetail, "warning");
  if (!ok) return;
  const result = await rpc.call("scm.discard", { workspaceId, paths: [file.rel] });
  if (result.restored + result.trashed === 0) hint(S.discardNothing);
  await Promise.all([reloadWorkspaceChanges(workspaceId), refreshFileList(workspaceId)]);
}

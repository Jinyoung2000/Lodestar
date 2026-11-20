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
import { flash, openFile } from "./store";
import { S } from "./strings";
import { reloadWorkspaceChanges, useWorkspaceChanges } from "./workspaceChanges";
import { hint } from "./hint";

// 새 세션 화면(세션 없음)의 Changes 탭: 고른 폴더의 커밋 안 된 변경. 행은 세션 Changes 의 행을 그대로 쓰고(+N -N, 상태 글자, hover 단추), 세션이 없으니 diff 탭 대신 에디터 탭으로 연다.
// 지워진 파일은 열 파일이 없어서 누르면 아무 일도 없다.
export function DraftChanges({ workspaceId }: { workspaceId: string }) {
  const files = useWorkspaceChanges(workspaceId);
  const treeView = useChangesView((s) => s.treeView);
  // 생성 파일(shared/generatedFiles.ts)은 세션 Changes 와 같게 목록에서 뺀다
  const list = useMemo(() => (files ?? []).filter((f) => !isGeneratedPath(f.path)), [files]);
  const actionsOf = (file: ChangedFile): RowActionHandlers => ({
    onOpenFile: file.status === "D" ? undefined : () => openFile(toTarget(file.path, workspaceId)),
    onDiscard: file.outside ? undefined : () => void discardInFolder(workspaceId, file).catch((e: Error) => flash(S.discardFailed(e.message), "error")),
  });
  const pick = (file: ChangedFile, preview: boolean, side = false) => {
    if (file.status !== "D") openFile(toTarget(file.path, workspaceId), { preview: preview && !side, side });
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

// 폴더의 변경 하나를 버린다. Source Control 의 Discard 와 같은 서버 동작(추적 파일은 되돌리고 새 파일은 휴지통)이라 확인 창도 같다.
async function discardInFolder(workspaceId: string, file: ChangedFile) {
  const fresh = file.status === "A";
  const name = file.rel.slice(file.rel.lastIndexOf("/") + 1);
  const ok = await confirmAction(fresh ? M.trashFileTitle(name) : M.discardFileTitle(name), fresh ? M.trashFileButton : M.discardFileButton, fresh ? M.trashFileDetail : M.discardFileDetail, "warning");
  if (!ok) return;
  const result = await rpc.call("scm.discard", { workspaceId, paths: [file.rel] });
  if (result.restored + result.trashed === 0) hint(S.discardNothing);
  await Promise.all([reloadWorkspaceChanges(workspaceId), refreshFileList(workspaceId)]);
}

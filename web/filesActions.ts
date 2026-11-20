import { attachFile } from "./attachments";
import { confirmAction } from "./ConfirmDialog";
import { refreshFileList, requestCloseTabs, validateNewPath } from "./editorDocs";
import { renamedKey } from "./editorTabs";
import { isSameOrUnder, renamedPath, renameProblem, retargetPath, type FilesMenuAction, type FilesRowKind } from "./filesMenu";
import { rpc } from "./rpc";
import { findInFiles } from "./findInFiles";
import { addTerminal, fileTabKey, flash, getState, openFile, refreshGit, replaceTab } from "./store";
import { S } from "./strings";
import { terminalScopeOf } from "./terminalScope";
import { wantTerminalFocus } from "./terminalHandles";
import { hint } from "./hint";

// R4FIX: Files 트리 우클릭 메뉴의 동작. 트리 안에서 입력줄을 여는 항목(New File, New Folder, Rename)은 FilesTab 이 처리하고, 나머지는 여기서 서버와 스토어를 부른다.
// path 는 작업 폴더 기준 경로이고 루트 행은 빈 문자열이다.
export type FilesTarget = { workspaceId: string; path: string; kind: FilesRowKind };

export function runFilesAction(action: Exclude<FilesMenuAction, "newFile" | "newFolder" | "rename">, target: FilesTarget) {
  const { workspaceId, path } = target;
  if (action === "open") openFile({ workspaceId, path });
  else if (action === "openSide") openToSide(workspaceId, path);
  else if (action === "reveal") void rpc.call("files.reveal", { workspaceId, path }).catch((e: Error) => flash(S.revealEntryFailed(e.message), "error"));
  else if (action === "openTerminal") openTerminalAt(path);
  else if (action === "findInFolder") findInFiles({ include: path ? `./${path}` : "" });
  else if (action === "attach") attachToChat(workspaceId, path);
  else if (action === "copyPath") copyText(`${workspaceDir(workspaceId)}${path ? `/${path}` : ""}`);
  else if (action === "copyRelativePath") copyText(path);
  else void deleteEntry(target);
}

const workspaceDir = (workspaceId: string) => getState().workspaces.find((w) => w.id === workspaceId)?.dir ?? "";

function copyText(text: string) {
  void navigator.clipboard.writeText(text).then(() => hint(S.copied, undefined, { check: true }), () => flash(S.pathCopyFailed, "error"));
}

function openToSide(workspaceId: string, path: string) {
  openFile({ workspaceId, path }, { side: true });
}

// 아래 패널의 터미널을 그 폴더에서 연다. 터미널 목록은 열린 세션(없으면 새 세션 화면의 폴더) 쪽에 매달린다.
function openTerminalAt(dir: string) {
  addTerminal(terminalScopeOf(getState()).key, dir || undefined);
  wantTerminalFocus();
}

function attachToChat(workspaceId: string, path: string) {
  const paneId = getState().activePaneId;
  if (paneId) attachFile(paneId, workspaceId, path);
}

// --- 삭제 (휴지통) ---

async function deleteEntry({ workspaceId, path, kind }: FilesTarget) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!(await confirmAction(S.trashEntryTitle(name), S.trashEntryButton, kind === "folder" ? S.trashFolderDetail : S.trashEntryDetail))) return;
  // 열려 있는 탭은 먼저 닫는다. 저장하지 않은 편집이 있으면 Save, Don't Save, Cancel 을 묻고, 취소하면 삭제도 하지 않는다.
  const open = getState().tabs.filter((t) => t.kind === "file" && t.workspaceId === workspaceId && isSameOrUnder(t.path, path)).map((t) => t.key);
  if (!(await requestCloseTabs(open))) return;
  try {
    await rpc.call("files.trash", { workspaceId, path });
  } catch (error) {
    flash(S.trashFailed((error as Error).message), "error");
    return;
  }
  await afterTreeChange(workspaceId);
  flash(S.movedToTrash(name));
}

// --- 이름 바꾸기 ---

export type RenameResult = { error: string } | { to: string };

// 입력한 이름으로 바꾼다. 같은 이름이면 아무 일도 없다. 열려 있는 파일 탭은 새 경로의 탭으로 바뀐다(자리와 미리보기 여부는 그대로).
// 저장하지 않은 편집이 있는 탭이 걸려 있으면 에디터 내용을 옮길 길이 없어서 거절한다.
export async function renameEntry(workspaceId: string, path: string, newName: string): Promise<RenameResult> {
  const problem = renameProblem(newName);
  if (problem) return { error: problem === "empty" ? S.newEntryEmpty : S.renameInvalid };
  const to = renamedPath(path, newName);
  if (to === path) return { to };
  const taken = await validateNewPath(workspaceId, to);
  if (taken) return { error: taken };
  const affected = getState().tabs.filter((t) => t.kind === "file" && t.workspaceId === workspaceId && isSameOrUnder(t.path, path));
  const dirty = affected.find((t) => getState().dirtyTabs[t.key]);
  if (dirty && dirty.kind === "file") return { error: S.renameDirtyOpen(dirty.path.slice(dirty.path.lastIndexOf("/") + 1)) };
  try {
    await rpc.call("files.rename", { workspaceId, from: path, to });
  } catch (error) {
    return { error: S.renameEntryFailed((error as Error).message) };
  }
  for (const tab of affected) {
    if (tab.kind !== "file") continue;
    const next = retargetPath(tab.path, path, to);
    // 같은 파일을 여러 그룹에 연 탭은 키 끝의 #번호를 지켜야 키가 겹치지 않는다
    if (next) replaceTab(tab.key, { key: renamedKey(fileTabKey(workspaceId, next), tab.key), kind: "file", workspaceId, path: next, ...(tab.preview ? { preview: true } : {}), ...(tab.sticky ? { sticky: true } : {}) });
  }
  await afterTreeChange(workspaceId);
  return { to };
}

async function afterTreeChange(workspaceId: string) {
  await refreshFileList(workspaceId);
  for (const agent of getState().agents) if (agent.workspaceId === workspaceId) void refreshGit(agent.id);
}

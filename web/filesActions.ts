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

function openTerminalAt(dir: string) {
  addTerminal(terminalScopeOf(getState()).key, dir || undefined);
  wantTerminalFocus();
}

function attachToChat(workspaceId: string, path: string) {
  const paneId = getState().activePaneId;
  if (paneId) attachFile(paneId, workspaceId, path);
}

async function deleteEntry({ workspaceId, path, kind }: FilesTarget) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!(await confirmAction(S.trashEntryTitle(name), S.trashEntryButton, kind === "folder" ? S.trashFolderDetail : S.trashEntryDetail))) return;
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

export async function deleteEntries(workspaceId: string, entries: readonly { path: string; file: boolean }[]): Promise<boolean> {
  const roots = entries.filter((e) => e.path && !entries.some((o) => o !== e && o.path !== e.path && isSameOrUnder(e.path, o.path)));
  if (roots.length === 0) return false;
  if (roots.length === 1) {
    await deleteEntry({ workspaceId, path: roots[0].path, kind: roots[0].file ? "file" : "folder" });
    return true;
  }
  if (!(await confirmAction(S.trashEntriesTitle(roots.length), S.trashEntryButton, S.trashEntriesDetail))) return false;
  const open = getState().tabs.filter((t) => t.kind === "file" && t.workspaceId === workspaceId && roots.some((r) => isSameOrUnder(t.path, r.path))).map((t) => t.key);
  if (!(await requestCloseTabs(open))) return false;
  let moved = 0;
  for (const { path } of roots) {
    try {
      await rpc.call("files.trash", { workspaceId, path });
      moved++;
    } catch (error) {
      flash(S.trashFailed((error as Error).message), "error");
      break;
    }
  }
  await afterTreeChange(workspaceId);
  if (moved > 0) flash(S.movedManyToTrash(moved));
  return true;
}

export type RenameResult = { error: string } | { to: string };

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
    if (next) replaceTab(tab.key, { key: renamedKey(fileTabKey(workspaceId, next), tab.key), kind: "file", workspaceId, path: next, ...(tab.preview ? { preview: true } : {}), ...(tab.sticky ? { sticky: true } : {}) });
  }
  await afterTreeChange(workspaceId);
  return { to };
}

async function afterTreeChange(workspaceId: string) {
  await refreshFileList(workspaceId);
  for (const agent of getState().agents) if (agent.workspaceId === workspaceId) void refreshGit(agent.id);
}

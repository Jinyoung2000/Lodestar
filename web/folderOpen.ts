import type { Workspace } from "../shared/protocol";
import { displayPath } from "./displayPath";
import { openTextPrompt } from "./QuickChoice";
import { localNative } from "./remote";
import { rpc } from "./rpc";
import { newFolderParent } from "./sessionFolders";
import { flash, startDraft, takePickFolderOnStart } from "./store";
import { S } from "./strings";

export const canPickFolder = () => typeof window !== "undefined" && !!localNative()?.pickFolder;

async function chooseFolderPath(): Promise<string | null> {
  const pick = localNative()?.pickFolder;
  if (pick) return pick();
  return openTextPrompt({ title: S.openFolderTitle, placeholder: S.openFolderPlaceholder });
}

export async function pickFolder(): Promise<Workspace | null> {
  try {
    const dir = await chooseFolderPath();
    if (!dir?.trim()) return null;
    takePickFolderOnStart();
    return await rpc.call("workspaces.add", { dir: dir.trim() });
  } catch (error) {
    flash((error as Error).message, "error");
    return null;
  }
}

export async function createProject(): Promise<Workspace | null> {
  const parent = newFolderParent();
  const name = await openTextPrompt({ title: S.newProjectTitle, placeholder: S.newFolderPlaceholder, hint: (value) => S.newProjectHint(`${displayPath(parent)}/${value.trim() || S.newFolderPlaceholder}`) });
  if (!name?.trim()) return null;
  try {
    takePickFolderOnStart();
    return await rpc.call("workspaces.create", { parent, name: name.trim(), git: true });
  } catch (error) {
    flash((error as Error).message, "error");
    return null;
  }
}

export async function openFolderInNewSession() {
  const workspace = await pickFolder();
  if (workspace) startDraft(workspace.id);
}

export async function newProjectInNewSession() {
  const workspace = await createProject();
  if (workspace) startDraft(workspace.id);
}

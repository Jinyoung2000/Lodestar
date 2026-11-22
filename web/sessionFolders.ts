import type { Agent, Workspace } from "../shared/protocol";
import { folderOf } from "../shared/sessionFolders";
import { displayPath } from "./displayPath";
import { openChoice, openTextPrompt, type ChoiceItem } from "./QuickChoice";
import { rpc } from "./rpc";
import { flash, getState, isTopWorkspace, openAgent } from "./store";
import { S } from "./strings";

export type SessionRoot = { id: string; workspace: Workspace | null; label: string; primary: boolean };

export function folderIdsOf(agent: Pick<Agent, "workspaceId" | "extraWorkspaceIds">): string[] {
  return agent.workspaceId ? [agent.workspaceId, ...(agent.extraWorkspaceIds ?? [])] : [];
}

export const isMultiRoot = (agent: Pick<Agent, "workspaceId" | "extraWorkspaceIds"> | null | undefined) => !!agent?.workspaceId && (agent.extraWorkspaceIds?.length ?? 0) > 0;

export function sessionRoots(agent: Pick<Agent, "workspaceId" | "extraWorkspaceIds">, workspaces: readonly Workspace[]): SessionRoot[] {
  const used = new Map<string, number>();
  return folderIdsOf(agent).map((id, index) => {
    const workspace = workspaces.find((w) => w.id === id) ?? null;
    const base = workspace?.name ?? S.folderUnknown;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return { id, workspace, label: count === 1 ? base : `${base} (${count})`, primary: index === 0 };
  });
}

export const parentDisplay = (dir: string) => displayPath(dir.slice(0, dir.lastIndexOf("/")) || "/");

export function insideOf(dir: string, chosen: readonly Workspace[]): Workspace | null {
  const root = folderOf(
    chosen.filter((w) => w.dir !== dir).map((w) => w.dir),
    dir,
  );
  return root ? (chosen.find((w) => w.dir === root) ?? null) : null;
}

export const newFolderParent = () => {
  const s = getState();
  const last = s.workspaces.find((w) => w.id === s.activeWorkspaceId && isTopWorkspace(w)) ?? null;
  return last ? last.dir.slice(0, last.dir.lastIndexOf("/")) || "/" : "~/Repository";
};

const OPEN_FOLDER = "\u0000open";
const NEW_FOLDER = "\u0000new";

async function promptFolderPath() {
  return openTextPrompt({ title: S.openFolderTitle, placeholder: S.openFolderPlaceholder });
}

export async function addFolderToSession(agentId: string) {
  const s = getState();
  const agent = s.agents.find((a) => a.id === agentId);
  if (!agent?.workspaceId) {
    flash(S.folderNeedsProject);
    return;
  }
  const chosen = sessionRoots(agent, s.workspaces).flatMap((r) => (r.workspace ? [r.workspace] : []));
  const candidates = s.workspaces.filter(isTopWorkspace).filter((w) => !chosen.some((c) => c.id === w.id) && !insideOf(w.dir, chosen));
  const items: ChoiceItem[] = [...candidates.map((w) => ({ id: w.id, label: w.name, detail: parentDisplay(w.dir), icon: "folder" })), { id: OPEN_FOLDER, label: S.openFolder, icon: "folder-opened", separatorBefore: true, always: true }];
  const picked = await openChoice({ title: S.addFolderTitle, placeholder: S.addFolderTitle, items, inline: true });
  if (!picked) return;
  try {
    let workspaceId = picked;
    if (picked === OPEN_FOLDER) {
      const dir = await promptFolderPath();
      if (!dir) return;
      workspaceId = (await rpc.call("workspaces.add", { dir })).id;
    }
    await rpc.call("agents.addFolder", { agentId, workspaceId });
  } catch (error) {
    flash((error as Error).message, "error");
  }
}

export async function removeFolderFromSession(agentId: string, workspaceId?: string) {
  const s = getState();
  const agent = s.agents.find((a) => a.id === agentId);
  const extras = agent ? sessionRoots(agent, s.workspaces).filter((r) => !r.primary) : [];
  if (!agent || extras.length === 0) {
    flash(S.folderNoneToRemove);
    return;
  }
  const picked = workspaceId ?? (await openChoice({ title: S.removeFolderTitle, placeholder: S.removeFolderTitle, items: extras.map((r) => ({ id: r.id, label: r.label, detail: r.workspace ? parentDisplay(r.workspace.dir) : S.folderNotFound, icon: "folder" })), inline: true }));
  if (!picked) return;
  try {
    await rpc.call("agents.removeFolder", { agentId, workspaceId: picked });
  } catch (error) {
    flash((error as Error).message, "error");
  }
}

export async function moveChatToFolder(agentId: string) {
  const s = getState();
  const agent = s.agents.find((a) => a.id === agentId);
  if (!agent || agent.workspaceId !== null) {
    flash(S.moveChatOnly);
    return;
  }
  const items: ChoiceItem[] = [
    ...s.workspaces.filter(isTopWorkspace).map((w) => ({ id: w.id, label: w.name, detail: parentDisplay(w.dir), icon: "folder" })),
    { id: NEW_FOLDER, label: S.newFolderEllipsis, icon: "new-folder", separatorBefore: true, always: true },
    { id: OPEN_FOLDER, label: S.openFolder, icon: "folder-opened", always: true },
  ];
  const picked = await openChoice({ title: S.moveToFolderTitle, placeholder: S.moveToFolderTitle, items, inline: true });
  if (!picked) return;
  try {
    if (picked === NEW_FOLDER) {
      const parent = newFolderParent();
      const name = await openTextPrompt({ title: S.newFolderTitle, placeholder: S.newFolderPlaceholder, hint: (value) => S.newFolderHint(`${displayPath(parent)}/${value.trim() || S.newFolderPlaceholder}`) });
      if (!name) return;
      if (name.includes("/") || name === "." || name === "..") {
        flash(S.newFolderBadName, "error");
        return;
      }
      await rpc.call("agents.moveToFolder", { agentId, dir: `${parent}/${name}`, create: true });
    } else if (picked === OPEN_FOLDER) {
      const dir = await promptFolderPath();
      if (!dir) return;
      await rpc.call("agents.moveToFolder", { agentId, dir });
    } else {
      const workspace = getState().workspaces.find((w) => w.id === picked);
      if (!workspace) return;
      await rpc.call("agents.moveToFolder", { agentId, dir: workspace.dir });
    }
    openAgent(agentId);
  } catch (error) {
    flash((error as Error).message, "error");
  }
}

import type { Agent, Workspace } from "../shared/protocol";
import { confirmAction, promptText } from "./ConfirmDialog";
import { refreshMissingFolders } from "./missingFolders";
import { isBusyAgent } from "../shared/agentBusy";
import { rpc } from "./rpc";
import { getState, flash, isTopWorkspace, setState, startDraft, takePickFolderOnStart, topWorkspaceId } from "./store";
import { markRead } from "./sessionActions";
import { getSessionList } from "./sessionListState";
import { S } from "./strings";
import { hint } from "./hint";
import { announce } from "./announce";

export async function addWorkspaceByPath(dir: string) {
  takePickFolderOnStart();
  const workspace = await rpc.call("workspaces.add", { dir: dir.trim() });
  startDraft(workspace.id);
  return workspace;
}

export function agentsInFolder(agents: Agent[], workspaceId: string) {
  return agents.filter((a) => a.workspaceId !== null && topWorkspaceId(a.workspaceId) === workspaceId);
}

export function isRunning(agent: Agent) {
  return isBusyAgent(agent);
}

export async function removeFolderFromList(workspace: Workspace): Promise<boolean> {
  const mine = agentsInFolder(getState().agents, workspace.id);
  const running = mine.filter(isRunning);
  if (running.length) {
    flash(S.folderRemoveBusy(running.length), "warning");
    return false;
  }
  if (mine.length && !(await confirmAction(S.folderRemoveTitle(workspace.name), S.folderRemoveButton, S.folderRemoveDetail(mine.length)))) return false;
  try {
    const { hidden } = await rpc.call("workspaces.remove", { id: workspace.id });
    setState((s) => {
      const first = s.workspaces.find(isTopWorkspace)?.id ?? "";
      return {
        activeWorkspaceId: s.activeWorkspaceId === workspace.id ? first || null : s.activeWorkspaceId,
        panes: s.panes.map((p) => (p.kind === "draft" && p.workspaceId === workspace.id ? { ...p, workspaceId: first } : p)),
      };
    });
    flash(S.folderRemoved(workspace.name, hidden));
    return true;
  } catch (error) {
    flash(S.folderRemoveFailed((error as Error).message), "error");
    return false;
  }
}

export async function locateFolder(workspace: Workspace): Promise<boolean> {
  const dir = await promptText(S.folderLocateTitle(workspace.name), S.folderLocateButton, { initial: workspace.dir, placeholder: S.folderLocatePlaceholder, label: S.folderLocateLabel, validate: (value) => (value.trim() ? null : S.folderLocateEmpty) }, S.folderLocateDetail);
  if (dir === null) return false;
  try {
    await rpc.call("workspaces.relocate", { id: workspace.id, dir });
    await refreshMissingFolders();
    announce(S.folderLocated(workspace.name));
    return true;
  } catch (error) {
    flash(S.folderLocateFailed((error as Error).message), "error");
    return false;
  }
}

export function startWorktreeSession(workspaceId: string) {
  startDraft(workspaceId, "active", { seed: { cardId: null, worktreeBranch: "", nonce: Date.now() } });
}

export function revealFolder(workspaceId: string) {
  rpc.call("workspaces.reveal", { workspaceId }).catch((error: Error) => flash(S.revealFailed(error.message.split("\n")[0]), "error"));
}

export function copyFolderPath(dir: string) {
  navigator.clipboard.writeText(dir).then(
    () => hint(S.pathCopied, undefined, { check: true }),
    () => flash(S.pathCopyFailed),
  );
}

export function markFolderDone(agents: Agent[]) {
  const open = agents.filter((a) => !a.done);
  for (const agent of open) void rpc.call("agents.setDone", { agentId: agent.id, done: true }).catch((error: Error) => flash(error.message, "error"));
  if (open.length && !getSessionList().view.showDone) flash(S.markedDone);
}

export function markFolderRead(agents: Agent[]) {
  for (const agent of agents) if (agent.unread) markRead(agent, true);
}

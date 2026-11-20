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

// WSMENU: 사이드바 폴더 묶음 머리 메뉴와 새 세션 화면 폴더 목록이 같이 쓰는 폴더 동작.

// 경로로 폴더를 추가하고 그 폴더의 새 세션 화면을 연다. 실패하면 서버 메시지를 담은 Error 를 던진다.
export async function addWorkspaceByPath(dir: string) {
  takePickFolderOnStart();
  const workspace = await rpc.call("workspaces.add", { dir: dir.trim() });
  startDraft(workspace.id);
  return workspace;
}

// 폴더 안 세션(worktree 세션 포함). 피드백 개선 세션은 부모 폴더가 없어서 들지 않는다.
export function agentsInFolder(agents: Agent[], workspaceId: string) {
  return agents.filter((a) => a.workspaceId !== null && topWorkspaceId(a.workspaceId) === workspaceId);
}

export function isRunning(agent: Agent) {
  return isBusyAgent(agent);
}

// 목록에서 폴더를 뺀다. 세션이 있으면 확인을 받고, 지우지 않고 숨긴다(폴더를 다시 추가하면 돌아온다). 도는 세션이 있으면 이유를 알리고 멈춘다.
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
    // 빠진 폴더를 가리키던 선택과 새 세션 칸은 남은 첫 폴더로 옮긴다
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

// 사라진 폴더를 새 경로에 다시 잇는다. 네이티브 폴더 선택창 대신 앱 안의 경로 입력 창을 쓴다(Add Workspace 도 경로 입력이다). 세션은 그대로 남는다.
export async function locateFolder(workspace: Workspace): Promise<boolean> {
  const dir = await promptText(S.folderLocateTitle(workspace.name), S.folderLocateButton, { initial: workspace.dir, placeholder: S.folderLocatePlaceholder, label: S.folderLocateLabel, validate: (value) => (value.trim() ? null : S.folderLocateEmpty) }, S.folderLocateDetail);
  if (dir === null) return false;
  try {
    await rpc.call("workspaces.relocate", { id: workspace.id, dir });
    await refreshMissingFolders();
    // 목록에서 폴더 경고 표시가 사라지는 것이 보이므로 낭독만 한다
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

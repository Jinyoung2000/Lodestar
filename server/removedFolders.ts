import type { Agent, Workspace } from "../shared/protocol";
import { isBusyAgent } from "../shared/agentBusy";
import { T } from "./strings";

// WSMENU: 사이드바에서 폴더를 뺄 때 세션을 지우지 않고 맡겨 두는 곳. 같은 폴더를 다시 추가하면 그대로 돌려준다.
// workspaces[0] 이 최상위 폴더이고 나머지는 그 아래 worktree 워크스페이스다. 세션 기록(타임라인, 변경, diff 피드백) 파일은 건드리지 않는다.
export type RemovedFolder = { workspaces: Workspace[]; agents: Agent[] };
export type FolderState = { workspaces: Workspace[]; agents: Agent[]; removed?: RemovedFolder[] };

// 최상위 폴더와 그 아래 worktree 워크스페이스, 그 안의 세션. 피드백 개선 세션의 워크스페이스는 부모가 없어서 여기 들지 않는다.
export function folderScope(state: FolderState, id: string): RemovedFolder {
  const top = state.workspaces.find((w) => w.id === id);
  if (!top || top.parentId) throw new Error(`Unknown workspace: ${id}`);
  const workspaces = [top, ...state.workspaces.filter((w) => w.parentId === id && !w.feedback)];
  const ids = new Set(workspaces.map((w) => w.id));
  return { workspaces, agents: state.agents.filter((a) => a.workspaceId !== null && ids.has(a.workspaceId)) };
}

// 턴이 도는 중이거나 승인을 기다리거나 백그라운드 작업이 남은 세션(error 는 제외, shared/agentBusy.ts). 숨기면 이 세션의 이후 이벤트가 갈 곳이 없어진다.
export function busyAgents(agents: Agent[]) {
  return agents.filter(isBusyAgent);
}

// 세션이 없으면 폴더 기록만 지운다. 있으면 모두 맡겨 두고 숨긴 수를 돌려준다. 도는 세션이 있으면 아무것도 바꾸지 않고 던진다.
export function removeFolder(state: FolderState, id: string): { hidden: number; agents: Agent[] } {
  const scope = folderScope(state, id);
  const busy = busyAgents(scope.agents);
  if (busy.length) throw new Error(T.errFolderBusy(busy.length));
  const workspaceIds = new Set(scope.workspaces.map((w) => w.id));
  const agentIds = new Set(scope.agents.map((a) => a.id));
  state.workspaces = state.workspaces.filter((w) => !workspaceIds.has(w.id));
  state.agents = state.agents.filter((a) => !agentIds.has(a.id));
  if (scope.agents.length) state.removed = [...(state.removed ?? []), scope];
  return { hidden: scope.agents.length, agents: scope.agents };
}

export function restoreFolder(state: FolderState, dir: string): { workspace: Workspace; agents: Agent[] } | null {
  const entry = state.removed?.find((r) => r.workspaces[0]?.dir === dir);
  if (!entry) return null;
  state.removed = state.removed!.filter((r) => r !== entry);
  state.workspaces.push(...entry.workspaces);
  state.agents.push(...entry.agents);
  return { workspace: entry.workspaces[0], agents: entry.agents };
}

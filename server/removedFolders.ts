import type { Agent, Workspace } from "../shared/protocol";
import { isBusyAgent } from "../shared/agentBusy";
import { T } from "./strings";

export type RemovedFolder = { workspaces: Workspace[]; agents: Agent[] };
export type FolderState = { workspaces: Workspace[]; agents: Agent[]; removed?: RemovedFolder[] };

export function folderScope(state: FolderState, id: string): RemovedFolder {
  const top = state.workspaces.find((w) => w.id === id);
  if (!top || top.parentId) throw new Error(`Unknown workspace: ${id}`);
  const workspaces = [top, ...state.workspaces.filter((w) => w.parentId === id && !w.feedback)];
  const ids = new Set(workspaces.map((w) => w.id));
  return { workspaces, agents: state.agents.filter((a) => a.workspaceId !== null && ids.has(a.workspaceId)) };
}

export function busyAgents(agents: Agent[]) {
  return agents.filter(isBusyAgent);
}

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

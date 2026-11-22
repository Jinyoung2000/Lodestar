import type { Agent, Workspace } from "../shared/protocol";
import type { Pane, State } from "./store";

export const chatTabId = (paneId: string) => `chat-tab-${paneId}`;
export const chatPanelId = (paneId: string) => `chat-panel-${paneId}`;

export function chatPaneWorkspace(pane: Pane | undefined, agents: readonly Agent[]): string | null {
  if (pane?.kind === "draft") return pane.workspaceId || null;
  return pane ? agents.find((agent) => agent.id === pane.agentId)?.workspaceId ?? null : null;
}

export function chatProject(workspaceId: string | null, workspaces: readonly Workspace[]): string | null {
  return workspaces.find((workspace) => workspace.id === workspaceId)?.parentId ?? workspaceId;
}

export function editorGitWorkspaceOf(s: Pick<State, "layoutMode" | "panes" | "activePaneId" | "agents" | "workspaces">): string | null {
  if (s.layoutMode !== "editor") return null;
  const pane = s.panes.find((item) => item.id === s.activePaneId);
  const id = chatPaneWorkspace(pane, s.agents);
  if (pane?.kind !== "agent" || !id) return id;
  const agent = s.agents.find((item) => item.id === pane.agentId);
  const workspace = s.workspaces.find((item) => item.id === id);
  if (agent?.feedbackId || workspace?.feedback) return null;
  const project = chatProject(id, s.workspaces);
  return s.workspaces.some((item) => item.id === project) ? project : id;
}

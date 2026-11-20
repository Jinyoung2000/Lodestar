import type { Agent, Workspace } from "../shared/protocol";
import { activeAgentOf } from "./activeAgentOf";
import { addTerminal, getState, setState, type State } from "./store";
import { wantTerminalFocus } from "./terminalHandles";

export type TerminalScope = { key: string; params: Record<string, string>; label: string };

export function terminalScopeOf(s: Pick<State, "panes" | "activePaneId" | "agents" | "activeWorkspaceId" | "workspaces">): TerminalScope {
  return terminalScopeFor(activeAgentOf(s.panes, s.activePaneId, s.agents), workspaceForTerminal(s));
}

// 세션이 없을 때의 폴더 후보: 새 세션 칸이 고른 워크스페이스, 없으면 활성 워크스페이스
export function workspaceForTerminal(s: Pick<State, "panes" | "activePaneId" | "activeWorkspaceId" | "workspaces">): Workspace | undefined {
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  const id = (pane?.kind === "draft" ? pane.workspaceId : null) ?? s.activeWorkspaceId;
  return id ? s.workspaces.find((w) => w.id === id) : undefined;
}

export function terminalScopeFor(agent: Agent | null, workspace: Workspace | undefined): TerminalScope {
  if (agent) return { key: agent.id, params: { agentId: agent.id }, label: agent.cwd.split("/").slice(-2).join("/") };
  if (workspace) return { key: `workspace:${workspace.id}`, params: { workspaceId: workspace.id }, label: workspace.dir.split("/").slice(-2).join("/") };
  return { key: "home", params: {}, label: "~" };
}

export function toggleBottomPanel() {
  const s = getState();
  if (s.bottomOpen) {
    setState({ bottomOpen: false });
    return;
  }
  setState({ bottomOpen: true });
  if (s.bottomTab !== "terminal") return;
  const scope = terminalScopeOf(s);
  wantTerminalFocus();
  if ((s.terminals[scope.key] ?? []).length === 0) addTerminal(scope.key);
}

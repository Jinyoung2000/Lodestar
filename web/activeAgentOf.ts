import type { Agent } from "../shared/protocol";
import type { Pane } from "./store";

export function activeAgentOf(panes: Pane[], activePaneId: string, agents: Agent[]) {
  const pane = panes.find((p) => p.id === activePaneId);
  return pane?.kind === "agent" ? (agents.find((a) => a.id === pane.agentId) ?? null) : null;
}

import { pendingToolRequest } from "../shared/interactive";
import { activeAgentOf } from "./activeAgentOf";
import { rpc } from "./rpc";
import { flash, getState } from "./store";

export function pendingToolApproval(): { agentId: string; itemId: string } | null {
  const s = getState();
  if (s.centerView !== "sessions" || s.overlay) return null;
  if (s.layoutMode === "editor" && (s.chatDock === "floating" ? s.floatCollapsed : !s.chatDockOpen)) return null;
  const agent = activeAgentOf(s.panes, s.activePaneId, s.agents);
  const request = agent ? pendingToolRequest(s.timelines[agent.id]) : null;
  return agent && request ? { agentId: agent.id, itemId: request.id } : null;
}

export function answerToolApproval(decision: "allow" | "deny") {
  const target = pendingToolApproval();
  if (!target) return;
  rpc.call("agents.respondPermission", { ...target, decision }).catch((error: Error) => flash(error.message));
}

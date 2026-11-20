import { pendingToolRequest } from "../shared/interactive";
import { activeAgentOf } from "./activeAgentOf";
import { rpc } from "./rpc";
import { flash, getState } from "./store";

export function pendingToolApproval(): { agentId: string; itemId: string } | null {
  const s = getState();
  if (s.centerView !== "sessions" || s.overlay) return null;
  // Editor 배치에서 대화 창을 알약으로 접었거나 대화 패널을 닫았으면 카드가 보이지 않는다. 보이지 않는 요청을 키로 허용하지 않는다.
  if (s.layoutMode === "editor" && (s.chatDock === "floating" ? s.floatCollapsed : !s.chatDockOpen)) return null;
  const agent = activeAgentOf(s.panes, s.activePaneId, s.agents);
  const request = agent ? pendingToolRequest(s.timelines[agent.id]) : null;
  return agent && request ? { agentId: agent.id, itemId: request.id } : null;
}

// Allow Once 는 allow, Skip 은 deny. 승인 카드의 단추와 같은 호출이다.
export function answerToolApproval(decision: "allow" | "deny") {
  const target = pendingToolApproval();
  if (!target) return;
  rpc.call("agents.respondPermission", { ...target, decision }).catch((error: Error) => flash(error.message));
}

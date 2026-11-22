import type { Agent, Feedback } from "./protocol";

export type AttentionReason = "input" | "reply";
export type AttentionItem = { agentId: string; title: string; reason: AttentionReason };

type AgentRef = Pick<Agent, "id" | "title" | "status" | "done" | "updatedAt">;
type FeedbackRef = Pick<Feedback, "agentId" | "status">;

export function attentionItems(agents: readonly AgentRef[], feedbacks: Readonly<Record<string, FeedbackRef>>): AttentionItem[] {
  const waiting = agents
    .filter((a) => a.status === "waiting" && !a.done)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map((a): AttentionItem => ({ agentId: a.id, title: a.title, reason: "input" }));
  const taken = new Set(waiting.map((item) => item.agentId));
  const live = new Map(agents.map((a) => [a.id, a]));
  const replies = Object.values(feedbacks)
    .filter((f) => f.status === "needsInput" && live.has(f.agentId) && !taken.has(f.agentId))
    .map((f): AttentionItem => ({ agentId: f.agentId, title: live.get(f.agentId)?.title ?? "", reason: "reply" }));
  return [...waiting, ...replies];
}

export function attentionCount(agents: readonly AgentRef[], feedbacks: Readonly<Record<string, FeedbackRef>>): number {
  return attentionItems(agents, feedbacks).length;
}

type PaneRef = { kind: string; agentId?: string };

export function isSessionShown(agentId: string, panes: readonly PaneRef[], centerView: string): boolean {
  return centerView === "sessions" && panes.some((p) => p.kind === "agent" && p.agentId === agentId);
}

export function awayItems(items: readonly AttentionItem[], panes: readonly PaneRef[], centerView: string): AttentionItem[] {
  return items.filter((item) => !isSessionShown(item.agentId, panes, centerView));
}

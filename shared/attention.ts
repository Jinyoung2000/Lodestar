// 사람이 봐야 하는 세션을 모은다. Dock 배지의 수와 제목줄 칩이 같은 목록을 쓴다. 시험: test/attention.test.ts
import type { Agent, Feedback } from "./protocol";

// input: 승인, 질문, 계획 확인이 막고 있는 세션(status waiting). reply: 개선 세션이 끝나고 사용자 답을 기다리는 것(Improvements 의 Needs your reply).
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

// 세션이 지금 화면에 보이는가. 세션 화면이 아닌 가운데 화면(Board 등)이 덮고 있으면 칸에 열린 세션도 보이지 않는 것이다.
export function isSessionShown(agentId: string, panes: readonly PaneRef[], centerView: string): boolean {
  return centerView === "sessions" && panes.some((p) => p.kind === "agent" && p.agentId === agentId);
}

export function awayItems(items: readonly AttentionItem[], panes: readonly PaneRef[], centerView: string): AttentionItem[] {
  return items.filter((item) => !isSessionShown(item.agentId, panes, centerView));
}

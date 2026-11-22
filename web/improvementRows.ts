import type { Agent, Feedback } from "../shared/protocol";
import { canRetryChecks } from "../shared/feedbackRetry";
import { feedbackBadge } from "./feedbackBadge";

export type ImprovementFilter = "all" | "notApplied" | "applied" | "dismissed";

type FeedbackRow = Pick<Feedback, "id" | "agentId" | "status" | "retrying" | "restartPending" | "failure" | "checks" | "createdAt" | "updatedAt"> & Partial<Pick<Feedback, "blocked">>;
type AgentRef = Pick<Agent, "id" | "feedbackId" | "status">;

export const isImprovementSession = (agent: Pick<Agent, "feedbackId">): boolean => !!agent.feedbackId;

export function withoutImprovementSessions<T extends Pick<Agent, "feedbackId">>(agents: readonly T[]): T[] {
  return agents.filter((a) => !isImprovementSession(a));
}

export function matchesImprovement(feedback: Pick<Feedback, "status" | "retrying" | "restartPending" | "failure"> & Partial<Pick<Feedback, "blocked">>, filter: ImprovementFilter): boolean {
  if (filter === "dismissed") return feedback.status === "dismissed";
  if (filter === "all") return feedback.status !== "dismissed";
  if (filter === "notApplied") return feedbackBadge(feedback)?.status === "failed";
  return !feedback.retrying && (feedback.status === "applied" || feedback.status === "awaitingRestart" || feedback.status === "resolved");
}

export function improvementRows<T extends FeedbackRow>(feedbacks: Readonly<Record<string, T>>, agents: readonly AgentRef[], filter: ImprovementFilter, selectedId: string | null): T[] {
  const live = new Set(agents.map((a) => a.id));
  return Object.values(feedbacks)
    .filter((f) => live.has(f.agentId) && (matchesImprovement(f, filter) || f.id === selectedId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
}

export function notAppliedCount(feedbacks: Readonly<Record<string, FeedbackRow>>, agents: readonly AgentRef[]): number {
  return improvementRows(feedbacks, agents, "notApplied", null).length;
}

export function needsInputCount(feedbacks: Readonly<Record<string, FeedbackRow>>, agents: readonly AgentRef[]): number {
  return improvementRows(feedbacks, agents, "all", null).filter((f) => f.status === "needsInput").length;
}

export function improvementsBusy(feedbacks: Readonly<Record<string, FeedbackRow>>, agents: readonly AgentRef[]): boolean {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return Object.values(feedbacks).some((f) => {
    const agent = byId.get(f.agentId);
    if (!agent) return false;
    return f.status === "running" || f.status === "checking" || f.status === "fixing" || !!f.retrying || agent.status === "running" || agent.status === "waiting";
  });
}

export function retryTargets(feedbacks: Readonly<Record<string, FeedbackRow>>, agents: readonly AgentRef[]): string[] {
  return improvementRows(feedbacks, agents, "notApplied", null)
    .filter((f) => canRetryChecks(f))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((f) => f.id);
}

export function requestFirstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

export const canTidy = (feedback: Pick<Feedback, "status" | "retrying">): boolean => feedback.status === "failed" && !feedback.retrying;

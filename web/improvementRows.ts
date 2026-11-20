// Improvements 화면(Lodestar 가 만든 개선 세션 목록)의 순수 계산. 시험: test/improvements.test.ts
import type { Agent, Feedback } from "../shared/protocol";
import { canRetryChecks } from "../shared/feedbackRetry";
import { feedbackBadge } from "./feedbackBadge";

export type ImprovementFilter = "all" | "notApplied" | "applied" | "dismissed";

type FeedbackRow = Pick<Feedback, "id" | "agentId" | "status" | "retrying" | "restartPending" | "failure" | "checks" | "createdAt" | "updatedAt"> & Partial<Pick<Feedback, "blocked">>;
type AgentRef = Pick<Agent, "id" | "feedbackId" | "status">;

// 피드백이 연 개선 세션은 Sessions 목록, 세션 검색, 순서 이동에서 빠진다. 이 화면이 맡는다.
export const isImprovementSession = (agent: Pick<Agent, "feedbackId">): boolean => !!agent.feedbackId;

export function withoutImprovementSessions<T extends Pick<Agent, "feedbackId">>(agents: readonly T[]): T[] {
  return agents.filter((a) => !isImprovementSession(a));
}

// Not applied 는 사이드바 개수와 같은 기준이다: 상태 라벨이 "Not applied" 인 것(검사를 다시 돌리는 중은 빠진다).
// Applied 는 본 작업 폴더에 들어간 것: 재시작만 기다리는 것(awaitingRestart)도 들어가고, 되돌린 뒤 재시작을 기다리는 것(reverted)은 안 들어간다.
// FBREDO: 사람이 정리한 항목: resolved(Resolved manually)는 Applied 쪽 차분한 표시로 모이고, dismissed 는 All 에서 빠져 Dismissed 필터로만 보인다.
// FBBLOCK: 환경이나 인증 때문에 기다리는 중(blocked)인 항목은 실패가 아니라서 Not applied 에 안 들어가고 All 에만 보인다.
export function matchesImprovement(feedback: Pick<Feedback, "status" | "retrying" | "restartPending" | "failure"> & Partial<Pick<Feedback, "blocked">>, filter: ImprovementFilter): boolean {
  if (filter === "dismissed") return feedback.status === "dismissed";
  if (filter === "all") return feedback.status !== "dismissed";
  if (filter === "notApplied") return feedbackBadge(feedback)?.status === "failed";
  return !feedback.retrying && (feedback.status === "applied" || feedback.status === "awaitingRestart" || feedback.status === "resolved");
}

// 세션이 아직 있는 피드백만 보인다(세션을 지우면 기록은 되돌리기 백업으로 남지만 이 목록에서는 사라진다). 최신순.
// 지금 상세 칸에 열린 항목은 필터와 맞지 않게 되어도(Retry 로 Applied 가 된 경우) 고른 동안 목록에 남긴다.
export function improvementRows<T extends FeedbackRow>(feedbacks: Readonly<Record<string, T>>, agents: readonly AgentRef[], filter: ImprovementFilter, selectedId: string | null): T[] {
  const live = new Set(agents.map((a) => a.id));
  return Object.values(feedbacks)
    .filter((f) => live.has(f.agentId) && (matchesImprovement(f, filter) || f.id === selectedId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
}

export function notAppliedCount(feedbacks: Readonly<Record<string, FeedbackRow>>, agents: readonly AgentRef[]): number {
  return improvementRows(feedbacks, agents, "notApplied", null).length;
}

// 개선 세션이 사용자에게 묻고 답을 기다리는 항목 수. 미적용과는 따로 센다(실패가 아니라 사용자 차례다).
export function needsInputCount(feedbacks: Readonly<Record<string, FeedbackRow>>, agents: readonly AgentRef[]): number {
  return improvementRows(feedbacks, agents, "all", null).filter((f) => f.status === "needsInput").length;
}

// 개선 세션이 돌고 있거나(작업 중) 검사 중인 것이 하나라도 있는가. 사이드바 바닥 항목의 진행 표시.
export function improvementsBusy(feedbacks: Readonly<Record<string, FeedbackRow>>, agents: readonly AgentRef[]): boolean {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return Object.values(feedbacks).some((f) => {
    const agent = byId.get(f.agentId);
    if (!agent) return false;
    return f.status === "running" || f.status === "checking" || f.status === "fixing" || !!f.retrying || agent.status === "running" || agent.status === "waiting";
  });
}

// Retry all not applied 가 차례로 돌릴 피드백 id. 검사를 다시 돌릴 수 있는 미적용 항목만, 오래된 것부터.
export function retryTargets(feedbacks: Readonly<Record<string, FeedbackRow>>, agents: readonly AgentRef[]): string[] {
  return improvementRows(feedbacks, agents, "notApplied", null)
    .filter((f) => canRetryChecks(f))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((f) => f.id);
}

// 목록 행에 보일 피드백 원문의 첫 줄
export function requestFirstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

// FBREDO: 반영 안 됨으로 남은(검사를 다시 돌리는 중이 아닌) 항목만 해결됨 표시나 숨김으로 정리할 수 있다. 서버 규칙(feedback.resolve, dismiss)과 같다.
export const canTidy = (feedback: Pick<Feedback, "status" | "retrying">): boolean => feedback.status === "failed" && !feedback.retrying;

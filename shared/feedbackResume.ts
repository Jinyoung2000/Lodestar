import type { Agent, Feedback, FeedbackStatus } from "./protocol";
import { endedInSessionError } from "./feedbackBlock";

export const MAX_RESUMES = 2;

export const isInterruptible = (status: FeedbackStatus) => status === "running" || status === "checking" || status === "fixing";

export type ResumeFacts = {
  status: FeedbackStatus;
  resumeCount: number;
  worktreeExists: boolean;
  baselineExists: boolean;
  agentExists: boolean;
  hasSession: boolean;
};

export type GiveUpReason = "noWorktree" | "noAgent" | "noSession" | "tooMany";
export type ResumePlan = { action: "recheck" } | { action: "continue" } | { action: "giveUp"; reason: GiveUpReason };

export function resumePlan(facts: ResumeFacts): ResumePlan {
  if (!facts.worktreeExists || !facts.baselineExists) return { action: "giveUp", reason: "noWorktree" };
  if (!facts.agentExists) return { action: "giveUp", reason: "noAgent" };
  if (facts.resumeCount >= MAX_RESUMES) return { action: "giveUp", reason: "tooMany" };
  if (facts.status === "checking") return { action: "recheck" };
  if (!facts.hasSession) return { action: "giveUp", reason: "noSession" };
  return { action: "continue" };
}

type RunAgainFacts = Pick<Feedback, "status"> & Partial<Pick<Feedback, "interrupted" | "blocked" | "sessionFailed" | "checks" | "failure">>;
export function canRunAgain(feedback: RunAgainFacts): boolean {
  if (feedback.status === "blocked") return feedback.blocked?.stage === "session";
  if (feedback.status !== "failed") return false;
  if (feedback.interrupted === true || feedback.sessionFailed === true) return true;
  return feedback.sessionFailed === undefined && (feedback.checks?.length ?? 0) === 0 && endedInSessionError(feedback.failure);
}

export function runningWork(agents: Pick<Agent, "status" | "feedbackId">[], feedbacks: Pick<Feedback, "status">[]) {
  return {
    sessions: agents.filter((a) => !a.feedbackId && (a.status === "running" || a.status === "waiting")).length,
    improvements: feedbacks.filter((f) => isInterruptible(f.status)).length,
  };
}

import type { Agent, Feedback, FeedbackStatus } from "./protocol";
import { endedInSessionError } from "./feedbackBlock";

// FBREDO: 데몬이 재시작될 때 돌고 있던 피드백(턴이나 검사 중)을 이어 갈지, 포기할지 정하는 판단.
// 한 피드백을 이어 가는 최대 횟수. 턴이 데몬을 죽이는 피드백이 끝없이 되살아나지 않게 한다. 턴이 끝나면 0부터 다시 센다.
export const MAX_RESUMES = 2;

// 재시작에 끊기는 상태: 개선 세션 턴이 도는 중(running, fixing)이거나 검사 중(checking)
export const isInterruptible = (status: FeedbackStatus) => status === "running" || status === "checking" || status === "fixing";

export type ResumeFacts = {
  status: FeedbackStatus;
  resumeCount: number;
  worktreeExists: boolean;
  baselineExists: boolean;
  agentExists: boolean;
  // 개선 세션의 세션 기록(sessionId 와 그 기록 파일)이 남아 있는가. 턴이 끊긴 경우에만 쓴다.
  hasSession: boolean;
};

export type GiveUpReason = "noWorktree" | "noAgent" | "noSession" | "tooMany";
export type ResumePlan = { action: "recheck" } | { action: "continue" } | { action: "giveUp"; reason: GiveUpReason };

// checking: 개선 세션 턴은 이미 끝났으니 검사와 반영만 처음부터 돈다(세션 기록이 필요 없다).
// running, fixing: 같은 worktree 와 세션을 resume 해서 이어 쓴다. worktree, 기준 해시, 세션 기록이 모두 있어야 한다.
export function resumePlan(facts: ResumeFacts): ResumePlan {
  if (!facts.worktreeExists || !facts.baselineExists) return { action: "giveUp", reason: "noWorktree" };
  if (!facts.agentExists) return { action: "giveUp", reason: "noAgent" };
  if (facts.resumeCount >= MAX_RESUMES) return { action: "giveUp", reason: "tooMany" };
  if (facts.status === "checking") return { action: "recheck" };
  if (!facts.hasSession) return { action: "giveUp", reason: "noSession" };
  return { action: "continue" };
}

// 재시작에 끊겨 이어 가지 못한(또는 이어 갔지만 실패한) 피드백은 같은 요청을 처음부터 다시 돌릴 수 있다.
// FBBLOCK: 개선 세션이 시작하자마자 오류로 끝난 것(sessionFailed, 표시가 생기기 전 항목은 실패 문장으로 판별)과, 세션 단계에서 기다리는 중(blocked)인 것도 같다.
type RunAgainFacts = Pick<Feedback, "status"> & Partial<Pick<Feedback, "interrupted" | "blocked" | "sessionFailed" | "checks" | "failure">>;
export function canRunAgain(feedback: RunAgainFacts): boolean {
  if (feedback.status === "blocked") return feedback.blocked?.stage === "session";
  if (feedback.status !== "failed") return false;
  if (feedback.interrupted === true || feedback.sessionFailed === true) return true;
  return feedback.sessionFailed === undefined && (feedback.checks?.length ?? 0) === 0 && endedInSessionError(feedback.failure);
}

// 데몬 재시작이 끊을 일의 수. 개선 세션(feedbackId 가 있는 세션)은 세션 수에서 빼고 improvements 로 따로 센다:
// 재시작 뒤 스스로 이어 가므로 "멈춘다" 가 아니라 "이어 간다" 로 알려야 하고, 검사 중인 피드백은 세션이 쉬고 있어서 세션 수로는 안 잡힌다.
export function runningWork(agents: Pick<Agent, "status" | "feedbackId">[], feedbacks: Pick<Feedback, "status">[]) {
  return {
    sessions: agents.filter((a) => !a.feedbackId && (a.status === "running" || a.status === "waiting")).length,
    improvements: feedbacks.filter((f) => isInterruptible(f.status)).length,
  };
}

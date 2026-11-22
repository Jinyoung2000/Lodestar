import type { Feedback, FeedbackStatus } from "../shared/protocol";
import { S } from "./strings";

export type FeedbackBadgeTone = "success" | "warning" | "danger" | "info" | "muted" | "accent" | "failed";
export type FeedbackBadge = { status: FeedbackStatus; label: string; tone: FeedbackBadgeTone; icon: string; spin?: boolean };

type BadgeInput = Pick<Feedback, "status" | "retrying" | "restartPending" | "failure"> & Partial<Pick<Feedback, "blocked" | "reapplying">>;

const BADGES: Record<Exclude<FeedbackStatus, "running">, Omit<FeedbackBadge, "label">> = {
  checking: { status: "checking", tone: "info", icon: "sync", spin: true },
  fixing: { status: "fixing", tone: "muted", icon: "sync", spin: true },
  applied: { status: "applied", tone: "success", icon: "check" },
  awaitingRestart: { status: "awaitingRestart", tone: "warning", icon: "debug-restart" },
  failed: { status: "failed", tone: "failed", icon: "error" },
  noChanges: { status: "noChanges", tone: "muted", icon: "dash" },
  needsInput: { status: "needsInput", tone: "accent", icon: "comment" },
  reverted: { status: "reverted", tone: "muted", icon: "discard" },
  resolved: { status: "resolved", tone: "muted", icon: "pass" },
  dismissed: { status: "dismissed", tone: "muted", icon: "close" },
  blocked: { status: "blocked", tone: "muted", icon: "watch" },
};

export function feedbackBadge(feedback: BadgeInput | undefined): FeedbackBadge | null {
  if (!feedback || feedback.status === "running") return null;
  const status: Exclude<FeedbackStatus, "running"> = feedback.retrying ? "checking" : feedback.status === "reverted" && feedback.restartPending ? "awaitingRestart" : feedback.status;
  const label = status === "blocked" ? S.feedbackBlockedLabel[feedback.blocked?.reason ?? "environment"] : status === "fixing" && feedback.reapplying ? S.feedbackReapplying : S.feedbackStatus[status];
  return { ...BADGES[status], label };
}

export function feedbackFailureReason(feedback: Pick<Feedback, "status" | "retrying" | "failure">): string | null {
  if (feedback.status !== "failed" || feedback.retrying) return null;
  const first = (feedback.failure ?? "").split("\n")[0].replace(/^Not applied:\s*/, "").trim();
  return first ? S.feedbackFailed(first) : null;
}

export function countNotApplied(feedbacks: (BadgeInput | undefined)[]): number {
  return feedbacks.filter((f) => feedbackBadge(f)?.status === "failed").length;
}

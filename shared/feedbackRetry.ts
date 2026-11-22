import type { Feedback } from "./protocol";

export function canRetryChecks(feedback: Pick<Feedback, "status" | "checks" | "retrying"> & Partial<Pick<Feedback, "blocked">>): boolean {
  if (feedback.status === "blocked") return feedback.blocked?.stage === "checks";
  return feedback.status === "failed" && !feedback.retrying && feedback.checks.length > 0;
}

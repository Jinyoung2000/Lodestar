import type { Feedback, FeedbackStatus } from "../shared/protocol";
import { S } from "./strings";

// Lodestar improvements 행의 상태 표시. 서버의 Feedback 상태 값을 짧은 라벨, 색 계열, 아이콘으로 묶는다.
export type FeedbackBadgeTone = "success" | "warning" | "danger" | "info" | "muted" | "accent" | "failed";
export type FeedbackBadge = { status: FeedbackStatus; label: string; tone: FeedbackBadgeTone; icon: string; spin?: boolean };

type BadgeInput = Pick<Feedback, "status" | "retrying" | "restartPending" | "failure"> & Partial<Pick<Feedback, "blocked" | "reapplying">>;

const BADGES: Record<Exclude<FeedbackStatus, "running">, Omit<FeedbackBadge, "label">> = {
  checking: { status: "checking", tone: "info", icon: "sync", spin: true },
  fixing: { status: "fixing", tone: "muted", icon: "sync", spin: true },
  applied: { status: "applied", tone: "success", icon: "check" },
  awaitingRestart: { status: "awaitingRestart", tone: "warning", icon: "debug-restart" },
  // 실패는 No changes 와 한눈에 갈라져야 하지만 빨강 경고처럼 공격적이면 안 된다(사용자). 아이콘만 차분한 붉은 기운(.feedback-state[data-tone="failed"])이고 문구는 다른 상태처럼 흐리다.
  failed: { status: "failed", tone: "failed", icon: "error" },
  noChanges: { status: "noChanges", tone: "muted", icon: "dash" },
  needsInput: { status: "needsInput", tone: "accent", icon: "comment" },
  reverted: { status: "reverted", tone: "muted", icon: "discard" },
  // FBREDO: 사람이 정리한 항목. 차분한 표시(Applied 쪽에 모인다)
  resolved: { status: "resolved", tone: "muted", icon: "pass" },
  dismissed: { status: "dismissed", tone: "muted", icon: "close" },
  // FBBLOCK: 환경이나 인증 때문에 스스로 다시 시도하는 중. 실패가 아니라서 빨강 기운 없이 흐린 대기 표시(시계 모양 watch)
  blocked: { status: "blocked", tone: "muted", icon: "watch" },
};

// 개선 세션이 도는 중(running)은 행의 기존 실행 표시가 맡아서 null 이다.
export function feedbackBadge(feedback: BadgeInput | undefined): FeedbackBadge | null {
  if (!feedback || feedback.status === "running") return null;
  // 실패한 검사를 다시 돌리는 중에는 status 가 checking 이지만 retrying 이 먼저 켜진다.
  const status: Exclude<FeedbackStatus, "running"> = feedback.retrying ? "checking" : feedback.status === "reverted" && feedback.restartPending ? "awaitingRestart" : feedback.status;
  // FBREBASE: 본 작업 폴더가 바뀌어 개선 세션이 그 위에 변경을 다시 적용하는 중이면 Fixing 이 아니라 Re-applying 으로 읽힌다.
  const label = status === "blocked" ? S.feedbackBlockedLabel[feedback.blocked?.reason ?? "environment"] : status === "fixing" && feedback.reapplying ? S.feedbackReapplying : S.feedbackStatus[status];
  return { ...BADGES[status], label };
}

// 미적용 행의 hover 툴팁에 붙일 실패 이유 첫 줄. 서버 문장이 이미 "Not applied:" 로 시작하면 접두를 한 번만 둔다.
export function feedbackFailureReason(feedback: Pick<Feedback, "status" | "retrying" | "failure">): string | null {
  if (feedback.status !== "failed" || feedback.retrying) return null;
  const first = (feedback.failure ?? "").split("\n")[0].replace(/^Not applied:\s*/, "").trim();
  return first ? S.feedbackFailed(first) : null;
}

export function countNotApplied(feedbacks: (BadgeInput | undefined)[]): number {
  return feedbacks.filter((f) => feedbackBadge(f)?.status === "failed").length;
}

import type { Feedback, FeedbackStatus } from "./protocol";
import { canRunAgain } from "./feedbackResume";

// PERFDAEMON: 끝난 피드백이 남기는 것을 얼마나 오래 둘지 정하는 규칙(순수 함수). 시험: test/feedbackretention.test.ts
// 두 가지를 따로 정한다.
// 1) worktree: 개선 세션이 일하던 사본(<repo>.worktrees/feedback-<id>, 25MB 안팎)과 그 워크스페이스. 끝난 뒤 이어서 대화하거나 변경 패널을 보는 데만 쓴다.
// 2) 되돌리기 백업(backup, backup-dist, backup-dist-electron): Revert 는 "이 피드백보다 늦게 반영된 피드백이 없을 때" 만 되므로(server/feedback.ts revert), 가장 최근에 반영된 몇 개 말고는 쓸 일이 없다.

// 끝난 상태. 더 돌아갈 일이 없고 사람이 정리했거나(resolved, dismissed) 반영이 끝났거나(applied) 바뀐 게 없는(noChanges) 것.
// reverted 도 포함한다: 되돌림이 끝났고 재시작 대기(restartPending)는 보호 조건에서 따로 거른다.
export const ENDED_STATUSES: ReadonlySet<FeedbackStatus> = new Set(["applied", "resolved", "dismissed", "noChanges", "reverted"]);

export type RetentionPolicy = {
  // 끝난 피드백 중 최근에 끝난 이만큼은 worktree 를 둔다
  worktreeKeepRecent: number;
  // 마지막 갱신이 이 일수 안이면 worktree 를 둔다 (위 개수와 둘 중 하나라도 걸리면 둔다)
  worktreeKeepDays: number;
  // 반영된 피드백 중 가장 최근에 반영된 이만큼은 되돌리기 백업을 둔다
  backupKeepApplied: number;
  // 반영한 지 이 일수 안이면 백업을 둔다
  backupKeepDays: number;
};

export const DEFAULT_RETENTION: RetentionPolicy = { worktreeKeepRecent: 5, worktreeKeepDays: 3, backupKeepApplied: 3, backupKeepDays: 3 };

// 호출이 준 값 중 0 이상의 유한한 수만 받고 나머지는 기본값을 쓴다.
export function withPolicy(override: Partial<RetentionPolicy> | undefined): RetentionPolicy {
  const next = { ...DEFAULT_RETENTION };
  for (const key of Object.keys(next) as (keyof RetentionPolicy)[]) {
    const value = override?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) next[key] = value;
  }
  return next;
}

// 계획에 필요한 사실만 모은다. 디스크와 데몬 상태를 읽는 쪽(server/feedback.ts)이 채운다.
export type RetentionFacts = {
  id: string;
  feedback: Pick<Feedback, "status" | "restartRequested" | "restartPending" | "retrying"> & Partial<Pick<Feedback, "interrupted" | "blocked" | "sessionFailed" | "checks" | "failure">>;
  updatedAt: number;
  appliedAt: number | null;
  // 개선 세션이 돌거나 승인을 기다리는 중이거나, 검사와 반영 파이프라인이 도는 중
  busy: boolean;
  hasWorktree: boolean;
  hasBackup: boolean;
};

export type KeepReason = "active" | "restart" | "retryable" | "busy" | "recent" | "recentApplied";
export type RetentionEntry = { id: string; action: "keep" | "worktree" | "backup" | "both"; reason: KeepReason | null };

// 정리 계획(feedback.tidyPlan 의 결과). 크기는 바이트. worktree 가 없거나 백업이 없으면 0.
export type TidyEntry = {
  id: string;
  text: string;
  status: FeedbackStatus;
  updatedAt: string;
  action: RetentionEntry["action"];
  reason: KeepReason | null;
  worktree: string | null;
  worktreeBytes: number;
  backupBytes: number;
  generatedBytes: number;
};
export type TidyPlan = {
  policy: RetentionPolicy;
  now: number;
  entries: TidyEntry[];
  totals: { feedbacks: number; kept: number; worktrees: number; worktreeBytes: number; backups: number; backupBytes: number; generatedBytes: number; workspaces: number };
};
export type TidyResult = { worktrees: number; backups: number; workspaces: number; freedBytes: number; skipped: string[]; failed: { id: string; error: string }[] };

const DAY_MS = 86_400_000;

// 정리하면 안 되는 이유. 진행 중이거나 다시 돌릴 수 있는 것(Run Again, Retry), 재시작 대기는 어떤 경우에도 건드리지 않는다.
export function protectedReason(facts: RetentionFacts): KeepReason | null {
  const { feedback } = facts;
  if (facts.busy) return "busy";
  if (!ENDED_STATUSES.has(feedback.status)) return canRunAgain(feedback) ? "retryable" : "active";
  if (feedback.restartRequested || feedback.restartPending || feedback.retrying) return "restart";
  return null;
}

export function planRetention(all: readonly RetentionFacts[], now: number, policy: RetentionPolicy = DEFAULT_RETENTION): RetentionEntry[] {
  const ended = all.filter((f) => protectedReason(f) === null).sort((a, b) => b.updatedAt - a.updatedAt);
  const recentIds = new Set(ended.slice(0, policy.worktreeKeepRecent).map((f) => f.id));
  const applied = ended.filter((f) => f.feedback.status === "applied").sort((a, b) => (b.appliedAt ?? b.updatedAt) - (a.appliedAt ?? a.updatedAt));
  const recentApplied = new Set(applied.slice(0, policy.backupKeepApplied).map((f) => f.id));

  return all.map((facts) => {
    const reason = protectedReason(facts);
    if (reason) return { id: facts.id, action: "keep", reason };
    const worktreeKept = recentIds.has(facts.id) || now - facts.updatedAt < policy.worktreeKeepDays * DAY_MS;
    const backupKept = recentApplied.has(facts.id) || now - (facts.appliedAt ?? facts.updatedAt) < policy.backupKeepDays * DAY_MS;
    const worktree = facts.hasWorktree && !worktreeKept;
    const backup = facts.hasBackup && !backupKept;
    if (worktree && backup) return { id: facts.id, action: "both", reason: null };
    if (worktree) return { id: facts.id, action: "worktree", reason: null };
    if (backup) return { id: facts.id, action: "backup", reason: null };
    return { id: facts.id, action: "keep", reason: facts.hasWorktree && worktreeKept ? "recent" : facts.hasBackup && backupKept ? "recentApplied" : null };
  });
}

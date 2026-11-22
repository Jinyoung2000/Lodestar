import type { Feedback, FeedbackStatus } from "./protocol";
import { canRunAgain } from "./feedbackResume";

export const ENDED_STATUSES: ReadonlySet<FeedbackStatus> = new Set(["applied", "resolved", "dismissed", "noChanges", "reverted"]);

export type RetentionPolicy = {
  worktreeKeepRecent: number;
  worktreeKeepDays: number;
  backupKeepApplied: number;
  backupKeepDays: number;
};

export const DEFAULT_RETENTION: RetentionPolicy = { worktreeKeepRecent: 5, worktreeKeepDays: 3, backupKeepApplied: 3, backupKeepDays: 3 };

export function withPolicy(override: Partial<RetentionPolicy> | undefined): RetentionPolicy {
  const next = { ...DEFAULT_RETENTION };
  for (const key of Object.keys(next) as (keyof RetentionPolicy)[]) {
    const value = override?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) next[key] = value;
  }
  return next;
}

export type RetentionFacts = {
  id: string;
  feedback: Pick<Feedback, "status" | "restartRequested" | "restartPending" | "retrying"> & Partial<Pick<Feedback, "interrupted" | "blocked" | "sessionFailed" | "checks" | "failure">>;
  updatedAt: number;
  appliedAt: number | null;
  busy: boolean;
  hasWorktree: boolean;
  hasBackup: boolean;
};

export type KeepReason = "active" | "restart" | "retryable" | "busy" | "recent" | "recentApplied";
export type RetentionEntry = { id: string; action: "keep" | "worktree" | "backup" | "both"; reason: KeepReason | null };

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

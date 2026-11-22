import type { PrCheck, PrCommitText, PrDetail, PrMergeable, PrMergeMethod, PrRequiredReviews } from "./prTypes";


export const MERGE_METHODS: readonly PrMergeMethod[] = ["merge", "squash", "rebase"];

export type MergeReadiness = "mergeable" | "conflict" | "blocked" | "behind" | "unknown";

export function mergeReadiness(mergeable: PrMergeable, mergeStateStatus: string | null): MergeReadiness {
  if (mergeable === "CONFLICTING") return "conflict";
  if (mergeStateStatus === "BLOCKED") return "blocked";
  if (mergeStateStatus === "BEHIND") return "behind";
  return mergeable === "MERGEABLE" ? "mergeable" : "unknown";
}

export function defaultMergeMethod(methods: Record<PrMergeMethod, boolean>, preferred: PrMergeMethod = "merge"): PrMergeMethod | null {
  if (methods[preferred]) return preferred;
  return MERGE_METHODS.find((m) => methods[m]) ?? null;
}

export type MergeArea = {
  state: "open" | "merged" | "closed";
  readiness: MergeReadiness;
  action: "ready" | "merge" | null;
  canDeleteBranch: boolean;
};

export function mergeArea(detail: Pick<PrDetail, "state" | "isDraft" | "merge">): MergeArea {
  const info = detail.merge;
  const readiness = mergeReadiness(info.mergeable, info.mergeStateStatus);
  if (detail.state !== "OPEN") {
    const canDeleteBranch = info.headRefId !== null && !info.headIsDefault && info.canDeleteHead;
    return { state: detail.state === "MERGED" ? "merged" : "closed", readiness, action: null, canDeleteBranch };
  }
  const action = detail.isDraft ? (info.canUpdate ? "ready" : null) : readiness === "mergeable" && info.canWrite ? "merge" : null;
  return { state: "open", readiness, action, canDeleteBranch: false };
}

export type CommitSource = { number: number; title: string; body: string; headLabel: string; commitMessages: string[] };
export type CommitSettings = { mergeCommitTitle: string | null; mergeCommitMessage: string | null; squashMergeCommitTitle: string | null; squashMergeCommitMessage: string | null };

export function commitTextFor(title: string | null, message: string | null, pr: CommitSource): PrCommitText {
  const suffix = `(#${pr.number})`;
  let headline = "";
  if (title === "PR_TITLE") headline = `${pr.title} ${suffix}`;
  else if (title === "MERGE_MESSAGE") headline = `Merge pull request #${pr.number} from ${pr.headLabel}`;
  else if (title === "COMMIT_OR_PR_TITLE") headline = pr.commitMessages.length === 1 ? `${pr.commitMessages[0].split("\n")[0]} ${suffix}` : `${pr.title} ${suffix}`;
  let body = "";
  if (message === "PR_BODY") body = pr.body;
  else if (message === "PR_TITLE") body = pr.title;
  else if (message === "COMMIT_MESSAGES") {
    if (pr.commitMessages.length === 1 && title === "COMMIT_OR_PR_TITLE") {
      const lines = pr.commitMessages[0].split("\n");
      body = lines.length > 1 ? lines.slice(1).join("\n").trim() : "";
    } else body = pr.commitMessages.map((m) => `* ${m}`).join("\n\n");
  }
  return { title: headline, body };
}

export function commitTexts(settings: CommitSettings, pr: CommitSource): Record<"merge" | "squash", PrCommitText> {
  const merge = settings.mergeCommitTitle && settings.mergeCommitMessage ? commitTextFor(settings.mergeCommitTitle, settings.mergeCommitMessage, pr) : { title: `Merge pull request #${pr.number} from ${pr.headLabel}`, body: pr.title };
  const squash = settings.squashMergeCommitTitle && settings.squashMergeCommitMessage ? commitTextFor(settings.squashMergeCommitTitle, settings.squashMergeCommitMessage, pr) : { title: `${pr.title} (#${pr.number})`, body: "" };
  return { merge, squash };
}

export function requiredReviews(count: number, approvals: string[], requestedChanges: string[]): PrRequiredReviews | null {
  if (count <= 0) return null;
  let state: PrRequiredReviews["state"] = "success";
  if (approvals.length < count) state = requestedChanges.length ? "pending" : "failure";
  return { count, approvals, requestedChanges, state };
}

export function requiredReviewSummary(r: PrRequiredReviews): string {
  if (r.state === "failure") return `At least ${r.count} approving review${r.count > 1 ? "s" : ""} is required by reviewers with write access.`;
  if (r.state === "pending") return `${r.requestedChanges.length} review${r.requestedChanges.length > 1 ? "s" : ""} requesting changes by reviewers with write access.`;
  return `${r.approvals.length} approving review${r.approvals.length > 1 ? "s" : ""} by reviewers with write access.`;
}

export function checksSummary(checks: PrCheck[]): string {
  const label: Record<PrCheck["state"], string> = { success: "successful", failure: "failed", neutral: "skipped", pending: "pending" };
  const counts = new Map<PrCheck["state"], number>();
  for (const check of checks) counts.set(check.state, (counts.get(check.state) ?? 0) + 1);
  return [...counts].map(([state, n]) => `${n} ${label[state]} check${n > 1 ? "s" : ""}`).join(" and ");
}

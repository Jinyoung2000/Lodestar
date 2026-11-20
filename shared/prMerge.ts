import type { PrCheck, PrCommitText, PrDetail, PrMergeable, PrMergeMethod, PrRequiredReviews } from "./prTypes";


export const MERGE_METHODS: readonly PrMergeMethod[] = ["merge", "squash", "rebase"];

// 확장의 머지 가능 판정(pu): 충돌이 아니면 mergeStateStatus 의 BLOCKED, BEHIND 가 mergeable 을 덮는다. UNSTABLE, HAS_HOOKS 는 머지할 수 있다.
export type MergeReadiness = "mergeable" | "conflict" | "blocked" | "behind" | "unknown";

export function mergeReadiness(mergeable: PrMergeable, mergeStateStatus: string | null): MergeReadiness {
  if (mergeable === "CONFLICTING") return "conflict";
  if (mergeStateStatus === "BLOCKED") return "blocked";
  if (mergeStateStatus === "BEHIND") return "behind";
  return mergeable === "MERGEABLE" ? "mergeable" : "unknown";
}

// 저장소 설정에서 고른 기본 방식. 확장은 설정 githubPullRequests.defaultMergeMethod(기본 merge)가 허용되면 그것, 아니면 merge, squash, rebase 순으로 허용된 첫 방식이다.
// Lodestar 에는 그 설정이 없으므로 확장의 기본값(merge)과 같은 결과다. 허용된 방식이 없으면 null.
export function defaultMergeMethod(methods: Record<PrMergeMethod, boolean>, preferred: PrMergeMethod = "merge"): PrMergeMethod | null {
  if (methods[preferred]) return preferred;
  return MERGE_METHODS.find((m) => methods[m]) ?? null;
}

// 머지 영역에 무엇을 보일지. 확장의 StatusChecksSection, MergeStatusAndActions, PrActions, DeleteOption 순서를 따른다.
//  - 머지됨, 닫힘: 상태 문구, 원격 head 브랜치가 남아 있으면 Delete Branch...
//  - 열림: 머지 가능 상태 줄, 그 아래 동작(draft 면 Ready for Review, 머지 가능하고 쓰기 권한이 있으면 Merge Pull Request, 아니면 없음)
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
    // 확장은 원격 브랜치가 지워졌거나(headRef 없음) 기본 브랜치면 원격 삭제를 내지 않는다
    const canDeleteBranch = info.headRefId !== null && !info.headIsDefault && info.canDeleteHead;
    return { state: detail.state === "MERGED" ? "merged" : "closed", readiness, action: null, canDeleteBranch };
  }
  const action = detail.isDraft ? (info.canUpdate ? "ready" : null) : readiness === "mergeable" && info.canWrite ? "merge" : null;
  return { state: "open", readiness, action, canDeleteBranch: false };
}

// 확장의 기본 커밋 문구(om). 저장소 설정 mergeCommitTitle/Message, squashMergeCommitTitle/Message 를 따른다.
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

// 저장소 설정을 못 읽었을 때 확장이 쓰는 문구(getDefaultTitleText, getDefaultDescriptionText)
export function commitTexts(settings: CommitSettings, pr: CommitSource): Record<"merge" | "squash", PrCommitText> {
  const merge = settings.mergeCommitTitle && settings.mergeCommitMessage ? commitTextFor(settings.mergeCommitTitle, settings.mergeCommitMessage, pr) : { title: `Merge pull request #${pr.number} from ${pr.headLabel}`, body: pr.title };
  const squash = settings.squashMergeCommitTitle && settings.squashMergeCommitMessage ? commitTextFor(settings.squashMergeCommitTitle, settings.squashMergeCommitMessage, pr) : { title: `${pr.title} (#${pr.number})`, body: "" };
  return { merge, squash };
}

// 확장의 필수 리뷰 판정(getStatusChecks): 보호 규칙의 승인 수보다 적으면 failure, 그중 변경 요청이 있으면 pending. 규칙이 없거나 0 이면 null.
export function requiredReviews(count: number, approvals: string[], requestedChanges: string[]): PrRequiredReviews | null {
  if (count <= 0) return null;
  let state: PrRequiredReviews["state"] = "success";
  if (approvals.length < count) state = requestedChanges.length ? "pending" : "failure";
  return { count, approvals, requestedChanges, state };
}

// 확장의 필수 리뷰 문구(getRequiredReviewSummary)
export function requiredReviewSummary(r: PrRequiredReviews): string {
  if (r.state === "failure") return `At least ${r.count} approving review${r.count > 1 ? "s" : ""} is required by reviewers with write access.`;
  if (r.state === "pending") return `${r.requestedChanges.length} review${r.requestedChanges.length > 1 ? "s" : ""} requesting changes by reviewers with write access.`;
  return `${r.approvals.length} approving review${r.approvals.length > 1 ? "s" : ""} by reviewers with write access.`;
}

// 확장의 체크 요약(getSummaryLabel): 처음 나온 상태 순서로 "1 failed check and 2 successful checks"
export function checksSummary(checks: PrCheck[]): string {
  const label: Record<PrCheck["state"], string> = { success: "successful", failure: "failed", neutral: "skipped", pending: "pending" };
  const counts = new Map<PrCheck["state"], number>();
  for (const check of checks) counts.set(check.state, (counts.get(check.state) ?? 0) + 1);
  return [...counts].map(([state, n]) => `${n} ${label[state]} check${n > 1 ? "s" : ""}`).join(" and ");
}

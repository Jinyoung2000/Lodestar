
export type PrRepo = {
  fullName: string;
  dirs: string[];
  remote: string;
  upstreamOf: string | null;
};

export type PrUser = { login: string; avatarUrl: string | null };

export type PrStatusResult = {
  available: boolean;
  reason: string | null;
  viewer: PrUser | null;
  repos: PrRepo[];
};

export type PrChecksState = "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | null;
export type PrReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
export type PrState = "OPEN" | "CLOSED" | "MERGED";

export type PrSummary = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: PrUser | null;
  isDraft: boolean;
  state: PrState;
  updatedAt: string;
  reviewDecision: PrReviewDecision;
  checks: PrChecksState;
  comments: number;
  baseRef: string;
  headRef: string;
};

export const PR_QUERIES = ["waiting", "assigned", "created", "all"] as const;
export type PrQueryName = (typeof PR_QUERIES)[number];
export type PrListResult = Record<PrQueryName, PrSummary[]>;

export type PrLabel = { name: string; color: string };

export type PrCheck = { name: string; state: "success" | "failure" | "pending" | "neutral"; detail: string; url: string | null; durationMs: number | null };

export type PrReviewer = { name: string; avatarUrl: string | null; state: "REQUESTED" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" };

export type PrComment = {
  id: string;
  anchorId: string | null;
  author: PrUser | null;
  body: string;
  createdAt: string;
  updatedAt: string | null;
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
  pending: boolean;
  reviewId: string | null;
};

export type PrThread = {
  id: string;
  path: string;
  isResolved: boolean;
  isOutdated: boolean;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  side: "LEFT" | "RIGHT";
  startSide: "LEFT" | "RIGHT" | null;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  comments: PrComment[];
};

export type PrTimelineEntry =
  | { kind: "comment"; comment: PrComment }
  | { kind: "review"; id: string; anchorId: string | null; author: PrUser | null; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"; body: string; createdAt: string };

export type PrPendingReview = { id: string; comments: number };

export type PrCommit = { oid: string; abbreviatedOid: string; headline: string; url: string; authoredAt: string; author: PrUser | null; authorName: string | null };

export type PrMergeMethod = "merge" | "squash" | "rebase";
export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type PrCommitText = { title: string; body: string };

export type PrRequiredReviews = { count: number; approvals: string[]; requestedChanges: string[]; state: "success" | "failure" | "pending" };

export type PrMergeInfo = {
  mergeable: PrMergeable;
  mergeStateStatus: string | null;
  methods: Record<PrMergeMethod, boolean>;
  deleteBranchOnMerge: boolean;
  canWrite: boolean;
  canUpdate: boolean;
  headRefId: string | null;
  headLabel: string;
  headRepoName: string | null;
  canDeleteHead: boolean;
  headIsDefault: boolean;
  requiredReviews: PrRequiredReviews | null;
  commitText: Record<"merge" | "squash", PrCommitText>;
};

export type PrDetail = PrSummary & {
  id: string;
  body: string;
  labels: PrLabel[];
  assignees: PrUser[];
  reviewers: PrReviewer[];
  checkList: PrCheck[];
  commitList: PrCommit[];
  commitCount: number;
  timeline: PrTimelineEntry[];
  threads: PrThread[];
  headSha: string;
  headRepo: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  viewer: PrUser | null;
  pendingReview: PrPendingReview | null;
  truncated: boolean;
  merge: PrMergeInfo;
};

export type PrFile = {
  path: string;
  previousPath: string | null;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch: string | null;
  viewed: boolean;
};

export type PrCheckoutResult = { workspaceId: string; dir: string; branch: string; reused: boolean };

export type PrLocalTarget =
  | { kind: "checked-out"; workspaceId: string; dir: string; branch: string | null; exact: boolean }
  | { kind: "commit"; workspaceId: string; dir: string }
  | { kind: "fetch-needed"; workspaceId: string; dir: string }
  | { kind: "no-workspace" };

type Confirmed = { confirmed: true };
type Ref = { repo: string; number: number };
type Anchor = { path: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; startSide?: "LEFT" | "RIGHT" };

export type PrRpcMethods = {
  "pr.status": { params: Record<string, never>; result: PrStatusResult };
  "pr.list": { params: { repo: string }; result: PrListResult };
  "pr.get": { params: Ref; result: PrDetail };
  "pr.files": { params: Ref & { prId: string }; result: PrFile[] };
  "pr.addComment": { params: Ref & Confirmed & { prId: string; body: string }; result: null };
  "pr.createThread": { params: Ref & Confirmed & Anchor & { prId: string; headSha: string; body: string; mode: "single" | "review"; pendingReviewId: string | null }; result: null };
  "pr.reply": { params: Ref & Confirmed & { threadId: string; body: string; pendingReviewId: string | null }; result: null };
  "pr.editComment": { params: Confirmed & { id: string; kind: "review" | "issue"; body: string }; result: null };
  "pr.deleteComment": { params: Confirmed & { id: string; kind: "review" | "issue" }; result: null };
  "pr.setResolved": { params: Confirmed & { threadId: string; resolved: boolean }; result: null };
  "pr.submitReview": { params: Ref & Confirmed & { prId: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string; pendingReviewId: string | null }; result: null };
  "pr.discardReview": { params: Confirmed & { pendingReviewId: string }; result: null };
  "pr.setViewed": { params: Ref & Confirmed & { prId: string; path: string; viewed: boolean }; result: null };
  "pr.checkout": { params: Ref & Confirmed; result: PrCheckoutResult };
  "pr.local": { params: Ref & { headRef: string; headSha: string }; result: PrLocalTarget };
  "pr.fileAt": { params: { workspaceId: string; sha: string; path: string }; result: { text: string | null } };
  "pr.merge": { params: Ref & Confirmed & { prId: string; method: PrMergeMethod; expectedHeadOid: string; commitHeadline: string; commitBody: string }; result: null };
  "pr.readyForReview": { params: Ref & Confirmed & { prId: string }; result: null };
  "pr.deleteBranch": { params: Ref & Confirmed & { headRefId: string }; result: { branch: string } };
};

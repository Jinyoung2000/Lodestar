// PR: GitHub Pull Requests 화면과 데몬이 주고받는 타입. 데몬은 gh CLI 로만 GitHub 에 닿는다.

export type PrRepo = {
  // "owner/name"
  fullName: string;
  // 이 저장소를 가리키는 원격이 있는 워크스페이스 폴더들 (worktree 제외)
  dirs: string[];
  // 첫 폴더에서 이 저장소를 가리키는 원격 이름 (origin, upstream ...)
  remote: string;
  // fork 의 upstream 이라서 들어온 저장소
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
  // GraphQL node id
  id: string;
  // GitHub 주소 끝의 #discussion_r<번호>, #issuecomment-<번호> 가 가리키는 번호(fullDatabaseId, 문자열). 응답에 없으면 null
  anchorId: string | null;
  author: PrUser | null;
  body: string;
  createdAt: string;
  updatedAt: string | null;
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
  // 아직 제출하지 않은 리뷰의 코멘트
  pending: boolean;
  reviewId: string | null;
};

export type PrThread = {
  id: string;
  path: string;
  isResolved: boolean;
  isOutdated: boolean;
  // 현재 diff 에서의 줄. 낡은(outdated) 스레드는 null
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

// 저장소 보호 규칙이 요구하는 승인 수와 지금 상태(쓰기 권한 있는 리뷰어만 센다). 규칙이 없으면 null
export type PrRequiredReviews = { count: number; approvals: string[]; requestedChanges: string[]; state: "success" | "failure" | "pending" };

// Overview 아래 머지 영역이 쓰는 값. 판정은 shared/prMerge.ts
export type PrMergeInfo = {
  mergeable: PrMergeable;
  // GitHub 의 mergeStateStatus (CLEAN, BLOCKED, BEHIND, DIRTY, DRAFT, HAS_HOOKS, UNSTABLE, UNKNOWN)
  mergeStateStatus: string | null;
  // 저장소가 허용하는 머지 방식
  methods: Record<PrMergeMethod, boolean>;
  deleteBranchOnMerge: boolean;
  // 저장소 쓰기 권한(WRITE, MAINTAIN, ADMIN). 머지 버튼의 조건
  canWrite: boolean;
  // PR 을 고칠 수 있다(작성자이거나 쓰기 권한). Ready for Review 의 조건
  canUpdate: boolean;
  // 원격 head 브랜치의 ref node id. 이미 지워졌으면 null
  headRefId: string | null;
  // "owner:branch" (머지 커밋 기본 제목에 쓴다)
  headLabel: string;
  // head 브랜치가 있는 저장소 "owner/name"
  headRepoName: string | null;
  // head 저장소에 쓰기 권한이 있다(원격 브랜치 삭제의 조건)
  canDeleteHead: boolean;
  // head 브랜치가 그 저장소의 기본 브랜치다(지우자고 하지 않는다)
  headIsDefault: boolean;
  requiredReviews: PrRequiredReviews | null;
  // 확인 단계 입력칸의 기본 커밋 제목과 본문(저장소 설정을 따른다). rebase 는 입력칸이 없다
  commitText: Record<"merge" | "squash", PrCommitText>;
};

export type PrDetail = PrSummary & {
  // GraphQL node id (쓰기 동작이 쓴다)
  id: string;
  body: string;
  labels: PrLabel[];
  assignees: PrUser[];
  reviewers: PrReviewer[];
  checkList: PrCheck[];
  // 커밋 목록(오래된 것부터, 최대 100개)과 전체 개수
  commitList: PrCommit[];
  commitCount: number;
  timeline: PrTimelineEntry[];
  threads: PrThread[];
  headSha: string;
  // fork 에서 온 PR 이면 그 저장소 "owner/name"
  headRepo: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  viewer: PrUser | null;
  pendingReview: PrPendingReview | null;
  // 목록이 100개 한도에서 잘렸다
  truncated: boolean;
  merge: PrMergeInfo;
};

export type PrFile = {
  path: string;
  previousPath: string | null;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  // 큰 파일이나 바이너리는 GitHub 가 patch 를 주지 않는다
  patch: string | null;
  viewed: boolean;
};

export type PrCheckoutResult = { workspaceId: string; dir: string; branch: string; reused: boolean };

// 코드 보기(hover, 정의 이동)가 PR 의 새 쪽 글을 어디 것으로 쓰는지. 저장소는 원격 주소로, 체크아웃 여부는 HEAD 로 정한다(shared/prLsp.ts chooseLocalTarget).
//   checked-out: 이 폴더의 HEAD 가 PR head 브랜치이거나 head 커밋이다. 실제 파일을 읽고 그 워크스페이스의 LSP 에 붙인다. exact 가 거짓이면 브랜치만 같고 커밋은 다르다(로컬 커밋이 앞서거나 뒤처짐).
//   commit: 체크아웃은 없지만 head 커밋이 로컬 git 에 있다. git show 로 읽은 글을 가상 문서로 같은 워크스페이스 LSP 에 연다.
//   fetch-needed: 저장소는 있는데 head 커밋이 로컬에 없다(받으려면 네트워크가 필요해 자동으로 받지 않는다).
//   no-workspace: 이 저장소를 가리키는 원격이 있는 워크스페이스 폴더가 없다.
export type PrLocalTarget =
  | { kind: "checked-out"; workspaceId: string; dir: string; branch: string | null; exact: boolean }
  | { kind: "commit"; workspaceId: string; dir: string }
  | { kind: "fetch-needed"; workspaceId: string; dir: string }
  | { kind: "no-workspace" };

// 쓰기 요청은 사용자가 버튼을 눌렀다는 뜻으로 confirmed: true 를 싣는다. 없으면 데몬이 거절한다.
type Confirmed = { confirmed: true };
type Ref = { repo: string; number: number };
type Anchor = { path: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; startSide?: "LEFT" | "RIGHT" };

export type PrRpcMethods = {
  "pr.status": { params: Record<string, never>; result: PrStatusResult };
  "pr.list": { params: { repo: string }; result: PrListResult };
  "pr.get": { params: Ref; result: PrDetail };
  "pr.files": { params: Ref & { prId: string }; result: PrFile[] };
  "pr.addComment": { params: Ref & Confirmed & { prId: string; body: string }; result: null };
  // single 이면 바로 올리고, review 면 대기 리뷰에 쌓는다 (없으면 만든다)
  "pr.createThread": { params: Ref & Confirmed & Anchor & { prId: string; headSha: string; body: string; mode: "single" | "review"; pendingReviewId: string | null }; result: null };
  "pr.reply": { params: Ref & Confirmed & { threadId: string; body: string; pendingReviewId: string | null }; result: null };
  "pr.editComment": { params: Confirmed & { id: string; kind: "review" | "issue"; body: string }; result: null };
  "pr.deleteComment": { params: Confirmed & { id: string; kind: "review" | "issue" }; result: null };
  "pr.setResolved": { params: Confirmed & { threadId: string; resolved: boolean }; result: null };
  "pr.submitReview": { params: Ref & Confirmed & { prId: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string; pendingReviewId: string | null }; result: null };
  "pr.discardReview": { params: Confirmed & { pendingReviewId: string }; result: null };
  "pr.setViewed": { params: Ref & Confirmed & { prId: string; path: string; viewed: boolean }; result: null };
  "pr.checkout": { params: Ref & Confirmed; result: PrCheckoutResult };
  // 읽기 전용. 로컬 워크스페이스 중 이 PR 의 새 쪽 글을 줄 곳을 고른다
  "pr.local": { params: Ref & { headRef: string; headSha: string }; result: PrLocalTarget };
  // 읽기 전용. 워크스페이스 저장소의 sha 시점 파일 글(git show sha:path). 그 커밋에 파일이 없으면 null
  "pr.fileAt": { params: { workspaceId: string; sha: string; path: string }; result: { text: string | null } };
  // expectedHeadOid 는 화면이 본 head 커밋이다. 그 사이 브랜치가 바뀌었으면 GitHub 가 거절한다
  "pr.merge": { params: Ref & Confirmed & { prId: string; method: PrMergeMethod; expectedHeadOid: string; commitHeadline: string; commitBody: string }; result: null };
  "pr.readyForReview": { params: Ref & Confirmed & { prId: string }; result: null };
  // 머지되었거나 닫힌 PR 의 원격 head 브랜치를 지운다. 데몬이 PR 을 다시 읽어 상태와 ref 를 확인한 뒤 지운다
  "pr.deleteBranch": { params: Ref & Confirmed & { headRefId: string }; result: { branch: string } };
};

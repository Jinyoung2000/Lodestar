import { commitTexts, requiredReviews } from "../shared/prMerge";
import type { PrChecksState, PrCheck, PrCommit, PrComment, PrDetail, PrFile, PrListResult, PrMergeInfo, PrQueryName, PrReviewer, PrSummary, PrThread, PrTimelineEntry, PrUser } from "../shared/prTypes";

const SUMMARY_FIELDS = `number title url isDraft state updatedAt reviewDecision baseRefName headRefName
  author { login avatarUrl }
  comments { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

export const LIST_QUERY = `query PrList($waiting: String!, $assigned: String!, $created: String!, $all: String!) {
  waiting: search(query: $waiting, type: ISSUE, first: 30) { nodes { ... on PullRequest { ${SUMMARY_FIELDS} } } }
  assigned: search(query: $assigned, type: ISSUE, first: 30) { nodes { ... on PullRequest { ${SUMMARY_FIELDS} } } }
  created: search(query: $created, type: ISSUE, first: 30) { nodes { ... on PullRequest { ${SUMMARY_FIELDS} } } }
  all: search(query: $all, type: ISSUE, first: 30) { nodes { ... on PullRequest { ${SUMMARY_FIELDS} } } }
}`;

export function listVariables(repo: string): Record<PrQueryName, string> {
  const base = `repo:${repo} is:pr is:open sort:updated-desc`;
  return { waiting: `${base} review-requested:@me`, assigned: `${base} assignee:@me`, created: `${base} author:@me`, all: base };
}

const ISSUE_COMMENT_FIELDS = `id fullDatabaseId body createdAt lastEditedAt viewerCanUpdate viewerCanDelete author { login avatarUrl }`;
const COMMENT_FIELDS = `${ISSUE_COMMENT_FIELDS} state pullRequestReview { id state }`;

export const DETAIL_QUERY = `query PrDetail($owner: String!, $name: String!, $number: Int!) {
  viewer { login avatarUrl }
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge viewerPermission
    mergeCommitTitle mergeCommitMessage squashMergeCommitTitle squashMergeCommitMessage
    pullRequest(number: $number) {
      id ${SUMMARY_FIELDS} body headRefOid additions deletions changedFiles
      mergeable mergeStateStatus viewerCanUpdate
      headRef { id }
      headRepositoryOwner { login }
      headRepository { nameWithOwner viewerPermission defaultBranchRef { name } }
      baseRef { refUpdateRule { requiredApprovingReviewCount } }
      reviewsRequestingChanges: reviews(last: 5, states: [CHANGES_REQUESTED]) { nodes { authorCanPushToRepository author { login } } }
      labels(first: 30) { nodes { name color } }
      assignees(first: 10) { nodes { login avatarUrl } }
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } ... on Team { name } } } }
      latestReviews(first: 20) { nodes { state authorCanPushToRepository author { login avatarUrl } } }
      pendingReviews: reviews(first: 5, states: PENDING) { nodes { id comments { totalCount } } }
      reviews(first: 50) { nodes { id fullDatabaseId state body createdAt author { login avatarUrl } } }
      timelineComments: comments(first: 100) { totalCount nodes { ${ISSUE_COMMENT_FIELDS} } }
      reviewThreads(first: 100) {
        totalCount
        nodes {
          id path isResolved isOutdated line originalLine startLine originalStartLine diffSide startDiffSide viewerCanResolve viewerCanUnresolve
          comments(first: 50) { nodes { ${COMMENT_FIELDS} } }
        }
      }
      commitList: commits(first: 100) { totalCount nodes { commit { oid abbreviatedOid messageHeadline message url authoredDate author { name user { login avatarUrl } } } } }
      checkRuns: commits(last: 1) {
        nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl startedAt completedAt } ... on StatusContext { context state targetUrl } } } } } }
      }
    }
  }
}`;

export const DELETE_BRANCH_QUERY = `query PrDeleteBranchInfo($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { state headRefName headRef { id } headRepository { defaultBranchRef { name } } } }
}`;

export const VIEWED_QUERY = `query PrViewed($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { files(first: 100) { nodes { path viewerViewedState } } } }
}`;

type Json = Record<string, any>;

const user = (raw: Json | null | undefined): PrUser | null => (raw?.login ? { login: String(raw.login), avatarUrl: raw.avatarUrl ?? null } : null);

function checksState(raw: Json): PrChecksState {
  const state = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return state === "SUCCESS" || state === "FAILURE" || state === "PENDING" || state === "ERROR" || state === "EXPECTED" ? state : null;
}

export function parseSummary(repo: string, raw: Json): PrSummary {
  return {
    repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: user(raw.author),
    isDraft: !!raw.isDraft,
    state: raw.state === "MERGED" || raw.state === "CLOSED" ? raw.state : "OPEN",
    updatedAt: raw.updatedAt,
    reviewDecision: raw.reviewDecision ?? null,
    checks: checksState(raw),
    comments: raw.comments?.totalCount ?? 0,
    baseRef: raw.baseRefName,
    headRef: raw.headRefName,
  };
}

export function parseList(repo: string, data: Json): PrListResult {
  const pick = (name: PrQueryName): PrSummary[] => ((data[name]?.nodes ?? []) as Json[]).filter((node) => node?.number).map((node) => parseSummary(repo, node));
  return { waiting: pick("waiting"), assigned: pick("assigned"), created: pick("created"), all: pick("all") };
}

const anchorIdOf = (raw: Json): string | null => (raw.fullDatabaseId != null ? String(raw.fullDatabaseId) : null);

function parseCommits(raw: Json): PrCommit[] {
  return ((raw.commitList?.nodes ?? []) as Json[])
    .filter((node) => node?.commit?.oid)
    .map((node) => {
      const commit = node.commit as Json;
      return { oid: commit.oid, abbreviatedOid: commit.abbreviatedOid ?? String(commit.oid).slice(0, 7), headline: commit.messageHeadline ?? "", url: commit.url ?? "", authoredAt: commit.authoredDate ?? "", author: user(commit.author?.user), authorName: commit.author?.name ?? null };
    });
}

function parseComment(raw: Json): PrComment {
  const review = raw.pullRequestReview;
  return {
    id: raw.id,
    anchorId: anchorIdOf(raw),
    author: user(raw.author),
    body: raw.body ?? "",
    createdAt: raw.createdAt,
    updatedAt: raw.lastEditedAt ?? null,
    viewerCanUpdate: !!raw.viewerCanUpdate,
    viewerCanDelete: !!raw.viewerCanDelete,
    pending: raw.state === "PENDING" || review?.state === "PENDING",
    reviewId: review?.id ?? null,
  };
}

function parseThread(raw: Json): PrThread {
  const side = raw.diffSide === "LEFT" ? "LEFT" : "RIGHT";
  return {
    id: raw.id,
    path: raw.path,
    isResolved: !!raw.isResolved,
    isOutdated: !!raw.isOutdated,
    line: raw.line ?? null,
    startLine: raw.startLine ?? null,
    originalLine: raw.originalLine ?? null,
    originalStartLine: raw.originalStartLine ?? null,
    side,
    startSide: raw.startDiffSide === "LEFT" ? "LEFT" : raw.startDiffSide === "RIGHT" ? "RIGHT" : null,
    viewerCanResolve: !!raw.viewerCanResolve,
    viewerCanUnresolve: !!raw.viewerCanUnresolve,
    comments: ((raw.comments?.nodes ?? []) as Json[]).map(parseComment),
  };
}

function parseChecks(raw: Json): PrCheck[] {
  const contexts = (raw.checkRuns?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []) as Json[];
  return contexts.map((c) => {
    if (c.__typename === "CheckRun") {
      const done = c.status === "COMPLETED";
      const conclusion = String(c.conclusion ?? "");
      const state = !done ? "pending" : conclusion === "SUCCESS" ? "success" : conclusion === "NEUTRAL" || conclusion === "SKIPPED" ? "neutral" : "failure";
      const started = Date.parse(c.startedAt ?? "");
      const ended = Date.parse(c.completedAt ?? "");
      const durationMs = done && !Number.isNaN(started) && !Number.isNaN(ended) && ended >= started ? ended - started : null;
      return { name: c.name, state, detail: done ? conclusion.toLowerCase().replace(/_/g, " ") : String(c.status ?? "").toLowerCase().replace(/_/g, " "), url: c.detailsUrl ?? null, durationMs };
    }
    const state = c.state === "SUCCESS" ? "success" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "failure";
    return { name: c.context, state, detail: String(c.state ?? "").toLowerCase(), url: c.targetUrl ?? null, durationMs: null };
  });
}

function parseReviewers(raw: Json): PrReviewer[] {
  const out: PrReviewer[] = [];
  for (const node of (raw.reviewRequests?.nodes ?? []) as Json[]) {
    const who = node.requestedReviewer;
    if (who?.login) out.push({ name: who.login, avatarUrl: who.avatarUrl ?? null, state: "REQUESTED" });
    else if (who?.name) out.push({ name: who.name, avatarUrl: null, state: "REQUESTED" });
  }
  for (const node of (raw.latestReviews?.nodes ?? []) as Json[]) {
    if (!node.author?.login || out.some((r) => r.name === node.author.login)) continue;
    const state = node.state === "APPROVED" || node.state === "CHANGES_REQUESTED" || node.state === "DISMISSED" ? node.state : "COMMENTED";
    out.push({ name: node.author.login, avatarUrl: node.author.avatarUrl ?? null, state });
  }
  return out;
}

const WRITE_PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

export function parseMergeInfo(repo: string, repository: Json, pr: Json): PrMergeInfo {
  const headOwner = pr.headRepositoryOwner?.login ?? repo.split("/")[0];
  const headLabel = `${headOwner}:${pr.headRefName ?? ""}`;
  const canPush = (node: Json) => !!node.authorCanPushToRepository && !!node.author?.login;
  const approvals = ((pr.latestReviews?.nodes ?? []) as Json[]).filter((n) => canPush(n) && n.state === "APPROVED").map((n) => String(n.author.login));
  const requestedChanges = ((pr.reviewsRequestingChanges?.nodes ?? []) as Json[]).filter(canPush).map((n) => String(n.author.login));
  const commitMessages = ((pr.commitList?.nodes ?? []) as Json[]).filter((n) => n?.commit).map((n) => String(n.commit.message ?? n.commit.messageHeadline ?? ""));
  const headRepoName = pr.headRepository?.nameWithOwner ?? null;
  return {
    mergeable: pr.mergeable === "MERGEABLE" || pr.mergeable === "CONFLICTING" ? pr.mergeable : "UNKNOWN",
    mergeStateStatus: typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus : null,
    methods: { merge: repository.mergeCommitAllowed === true, squash: repository.squashMergeAllowed === true, rebase: repository.rebaseMergeAllowed === true },
    deleteBranchOnMerge: repository.deleteBranchOnMerge === true,
    canWrite: WRITE_PERMISSIONS.has(repository.viewerPermission),
    canUpdate: !!pr.viewerCanUpdate,
    headRefId: pr.headRef?.id ?? null,
    headLabel,
    headRepoName,
    canDeleteHead: WRITE_PERMISSIONS.has(headRepoName === repo ? repository.viewerPermission : pr.headRepository?.viewerPermission),
    headIsDefault: !!pr.headRepository?.defaultBranchRef?.name && pr.headRepository.defaultBranchRef.name === pr.headRefName,
    requiredReviews: requiredReviews(Number(pr.baseRef?.refUpdateRule?.requiredApprovingReviewCount ?? 0), approvals, requestedChanges),
    commitText: commitTexts(
      { mergeCommitTitle: repository.mergeCommitTitle ?? null, mergeCommitMessage: repository.mergeCommitMessage ?? null, squashMergeCommitTitle: repository.squashMergeCommitTitle ?? null, squashMergeCommitMessage: repository.squashMergeCommitMessage ?? null },
      { number: pr.number, title: pr.title ?? "", body: pr.body ?? "", headLabel, commitMessages },
    ),
  };
}

export function parseDetail(repo: string, data: Json): PrDetail {
  const pr = data.repository?.pullRequest as Json | undefined;
  if (!pr) throw new Error("Pull request not found");
  const timeline: PrTimelineEntry[] = [
    ...((pr.timelineComments?.nodes ?? []) as Json[]).map((c): PrTimelineEntry => ({ kind: "comment", comment: parseComment(c) })),
    ...((pr.reviews?.nodes ?? []) as Json[])
      .filter((r) => r.state !== "PENDING")
      .map((r): PrTimelineEntry => ({ kind: "review", id: r.id, anchorId: anchorIdOf(r), author: user(r.author), state: r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED" ? r.state : "COMMENTED", body: r.body ?? "", createdAt: r.createdAt })),
  ];
  const stamp = (e: PrTimelineEntry) => (e.kind === "comment" ? e.comment.createdAt : e.createdAt);
  timeline.sort((a, b) => stamp(a).localeCompare(stamp(b)));
  const pending = ((pr.pendingReviews?.nodes ?? []) as Json[])[0];
  return {
    ...parseSummary(repo, pr),
    id: pr.id,
    body: pr.body ?? "",
    labels: ((pr.labels?.nodes ?? []) as Json[]).map((l) => ({ name: l.name, color: l.color })),
    assignees: ((pr.assignees?.nodes ?? []) as Json[]).map((u) => user(u)).filter((u): u is PrUser => !!u),
    reviewers: parseReviewers(pr),
    checkList: parseChecks(pr),
    commitList: parseCommits(pr),
    commitCount: pr.commitList?.totalCount ?? 0,
    timeline,
    threads: ((pr.reviewThreads?.nodes ?? []) as Json[]).map(parseThread),
    headSha: pr.headRefOid,
    headRepo: pr.headRepository?.nameWithOwner && pr.headRepository.nameWithOwner !== repo ? pr.headRepository.nameWithOwner : null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
    viewer: user(data.viewer),
    pendingReview: pending ? { id: pending.id, comments: pending.comments?.totalCount ?? 0 } : null,
    truncated: (pr.reviewThreads?.totalCount ?? 0) > 100 || (pr.timelineComments?.totalCount ?? 0) > 100,
    merge: parseMergeInfo(repo, data.repository as Json, pr),
  };
}

export function parseFiles(rest: Json[], viewed: Json): PrFile[] {
  const states = new Map<string, boolean>();
  for (const node of (viewed.repository?.pullRequest?.files?.nodes ?? []) as Json[]) states.set(node.path, node.viewerViewedState === "VIEWED");
  return rest.map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    patch: typeof f.patch === "string" ? f.patch : null,
    viewed: states.get(f.filename) ?? false,
  }));
}

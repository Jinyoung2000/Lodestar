import type { PrFile, PrListResult, PrRpcMethods, PrStatusResult } from "../shared/prTypes";
import type { Workspace } from "../shared/protocol";
import { ghGraphql, ghRest, ghRestPages, GhError } from "./ghExec";
import { MERGE_METHODS } from "../shared/prMerge";
import { DELETE_BRANCH_QUERY, DETAIL_QUERY, LIST_QUERY, listVariables, parseDetail, parseFiles, parseList, VIEWED_QUERY } from "./prParse";
import { checkoutPullRequest, type CheckoutDeps } from "./prCheckout";
import { discoverRepos } from "./prRepos";
import { fileAt, localTarget } from "./prLocal";

export function requireConfirmed(params: unknown): void {
  if (!params || typeof params !== "object" || (params as { confirmed?: unknown }).confirmed !== true) throw new Error("This action changes GitHub and needs an explicit confirmation from the app.");
}

function splitRepo(repo: string): { owner: string; name: string } {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(String(repo));
  if (!match) throw new Error(`Not a GitHub repository: ${repo}`);
  return { owner: match[1], name: match[2] };
}

export type PrDeps = CheckoutDeps & { workspaces: () => Workspace[] };

type Handlers = { [M in keyof PrRpcMethods]: (params: PrRpcMethods[M]["params"]) => Promise<PrRpcMethods[M]["result"]> };

export function prHandlers(deps: PrDeps): Handlers {
  const topDirs = () => deps.workspaces().filter((w) => !w.parentId && !w.feedback).map((w) => w.dir);
  return {
    "pr.status": () => status(topDirs()),
    "pr.list": async ({ repo }) => list(repo),
    "pr.get": async ({ repo, number }) => {
      const { owner, name } = splitRepo(repo);
      return parseDetail(repo, await ghGraphql(DETAIL_QUERY, { owner, name, number: Number(number) }));
    },
    "pr.files": async ({ repo, number }) => files(repo, Number(number)),
    "pr.addComment": async (params) => {
      requireConfirmed(params);
      await ghGraphql("mutation PrAddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id } } } }", { input: { subjectId: params.prId, body: params.body } });
      return null;
    },
    "pr.createThread": async (params) => {
      requireConfirmed(params);
      const { owner, name } = splitRepo(params.repo);
      if (params.mode === "single") {
        await ghRest("POST", `repos/${owner}/${name}/pulls/${Number(params.number)}/comments`, {
          body: params.body,
          commit_id: params.headSha,
          path: params.path,
          line: params.line,
          side: params.side,
          ...(params.startLine !== undefined && params.startLine !== params.line ? { start_line: params.startLine, start_side: params.startSide ?? params.side } : {}),
        });
        return null;
      }
      await ghGraphql("mutation PrAddThread($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }", {
        input: {
          pullRequestId: params.prId,
          ...(params.pendingReviewId ? { pullRequestReviewId: params.pendingReviewId } : {}),
          path: params.path,
          body: params.body,
          line: params.line,
          side: params.side,
          ...(params.startLine !== undefined && params.startLine !== params.line ? { startLine: params.startLine, startSide: params.startSide ?? params.side } : {}),
        },
      });
      return null;
    },
    "pr.reply": async (params) => {
      requireConfirmed(params);
      await ghGraphql("mutation PrReply($input: AddPullRequestReviewThreadReplyInput!) { addPullRequestReviewThreadReply(input: $input) { comment { id } } }", {
        input: { pullRequestReviewThreadId: params.threadId, body: params.body, ...(params.pendingReviewId ? { pullRequestReviewId: params.pendingReviewId } : {}) },
      });
      return null;
    },
    "pr.editComment": async (params) => {
      requireConfirmed(params);
      if (params.kind === "issue") await ghGraphql("mutation PrEditIssueComment($input: UpdateIssueCommentInput!) { updateIssueComment(input: $input) { issueComment { id } } }", { input: { id: params.id, body: params.body } });
      else await ghGraphql("mutation PrEditReviewComment($input: UpdatePullRequestReviewCommentInput!) { updatePullRequestReviewComment(input: $input) { pullRequestReviewComment { id } } }", { input: { pullRequestReviewCommentId: params.id, body: params.body } });
      return null;
    },
    "pr.deleteComment": async (params) => {
      requireConfirmed(params);
      if (params.kind === "issue") await ghGraphql("mutation PrDeleteIssueComment($input: DeleteIssueCommentInput!) { deleteIssueComment(input: $input) { clientMutationId } }", { input: { id: params.id } });
      else await ghGraphql("mutation PrDeleteReviewComment($input: DeletePullRequestReviewCommentInput!) { deletePullRequestReviewComment(input: $input) { clientMutationId } }", { input: { id: params.id } });
      return null;
    },
    "pr.setResolved": async (params) => {
      requireConfirmed(params);
      if (params.resolved) await ghGraphql("mutation PrResolve($input: ResolveReviewThreadInput!) { resolveReviewThread(input: $input) { thread { id } } }", { input: { threadId: params.threadId } });
      else await ghGraphql("mutation PrUnresolve($input: UnresolveReviewThreadInput!) { unresolveReviewThread(input: $input) { thread { id } } }", { input: { threadId: params.threadId } });
      return null;
    },
    "pr.submitReview": async (params) => {
      requireConfirmed(params);
      if (params.pendingReviewId) await ghGraphql("mutation PrSubmitReview($input: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $input) { pullRequestReview { id } } }", { input: { pullRequestId: params.prId, pullRequestReviewId: params.pendingReviewId, event: params.event, body: params.body } });
      else await ghGraphql("mutation PrCreateReview($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }", { input: { pullRequestId: params.prId, event: params.event, body: params.body } });
      return null;
    },
    "pr.discardReview": async (params) => {
      requireConfirmed(params);
      await ghGraphql("mutation PrDiscardReview($input: DeletePullRequestReviewInput!) { deletePullRequestReview(input: $input) { clientMutationId } }", { input: { pullRequestReviewId: params.pendingReviewId } });
      return null;
    },
    "pr.setViewed": async (params) => {
      requireConfirmed(params);
      if (params.viewed) await ghGraphql("mutation PrMarkViewed($input: MarkFileAsViewedInput!) { markFileAsViewed(input: $input) { clientMutationId } }", { input: { pullRequestId: params.prId, path: params.path } });
      else await ghGraphql("mutation PrUnmarkViewed($input: UnmarkFileAsViewedInput!) { unmarkFileAsViewed(input: $input) { clientMutationId } }", { input: { pullRequestId: params.prId, path: params.path } });
      return null;
    },
    "pr.checkout": async (params) => {
      requireConfirmed(params);
      return checkoutPullRequest(deps, topDirs(), params.repo, Number(params.number));
    },
    "pr.local": async ({ repo, headRef, headSha }) => {
      splitRepo(repo);
      return localTarget(deps, repo, String(headRef), String(headSha));
    },
    "pr.fileAt": async ({ workspaceId, sha, path }) => fileAt(deps, String(workspaceId), sha, path),
    "pr.merge": async (params) => {
      requireConfirmed(params);
      if (!MERGE_METHODS.includes(params.method)) throw new Error(`Unknown merge method: ${String(params.method)}`);
      const input = {
        pullRequestId: params.prId,
        mergeMethod: params.method.toUpperCase(),
        expectedHeadOid: params.expectedHeadOid,
        ...(params.method === "rebase" ? {} : { commitHeadline: String(params.commitHeadline ?? ""), commitBody: String(params.commitBody ?? "") }),
      };
      try {
        await ghGraphql("mutation PrMerge($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { id state } } }", { input });
      } catch (error) {
        if (/Head branch was modified/i.test(String((error as Error).message))) throw new Error("Head branch was modified. Pull, review, then try again.");
        throw error;
      }
      return null;
    },
    "pr.readyForReview": async (params) => {
      requireConfirmed(params);
      await ghGraphql("mutation PrReadyForReview($input: MarkPullRequestReadyForReviewInput!) { markPullRequestReadyForReview(input: $input) { pullRequest { id isDraft } } }", { input: { pullRequestId: params.prId } });
      return null;
    },
    "pr.deleteBranch": async (params) => {
      requireConfirmed(params);
      const { owner, name } = splitRepo(params.repo);
      const info = (await ghGraphql(DELETE_BRANCH_QUERY, { owner, name, number: Number(params.number) })) as { repository?: { pullRequest?: { state: string; headRefName: string; headRef: { id: string } | null; headRepository: { defaultBranchRef: { name: string } | null } | null } } };
      const pr = info.repository?.pullRequest;
      if (!pr) throw new Error("Pull request not found");
      if (pr.state === "OPEN") throw new Error("Only the branch of a merged or closed pull request can be deleted.");
      if (!pr.headRef || pr.headRef.id !== params.headRefId) throw new Error("The pull request branch changed or was already deleted. Refresh and try again.");
      if (pr.headRepository?.defaultBranchRef?.name === pr.headRefName) throw new Error("The default branch is not deleted.");
      await ghGraphql("mutation PrDeleteRef($input: DeleteRefInput!) { deleteRef(input: $input) { clientMutationId } }", { input: { refId: pr.headRef.id } });
      return { branch: pr.headRefName };
    },
  };
}

async function status(dirs: string[]): Promise<PrStatusResult> {
  try {
    const data = (await ghGraphql("query PrViewer { viewer { login avatarUrl } }", {})) as { viewer?: { login: string; avatarUrl: string } };
    const repos = await discoverRepos(dirs);
    return { available: true, reason: repos.length ? null : "No workspace folder has a GitHub remote.", viewer: data.viewer ? { login: data.viewer.login, avatarUrl: data.viewer.avatarUrl } : null, repos };
  } catch (error) {
    const message = error instanceof GhError ? error.message : String(error);
    const loggedOut = error instanceof GhError && error.kind === "failed";
    return { available: false, reason: loggedOut ? `GitHub CLI is not signed in or could not reach GitHub. Run gh auth login. (${message})` : message, viewer: null, repos: [] };
  }
}

async function list(repo: string): Promise<PrListResult> {
  splitRepo(repo);
  return parseList(repo, await ghGraphql(LIST_QUERY, listVariables(repo)));
}

async function files(repo: string, number: number): Promise<PrFile[]> {
  const { owner, name } = splitRepo(repo);
  const [rest, viewed] = await Promise.all([ghRestPages<Record<string, unknown>>(`repos/${owner}/${name}/pulls/${number}/files?per_page=100`), ghGraphql(VIEWED_QUERY, { owner, name, number })]);
  return parseFiles(rest, viewed);
}


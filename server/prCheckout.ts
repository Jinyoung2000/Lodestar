import { git } from "./git";
import { worktreePath, repoRoot } from "./git";
import { ghGraphql } from "./ghExec";
import { discoverRepos } from "./prRepos";
import type { PrCheckoutResult } from "../shared/prTypes";
import type { Workspace } from "../shared/protocol";

export type CheckoutDeps = {
  addWorkspace: (dir: string, parentId: string | null, name: string) => Workspace;
  workspaceOfDir: (dir: string) => Workspace | undefined;
  announce: () => void;
  markReview?: (dir: string) => void;
};

export async function checkoutPullRequest(deps: CheckoutDeps, dirs: string[], repo: string, number: number): Promise<PrCheckoutResult> {
  const repos = await discoverRepos(dirs);
  const found = repos.find((r) => r.fullName === repo);
  if (!found) throw new Error(`No workspace folder has a git remote for ${repo}. Add the folder as a workspace first.`);
  const dir = found.dirs[0];
  const root = await repoRoot(dir);
  if (!root) throw new Error(`${dir} is not a git repository`);
  const [owner, name] = repo.split("/");
  const data = (await ghGraphql("query PrCheckoutInfo($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefName headRepository { nameWithOwner } } } }", { owner, name, number })) as {
    repository?: { pullRequest?: { headRefName: string; headRepository: { nameWithOwner: string } | null } | null };
  };
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error("Pull request not found");
  const fromFork = !!pr.headRepository && pr.headRepository.nameWithOwner !== repo;
  const branch = fromFork ? `pr-${number}-${pr.headRefName.replace(/[^\w.-]+/g, "-")}` : pr.headRefName;
  if (!/^[\w./-]+$/.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/") || branch.startsWith("-")) throw new Error(`Unsafe branch name: ${branch}`);

  const existing = await worktreeOfBranch(root, branch);
  let path = existing;
  let reused = !!existing;
  if (!path) {
    path = worktreePath(root, branch);
    if (fromFork) {
      await git(root, ["fetch", found.remote, `pull/${number}/head`]);
      await git(root, ["worktree", "add", "-b", branch, path, "FETCH_HEAD"]);
    } else {
      await git(root, ["fetch", found.remote, `+refs/heads/${pr.headRefName}:refs/remotes/${found.remote}/${pr.headRefName}`]);
      const hasLocal = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
      if (hasLocal) await git(root, ["worktree", "add", path, branch]);
      else await git(root, ["worktree", "add", "-b", branch, path, `${found.remote}/${pr.headRefName}`]);
    }
    deps.markReview?.(path);
    reused = false;
  }
  const parent = deps.workspaceOfDir(dir);
  const workspace = deps.workspaceOfDir(path) ?? deps.addWorkspace(path, parent?.id ?? null, `${parent?.name ?? repo} (${branch})`);
  deps.announce();
  return { workspaceId: workspace.id, dir: path, branch, reused };
}

async function worktreeOfBranch(root: string, branch: string): Promise<string | null> {
  const output = await git(root, ["worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

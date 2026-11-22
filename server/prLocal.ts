import type { PrLocalTarget } from "../shared/prTypes";
import { chooseLocalTarget, isRepoRelativePath, isSha, type PrLocalCandidate } from "../shared/prLsp";
import { git, repoRoot, worktreePath } from "./git";
import { discoverRepos } from "./prRepos";
import type { PrDeps } from "./pr";

const tryGit = (cwd: string, args: string[]) => git(cwd, args).then((out) => out.trim(), () => null);

export async function localTarget(deps: PrDeps, repo: string, headRef: string, headSha: string): Promise<PrLocalTarget> {
  if (!isSha(headSha)) throw new Error(`Not a commit id: ${String(headSha)}`);
  const all = deps.workspaces().filter((w) => !w.feedback && !w.archived);
  const tops = all.filter((w) => !w.parentId);
  const found = (await discoverRepos(tops.map((w) => w.dir))).find((r) => r.fullName === repo);
  if (!found) return { kind: "no-workspace" };
  const matchedTops = tops.filter((w) => found.dirs.includes(w.dir));
  const matched = [...matchedTops, ...all.filter((w) => w.parentId && matchedTops.some((t) => t.id === w.parentId))];
  const candidates: PrLocalCandidate[] = await Promise.all(
    matched.map(async (w) => ({
      workspaceId: w.id,
      dir: w.dir,
      topLevel: !w.parentId,
      headSha: await tryGit(w.dir, ["rev-parse", "HEAD"]),
      branch: await tryGit(w.dir, ["symbolic-ref", "--short", "-q", "HEAD"]),
      hasCommit: (await tryGit(w.dir, ["cat-file", "-e", `${headSha}^{commit}`])) !== null,
    })),
  );
  const root = await repoRoot(found.dirs[0]);
  return chooseLocalTarget({ headRef, headSha, checkoutDir: root ? worktreePath(root, headRef) : null }, candidates);
}

const MAX_BYTES = 2 * 1024 * 1024;

export async function fileAt(deps: PrDeps, workspaceId: string, sha: string, path: string): Promise<{ text: string | null }> {
  if (!isSha(sha)) throw new Error(`Not a commit id: ${String(sha)}`);
  if (!isRepoRelativePath(path)) throw new Error(`Not a repository path: ${String(path)}`);
  const workspace = deps.workspaces().find((w) => w.id === workspaceId);
  if (!workspace) throw new Error("Unknown workspace");
  const text = await git(workspace.dir, ["show", `${sha}:${path}`]).catch(() => null);
  return { text: text !== null && Buffer.byteLength(text) <= MAX_BYTES ? text : null };
}

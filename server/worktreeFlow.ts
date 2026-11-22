import { existsSync } from "node:fs";
import type { WorktreeMergeInfo, WorktreePrResult } from "../shared/protocol";
import { git } from "./git";
import { GhError, runGh } from "./ghExec";
import { parseRemoteUrl } from "./prRepos";
import { T } from "./strings";

export type WorktreeRef = { root: string; branch: string; base: string };

type MergeInfo = WorktreeMergeInfo;
type PullRequestResult = WorktreePrResult;

const run = async (cwd: string, args: string[]) => (await git(cwd, args)).trim();
const tryRun = (cwd: string, args: string[]) => run(cwd, args).catch(() => null);

export async function targetBranch(root: string, base: string): Promise<string> {
  const remotes = ((await tryRun(root, ["remote"])) ?? "").split("\n").filter(Boolean);
  const remote = remotes.find((name) => base.startsWith(`${name}/`));
  return remote ? base.slice(remote.length + 1) : base;
}

export function checkedOutAt(porcelain: string, branch: string): string | null {
  let path: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

export async function mergeInfo(ref: WorktreeRef): Promise<MergeInfo> {
  const target = await targetBranch(ref.root, ref.base);
  const info: MergeInfo = { branch: ref.branch, target, unmerged: 0, blocker: null };
  if (!(await tryRun(ref.root, ["rev-parse", "--verify", "-q", `refs/heads/${target}`]))) return { ...info, blocker: T.errMergeNoTarget(target) };
  info.unmerged = Number((await tryRun(ref.root, ["rev-list", "--count", `${target}..${ref.branch}`])) ?? 0);
  if (info.unmerged === 0) return { ...info, blocker: T.errMergeNothing(ref.branch, target) };
  if ((await run(ref.root, ["status", "--porcelain"])) !== "") return { ...info, blocker: T.errMergeWorktreeDirty };
  return info;
}

export async function mergeIntoBase(ref: WorktreeRef): Promise<{ target: string; fastForward: boolean; commits: number; dir: string | null }> {
  const info = await mergeInfo(ref);
  if (info.blocker) throw new Error(info.blocker);
  const { target } = info;
  const dir = checkedOutAt(await run(ref.root, ["worktree", "list", "--porcelain"]), target);
  const targetHead = await run(ref.root, ["rev-parse", target]);
  const fastForward = (await tryRun(ref.root, ["merge-base", "--is-ancestor", targetHead, ref.branch])) !== null;
  if (!dir) {
    if (!fastForward) throw new Error(T.errMergeNotCheckedOut(target));
    await run(ref.root, ["update-ref", `refs/heads/${target}`, await run(ref.root, ["rev-parse", ref.branch]), targetHead]);
    return { target, fastForward: true, commits: info.unmerged, dir: null };
  }
  if ((await run(dir, ["status", "--porcelain"])) !== "") throw new Error(T.errMergeTargetDirty(target, dir));
  try {
    await git(dir, ["merge", "--no-edit", ref.branch]);
  } catch (error) {
    const conflicted = ((await tryRun(dir, ["diff", "--name-only", "--diff-filter=U"])) ?? "").split("\n").filter(Boolean);
    if (existsSync(await mergeHead(dir))) await tryRun(dir, ["merge", "--abort"]);
    if (conflicted.length > 0) throw new Error(T.errMergeConflict(target, conflicted));
    throw new Error(gitMessage(error));
  }
  return { target, fastForward, commits: info.unmerged, dir };
}

async function mergeHead(dir: string) {
  return (await run(dir, ["rev-parse", "--git-path", "MERGE_HEAD"])).replace(/^(?!\/)/, `${dir}/`);
}

function gitMessage(error: unknown) {
  const e = error as { stderr?: string; stdout?: string; message?: string };
  return String(e.stderr ?? "").trim() || String(e.stdout ?? "").trim().split("\n").slice(-1)[0] || String(e.message);
}

export async function unmergedCount(ref: WorktreeRef): Promise<number | null> {
  const target = await targetBranch(ref.root, ref.base);
  const count = await tryRun(ref.root, ["rev-list", "--count", `${target}..${ref.branch}`]);
  return count === null ? null : Number(count);
}

export function compareUrl(repo: string, base: string, branch: string) {
  const encode = (name: string) => name.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/compare/${encode(base)}...${encode(branch)}?expand=1`;
}

type PullDeps = { gh: typeof runGh };

export async function createPullRequest(ref: WorktreeRef, deps: PullDeps = { gh: runGh }): Promise<PullRequestResult> {
  const base = await targetBranch(ref.root, ref.base);
  const remoteUrl = await tryRun(ref.root, ["config", "--get", "remote.origin.url"]);
  if (!remoteUrl) throw new Error(T.errPrNoRemote);
  if ((await unmergedCount(ref)) === 0) throw new Error(T.errMergeNothing(ref.branch, base));
  try {
    await git(ref.root, ["push", "-u", "origin", ref.branch]);
  } catch (error) {
    throw new Error(T.errPushFailed(gitMessage(error)));
  }
  const repo = parseRemoteUrl(remoteUrl);
  if (!repo) return { kind: "pushed", url: null, message: T.prPushedNoGithub(ref.branch) };
  try {
    const out = await deps.gh(["pr", "create", "--fill", "--head", ref.branch, "--base", base, "--repo", repo], { cwd: ref.root });
    const url = /https:\/\/\S+\/pull\/\d+/.exec(out)?.[0] ?? null;
    return { kind: "created", url, message: T.prCreated(ref.branch, base) };
  } catch (error) {
    const message = (error as Error).message;
    const existing = /https:\/\/\S+\/pull\/\d+/.exec(message)?.[0];
    if (existing) return { kind: "existing", url: existing, message: T.prExists(ref.branch) };
    if (error instanceof GhError && error.kind === "missing") return { kind: "pushed", url: compareUrl(repo, base, ref.branch), message: T.prPushedNoGh(ref.branch) };
    throw new Error(T.errPrCreateFailed(ref.branch, message));
  }
}

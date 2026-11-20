import { existsSync } from "node:fs";
import type { WorktreeMergeInfo, WorktreePrResult } from "../shared/protocol";
import { git } from "./git";
import { GhError, runGh } from "./ghExec";
import { parseRemoteUrl } from "./prRepos";
import { T } from "./strings";

// 워크트리 세션의 마무리: 기본 브랜치로 합치기, PR 준비(dogfood 4회차 7번), 삭제 전 미병합 안내.
// 합치기는 기준 브랜치가 체크아웃된 작업 트리(보통 원래 저장소 폴더)에서 한다. 워크트리 안에서는 기준 브랜치를 체크아웃할 수 없어서다.
// --force 는 쓰지 않는다. 충돌이면 merge --abort 로 되돌리고 알린다. push 와 gh pr create 는 사용자가 확인한 뒤에만 부른다(index.ts 의 confirmed).
export type WorktreeRef = { root: string; branch: string; base: string };

type MergeInfo = WorktreeMergeInfo;
type PullRequestResult = WorktreePrResult;

const run = async (cwd: string, args: string[]) => (await git(cwd, args)).trim();
const tryRun = (cwd: string, args: string[]) => run(cwd, args).catch(() => null);

// 기준 브랜치 이름에서 원격 접두사(origin/)를 뗀 로컬 브랜치 이름
export async function targetBranch(root: string, base: string): Promise<string> {
  const remotes = ((await tryRun(root, ["remote"])) ?? "").split("\n").filter(Boolean);
  const remote = remotes.find((name) => base.startsWith(`${name}/`));
  return remote ? base.slice(remote.length + 1) : base;
}

// `git worktree list --porcelain` 에서 브랜치가 체크아웃된 작업 트리 경로.
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

// 기준 브랜치로 합친다. 기준 브랜치가 체크아웃된 작업 트리가 깨끗하면 거기서 git merge(되면 fast-forward, 아니면 merge 커밋).
// 어느 작업 트리에도 체크아웃돼 있지 않으면 fast-forward 가 되는 경우에만 브랜치 포인터를 옮긴다.
export async function mergeIntoBase(ref: WorktreeRef): Promise<{ target: string; fastForward: boolean; commits: number; dir: string | null }> {
  const info = await mergeInfo(ref);
  if (info.blocker) throw new Error(info.blocker);
  const { target } = info;
  const dir = checkedOutAt(await run(ref.root, ["worktree", "list", "--porcelain"]), target);
  const targetHead = await run(ref.root, ["rev-parse", target]);
  const fastForward = (await tryRun(ref.root, ["merge-base", "--is-ancestor", targetHead, ref.branch])) !== null;
  if (!dir) {
    if (!fastForward) throw new Error(T.errMergeNotCheckedOut(target));
    // 옛 값을 같이 넘겨 그 사이 기준 브랜치가 움직였으면 git 이 거절한다
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

// 워크트리를 지울 때 알려 줄 것: 기준 브랜치에 아직 없는 커밋 수. 기준 브랜치를 못 찾으면 null.
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

// PR 준비: 브랜치를 origin 에 push 한다(-u, force 없음). GitHub 원격이고 gh 가 있으면 브라우저를 열지 않고 gh pr create --fill 로 PR 까지 만든다.
// gh 가 없거나 GitHub 가 아니면 push 까지 하고, GitHub 원격이면 비교 URL 을 돌려준다(화면이 복사한다).
export async function createPullRequest(ref: WorktreeRef, deps: PullDeps = { gh: runGh }): Promise<PullRequestResult> {
  const base = await targetBranch(ref.root, ref.base);
  // remote get-url 은 insteadOf 로 바뀐 주소를 주므로 설정에 적힌 그대로의 주소를 읽는다(GitHub 인지 판단하려는 것)
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
    // gh 가 없으면 push 한 것으로 끝내고 비교 URL 을 준다. 그 밖의 gh 실패는 push 가 됐다는 사실과 함께 알린다.
    if (error instanceof GhError && error.kind === "missing") return { kind: "pushed", url: compareUrl(repo, base, ref.branch), message: T.prPushedNoGh(ref.branch) };
    throw new Error(T.errPrCreateFailed(ref.branch, message));
  }
}

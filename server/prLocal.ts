import type { PrLocalTarget } from "../shared/prTypes";
import { chooseLocalTarget, isRepoRelativePath, isSha, type PrLocalCandidate } from "../shared/prLsp";
import { git, repoRoot, worktreePath } from "./git";
import { discoverRepos } from "./prRepos";
import type { PrDeps } from "./pr";

// PR diff 의 언어 기능이 쓸 로컬 글을 찾는다. 둘 다 읽기만 한다(네트워크 fetch 와 worktree 만들기는 하지 않는다. 그건 Checkout 버튼이 한다).

const tryGit = (cwd: string, args: string[]) => git(cwd, args).then((out) => out.trim(), () => null);

// 이 PR 의 저장소를 가리키는 원격이 있는 워크스페이스 폴더(와 그 아래 붙은 worktree 워크스페이스)에서 새 쪽 글을 줄 곳을 고른다.
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

// 워크스페이스 저장소의 sha 시점 파일 글. 그 커밋에 파일이 없거나 너무 크면 null
export async function fileAt(deps: PrDeps, workspaceId: string, sha: string, path: string): Promise<{ text: string | null }> {
  if (!isSha(sha)) throw new Error(`Not a commit id: ${String(sha)}`);
  if (!isRepoRelativePath(path)) throw new Error(`Not a repository path: ${String(path)}`);
  const workspace = deps.workspaces().find((w) => w.id === workspaceId);
  if (!workspace) throw new Error("Unknown workspace");
  // `<sha>:<path>` 는 revision 한 개라서 path 가 옵션으로 읽히지 않는다(앞이 sha 이고, - 로 시작하는 경로도 거절했다)
  const text = await git(workspace.dir, ["show", `${sha}:${path}`]).catch(() => null);
  return { text: text !== null && Buffer.byteLength(text) <= MAX_BYTES ? text : null };
}

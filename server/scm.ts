import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { classifyGitFailure, type GitProblem, type GitVerb } from "../shared/gitProblems";
import { buildHunkPatch, newFileDiff, parseGitDiff, patchSafePath, type ParsedDiff } from "../shared/hunkPatch";
import { parseStatus, type ScmCode, type ScmCommit, type ScmCommitFile, type ScmCommitOptions, type ScmCommitResult, type ScmDiffSection, type ScmDiscardResult, type ScmEntry, type ScmFileDiff, type ScmOperation, type ScmOperationResult, type ScmPullMode, type ScmRepoWorktrees, type ScmStatus, type ScmSyncResult, type ScmWorktree } from "../shared/scm";
import { applyToIndex, fetch as gitFetch, git, info, pull, push, repoRoot } from "./git";
import { realDir, realPathLoose } from "./paths";
import { moveToTrash, pruneEmptyDirs, trashDir } from "./trash";

export { moveToTrash, trashDir };

// SCM: Source Control 보기의 git 동작. git 은 server/git.ts 의 git() 로만 부르고, 인자는 배열로만 넘기며 --force 는 쓰지 않는다.
// 경로는 저장소 안만 받는다. 폴더는 상태 목록에서 그 아래 파일로 풀어서 다루고(git clean 은 쓰지 않는다), 새 파일을 지우는 대신 휴지통으로 옮긴다.

export const SCM_MESSAGES = {
  badPath: (path: string) => `Path is outside the repository: ${path}`,
  noCommits: "There are no commits yet.",
  emptyMessage: "Please provide a commit message.",
  notRepository: "This folder is not a git repository.",
  badCommit: (hash: string) => `Unknown commit: ${hash}`,
  trashOutside: (path: string) => `Refusing to move a file outside the repository to the Trash: ${path}`,
  hunkStale: "The file changed since this diff was loaded. The diff has been refreshed.",
  hunkPath: "This file name has characters git quotes in patches. Stage the whole file instead.",
  hunkBinary: "Binary files cannot be staged by block.",
  noOperation: "There is no merge or rebase in progress.",
  unresolved: { kind: "conflict", title: "Some conflicts are not resolved yet", hint: "Mark every file under Merge Changes as resolved, then continue." } as GitProblem,
};

const execFileAsync = promisify(execFile);

// 경로를 저장소 루트 기준 상대 경로로 정규화한다. 저장소 밖이거나 .git 안이면 거절한다.
export function scmRelPath(root: string, input: string): string {
  if (!input || input.includes("\0")) throw new Error(SCM_MESSAGES.badPath(input));
  let rel = input;
  if (isAbsolute(input)) {
    rel = relative(realDir(root), realPathLoose(input));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(SCM_MESSAGES.badPath(input));
  }
  const normalized = normalize(rel).replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) throw new Error(SCM_MESSAGES.badPath(input));
  if (normalized === ".git" || normalized.startsWith(".git/")) throw new Error(SCM_MESSAGES.badPath(input));
  return normalized;
}

// --literal-pathspecs: ":(top)x" 같은 경로가 pathspec 문법으로 읽히지 않게 한다.
const LITERAL = "--literal-pathspecs";
const CHUNK = 200;

async function tryGit(cwd: string, args: string[]) {
  try {
    return (await git(cwd, args)).trim();
  } catch {
    return null;
  }
}

// git 이 낸 문장 전부(stdout 과 stderr). 훅은 두 쪽에 다 쓰므로 둘을 이어 붙인다.
export function gitOutput(error: unknown): string {
  const e = error as { stdout?: string; stderr?: string; message?: string };
  const text = [e.stdout, e.stderr]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join("\n");
  return text || (e.message ?? String(error));
}

async function needRoot(cwd: string) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error(SCM_MESSAGES.notRepository);
  return root;
}

// --- 상태 ---

const EMPTY: ScmStatus = { repoRoot: null, hasHead: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, hasRemote: false, staged: [], changes: [], conflicts: [], merging: false, lastCommit: null };

export async function status(cwd: string): Promise<ScmStatus> {
  const root = await repoRoot(cwd);
  if (!root) return EMPTY;
  const [raw, base, remotes, gitDir] = await Promise.all([
    git(root, ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all"]),
    info(root, null),
    tryGit(root, ["remote"]),
    tryGit(root, ["rev-parse", "--absolute-git-dir"]),
  ]);
  const files = parseStatus(raw, root);
  const { merging, operation } = operationOf(gitDir);
  const detached = base.hasHead && base.branch === "HEAD";
  return {
    repoRoot: root,
    hasHead: base.hasHead,
    branch: detached ? ((await tryGit(root, ["rev-parse", "--short", "HEAD"])) ?? "HEAD") : base.hasHead ? base.branch : await tryGit(root, ["symbolic-ref", "--short", "HEAD"]),
    detached,
    upstream: base.upstream,
    ahead: base.ahead,
    behind: base.behind,
    hasRemote: !!remotes,
    ...files,
    merging,
    lastCommit: base.hasHead ? await lastCommitOf(root, base) : null,
    operation,
    ...(operation && gitDir ? { operationText: await operationTextOf(gitDir, operation), mergeMessage: operation === "merge" ? await mergeMessageOf(gitDir) : "" } : {}),
  };
}

// 진행 중인 병합이나 리베이스. 둘 다 저장소(worktree)마다 따로인 git 폴더 안의 표식 파일로 안다.
function operationOf(gitDir: string | null): { merging: boolean; operation: ScmOperation | null } {
  if (!gitDir) return { merging: false, operation: null };
  const merging = existsSync(join(gitDir, "MERGE_HEAD"));
  if (merging) return { merging, operation: "merge" };
  return { merging, operation: existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply")) ? "rebase" : null };
}

async function readSmall(path: string) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

// 병합은 MERGE_MSG 첫 줄, 리베이스는 "브랜치 현재 단계/전체" 한 줄
async function operationTextOf(gitDir: string, operation: ScmOperation): Promise<string> {
  if (operation === "merge") return (await mergeMessageOf(gitDir)).split("\n")[0] ?? "";
  const dir = existsSync(join(gitDir, "rebase-merge")) ? join(gitDir, "rebase-merge") : join(gitDir, "rebase-apply");
  const [head, step, total, next, last] = await Promise.all(["head-name", "msgnum", "end", "next", "last"].map((name) => readSmall(join(dir, name))));
  const branch = head.replace(/^refs\/heads\//, "");
  const progress = (step || next) && (total || last) ? ` ${step || next}/${total || last}` : "";
  return `${branch}${progress}`.trim();
}

// MERGE_MSG 에서 git 이 붙인 "# Conflicts:" 같은 주석 줄을 뺀 병합 커밋 메시지
async function mergeMessageOf(gitDir: string): Promise<string> {
  const raw = await readSmall(join(gitDir, "MERGE_MSG"));
  return raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

async function lastCommitOf(root: string, base: { upstream: string | null; ahead: number }) {
  const line = await tryGit(root, ["log", "-1", "--format=%H%x1f%s%x1f%P"]);
  if (!line) return null;
  const [hash, subject, parents] = line.split("\x1f");
  let pushed = !!base.upstream && base.ahead === 0;
  if (!pushed) {
    const remote = (await tryGit(root, ["branch", "-r", "--contains", "HEAD"])) ?? "";
    pushed = remote.split("\n").some((l) => l.trim() && !l.includes("->"));
  }
  return { hash, subject, parents: parents ? parents.split(" ").length : 0, pushed };
}

// --- 스테이지, 스테이지 해제 ---

// 요청 경로(파일 또는 폴더)를 후보 목록에서 그 아래 파일로 푼다. 저장소 밖 경로는 여기서 거절한다.
function expand(root: string, requested: readonly string[], candidates: readonly ScmEntry[]): ScmEntry[] {
  const wanted = requested.map((p) => scmRelPath(root, p));
  const seen = new Set<string>();
  const out: ScmEntry[] = [];
  for (const entry of candidates) {
    if (seen.has(entry.rel)) continue;
    if (wanted.some((p) => entry.rel === p || entry.rel.startsWith(`${p}/`))) {
      seen.add(entry.rel);
      out.push(entry);
    }
  }
  return out;
}

async function inChunks(root: string, prefix: string[], paths: string[]) {
  for (let i = 0; i < paths.length; i += CHUNK) await git(root, [...prefix, "--", ...paths.slice(i, i + CHUNK)]);
}

export async function stage(cwd: string, paths: string[]) {
  const root = await needRoot(cwd);
  const current = await status(cwd);
  const entries = expand(root, paths, [...current.changes, ...current.conflicts]);
  await inChunks(root, [LITERAL, "add", "-A"], entries.map((e) => e.rel));
}

export async function unstage(cwd: string, paths: string[]) {
  const root = await needRoot(cwd);
  const current = await status(cwd);
  const entries = expand(root, paths, current.staged);
  // 이름 바뀜은 옛 경로의 삭제도 같이 되돌려야 한다
  const rels = [...new Set(entries.flatMap((e) => (e.code === "R" && e.from ? [e.rel, e.from] : [e.rel])))];
  await inChunks(root, current.hasHead ? [LITERAL, "restore", "--staged"] : [LITERAL, "rm", "--cached", "-r", "-q"], rels);
}

// --- 변경 버리기 ---

export async function discard(cwd: string, paths: string[]): Promise<ScmDiscardResult> {
  const root = await needRoot(cwd);
  const current = await status(cwd);
  const entries = expand(root, paths, current.changes);
  const tracked = entries.filter((e) => e.code !== "U" && e.code !== "A");
  // 추적하지 않는 새 파일과 intent-to-add 파일은 파일을 휴지통으로 옮긴다
  const fresh = entries.filter((e) => e.code === "U" || e.code === "A");
  await inChunks(root, [LITERAL, "restore"], tracked.map((e) => e.rel));
  const intent = fresh.filter((e) => e.code === "A").map((e) => e.rel);
  if (intent.length > 0) await inChunks(root, [LITERAL, "rm", "--cached", "-q"], intent);
  for (const entry of fresh) await trashInside(root, entry.rel);
  return { restored: tracked.length, trashed: fresh.length };
}

async function trashInside(root: string, rel: string) {
  const abs = join(realDir(root), rel);
  const parent = realPathLoose(dirname(abs));
  const inside = relative(realDir(root), parent);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(SCM_MESSAGES.trashOutside(rel));
  const target = await moveToTrash(join(parent, basename(abs)));
  await pruneEmptyDirs(realDir(root), parent);
  return target;
}

// --- 커밋 ---

export async function commit(cwd: string, options: ScmCommitOptions): Promise<ScmCommitResult> {
  const root = await needRoot(cwd);
  const message = options.message.trim();
  const current = await status(cwd);
  // 병합 중에는 메시지가 비어도 git 이 만들어 둔 MERGE_MSG 로 커밋한다
  if (!message && !options.amend && !current.merging) throw new Error(SCM_MESSAGES.emptyMessage);
  if (current.conflicts.length > 0) return { status: "conflicts" };
  if (options.amend) {
    if (!current.hasHead) throw new Error(SCM_MESSAGES.noCommits);
    if (current.lastCommit?.pushed && !options.confirmPushedAmend) return { status: "amendPushed" };
  } else if (current.staged.length === 0 && !current.merging) {
    if (current.changes.length === 0) return { status: "nothingToCommit" };
    if (!options.stageAll) return { status: "needsStageAll" };
    await git(root, ["add", "-A"]);
  }
  const args = ["commit", ...(options.amend ? ["--amend"] : []), ...(options.noVerify ? ["--no-verify"] : []), ...(message ? ["-m", message] : ["--no-edit"])];
  let out: string;
  try {
    out = await git(root, args);
  } catch (error) {
    const output = gitOutput(error);
    return { status: "failed", output, hook: /hook|husky|lint-staged|pre-commit|commit-msg/i.test(output) };
  }
  const summary = out.split("\n").find((l) => l.trim()) ?? "";
  let pushError: string | null = null;
  if (options.then) {
    try {
      if (options.then === "sync") await pullIfTracking(root);
      await push(root);
    } catch (error) {
      const problem = classifyGitFailure(gitOutput(error), "push", { branch: current.branch });
      pushError = `${problem.title}. ${problem.hint}`;
    }
  }
  return { status: "committed", summary, pushError };
}

// upstream 이 없으면 pull 할 것이 없다. 그 밖의 실패는 push 로 넘어가지 않고 올린다.
async function pullIfTracking(root: string) {
  try {
    await pull(root);
  } catch (error) {
    if (!/no tracking information/i.test(gitOutput(error))) throw error;
  }
}

// 마지막 커밋을 soft reset 으로 되돌리고(변경은 스테이지된 채 남는다) 그 커밋 메시지를 돌려준다. 첫 커밋은 HEAD 만 지운다.
export async function undoLastCommit(cwd: string): Promise<{ message: string }> {
  const root = await needRoot(cwd);
  const current = await status(cwd);
  if (!current.hasHead || !current.lastCommit) throw new Error(SCM_MESSAGES.noCommits);
  const message = (await git(root, ["log", "-1", "--format=%B"])).trim();
  if (current.lastCommit.parents === 0) await git(root, ["update-ref", "-d", "HEAD"]);
  else await git(root, ["reset", "--soft", "HEAD~1"]);
  return { message };
}

export async function lastCommitMessage(cwd: string): Promise<{ message: string }> {
  const root = await needRoot(cwd);
  const message = (await tryGit(root, ["log", "-1", "--format=%B"])) ?? "";
  return { message };
}

// --- Graph ---

const FIELD = "\x1f";

export async function graph(cwd: string, limit = 50): Promise<ScmCommit[]> {
  const root = await repoRoot(cwd);
  if (!root || !(await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))) return [];
  const upstream = await tryGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const count = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
  const out = await git(root, ["log", "-n", String(count), "--decorate=short", `--format=%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%P${FIELD}%D${FIELD}%s`, "HEAD", ...(upstream ? [upstream] : []), "--"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line): ScmCommit => {
      const [hash, short, author, date, parents, refs, ...subject] = line.split(FIELD);
      return {
        hash,
        short,
        author,
        date,
        parents: parents ? parents.split(" ").length : 0,
        refs: refs
          ? refs
              .split(", ")
              .map((r) => r.replace(/^HEAD -> /, ""))
              .filter(Boolean)
          : [],
        subject: subject.join(FIELD),
      };
    });
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function commitBase(root: string, hash: string) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash) || !(await tryGit(root, ["rev-parse", "--verify", "--quiet", `${hash}^{commit}`]))) throw new Error(SCM_MESSAGES.badCommit(hash));
  return (await tryGit(root, ["rev-parse", "--verify", "--quiet", `${hash}^1`])) ?? EMPTY_TREE;
}

// 커밋이 바꾼 파일 (첫 부모와 비교. 머지 커밋도 마찬가지)
export async function commitFiles(cwd: string, hash: string): Promise<ScmCommitFile[]> {
  const root = await needRoot(cwd);
  const base = await commitBase(root, hash);
  const [names, stats] = await Promise.all([git(root, ["diff", "--name-status", "-z", "-M", base, hash, "--"]), git(root, ["diff", "--numstat", "-z", "-M", base, hash, "--"])]);
  const files: ScmCommitFile[] = [];
  const parts = names.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const letter = parts[i];
    if (!letter) continue;
    const kind = letter[0];
    if (kind === "R" || kind === "C") {
      files.push({ rel: parts[i + 2], from: parts[i + 1], code: kind, additions: 0, deletions: 0 });
      i += 2;
    } else {
      files.push({ rel: parts[++i], code: kind === "A" || kind === "D" || kind === "T" ? (kind as ScmCode) : "M", additions: 0, deletions: 0 });
    }
  }
  const nums = stats.split("\0");
  for (let i = 0; i < nums.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(nums[i]);
    if (!m) continue;
    // 이름 바뀜은 "n\tn\t" 다음에 옛 경로와 새 경로가 따로 온다
    const rel = m[3] === "" ? nums[(i += 2)] : m[3];
    const file = files.find((f) => f.rel === rel);
    if (file) {
      file.additions = m[1] === "-" ? 0 : Number(m[1]);
      file.deletions = m[2] === "-" ? 0 : Number(m[2]);
    }
  }
  return files;
}

const MAX_DIFF = 200_000;

export async function commitFileDiff(cwd: string, hash: string, rel: string, from?: string): Promise<{ text: string; truncated: boolean }> {
  const root = await needRoot(cwd);
  const base = await commitBase(root, hash);
  const paths = [scmRelPath(root, rel), ...(from ? [scmRelPath(root, from)] : [])];
  const text = await git(root, [LITERAL, "diff", "--no-color", "--no-ext-diff", "-M", base, hash, "--", ...paths]);
  return text.length > MAX_DIFF ? { text: text.slice(0, MAX_DIFF), truncated: true } : { text, truncated: false };
}

// --- Worktrees ---

// 등록된 작업 폴더가 속한 저장소마다 `git worktree list`. 같은 저장소(공통 git 폴더)는 한 번만 센다.
export async function worktrees(dirs: readonly string[]): Promise<ScmRepoWorktrees[]> {
  const repos = new Map<string, ScmRepoWorktrees>();
  for (const dir of dirs) {
    const root = await repoRoot(dir);
    if (!root) continue;
    const common = await tryGit(root, ["rev-parse", "--git-common-dir"]);
    if (!common) continue;
    const key = await realpath(resolve(root, common)).catch(() => resolve(root, common));
    if (repos.has(key)) continue;
    repos.set(key, await readWorktrees(root));
  }
  return [...repos.values()];
}

export function isFeedbackWorktree(path: string, branch: string | null) {
  return branch !== null && /^feedback\/[0-9a-f]{8}$/.test(branch) && basename(path) === `feedback-${branch.slice("feedback/".length)}`;
}

async function readWorktrees(root: string): Promise<ScmRepoWorktrees> {
  const [list, refs] = await Promise.all([git(root, ["worktree", "list", "--porcelain"]), git(root, ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)", "refs/heads"])]);
  const tracking = new Map<string, { upstream: string | null; ahead: number; behind: number }>();
  for (const line of refs.split("\n").filter(Boolean)) {
    const [name, upstream, track] = line.split("\t");
    tracking.set(name, { upstream: upstream || null, ahead: Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0) });
  }
  const result: ScmWorktree[] = [];
  for (const block of list.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path || lines.includes("bare") || lines.some((l) => l.startsWith("prunable")) || !existsSync(path)) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch refs/heads/".length) ?? null;
    // PERFDAEMON: 피드백 개선 세션의 사본(<repo>.worktrees/feedback-<id>, 브랜치 feedback/<id>)은 사용자의 worktree 가 아니다. 113개가 쌓여 목록을 채웠다.
    if (isFeedbackWorktree(path, ref)) continue;
    const track = ref ? tracking.get(ref) : undefined;
    result.push({ path: realDir(path), branch: ref, head: (lines.find((l) => l.startsWith("HEAD ")) ?? "").slice(5, 12), detached: lines.includes("detached"), upstream: track?.upstream ?? null, ahead: track?.ahead ?? 0, behind: track?.behind ?? 0, main: result.length === 0 });
  }
  return { name: basename(result[0]?.path ?? root), root: result[0]?.path ?? root, worktrees: result };
}

// --- 커밋 메시지 생성에 보낼 입력 ---

const MAX_PROMPT_DIFF = 60_000;

export type CommitMessageInput = { diff: string; truncated: boolean; source: "staged" | "changes"; recent: string[] };

// 스테이지된 diff. 스테이지된 게 없으면 추적 중인 변경과 새 파일 목록으로 대신한다. 둘 다 없으면 null.
export async function commitMessageInput(cwd: string): Promise<CommitMessageInput | null> {
  const root = await needRoot(cwd);
  const current = await status(cwd);
  const read = async (args: string[]) => {
    const [stat, patch] = await Promise.all([git(root, [...args, "--stat"]), git(root, [...args, "--no-color", "--no-ext-diff", "-M", "--unified=2"])]);
    return `${stat}\n${patch}`.trim();
  };
  let source: CommitMessageInput["source"] = "staged";
  let diff = current.staged.length > 0 ? await read(["diff", "--cached"]) : "";
  if (!diff) {
    source = "changes";
    const tracked = current.changes.some((c) => c.code !== "U") ? await read(current.hasHead ? ["diff", "HEAD"] : ["diff"]) : "";
    const fresh = current.changes.filter((c) => c.code === "U").map((c) => `new file: ${c.rel}`);
    diff = [tracked, ...fresh].filter(Boolean).join("\n");
  }
  if (!diff) return null;
  const recent = current.hasHead ? ((await tryGit(root, ["log", "-8", "--format=%s"])) ?? "").split("\n").filter(Boolean) : [];
  return diff.length > MAX_PROMPT_DIFF ? { diff: diff.slice(0, MAX_PROMPT_DIFF), truncated: true, source, recent } : { diff, truncated: false, source, recent };
}

// --- FIX6B: pull, push, fetch ---

// git 명령 하나를 돌려 성공이면 출력, 실패면 분류한 문제를 돌려준다. 병합과 리베이스가 충돌로 멈춘 것은 충돌 파일 수를 같이 알린다.
async function syncRun(cwd: string, verb: GitVerb, job: () => Promise<string>): Promise<ScmSyncResult> {
  try {
    return { ok: true, output: (await job()).trim() };
  } catch (error) {
    const output = gitOutput(error);
    const current = await status(cwd).catch(() => null);
    const problem = classifyGitFailure(output, verb, { branch: current?.branch });
    // 충돌 문구가 없어도 병합 표식이 남았고 충돌 파일이 있으면 충돌로 본다(git 버전마다 문구가 다르다)
    if (problem.kind === "conflict" || (current?.operation && current.conflicts.length > 0 && problem.kind === "unknown")) {
      return { ok: false, output, problem: problem.kind === "conflict" ? problem : classifyGitFailure("CONFLICT (content)", verb), conflicts: current?.conflicts.length ?? 0 };
    }
    return { ok: false, output, problem };
  }
}

export async function pullOp(cwd: string, mode: ScmPullMode = "ff"): Promise<ScmSyncResult> {
  const root = await needRoot(cwd);
  return syncRun(root, mode === "merge" ? "merge" : mode === "rebase" ? "rebase" : "pull", () => pull(root, mode));
}

export async function pushOp(cwd: string): Promise<ScmSyncResult> {
  const root = await needRoot(cwd);
  return syncRun(root, "push", () => push(root));
}

export async function fetchOp(cwd: string): Promise<ScmSyncResult> {
  const root = await needRoot(cwd);
  return syncRun(root, "fetch", async () => {
    await gitFetch(root);
    return "";
  });
}

// --- FIX6B: 병합과 리베이스 이어가기, 중단 ---

// 충돌을 다 풀고(Merge Changes 가 비었고) 이어간다. 병합은 병합 커밋을 만들고(메시지가 비면 MERGE_MSG), 리베이스는 rebase --continue 를 한다.
// 리베이스는 다음 커밋에서 또 충돌할 수 있다. 그때는 conflict 문제로 돌려주고 같은 작업이 계속 진행 중이다.
export async function continueOperation(cwd: string, message = ""): Promise<ScmOperationResult> {
  const root = await needRoot(cwd);
  const current = await status(cwd);
  if (!current.operation) throw new Error(SCM_MESSAGES.noOperation);
  if (current.conflicts.length > 0) return { ok: false, output: "", problem: SCM_MESSAGES.unresolved };
  try {
    if (current.operation === "merge") {
      const text = message.trim();
      const out = await git(root, ["commit", ...(text ? ["-m", text] : ["--no-edit"])], { unattended: true });
      return { ok: true, summary: out.split("\n").find((l) => l.trim()) ?? "" };
    }
    const out = await git(root, ["rebase", "--continue"], { unattended: true });
    return { ok: true, summary: out.split("\n").find((l) => l.trim()) ?? "" };
  } catch (error) {
    const output = gitOutput(error);
    return { ok: false, output, problem: classifyGitFailure(output, "continue", { branch: current.branch }) };
  }
}

// 병합이나 리베이스를 시작하기 전 상태로 되돌린다. 충돌을 푼 작업도 사라진다(화면이 확인을 거친다).
export async function abortOperation(cwd: string): Promise<void> {
  const root = await needRoot(cwd);
  const current = await status(cwd);
  if (!current.operation) throw new Error(SCM_MESSAGES.noOperation);
  try {
    await git(root, [current.operation, "--abort"], { unattended: true });
  } catch (error) {
    throw new Error(gitOutput(error));
  }
}

// --- FIX6B: 파일 diff 와 hunk 단위 stage ---

const MAX_SIDE = 2_000_000;

async function showBlob(root: string, spec: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync("git", ["show", spec], { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" } });
    return stdout;
  } catch {
    return null;
  }
}

async function worktreeBlob(root: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(join(root, rel));
  } catch {
    return null;
  }
}

type LoadedDiff = { entry: ScmEntry; parsed: ParsedDiff; original: Buffer | null; modified: Buffer | null };

// 파일 하나의 두 쪽 내용과 git 이 정한 hunk. staged 는 HEAD 대 인덱스, changes 는 인덱스 대 작업 트리.
async function loadDiff(root: string, current: ScmStatus, rel: string, section: ScmDiffSection): Promise<LoadedDiff | null> {
  const entry = (section === "staged" ? current.staged : current.changes).find((e) => e.rel === rel);
  if (!entry) return null;
  const from = entry.code === "R" || entry.code === "C" ? entry.from : undefined;
  const untracked = section === "changes" && entry.code === "U";
  const [original, modified] = await Promise.all([
    section === "staged" ? (current.hasHead && entry.code !== "A" ? showBlob(root, `HEAD:${from ?? rel}`) : null) : untracked ? null : showBlob(root, `:${rel}`),
    section === "staged" ? (entry.code === "D" ? null : showBlob(root, `:${rel}`)) : entry.code === "D" ? null : worktreeBlob(root, rel),
  ]);
  if (untracked) {
    const executable = (() => {
      try {
        return (statSync(join(root, rel)).mode & 0o111) !== 0;
      } catch {
        return false;
      }
    })();
    return { entry, parsed: newFileDiff(modified?.toString("utf8") ?? "", executable ? "100755" : "100644"), original, modified };
  }
  const args = [LITERAL, "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", ...(section === "staged" ? ["--cached", "-M"] : []), "--", ...(from ? [from] : []), rel];
  const text = await git(root, args);
  return { entry, parsed: parseGitDiff(text), original, modified };
}

export async function fileDiff(cwd: string, relInput: string, section: ScmDiffSection): Promise<ScmFileDiff> {
  const root = await needRoot(cwd);
  const rel = scmRelPath(root, relInput);
  const current = await status(cwd);
  const loaded = await loadDiff(root, current, rel, section);
  if (!loaded) return { rel, original: null, modified: null, binary: false, tooLarge: false, hunks: [] };
  const { parsed, original, modified } = loaded;
  const binary = parsed.binary || !!original?.includes(0) || !!modified?.includes(0);
  const tooLarge = !binary && ((original?.length ?? 0) > MAX_SIDE || (modified?.length ?? 0) > MAX_SIDE);
  const shown = !binary && !tooLarge;
  return {
    rel,
    original: shown ? (original?.toString("utf8") ?? null) : null,
    modified: shown ? (modified?.toString("utf8") ?? null) : null,
    binary,
    tooLarge,
    hunks: binary || tooLarge ? [] : parsed.hunks.map(({ text: _text, ...info }) => info),
  };
}

// hunk 하나를 인덱스에 올리거나(changes) 내린다(staged). 화면이 diff 를 읽은 뒤 파일이 바뀌었으면 hunk 지문이 달라 거절한다.
export async function stageHunk(cwd: string, relInput: string, section: ScmDiffSection, index: number, hash: string): Promise<void> {
  const root = await needRoot(cwd);
  const rel = scmRelPath(root, relInput);
  if (!patchSafePath(rel)) throw new Error(SCM_MESSAGES.hunkPath);
  const current = await status(cwd);
  const loaded = await loadDiff(root, current, rel, section);
  if (loaded?.parsed.binary) throw new Error(SCM_MESSAGES.hunkBinary);
  const hunk = loaded?.parsed.hunks[index];
  if (!loaded || !hunk || hunk.hash !== hash) throw new Error(SCM_MESSAGES.hunkStale);
  try {
    await applyToIndex(root, buildHunkPatch(rel, loaded.parsed, hunk), { reverse: section === "staged" });
  } catch (error) {
    throw new Error(gitOutput(error));
  }
}

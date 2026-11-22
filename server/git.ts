import { ghBin } from "./ghExec";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, GitInfo, PullRequest } from "../shared/protocol";
import { realDir } from "./paths";
import { perfNote } from "./perfStats";
import { T } from "./strings";

const execFileAsync = promisify(execFile);

export const GIT_PATH_FLAGS = ["-c", "core.quotePath=false"];

const UNATTENDED_ENV = { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" };

export async function git(cwd: string, args: string[], options: { unattended?: boolean; input?: string } = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...(options.unattended ? UNATTENDED_ENV : {}) };
  const start = performance.now();
  try {
    const running = execFileAsync("git", [...GIT_PATH_FLAGS, ...args], { cwd, maxBuffer: 64 * 1024 * 1024, env });
    if (options.input !== undefined) {
      running.child.stdin?.on("error", () => undefined);
      running.child.stdin?.end(options.input);
    }
    const { stdout } = await running;
    perfNote("git", args[0] ?? "", stdout.length, performance.now() - start);
    return stdout;
  } catch (error) {
    perfNote("git", `${args[0]}(fail)`, 0, performance.now() - start);
    throw error;
  }
}

export function applyToIndex(cwd: string, patch: string, options: { reverse?: boolean } = {}): Promise<void> {
  return applyPatch(cwd, patch, ["--cached", ...(options.reverse ? ["-R"] : [])]);
}

export function revertInWorktree(cwd: string, patch: string): Promise<void> {
  return applyPatch(cwd, patch, ["-R"]);
}

function applyPatch(cwd: string, patch: string, flags: string[]): Promise<void> {
  const args = [...GIT_PATH_FLAGS, "apply", "--unidiff-zero", "--whitespace=nowarn", ...flags, "-"];
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(err.trim() || `git apply exited with ${code}`), { stderr: err }))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(patch);
  });
}

async function tryGit(cwd: string, args: string[]) {
  try {
    return (await git(cwd, args)).trim();
  } catch {
    return null;
  }
}

const ROOT_TTL_MS = 5_000;
const rootCache = new Map<string, { root: string; at: number }>();

export async function repoRoot(cwd: string) {
  const hit = rootCache.get(cwd);
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.root;
  const root = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root) {
    if (rootCache.size > 500) rootCache.clear();
    rootCache.set(cwd, { root, at: Date.now() });
  }
  return root;
}

export async function linkedGitDir(root: string) {
  const dir = await tryGit(root, ["rev-parse", "--absolute-git-dir"]);
  return dir && dir !== join(root, ".git") ? dir : null;
}

export async function headCommit(cwd: string) {
  return tryGit(cwd, ["rev-parse", "HEAD"]);
}

async function isDefaultBranch(cwd: string, branch: string) {
  const remoteHead = await tryGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead.replace(/^origin\//, "") === branch;
  return branch === "main" || branch === "master";
}

export async function defaultBase(cwd: string) {
  const remoteHead = await tryGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead;
  return tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function branches(cwd: string) {
  const root = await repoRoot(cwd);
  if (!root) return { repoRoot: null, current: null, defaultBase: null, branches: [] as string[], locals: [] as string[], remotes: [] as string[], uncommitted: 0 };
  const list = (await tryGit(cwd, ["branch", "-a", "--format=%(refname:short)"])) ?? "";
  const status = (await tryGit(cwd, ["status", "--porcelain"])) ?? "";
  const refs = await branchRefs(cwd);
  return {
    repoRoot: root,
    uncommitted: status.split("\n").filter((line) => line.trim()).length,
    current: await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    defaultBase: await defaultBase(cwd),
    branches: list
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b && !b.endsWith("/HEAD")),
    locals: refs.locals,
    remotes: refs.remotes,
  };
}

async function branchRefs(cwd: string) {
  const out = (await tryGit(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"])) ?? "";
  const locals: string[] = [];
  const remotes: string[] = [];
  for (const ref of out.split("\n")) {
    if (ref.startsWith("refs/heads/")) locals.push(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) remotes.push(ref.slice("refs/remotes/".length));
  }
  return { locals, remotes };
}

export async function switchBranch(cwd: string, branch: string) {
  if (!branch || branch.startsWith("-") || /[\0\r\n]/.test(branch)) throw new Error(T.errBranchInvalid);
  if (!(await repoRoot(cwd))) throw new Error(T.errSwitchNotGitRepo);
  const refs = await branchRefs(cwd);
  const isLocal = refs.locals.includes(branch);
  if (!isLocal && !refs.remotes.includes(branch)) throw new Error(T.errBranchUnknown(branch));
  try {
    await git(cwd, isLocal ? ["switch", branch] : ["switch", "--track", branch]);
  } catch (error) {
    throw new Error(gitMessage(error));
  }
}

function gitMessage(error: unknown) {
  const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
  return stderr || (error as Error).message;
}

export async function info(cwd: string, base: { ref: string; label: string } | null): Promise<GitInfo> {
  const root = await repoRoot(cwd);
  if (!root) return { repoRoot: null, hasHead: false, branch: null, upstream: null, ahead: 0, behind: 0, base: null, baseLabel: null, baseBranch: null };
  const [head, abbrev, upstreamRaw, remotes] = await Promise.all([headCommit(cwd), tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), tryGit(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]), tryGit(cwd, ["remote"])]);
  const branch = abbrev ?? (await tryGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]));
  const upstream = head ? upstreamRaw : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await tryGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    const [b, a] = (counts ?? "0\t0").split(/\s+/).map(Number);
    behind = b ?? 0;
    ahead = a ?? 0;
  }
  return { repoRoot: root, hasHead: !!head, branch, headShort: head ? head.slice(0, 7) : null, upstream, ahead, behind, base: base?.ref ?? null, baseLabel: base?.label ?? null, hasRemote: !!remotes?.trim() };
}

export async function fetch(cwd: string) {
  await git(cwd, ["fetch", "--prune"], { unattended: true });
}

export async function push(cwd: string) {
  return git(cwd, ["push"], { unattended: true });
}

export type PullMode = "ff" | "merge" | "rebase";

export async function pull(cwd: string, mode: PullMode = "ff") {
  const flags = mode === "merge" ? ["--no-rebase", "--no-edit"] : mode === "rebase" ? ["--rebase"] : ["--ff-only"];
  return git(cwd, ["pull", ...flags], { unattended: true });
}

export async function headOrEmptyTree(cwd: string) {
  return (await headCommit(cwd)) ?? tryGit(cwd, ["hash-object", "-t", "tree", "/dev/null"]);
}

export async function changes(cwd: string, base: string | null, options: { renames?: boolean } = {}): Promise<{ base: string | null; files: ChangedFile[] }> {
  const renameFlag = options.renames === false ? "--no-renames" : "-M";
  const root = await repoRoot(cwd);
  if (!root || !base) return { base: null, files: [] };
  const files = new Map<string, ChangedFile>();
  const add = (rel: string, status: ChangedFile["status"], additions: number, deletions: number, from?: string) => {
    const path = join(root, rel);
    const existing = files.get(path);
    files.set(path, {
      path,
      rel,
      status: existing?.status ?? status,
      additions: existing?.additions ?? additions,
      deletions: existing?.deletions ?? deletions,
      ...(from ? { from: join(root, from) } : {}),
    });
  };
  const names = ((await tryGit(root, ["diff", "--name-status", "-z", renameFlag, base, "--"])) ?? "").split("\0");
  for (let i = 0; names[i];) {
    const code = names[i++];
    const path = names[i++];
    const status = code.startsWith("R") ? "R" : code.startsWith("A") ? "A" : code.startsWith("D") ? "D" : "M";
    const moved = code.startsWith("R") || code.startsWith("C");
    const rel = moved ? names[i++] : path;
    add(rel, status, 0, 0, moved ? path : undefined);
  }
  const stats = ((await tryGit(root, ["diff", "--numstat", "-z", renameFlag, base, "--"])) ?? "").split("\0");
  for (let i = 0; stats[i];) {
    const row = stats[i++];
    const additionsEnd = row.indexOf("\t");
    const deletionsEnd = row.indexOf("\t", additionsEnd + 1);
    let rel = row.slice(deletionsEnd + 1);
    if (!rel) {
      i++;
      rel = stats[i++];
    }
    const entry = files.get(join(root, rel));
    if (entry) {
      entry.additions = Number(row.slice(0, additionsEnd)) || 0;
      entry.deletions = Number(row.slice(additionsEnd + 1, deletionsEnd)) || 0;
    }
  }
  const untracked = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).catch(() => "");
  for (const rel of untracked.split("\0").filter(Boolean)) {
    const lines = await countLines(join(root, rel));
    add(rel, "A", lines, 0);
  }
  return { base, files: [...files.values()].sort((x, y) => x.rel.localeCompare(y.rel)) };
}

export function limitToFolder<R extends { files: ChangedFile[] }>(cwd: string, result: R, includeOutside: boolean) {
  const realCwd = realDir(cwd);
  const tagged = result.files.map(({ outside: _stale, ...f }): ChangedFile => (isOutside(realCwd, f.path) ? { ...f, outside: true } : f));
  const inside = tagged.filter((f) => !f.outside);
  return { ...result, files: includeOutside ? tagged : inside, outsideCount: tagged.length - inside.length };
}

const COUNT_LINES_MAX_BYTES = 64 * 1024 * 1024;
const GIT_BINARY_PROBE_BYTES = 8000;

async function countLines(file: string) {
  try {
    const { readFile, stat } = await import("node:fs/promises");
    const info = await stat(file);
    if (!info.isFile() || info.size > COUNT_LINES_MAX_BYTES) return 0;
    const bytes = await readFile(file);
    if (bytes.subarray(0, GIT_BINARY_PROBE_BYTES).includes(0)) return 0;
    const text = bytes.toString("utf8");
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

export async function original(cwd: string, base: string | null, path: string, options: { strict?: boolean } = {}) {
  const root = await repoRoot(cwd);
  if (!root || !base) return null;
  const rel = relative(root, path);
  if (options.strict && (rel.startsWith("..") || isAbsolute(rel))) throw new Error(T.errOutsideWorkspace(path));
  try {
    const { stdout } = await execFileAsync("git", ["show", `${base}:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    return stdout;
  } catch (error) {
    if (!options.strict || isMissingInBase(error)) return null;
    throw new Error(T.errBaseUnreadable(String((error as { stderr?: string }).stderr ?? (error as Error).message).trim().split("\n")[0]));
  }
}

export async function originals(cwd: string, base: string | null, paths: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const root = await repoRoot(cwd);
  if (!root || !base) {
    for (const path of paths) result.set(path, null);
    return result;
  }
  const batched: { path: string; spec: string }[] = [];
  const fallback: string[] = [];
  for (const path of paths) {
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) result.set(path, null);
    else if (rel.includes("\n")) fallback.push(path);
    else batched.push({ path, spec: `${base}:${rel}` });
  }
  if (batched.length) {
    const output = await catFileBatch(root, batched.map((entry) => entry.spec));
    if (!output) fallback.push(...batched.map((entry) => entry.path));
    else {
      let offset = 0;
      for (const { path } of batched) {
        const end = output.indexOf(10, offset);
        if (end < 0) {
          fallback.push(path);
          continue;
        }
        const header = output.subarray(offset, end).toString("utf8");
        offset = end + 1;
        const found = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!found) {
          result.set(path, null);
          continue;
        }
        const size = Number(found[2]);
        if (found[1] === "blob") result.set(path, output.subarray(offset, offset + size).toString("utf8"));
        else fallback.push(path);
        offset += size + 1;
      }
    }
  }
  await Promise.all(fallback.map(async (path) => result.set(path, await original(cwd, base, path))));
  return result;
}

function catFileBatch(root: string, specs: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd: root, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${specs.join("\n")}\n`);
  });
}

function isMissingInBase(error: unknown) {
  return /exists on disk, but not in|does not exist in/.test(String((error as { stderr?: string }).stderr ?? ""));
}

function isOutside(realCwd: string, path: string) {
  const rel = relative(realCwd, path);
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

export async function mergeBase(cwd: string, base: string) {
  return tryGit(cwd, ["merge-base", base, "HEAD"]);
}

async function isAncestor(cwd: string, ancestor: string, descendant: string) {
  return (await tryGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])) !== null;
}

export async function sessionBase(cwd: string, start: string) {
  const head = await headCommit(cwd);
  if (!head) return start;
  const upstream = await tryGit(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (!(await isAncestor(cwd, start, head))) return (upstream ? await mergeBase(cwd, upstream) : null) ?? head;
  const remotes = [upstream, await tryGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])];
  let best = start;
  for (const remote of remotes) {
    const point = remote ? await mergeBase(cwd, remote) : null;
    if (!point || point === best || !(await isAncestor(cwd, start, point))) continue;
    if (best === start || (await isAncestor(cwd, best, point))) best = point;
  }
  return best;
}

export function worktreePath(root: string, branch: string) {
  return join(dirname(root), `${root.split("/").pop()}.worktrees`, branch);
}

export async function branchNameProblem(root: string, branch: string): Promise<string | null> {
  if (!branch.trim()) return T.errBranchInvalid;
  if (branch.startsWith("-")) return T.errBranchDash;
  if (/\s/.test(branch)) return T.errBranchSpace;
  if (branch === "@" || /[\0-\x1f\x7f~^:?*[\\]|@\{/.test(branch)) return T.errBranchChars;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return T.errBranchSlash;
  if (branch.includes("..") || branch.startsWith(".") || branch.endsWith(".") || branch.endsWith(".lock") || branch.includes("/.") || branch.includes(".lock/")) return T.errBranchDots;
  if ((await tryGit(root, ["check-ref-format", "--branch", branch])) !== branch) return T.errBranchInvalid;
  const existing = (await tryGit(root, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])) ?? "";
  if (existing) return T.errBranchExists(branch);
  const path = worktreePath(root, branch);
  if (existsSync(path)) return T.errWorktreeExists(path);
  return null;
}

export async function addWorktree(root: string, branch: string, base: string) {
  const problem = await branchNameProblem(root, branch);
  if (problem) throw new Error(problem);
  const path = worktreePath(root, branch);
  await git(root, ["worktree", "add", "-b", branch, "--", path, base]);
  return path;
}

export async function worktreeStatus(path: string) {
  const status = (await tryGit(path, ["status", "--porcelain"])) ?? "";
  const lines = status.split("\n").filter(Boolean);
  return { dirty: lines.length > 0, summary: lines.slice(0, 5).join("\n") + (lines.length > 5 ? T.moreLines(lines.length - 5) : "") };
}

export async function removeWorktree(root: string, path: string, branch: string) {
  await git(root, ["worktree", "remove", path]);
  await tryGit(root, ["branch", "-d", branch]);
}

export async function pullRequests(cwd: string): Promise<{ available: boolean; reason: string | null; prs: PullRequest[] }> {
    const branch = await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch) return { available: false, reason: T.prNoBranch, prs: [] };
    const remote = await tryGit(cwd, ["remote", "get-url", "origin"]);
    if (!remote) return { available: false, reason: T.prNoRemote, prs: [] };
    if (!remote.includes("github.com")) return { available: false, reason: T.prNotGithub, prs: [] };
    if (await isDefaultBranch(cwd, branch)) return { available: true, reason: null, prs: [] };
    try {
      const { stdout } = await execFileAsync(
        ghBin(),
        ["pr", "list", "--head", branch, "--state", "all", "--json", "number,title,url,state,statusCheckRollup", "--limit", "5"],
        { cwd, maxBuffer: 4 * 1024 * 1024 },
      );
      const list = JSON.parse(stdout) as { number: number; title: string; url: string; state: string; statusCheckRollup?: { conclusion?: string; status?: string; state?: string }[] }[];
      return {
        available: true,
        reason: null,
        prs: list.map((pr) => {
          const checks = { passing: 0, failing: 0, pending: 0 };
          for (const c of pr.statusCheckRollup ?? []) {
            const verdict = (c.conclusion ?? c.state ?? "").toUpperCase();
            if (verdict === "SUCCESS" || verdict === "NEUTRAL" || verdict === "SKIPPED") checks.passing++;
            else if (verdict === "FAILURE" || verdict === "ERROR" || verdict === "TIMED_OUT" || verdict === "CANCELLED") checks.failing++;
            else checks.pending++;
          }
          return { number: pr.number, title: pr.title, url: pr.url, state: pr.state, checks };
        }),
      };
    } catch (error) {
      return { available: false, reason: T.prGhFailed(String((error as Error).message).split("\n")[0]), prs: [] };
    }
}

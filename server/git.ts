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

// git 명령은 전부 여기서만 부른다. push, pull, worktree 추가와 삭제는 사용자 조작으로만 호출되고 --force 는 쓰지 않는다.
// core.quotePath=false: 기본값이면 한글 같은 비ASCII 경로를 "docs/\353..." 처럼 따옴표와 8진수로 감싸 출력해, 줄 단위로 나눈 경로가 깨진다.
export const GIT_PATH_FLAGS = ["-c", "core.quotePath=false"];

// FIX6B: 사람이 없는 곳에서 도는 원격과 병합 명령(pull, push, fetch, merge, rebase)용 환경.
// LC_ALL=C: 오류 문구를 영어로 고정해 실패 분류(shared/gitProblems.ts)가 맞게 한다.
// GIT_TERMINAL_PROMPT=0: 인증 질문이 터미널에서 영원히 기다리지 않고 실패하게 한다. GIT_EDITOR=true: 병합 커밋과 rebase --continue 가 편집기를 띄우지 않는다.
const UNATTENDED_ENV = { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" };

// input: 표준 입력으로 넘길 글(git blame --contents - 로 저장 안 한 버퍼를 읽게 할 때).
export async function git(cwd: string, args: string[], options: { unattended?: boolean; input?: string } = {}) {
  // GIT_OPTIONAL_LOCKS=0: git status 가 일하는 김에 .git/index 를 다시 쓰지 않게 한다. 파일 감시(server/workspaceWatch.ts)가 그 쓰기를 변화로 읽어 되돌아 읽는 고리를 막는다.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...(options.unattended ? UNATTENDED_ENV : {}) };
  const start = performance.now();
  try {
    const running = execFileAsync("git", [...GIT_PATH_FLAGS, ...args], { cwd, maxBuffer: 64 * 1024 * 1024, env });
    if (options.input !== undefined) {
      // git 이 입력을 다 읽기 전에 끝나면 EPIPE 가 오니 삼킨다. 실패는 아래 await 가 알린다.
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

// FIX6B: 패치를 표준 입력으로 받아 인덱스에 적용한다(hunk 단위 stage 는 --cached, unstage 는 reverse). --unidiff-zero: 문맥 없는 hunk(-U0)를 받는다.
// 작업 트리는 건드리지 않는다. 실패하면 git 이 낸 문장이 오류 메시지로 올라간다.
export function applyToIndex(cwd: string, patch: string, options: { reverse?: boolean } = {}): Promise<void> {
  const args = [...GIT_PATH_FLAGS, "apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", ...(options.reverse ? ["-R"] : []), "-"];
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

// PERFDAEMON: 세션을 열 때 화면이 부르는 git.info, git.changes(두 범위)가 같은 폴더의 저장소 루트를 따로 물었다(한 번 새로 고침에 3~4번). 찾은 루트는 잠깐 기억한다. 못 찾은 것(저장소가 아님)은 기억하지 않는다.
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

// TB: 연결된 worktree 의 git 폴더(메인 저장소의 .git/worktrees/<이름>). 보통 저장소나 git 이 아니면 null.
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

// 기준 브랜치의 기본값: 원격 기본 브랜치(origin/HEAD), 없으면 지금 브랜치.
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

// 로컬 브랜치 이름과 원격 추적 브랜치(origin/name 꼴), 최근 커밋이 있는 순. refs/remotes/origin/HEAD 는 브랜치가 아니라 뺀다.
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

// git switch 로 브랜치를 바꾼다. 로컬 브랜치면 그대로, 원격 추적 브랜치(origin/name)면 --track 으로 같은 이름의 로컬 브랜치를 만든다.
// --force, --discard-changes 는 쓰지 않는다: 커밋 안 된 변경이 겹치거나 다른 worktree 가 쓰는 브랜치면 git 이 거절하고, 그 문장을 그대로 올린다.
// 이름은 저장소의 실제 ref 목록에서만 고르고(인자 배열로만 넘긴다), '-' 로 시작하면 옵션으로 읽히니 거절한다.
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

// execFile 오류는 "Command failed: git ..." 로 시작하는데, 사용자에게는 git 이 낸 문장(stderr)만 보인다.
function gitMessage(error: unknown) {
  const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
  return stderr || (error as Error).message;
}

export async function info(cwd: string, base: { ref: string; label: string } | null): Promise<GitInfo> {
  const root = await repoRoot(cwd);
  if (!root) return { repoRoot: null, hasHead: false, branch: null, upstream: null, ahead: 0, behind: 0, base: null, baseLabel: null, baseBranch: null };
  // PERFDAEMON: 서로 기다릴 필요 없는 세 명령을 한꺼번에 낸다(차례로 낼 때는 프로세스 시작 시간이 그대로 더해졌다)
  const [head, abbrev, upstreamRaw, remotes] = await Promise.all([headCommit(cwd), tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), tryGit(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]), tryGit(cwd, ["remote"])]);
  // 커밋이 없는 저장소는 rev-parse 가 실패하니 symbolic-ref 로 이름만 읽는다
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

// 기준 커밋 대비 변경 파일. 기준이 없으면(커밋 0개 레포, 세션 시작 커밋 없음) 전체 트리가 "추가" 로 보여 버리므로 비운다.
// renames 를 끄면 이름이 바뀐 파일이 옛 이름 삭제와 새 이름 추가로 따로 나온다(파일별로 내용을 비교하는 쪽이 옛 이름도 알아야 해서).
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
  if (base) {
    const names = (await tryGit(root, ["diff", "--name-status", renameFlag, base, "--"])) ?? "";
    for (const line of names.split("\n").filter(Boolean)) {
      const [code, a, b] = line.split("\t");
      const status = code.startsWith("R") ? "R" : code.startsWith("A") ? "A" : code.startsWith("D") ? "D" : "M";
      add(status === "R" && b ? b : a, status, 0, 0, status === "R" && b ? a : undefined);
    }
    const stats = (await tryGit(root, ["diff", "--numstat", renameFlag, base, "--"])) ?? "";
    for (const line of stats.split("\n").filter(Boolean)) {
      const [a, d, ...rest] = line.split("\t");
      const rel = newNameOf(rest.join("\t"));
      const entry = files.get(join(root, rel));
      if (entry) {
        entry.additions = a === "-" ? 0 : Number(a);
        entry.deletions = d === "-" ? 0 : Number(d);
      }
    }
  }
  const untracked = (await tryGit(root, ["ls-files", "--others", "--exclude-standard"])) ?? "";
  for (const rel of untracked.split("\n").filter(Boolean)) {
    const lines = await countLines(join(root, rel));
    add(rel, "A", lines, 0);
  }
  return { base, files: [...files.values()].sort((x, y) => x.rel.localeCompare(y.rel)) };
}

// 작업 폴더 밖 파일(같은 저장소의 다른 폴더)에 outside 를 달고, includeOutside 가 아니면 목록에서 뺀다. 뺀 개수는 outsideCount.
export function limitToFolder<R extends { files: ChangedFile[] }>(cwd: string, result: R, includeOutside: boolean) {
  const realCwd = realDir(cwd);
  const tagged = result.files.map(({ outside: _stale, ...f }): ChangedFile => (isOutside(realCwd, f.path) ? { ...f, outside: true } : f));
  const inside = tagged.filter((f) => !f.outside);
  return { ...result, files: includeOutside ? tagged : inside, outsideCount: tagged.length - inside.length };
}

const COUNT_LINES_MAX_BYTES = 64 * 1024 * 1024;

async function countLines(file: string) {
  try {
    const { readFile, stat } = await import("node:fs/promises");
    // 추적하지 않는 심볼릭 링크가 /dev/zero 같은 장치를 가리키거나 파일이 아주 크면 줄 수를 세려고 수백 MB 를 읽게 된다. 일반 파일이고 COUNT_LINES_MAX_BYTES 이하일 때만 읽는다.
    const info = await stat(file);
    if (!info.isFile() || info.size > COUNT_LINES_MAX_BYTES) return 0;
    const text = await readFile(file, "utf8");
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

// 기준 커밋의 파일 내용. 그때 없던 파일이면 null.
// strict 이면 "기준에 그 파일이 없음" 만 null 이고, 기준을 읽지 못한 오류(잘못된 기준, git 실패)는 던진다. 화면이 빈 기준으로 착각하지 않게 하려는 것이다.
export async function original(cwd: string, base: string | null, path: string, options: { strict?: boolean } = {}) {
  const root = await repoRoot(cwd);
  if (!root || !base) return null;
  const rel = relative(root, path);
  if (options.strict && (rel.startsWith("..") || isAbsolute(rel))) throw new Error(T.errOutsideWorkspace(path));
  try {
    // 오류 문구로 "기준에 없음" 을 가리므로 로캘을 고정한다
    const { stdout } = await execFileAsync("git", ["show", `${base}:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    return stdout;
  } catch (error) {
    if (!options.strict || isMissingInBase(error)) return null;
    throw new Error(T.errBaseUnreadable(String((error as { stderr?: string }).stderr ?? (error as Error).message).trim().split("\n")[0]));
  }
}

// original 을 여러 파일에 한 번에: `git cat-file --batch` 프로세스 하나로 읽는다. 파일마다 git show 를 띄우면 80개에 4초 넘게 걸렸다.
// 결과는 original(비엄격)과 같다: 기준에 없거나 읽을 수 없으면 null. 한 줄 입력에 못 담는 경로와 blob 이 아닌 항목은 original 로 대신 읽는다.
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
          // "<spec> missing" 같은 답은 본문이 없다
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

// git show 가 "그 커밋에는 그 경로가 없다" 고 답한 경우 (새로 생긴 파일)
function isMissingInBase(error: unknown) {
  return /exists on disk, but not in|does not exist in/.test(String((error as { stderr?: string }).stderr ?? ""));
}

function isOutside(realCwd: string, path: string) {
  const rel = relative(realCwd, path);
  return rel.startsWith("..") || isAbsolute(rel);
}

// numstat 의 이름 바뀜 표기: "old => new" 또는 "dir/{old => new}/file". 새 이름만 돌려준다.
function newNameOf(shown: string) {
  const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(shown);
  if (braces) return `${braces[1]}${braces[3]}${braces[4]}`.replace(/\/\//g, "/");
  return shown.replace(/^.* => /, "");
}

export async function mergeBase(cwd: string, base: string) {
  return tryGit(cwd, ["merge-base", base, "HEAD"]);
}

async function isAncestor(cwd: string, ancestor: string, descendant: string) {
  return (await tryGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])) !== null;
}

// "이 세션의 변경" 을 재는 기준 커밋. 세션이 시작된 뒤 pull 로 들어온 남의 커밋은 세션의 변경이 아니다.
// 원격에 이미 있는 가장 앞선 조상(upstream, 원격 기본 브랜치와 HEAD 의 merge-base)이 세션 시작 커밋을 품고 있으면 그것이 기준이다:
// 그 뒤에 남은 것은 아직 원격에 없는 로컬 커밋과 커밋 안 된 변경, 곧 세션이 만든 것이다.
// 시작 커밋을 품지 못하면(시작할 때 이미 있던 미push 커밋이 있거나 원격 정보가 없음) 시작 커밋을 그대로 쓴다.
// 시작 커밋이 HEAD 의 조상이 아니면(세션 중 다른 브랜치로 옮김) 시작 커밋은 지금 이력과 상관이 없다. upstream 과의 merge-base, 없으면 HEAD 가 기준이다.
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

// worktree 경로 규칙: <repo>.worktrees/<branch> (브랜치의 슬래시는 폴더가 된다). 사용자가 app-client.worktrees/feature/... 로 써 온 방식.
export function worktreePath(root: string, branch: string) {
  return join(dirname(root), `${root.split("/").pop()}.worktrees`, branch);
}

// 새 브랜치 이름의 문제를 한 문장으로. 없으면 null.
// 판정은 git 자신(git check-ref-format --branch)이 한다: 한글 같은 비ASCII 문자는 허용되고 공백, "..", ".lock" 끝 같은 git 의 규칙은 그대로 거절한다.
// 거절되면 어느 규칙인지는 알려진 규칙으로 가려 말하고, 어디에도 안 걸리면 일반 문구다. 이미 있는 로컬 브랜치와 이미 있는 worktree 폴더도 문제다.
export async function branchNameProblem(root: string, branch: string): Promise<string | null> {
  if (!branch.trim()) return T.errBranchInvalid;
  if (branch.startsWith("-")) return T.errBranchDash;
  if (/\s/.test(branch)) return T.errBranchSpace;
  // @{-1} 같은 줄임 표기는 git 이 이전 브랜치 이름으로 풀어 통과시키므로 먼저 거른다
  if (branch === "@" || /[\0-\x1f\x7f~^:?*[\\]|@\{/.test(branch)) return T.errBranchChars;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return T.errBranchSlash;
  if (branch.includes("..") || branch.startsWith(".") || branch.endsWith(".") || branch.endsWith(".lock") || branch.includes("/.") || branch.includes(".lock/")) return T.errBranchDots;
  // git 이 이름을 다른 것으로 풀어 돌려주면(@ 는 지금 브랜치) 쓸 수 없는 이름이다
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
  // "--" 가 없으면 "-" 로 시작하는 base(--no-checkout, --force)가 옵션으로 읽힌다.
  await git(root, ["worktree", "add", "-b", branch, "--", path, base]);
  return path;
}

export async function worktreeStatus(path: string) {
  const status = (await tryGit(path, ["status", "--porcelain"])) ?? "";
  const lines = status.split("\n").filter(Boolean);
  return { dirty: lines.length > 0, summary: lines.slice(0, 5).join("\n") + (lines.length > 5 ? T.moreLines(lines.length - 5) : "") };
}

// --force 없이 지운다. 변경이 남아 있으면 git 이 거절하고 그 메시지를 그대로 올린다. 브랜치는 머지된 경우에만 -d 로 지운다.
export async function removeWorktree(root: string, path: string, branch: string) {
  await git(root, ["worktree", "remove", path]);
  await tryGit(root, ["branch", "-d", branch]);
}

// gh 로 지금 브랜치의 PR 과 체크 상태를 읽는다. 원격이 GitHub 가 아니거나 gh 가 없으면 이유와 함께 비운다.
export async function pullRequests(cwd: string): Promise<{ available: boolean; reason: string | null; prs: PullRequest[] }> {
    const branch = await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch) return { available: false, reason: T.prNoBranch, prs: [] };
    const remote = await tryGit(cwd, ["remote", "get-url", "origin"]);
    if (!remote) return { available: false, reason: T.prNoRemote, prs: [] };
    if (!remote.includes("github.com")) return { available: false, reason: T.prNotGithub, prs: [] };
    // 기본 브랜치(master, main)는 이 브랜치의 PR 이라는 개념이 없다. --head master 는 머지된 릴리스 PR 만 잡혀서 칩을 숨긴다.
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

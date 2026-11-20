import { execFile } from "node:child_process";
import { constants, existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_PATH_FLAGS, repoRoot } from "./git";
import { realDir, realPathLoose } from "./paths";
import { skillFileRealPath } from "./skillCatalog"; // SKILLS
import { T } from "./strings";
import { moveToTrash, pruneEmptyDirs } from "./trash";

const run = promisify(execFile);
const MAX_FILES = 50_000;
// 자동 생성 타입 파일(GraphQL codegen 등)이 수 MB 라 20MB 까지 연다. 2MB 를 넘는 파일은 에디터가 LSP, blame, 변경 거터를 끄고 연다(web/Editor.tsx LARGE_FILE_CHARS).
const MAX_READ_BYTES = 20 * 1024 * 1024;

export async function listFiles(dir: string) {
  if (!(await repoRoot(dir).catch(() => null))) return (await walkFolder(dir)).files;
  const { stdout } = await run("git", [...GIT_PATH_FLAGS, "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: dir,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\n").filter(Boolean).slice(0, MAX_FILES);
}

const WALK_SKIP = new Set([".git", ".svn", ".hg", ".DS_Store", "Thumbs.db", "node_modules"]);
export async function walkFolder(root: string) {
  const files: string[] = [];
  const emptyDirs: string[] = [];
  const seen = new Set<string>();
  const visit = async (relativePath: string): Promise<boolean> => {
    const absolute = relativePath ? join(root, relativePath) : root;
    const real = await realpath(absolute).catch(() => null);
    if (!real || seen.has(real)) return true;
    seen.add(real);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
    if (!entries) return true;
    let hasFile = false;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (WALK_SKIP.has(entry.name) || files.length >= MAX_FILES) continue;
      const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(join(root, path)).then((info) => info.isDirectory(), () => false)));
      if (isDir) {
        if (await visit(path)) hasFile = true;
      } else {
        files.push(path);
        hasFile = true;
      }
    }
    if (!hasFile && relativePath) emptyDirs.push(relativePath);
    return hasFile;
  };
  await visit("");
  return { files, emptyDirs };
}

// QUICKOPEN: .gitignore 에 가려진 파일. node_modules 같은 큰 폴더가 있으면 MAX_FILES 에서 잘리고, git 저장소가 아니면 빈 목록이다.
export async function listIgnoredFiles(dir: string) {
  try {
    const { stdout } = await run("git", [...GIT_PATH_FLAGS, "ls-files", "--others", "--ignored", "--exclude-standard"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\n").filter(Boolean).slice(0, MAX_FILES);
  } catch {
    return [];
  }
}

async function readAbsolute(absolute: string) {
  if (!existsSync(absolute)) return null;
  // 읽기 전에 크기를 본다(수백 MB 파일을 통째로 메모리에 올린 뒤에야 거절하지 않게).
  if ((await stat(absolute)).size > MAX_READ_BYTES) throw new Error(T.errFileTooLarge);
  const buffer = await readFile(absolute);
  if (buffer.length > MAX_READ_BYTES) throw new Error(T.errFileTooLarge);
  return buffer.toString("utf8");
}

// 읽은 시점의 수정 시각을 함께 준다. 없는 파일이면 둘 다 null.
// 바이너리(앞 8000바이트에 NUL)는 본문을 보내지 않고 binary 와 크기만 알린다(깨진 글자를 에디터에 싣지 않게). readOnly 는 이 프로세스가 쓸 수 없는 파일.
export async function readWorkspaceFileWithStat(dir: string, path: string) {
  const absolute = await resolveReadable(dir, path);
  const mtimeMs = await mtimeOf(absolute);
  if (mtimeMs === null) return { text: null, mtimeMs: null };
  // SKILLS: 스킬 목록 화면이 연 워크스페이스 밖 SKILL.md 는 저장도 거절되니(resolveWritable) 처음부터 읽기 전용으로 연다.
  // 워크스페이스 밖에서 열어 준 파일(위 SKILLS 와 outsideReadable)도 같은 이유로 읽기 전용이다.
  const skillOutside = !isUnder(dir, absolute) && !isUnder(realDir(dir), absolute) && (skillFileRealPath(absolute) !== null || (!(await inRepoOf(dir, absolute)) && outsideReadable(absolute) !== null));
  const [size, readOnly] = await Promise.all([stat(absolute).then((info) => info.size), skillOutside ? true : access(absolute, constants.W_OK).then(() => false, () => true)]);
  if (await looksBinary(absolute)) return { text: "", mtimeMs, binary: true as const, size, readOnly };
  const text = await readAbsolute(absolute);
  // UTF-8 이 아닌 파일(EUC-KR, Latin-1)은 잘못된 바이트가 U+FFFD 로 읽힌다. 그대로 저장하면 고치지 않은 글자까지 깨지므로 읽기 전용으로 연다.
  const lossy = text !== null && text.includes("\uFFFD") && !(await readFile(absolute)).equals(Buffer.from(text, "utf8"));
  return { text, mtimeMs, readOnly: readOnly || lossy };
}

// git 이 쓰는 기준과 같다: 앞 8000바이트 안에 NUL 이 있으면 바이너리.
async function looksBinary(absolute: string) {
  const handle = await open(absolute, "r");
  try {
    const head = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

// 이미지 미리보기용 원본 바이트(base64). 너무 크면 크기만 알리고 본문은 보내지 않는다.
export async function readWorkspaceBinary(dir: string, path: string) {
  const absolute = await resolveReadable(dir, path);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) throw new Error(T.errNoSuchEntry(path));
  const extension = absolute.slice(absolute.lastIndexOf(".") + 1).toLowerCase();
  const mime = IMAGE_MIME[extension] ?? null;
  if (info.size > MAX_PREVIEW_BYTES) return { base64: null, mime, size: info.size };
  return { base64: (await readFile(absolute)).toString("base64"), mime, size: info.size };
}

// 폴더도 있는 것으로 센다: 새 파일이나 폴더 이름이 이미 쓰이는지 볼 때 같이 쓴다.
export async function statWorkspaceFile(dir: string, path: string) {
  return { mtimeMs: await mtimeOf(await resolveReadable(dir, path), true) };
}

async function mtimeOf(absolute: string, anyKind = false) {
  try {
    const info = await stat(absolute);
    return anyKind || info.isFile() ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

// 만들기와 저장은 읽기보다 엄격하다: 상위 폴더의 node_modules 예외 없이 작업 폴더 안(심볼릭 링크를 푼 뒤에도)만.
export function resolveWritable(dir: string, path: string) {
  const absolute = isAbsolute(path) ? path : resolve(dir, path);
  if (isUnder(dir, absolute) && isUnder(realDir(dir), realPathLoose(absolute)) && absolute !== dir) return absolute;
  throw new Error(T.errNotWritable(path));
}

// 쓰기가 실제로 닿는 경로. realPathLoose 와 같지만 끊긴 심볼릭 링크(가리키는 곳이 아직 없는 링크)를 만나면 링크 이름이 아니라 링크가 가리키는 곳을 따라간다.
// writeFile 은 끊긴 링크를 따라가 그 자리에 파일을 만들기 때문이다. 링크가 고리를 이루면 null.
function realWriteTarget(path: string, hops = 0): string | null {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      let link: string | null = null;
      try {
        link = readlinkSync(current);
      } catch {
        // 링크가 아니거나 없는 이름
      }
      if (link !== null) return hops < 32 ? realWriteTarget(join(resolve(realDir(dirname(current)), link), ...rest), hops + 1) : null;
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

function isRealInside(dir: string, real: string | null) {
  const realRoot = realDir(dir);
  return real !== null && (isUnder(realRoot, real) || isUnderNodeModulesAncestor(realRoot, real));
}

export type SaveResult = { saved: true; mtimeMs: number } | { saved: false; conflict: "changed" | "exists" | "readonly"; mtimeMs: number | null };

// 에디터 저장. 마지막으로 읽은 때와 수정 시각이 다르고 내용도 다르면 쓰지 않는다(force 면 쓴다).
export async function saveWorkspaceFile(dir: string, path: string, text: string, baseMtimeMs: number | null, force = false): Promise<SaveResult> {
  const absolute = resolveWritable(dir, path);
  // resolveWritable 은 끊긴 심볼릭 링크를 링크 이름 그대로 보아 통과시킨다. 저장은 그 링크를 따라가 작업 폴더 밖에 파일을 만들므로 가리키는 곳으로 다시 확인한다.
  const target = realWriteTarget(absolute);
  if (target === null || !isUnder(realDir(dir), target)) throw new Error(T.errNotWritable(path));
  const current = await mtimeOf(absolute);
  if (!force && current !== null && current !== baseMtimeMs) {
    const onDisk = await readFile(absolute, "utf8");
    if (onDisk !== text) return { saved: false, conflict: baseMtimeMs === null ? "exists" : "changed", mtimeMs: current };
  }
  try {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text, "utf8");
  } catch (error) {
    // 읽기 전용 파일이나 폴더는 시스템 오류 원문 대신 화면이 안내할 수 있게 결과로 알린다.
    if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return { saved: false, conflict: "readonly", mtimeMs: current };
    throw error;
  }
  return { saved: true, mtimeMs: (await stat(absolute)).mtimeMs };
}

// 새 파일이나 폴더. 이미 있으면 덮어쓰지 않고 오류를 낸다(파일은 wx 플래그라 확인과 쓰기 사이에 생겨도 안전하다).
export async function createWorkspaceEntry(dir: string, path: string, kind: "file" | "folder", text = "") {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error(T.errBadNewPath);
  const absolute = resolveWritable(dir, trimmed);
  if (existsSync(absolute)) throw new Error(T.errAlreadyExists(trimmed));
  await mkdir(dirname(absolute), { recursive: true });
  try {
    if (kind === "folder") await mkdir(absolute);
    else await writeFile(absolute, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(T.errAlreadyExists(trimmed));
    throw error;
  }
  return { mtimeMs: (await stat(absolute)).mtimeMs };
}

// git ls-files 는 파일이 없는 폴더를 알려 주지 않는다. 추적되지 않는 폴더 이름(끝이 /)을 받아 안에 파일이 하나도 없는 폴더만 고른다.
export async function listEmptyDirs(dir: string) {
  if (!(await repoRoot(dir).catch(() => null))) return (await walkFolder(dir)).emptyDirs;
  const { stdout } = await run("git", [...GIT_PATH_FLAGS, "ls-files", "--others", "--directory", "--exclude-standard"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  const empty: string[] = [];
  for (const entry of stdout.split("\n").filter((line) => line.endsWith("/"))) await collectEmpty(dir, entry.slice(0, -1), empty);
  return empty;
}

async function collectEmpty(root: string, relativePath: string, out: string[]): Promise<boolean> {
  const entries = await readdir(join(root, relativePath), { withFileTypes: true }).catch(() => null);
  if (!entries) return false;
  let hasFile = false;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (await collectEmpty(root, `${relativePath}/${entry.name}`, out)) hasFile = true;
    } else hasFile = true;
  }
  if (!hasFile) out.push(relativePath);
  return hasFile;
}

// text 가 null 이면 파일을 지우는 대신 휴지통으로 옮긴다(새 파일을 되돌릴 때). 비게 된 폴더는 작업 폴더 아래에서만 거둔다.
export async function writeWorkspaceFile(dir: string, path: string, text: string | null) {
  const absolute = resolveInside(dir, path);
  // resolveInside 는 작업 폴더 안의 이름이면 심볼릭 링크를 풀어 보지 않는다. 링크가 밖을 가리키면 쓰기와 휴지통 이동이 밖의 파일에 닿으므로 실제 경로로 한 번 더 확인한다.
  // 지울 때는 링크 자체가 옮겨지므로 부모 폴더만, 쓸 때는 링크가 가리키는 곳까지 본다.
  if (!isRealInside(dir, text === null ? realPathLoose(dirname(absolute)) : realWriteTarget(absolute))) throw new Error(T.errNotWritable(path));
  if (text === null) {
    if (!existsSync(absolute)) return;
    await moveToTrash(absolute);
    await pruneEmptyDirs(realDir(dir), realPathLoose(dirname(absolute)));
    return;
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
}

// R4FIX: Files 트리의 Open in Integrated Terminal 이 시작 폴더로 쓸 하위 폴더. 작업 폴더 안의 실제 폴더만 받는다.
export function terminalDir(base: string, sub: string) {
  const dir = resolveInside(base, sub);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(T.errNoSuchEntry(sub));
  return dir;
}

// R4FIX: Files 트리 Delete. 파일이든 폴더든 휴지통으로 옮기고 영구 삭제하지 않는다. 작업 폴더 자체는 거절한다.
export async function trashWorkspaceEntry(dir: string, path: string) {
  const absolute = resolveWritable(dir, path);
  if (!(await lstat(absolute).then(() => true, () => false))) throw new Error(T.errNoSuchEntry(path));
  return { trashed: await moveToTrash(absolute) };
}

// R4FIX: Files 트리 Rename. 같은 폴더 안 이름 바꾸기와 다른 폴더로 옮기기를 둘 다 받는다. 이미 있는 이름이면 덮어쓰지 않고 오류.
export async function renameWorkspaceEntry(dir: string, from: string, to: string) {
  const target = to.trim().replace(/\/+$/, "");
  if (!target) throw new Error(T.errBadNewPath);
  const source = resolveWritable(dir, from);
  const destination = resolveWritable(dir, target);
  if (!(await lstat(source).then(() => true, () => false))) throw new Error(T.errNoSuchEntry(from));
  if (source === destination) return;
  if (await lstat(destination).then(() => true, () => false)) throw new Error(T.errAlreadyExists(target));
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
}

export async function openInVSCode(dir: string, path: string, line: number, column: number) {
  const absolute = resolveInside(dir, path);
  await run("code", ["--goto", `${absolute}:${line}:${column}`]);
}

export async function openFolderInVSCode(dir: string) {
  await run("code", [dir]);
}

// 워크스페이스 밖 경로(예: ../../etc/passwd)는 거절한다. node_modules 안 정의로 가는 건 허용한다.
// 글자로 비교해서 밖이면, 심볼릭 링크를 푼 실제 경로로 한 번 더 본다(/tmp/x 와 /private/tmp/x 는 같은 폴더다). 링크로 밖을 가리키는 경로는 이쪽에서도 밖이라 거절된다.
export function resolveInside(dir: string, path: string) {
  const absolute = isAbsolute(path) ? path : resolve(dir, path);
  if (isUnder(dir, absolute) || isUnderNodeModulesAncestor(dir, absolute)) return absolute;
  const realRoot = realDir(dir);
  const real = realPathLoose(absolute);
  if (isUnder(realRoot, real) || isUnderNodeModulesAncestor(realRoot, real)) return real;
  throw new Error(T.errOutsideWorkspace(path));
}

// 읽기 전용 경로 해석: resolveInside 가 받는 곳에 더해, 작업 폴더가 속한 git 저장소 안이면 폴더 밖이어도 읽는다.
// 모노레포에서 세션의 작업 폴더가 하위 폴더일 때 변경 파일은 저장소 전체에 걸쳐 있어서다. 쓰기는 이 함수를 쓰지 않는다(resolveWritable, files.write).
export async function resolveReadable(dir: string, path: string) {
  try {
    return resolveInside(dir, path);
  } catch (error) {
    const absolute = isAbsolute(path) ? path : resolve(dir, path);
    const root = await repoRoot(dir);
    if (root) {
      const real = realPathLoose(absolute);
      if (isUnder(realDir(root), real)) return real;
    }
    // SKILLS: 스킬 목록 화면이 보여 준 SKILL.md(사용자, 플러그인, 계정 동기화)는 워크스페이스 밖이어도 읽는다. 쓰기는 여전히 거절된다. 위의 저장소 읽기가 먼저라 일반 읽기 경로에는 비용이 없다.
    const skill = skillFileRealPath(absolute);
    if (skill) return skill;
    const outside = outsideReadable(absolute);
    if (outside) return outside;
    throw error;
  }
}

const OUTSIDE_ROOTS = [homedir(), "/tmp", "/private/tmp"];
// 비교는 소문자로 한다: macOS 기본 볼륨은 대소문자를 가리지 않아 ~/.SSH/id_rsa 도 같은 파일인데, realpath 는 받은 글자를 그대로 돌려준다.
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".netrc", ".git-credentials", ".npmrc", ".config/gh", ".config/gcloud", "Library/Keychains", "Library/Cookies", ".agent-nav/token", ".codex/auth.json", ".claude/.credentials.json"].map((p) => join(homedir(), p).toLowerCase());
export function outsideReadable(absolute: string): string | null {
  const real = realPathLoose(absolute);
  if (!OUTSIDE_ROOTS.some((root) => isUnder(root, real))) return null;
  const lower = real.toLowerCase();
  if (SECRET_DIRS.some((secret) => lower === secret || isUnder(secret, lower))) return null;
  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function isUnder(dir: string, absolute: string) {
  const rel = relative(dir, absolute);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// 모노레포에서는 정의가 상위 폴더의 node_modules 에 있을 수 있다.
function isUnderNodeModulesAncestor(dir: string, absolute: string) {
  let current = dir;
  for (;;) {
    const nodeModules = resolve(current, "node_modules");
    if (isUnder(nodeModules, absolute)) return true;
    const parent = resolve(current, "..");
    if (parent === current) return false;
    current = parent;
  }
}

// 작업 폴더가 속한 git 저장소 안인가(resolveReadable 의 모노레포 읽기와 같은 기준)
async function inRepoOf(dir: string, absolute: string) {
  const root = await repoRoot(dir);
  return !!root && isUnder(realDir(root), absolute);
}

import { execFile } from "node:child_process";
import { constants, existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_PATH_FLAGS, repoRoot } from "./git";
import { realDir, realPathLoose } from "./paths";
import { skillFileRealPath } from "./skillCatalog";
import { T } from "./strings";
import { moveToTrash, pruneEmptyDirs } from "./trash";

const run = promisify(execFile);
const MAX_FILES = 50_000;
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
  if ((await stat(absolute)).size > MAX_READ_BYTES) throw new Error(T.errFileTooLarge);
  const buffer = await readFile(absolute);
  if (buffer.length > MAX_READ_BYTES) throw new Error(T.errFileTooLarge);
  return buffer.toString("utf8");
}

export async function readWorkspaceFileWithStat(dir: string, path: string) {
  const absolute = await resolveReadable(dir, path);
  const mtimeMs = await mtimeOf(absolute);
  if (mtimeMs === null) return { text: null, mtimeMs: null };
  const skillOutside = !isUnder(dir, absolute) && !isUnder(realDir(dir), absolute) && (skillFileRealPath(absolute) !== null || (!(await inRepoOf(dir, absolute)) && outsideReadable(absolute) !== null));
  const [size, readOnly] = await Promise.all([stat(absolute).then((info) => info.size), skillOutside ? true : access(absolute, constants.W_OK).then(() => false, () => true)]);
  if (await looksBinary(absolute)) return { text: "", mtimeMs, binary: true as const, size, readOnly };
  const text = await readAbsolute(absolute);
  const lossy = text !== null && text.includes("\uFFFD") && !(await readFile(absolute)).equals(Buffer.from(text, "utf8"));
  return { text, mtimeMs, readOnly: readOnly || lossy };
}

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

export async function readWorkspaceBinary(dir: string, path: string) {
  const absolute = await resolveReadable(dir, path);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) throw new Error(T.errNoSuchEntry(path));
  const extension = absolute.slice(absolute.lastIndexOf(".") + 1).toLowerCase();
  const mime = IMAGE_MIME[extension] ?? null;
  if (info.size > MAX_PREVIEW_BYTES) return { base64: null, mime, size: info.size };
  return { base64: (await readFile(absolute)).toString("base64"), mime, size: info.size };
}

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

export function resolveWritable(dir: string, path: string) {
  const absolute = isAbsolute(path) ? path : resolve(dir, path);
  if (isUnder(dir, absolute) && isUnder(realDir(dir), realPathLoose(absolute)) && absolute !== dir) return absolute;
  throw new Error(T.errNotWritable(path));
}

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

export async function saveWorkspaceFile(dir: string, path: string, text: string, baseMtimeMs: number | null, force = false): Promise<SaveResult> {
  const absolute = resolveWritable(dir, path);
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
    if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return { saved: false, conflict: "readonly", mtimeMs: current };
    throw error;
  }
  return { saved: true, mtimeMs: (await stat(absolute)).mtimeMs };
}

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

export async function writeWorkspaceFile(dir: string, path: string, text: string | null) {
  const absolute = resolveInside(dir, path);
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

export function terminalDir(base: string, sub: string) {
  const dir = resolveInside(base, sub);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(T.errNoSuchEntry(sub));
  return dir;
}

export async function trashWorkspaceEntry(dir: string, path: string) {
  const absolute = resolveWritable(dir, path);
  if (!(await lstat(absolute).then(() => true, () => false))) throw new Error(T.errNoSuchEntry(path));
  return { trashed: await moveToTrash(absolute) };
}

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

export function resolveInside(dir: string, path: string) {
  const absolute = isAbsolute(path) ? path : resolve(dir, path);
  if (isUnder(dir, absolute) || isUnderNodeModulesAncestor(dir, absolute)) return absolute;
  const realRoot = realDir(dir);
  const real = realPathLoose(absolute);
  if (isUnder(realRoot, real) || isUnderNodeModulesAncestor(realRoot, real)) return real;
  throw new Error(T.errOutsideWorkspace(path));
}

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
    const skill = skillFileRealPath(absolute);
    if (skill) return skill;
    const outside = outsideReadable(absolute);
    if (outside) return outside;
    throw error;
  }
}

const OUTSIDE_ROOTS = [homedir(), "/tmp", "/private/tmp"];
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

async function inRepoOf(dir: string, absolute: string) {
  const root = await repoRoot(dir);
  return !!root && isUnder(realDir(root), absolute);
}

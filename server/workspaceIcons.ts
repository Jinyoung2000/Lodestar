import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";

export const ICON_MAX_BYTES = 4 * 1024 * 1024;
export const ICON_INLINE_BYTES = 48 * 1024;
const ICON_PIXELS = 96;

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const APP_ICON_FILES = [
  "assets/icon.png",
  "assets/images/icon.png",
  "app/icon.png",
  "src/app/icon.png",
  "app/apple-icon.png",
  "src/app/apple-icon.png",
  "build/icon.png",
  "resources/icon.png",
  "icon.png",
];

const WEB_ICON_FILES = [
  "public/apple-touch-icon.png",
  "public/favicon.png",
  "public/icon.png",
  "public/logo192.png",
  "public/logo.png",
  "static/apple-touch-icon.png",
  "static/favicon.png",
  "assets/images/favicon.png",
];

const MONOREPO_DIRS = ["apps", "packages"];
const NESTED_LIMIT = 40;

type Cached = { rootMtime: number; iconPath: string | null; iconMtime: number; checkedAt: number; icon: string | null };

const MISS_RECHECK_MS = 10 * 60 * 1000;

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && resolve(root, rel) === path;
}

function readIcon(root: string, candidate: string): { path: string; mtime: number; uri: string } | null {
  const ext = extname(candidate).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  try {
    const real = realpathSync(join(root, candidate));
    if (!inside(root, real)) return null;
    const info = statSync(real);
    if (!info.isFile() || info.size === 0 || info.size > ICON_MAX_BYTES) return null;
    const small = info.size <= ICON_INLINE_BYTES ? { mime, bytes: readFileSync(real) } : shrink(real);
    if (!small) return null;
    return { path: real, mtime: info.mtimeMs, uri: `data:${small.mime};base64,${small.bytes.toString("base64")}` };
  } catch {
    return null;
  }
}

function shrink(path: string): { mime: string; bytes: Buffer } | null {
  const scratch = mkdtempSync(join(tmpdir(), "lodestar-icon-"));
  const out = join(scratch, "icon.png");
  try {
    execFileSync("/usr/bin/sips", ["-s", "format", "png", "-Z", String(ICON_PIXELS), path, "--out", out], { stdio: "ignore", timeout: 5000 });
    const bytes = readFileSync(out);
    return bytes.length > 0 && bytes.length <= ICON_INLINE_BYTES ? { mime: "image/png", bytes } : null;
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function childDirs(root: string, dir: string): string[] {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name)
      .sort()
      .slice(0, NESTED_LIMIT);
  } catch {
    return [];
  }
}

export function iconCandidates(root: string): string[] {
  const children = childDirs(root, "").filter((name) => !MONOREPO_DIRS.includes(name));
  const packages = MONOREPO_DIRS.flatMap((group) => childDirs(root, group).map((name) => `${group}/${name}`));
  const prefixes = ["", ...children, ...packages];
  const at = (prefix: string, files: string[]) => files.map((file) => (prefix ? `${prefix}/${file}` : file));
  return [...at("", APP_ICON_FILES), ...at("", WEB_ICON_FILES), ...prefixes.slice(1).flatMap((prefix) => [...at(prefix, APP_ICON_FILES), ...at(prefix, WEB_ICON_FILES)])];
}

export function findWorkspaceIcon(dir: string): { path: string; mtime: number; uri: string } | null {
  let root: string;
  try {
    root = realpathSync(dir);
    if (!statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  for (const candidate of iconCandidates(root)) {
    const icon = readIcon(root, candidate);
    if (icon) return icon;
  }
  return null;
}

export class WorkspaceIcons {
  private cache = new Map<string, Cached>();

  constructor(private now: () => number = Date.now) {}

  icon(dir: string): string | null {
    const hit = this.cache.get(dir);
    if (hit && this.fresh(dir, hit)) return hit.icon;
    const found = findWorkspaceIcon(dir);
    this.cache.set(dir, { rootMtime: mtimeOf(dir), iconPath: found?.path ?? null, iconMtime: found?.mtime ?? 0, checkedAt: this.now(), icon: found?.uri ?? null });
    return found?.uri ?? null;
  }

  private fresh(dir: string, hit: Cached) {
    if (mtimeOf(dir) !== hit.rootMtime) return false;
    if (hit.iconPath) return mtimeOf(hit.iconPath) === hit.iconMtime;
    return this.now() - hit.checkedAt < MISS_RECHECK_MS;
  }
}

function mtimeOf(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

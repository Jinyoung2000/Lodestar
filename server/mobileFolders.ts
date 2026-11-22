import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { MobileBrowseEntry, MobileBrowseResult } from "../shared/mobile";
import { T } from "./strings";

export const BROWSE_LIMIT = 500;

const ROOT_EXCLUDED: ReadonlySet<string> = new Set(["Library", "Applications", "Movies", "Music", "Pictures", "Public"]);

export function browseRoot(): string {
  const root = process.env.AGENT_NAV_MOBILE_BROWSE_ROOT;
  return realpathSync(root && root.trim() ? root : homedir());
}

function visible(segments: readonly string[]): boolean {
  return segments.every((name, index) => !name.startsWith(".") && name !== "node_modules" && !(index === 0 && ROOT_EXCLUDED.has(name)));
}

export type ResolvedFolder = { dir: string; display: string };

export function resolveFolder(input: unknown, root = browseRoot()): ResolvedFolder {
  const raw = input === undefined || input === null ? "" : typeof input === "string" ? input.trim() : null;
  if (raw === null || raw.length > 1024 || raw.includes("\0")) throw new Error(T.errMobileParam("path"));
  let absolute: string;
  if (raw === "" || raw === "~") absolute = root;
  else if (raw.startsWith("~/")) absolute = resolve(root, raw.slice(2));
  else if (raw.startsWith("/")) absolute = resolve(raw);
  else absolute = resolve(root, raw);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    const lexical = relative(root, absolute);
    throw new Error(lexical === ".." || lexical.startsWith(`..${sep}`) ? T.errMobileFolderDenied : T.errMobileFolderMissing);
  }
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== real) throw new Error(T.errMobileFolderDenied);
  const segments = rel === "" ? [] : rel.split(sep);
  if (!visible(segments)) throw new Error(T.errMobileFolderDenied);
  if (!statSync(real).isDirectory()) throw new Error(T.errMobileFolderDenied);
  return { dir: real, display: segments.length ? `~/${segments.join("/")}` : "~" };
}

export function resolveAddable(input: unknown, root = browseRoot()): ResolvedFolder {
  const folder = resolveFolder(input, root);
  if (folder.dir === root) throw new Error(T.errMobileFolderRoot);
  return folder;
}

export function listFolder(folder: ResolvedFolder, workspaceByDir: ReadonlyMap<string, string>, root = browseRoot()): MobileBrowseResult {
  const atRoot = folder.dir === root;
  const entries: MobileBrowseEntry[] = [];
  let truncated = false;
  let names: { name: string; isDirectory: boolean }[] = [];
  try {
    names = readdirSync(folder.dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() && !d.isSymbolicLink() }));
  } catch {
    names = [];
  }
  for (const { name, isDirectory } of names.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))) {
    if (!isDirectory || name.startsWith(".") || name === "node_modules" || (atRoot && ROOT_EXCLUDED.has(name))) continue;
    if (entries.length >= BROWSE_LIMIT) {
      truncated = true;
      break;
    }
    const dir = join(folder.dir, name);
    entries.push({ name, git: existsSync(join(dir, ".git")), workspaceId: workspaceByDir.get(dir) ?? null });
  }
  const parent = atRoot ? null : folder.display.includes("/") ? folder.display.slice(0, folder.display.lastIndexOf("/")) || "~" : "~";
  return { path: folder.display, parent, git: existsSync(join(folder.dir, ".git")), workspaceId: workspaceByDir.get(folder.dir) ?? null, entries, truncated };
}

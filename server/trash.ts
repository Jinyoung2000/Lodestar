import { lstat, cp, mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";

export function trashDir() {
  return process.env.AGENT_NAV_TRASH_DIR ?? join(homedir(), ".Trash");
}

export async function moveToTrash(abs: string) {
  const dir = trashDir();
  await mkdir(dir, { recursive: true });
  const ext = extname(abs);
  const stem = basename(abs, ext);
  let target = join(dir, basename(abs));
  for (let n = 2; await exists(target); n++) target = join(dir, `${stem} ${n}${ext}`);
  try {
    await rename(abs, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(abs, target, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    await rm(abs, { recursive: true });
  }
  return target;
}

export async function saveToTrash(name: string, content: Buffer) {
  const dir = trashDir();
  await mkdir(dir, { recursive: true });
  const ext = extname(name);
  const stem = basename(name, ext);
  let target = join(dir, basename(name));
  for (let n = 2; await exists(target); n++) target = join(dir, `${stem} ${n}${ext}`);
  await writeFile(target, content, { flag: "wx" });
  return target;
}

export async function pruneEmptyDirs(root: string, from: string) {
  for (let dir = from; dir !== root && !relative(root, dir).startsWith(".."); dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

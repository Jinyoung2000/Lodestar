import { mkdir, readFile, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Agent, RestoreFile, RestorePlan, RestoreSkip } from "../shared/protocol";
import { insideCwd } from "./checkpoints";
import { canonPath, hashOf } from "./sessionTouch";
import { moveToTrash, saveToTrash } from "./trash";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

type Saved = { content: Buffer | null; mode: number | null };

export async function applyRestore(plan: RestorePlan, rewind: () => Promise<unknown>): Promise<{ trashed: RestoreFile[] }> {
  const protectedFiles = new Map<string, Saved>();
  for (const file of plan.skip) protectedFiles.set(file.path, await readSaved(file.path));
  const removing = new Map<string, Saved>();
  for (const file of plan.remove) removing.set(file.path, await readSaved(file.path));
  const trashed: RestoreFile[] = [];
  try {
    await rewind();
    for (const file of plan.remove) {
      const saved = removing.get(file.path);
      if (!saved?.content || (await readSaved(file.path)).content !== null) continue;
      await saveToTrash(basename(file.path), saved.content);
      trashed.push(file);
    }
  } finally {
    for (const [path, saved] of protectedFiles) await putBack(path, saved);
  }
  return { trashed };
}

async function readSaved(path: string): Promise<Saved> {
  try {
    const [content, info] = await Promise.all([readFile(path), stat(path)]);
    return { content, mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: null, mode: null };
    throw error;
  }
}

async function putBack(path: string, saved: Saved) {
  const now = await readSaved(path);
  if (saved.content === null) {
    if (now.content !== null) await unlink(path);
    return;
  }
  if (now.content?.equals(saved.content)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, saved.content);
  if (saved.mode !== null) await chmod(path, saved.mode);
}

export async function hashesOf(paths: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of paths) hashes[path] = hashOf((await readSaved(path)).content);
  return hashes;
}

export async function redoFiles(agent: Agent, files: Record<string, string | null>, restoredHash: Record<string, string> | undefined) {
  const written: string[] = [];
  const skipped: RestoreSkip[] = [];
  const cwd = await realpath(agent.cwd).catch(() => agent.cwd);
  for (const [path, data] of Object.entries(files)) {
    if (!(await insideCwd(agent, path))) continue;
    const now = await readSaved(path);
    if (restoredHash && path in restoredHash && hashOf(now.content) !== restoredHash[path]) {
      const rel = relative(cwd, await canonPath(path));
      skipped.push({ path, rel: rel.startsWith("..") || isAbsolute(rel) ? path : rel, reason: "modified" });
      continue;
    }
    if (data === null) {
      if (now.content !== null) await moveToTrash(path);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(data, "base64"));
    }
    written.push(path);
  }
  return { written, skipped };
}

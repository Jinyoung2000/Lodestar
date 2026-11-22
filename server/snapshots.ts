import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Agent, ChangedFile } from "../shared/protocol";
import { countLineChanges } from "../shared/lineDiff";
import type { Store } from "./store";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export function usesSnapshots(agent: Agent) {
  return !agent.startCommit && !agent.worktree && !agent.feedbackId && agent.workspaceId !== null;
}

export async function snapshotBeforeEdit(agent: Agent, store: Store, toolName: string, input: Record<string, unknown>) {
  if (!usesSnapshots(agent) || !EDIT_TOOLS.has(toolName)) return false;
  const raw = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  if (!raw) return false;
  const absolute = isAbsolute(raw) ? raw : resolve(agent.cwd, raw);
  const rel = relative(agent.cwd, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  if (store.change(agent.id, absolute)) return false;
  const original = await readText(absolute);
  if (original === undefined) return false;
  store.setChange(agent.id, absolute, original);
  return true;
}

export async function snapshotChanges(agent: Agent, store: Store): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (const entry of store.changes(agent.id)) {
    const current = await readText(entry.path);
    if (current === undefined) continue;
    if (current === entry.original) continue;
    const status = entry.original === null ? "A" : current === null ? "D" : "M";
    const { additions, deletions } = countLineChanges(entry.original ?? "", current ?? "");
    const rel = relative(agent.cwd, entry.path);
    files.push({ path: entry.path, rel: rel.startsWith("..") ? entry.path : rel, status, additions, deletions });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

export async function applyKeptCounts(agent: Agent, store: Store, files: ChangedFile[]): Promise<ChangedFile[]> {
  const kept = store.changes(agent.id);
  if (kept.length === 0) return files;
  return Promise.all(
    files.map(async (file) => {
      const entry = kept.find((c) => c.path === file.path);
      if (!entry) return file;
      const current = await readText(file.path);
      if (current === undefined) return file;
      const { additions, deletions } = countLineChanges(entry.original ?? "", current ?? "");
      return { ...file, additions, deletions };
    }),
  );
}

async function readText(path: string): Promise<string | null | undefined> {
  try {
    const buffer = await readFile(path);
    if (buffer.length > MAX_SNAPSHOT_BYTES) return undefined;
    return buffer.toString("utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

export { countLineChanges } from "../shared/lineDiff";

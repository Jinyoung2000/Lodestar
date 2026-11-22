import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { Agent, ChangedFile } from "../shared/protocol";
import * as gitOps from "./git";
import { countLineChanges } from "./snapshots";
import type { Store } from "./store";

const MAX_BYTES = 16 * 1024 * 1024;

export type Snapshot = Record<string, string | null>;

export async function dirtyPaths(agent: Agent, store: Store) {
  const paths = new Set<string>();
  if (await gitOps.headCommit(agent.cwd)) for (const file of (await gitOps.changes(agent.cwd, "HEAD", { renames: false })).files) paths.add(file.path);
  for (const entry of store.changes(agent.id)) paths.add(entry.path);
  return paths;
}

export async function takeSnapshot(paths: Iterable<string>): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  for (const path of paths) {
    const text = await readText(path);
    if (text !== undefined) snapshot[path] = text;
  }
  return snapshot;
}

const COMPARE_CONCURRENCY = 8;
export async function compareWith(agent: Agent, paths: Iterable<string>, before: (path: string) => Promise<string | null | undefined>): Promise<ChangedFile[]> {
  const root = (await gitOps.repoRoot(agent.cwd)) ?? agent.cwd;
  const list = [...paths];
  const found = await mapLimit(list, COMPARE_CONCURRENCY, async (path): Promise<ChangedFile | null> => {
    const current = await readText(path);
    if (current === undefined) return null;
    const then = await before(path);
    if (then === undefined || then === current) return null;
    const status = then === null ? "A" : current === null ? "D" : "M";
    const { additions, deletions } = countLineChanges(then ?? "", current ?? "");
    const rel = relative(root, path);
    return { path, rel: rel.startsWith("..") ? path : rel, status, additions, deletions };
  });
  return found.filter((file): file is ChangedFile => file !== null).sort((a, b) => a.rel.localeCompare(b.rel));
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

export async function readText(path: string): Promise<string | null | undefined> {
  try {
    const buffer = await readFile(path);
    return buffer.length > MAX_BYTES ? undefined : buffer.toString("utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

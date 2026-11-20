import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { Agent, ChangedFile } from "../shared/protocol";
import * as gitOps from "./git";
import { countLineChanges } from "./snapshots";
import type { Store } from "./store";

// Last Turn 과 갈래 세션의 Session 범위가 같이 쓰는 비교: 어떤 시점에 "이미 바뀌어 있던 파일" 의 내용을 저장해 두고, 지금 디스크와 비교한다.
const MAX_BYTES = 16 * 1024 * 1024;

// 절대 경로 -> 그 시점의 내용(null 은 파일이 없었음)
export type Snapshot = Record<string, string | null>;

// 지금 HEAD 대비 바뀐 파일(새 파일 포함)과 수정 직전 스냅샷이 있는 파일. 이 시점의 기준이 HEAD 가 아닌 파일은 여기서 걸러진다.
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

// paths 의 각 파일을 "그때 내용" 과 지금 디스크로 비교한다. 같으면 목록에서 뺀다. 그때 내용을 모르는 파일(undefined)과 너무 큰 파일은 비교하지 않는다.
// 파일은 동시에 몇 개씩 읽는다(순서대로 하나씩 기다리면 변경이 많을 때 느리다). 결과는 경로 순으로 정렬한다.
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

// items 를 limit 개씩 동시에 처리한다. 결과 순서는 items 순서다.
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

// 파일이 없으면 null, 너무 크면 undefined(비교하지 않는다).
export async function readText(path: string): Promise<string | null | undefined> {
  try {
    const buffer = await readFile(path);
    return buffer.length > MAX_BYTES ? undefined : buffer.toString("utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

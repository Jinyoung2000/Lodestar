import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, ChangedFile } from "../shared/protocol";
import * as gitOps from "./git";
import { compareWith, dirtyPaths, takeSnapshot, type Snapshot } from "./snapshotDiff";
import { HOME, type Store } from "./store";

type ForkBase = { head: string; files: Snapshot };

const DIR = join(HOME, "forkbase");
const memory = new Map<string, ForkBase>();

export async function captureForkBase(agent: Agent, store: Store, sourceId: string) {
  const head = await gitOps.headCommit(agent.cwd);
  if (!head) return false;
  const paths = await dirtyPaths({ ...agent, id: sourceId }, store);
  const base: ForkBase = { head, files: await takeSnapshot(paths) };
  memory.set(agent.id, base);
  mkdirSync(DIR, { recursive: true });
  await writeFile(join(DIR, `${agent.id}.json`), JSON.stringify(base));
  return true;
}

export function hasForkBase(agentId: string) {
  return memory.has(agentId) || existsSync(join(DIR, `${agentId}.json`));
}

export async function forgetForkBase(agentId: string) {
  memory.delete(agentId);
  await rm(join(DIR, `${agentId}.json`), { force: true });
}

export async function forkBaseChanges(agent: Agent): Promise<{ base: string | null; files: ChangedFile[] }> {
  const base = await load(agent.id);
  if (!base) return { base: null, files: [] };
  const head = await gitOps.sessionBase(agent.cwd, base.head);
  const paths = new Set([...Object.keys(base.files), ...(await gitOps.changes(agent.cwd, head, { renames: false })).files.map((f) => f.path)]);
  const committed = await gitOps.originals(agent.cwd, head, [...paths].filter((path) => !(path in base.files)));
  return { base: FORK_BASE, files: await compareWith(agent, paths, (path) => Promise.resolve(path in base.files ? base.files[path] : (committed.get(path) ?? null))) };
}

export async function forkBaseOriginal(agent: Agent, absolute: string) {
  const base = await load(agent.id);
  return base ? ((await originalOf(agent, base, await gitOps.sessionBase(agent.cwd, base.head), absolute)) ?? null) : null;
}

export const FORK_BASE = "fork";

function originalOf(agent: Agent, base: ForkBase, head: string, path: string): Promise<string | null | undefined> {
  return path in base.files ? Promise.resolve(base.files[path]) : gitOps.original(agent.cwd, head, path);
}

async function load(agentId: string) {
  const known = memory.get(agentId);
  if (known) return known;
  const file = join(DIR, `${agentId}.json`);
  if (!existsSync(file)) return null;
  try {
    const base = JSON.parse(await readFile(file, "utf8")) as ForkBase;
    memory.set(agentId, base);
    return base;
  } catch {
    return null;
  }
}

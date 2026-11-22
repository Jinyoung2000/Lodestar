import { mkdirSync, existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, ChangedFile } from "../shared/protocol";
import * as gitOps from "./git";
import { compareWith, dirtyPaths, takeSnapshot, type Snapshot } from "./snapshotDiff";
import { HOME, type Store } from "./store";

const DIR = join(HOME, "lastturn");

const memory = new Map<string, Snapshot>();

export async function beginTurn(agent: Agent, store: Store) {
  const snapshot = await takeSnapshot(await dirtyPaths(agent, store));
  memory.set(agent.id, snapshot);
  try {
    mkdirSync(DIR, { recursive: true });
    await writeFile(join(DIR, `${agent.id}.json`), JSON.stringify(snapshot));
  } catch {
  }
}

export async function forget(agentId: string) {
  memory.delete(agentId);
  await rm(join(DIR, `${agentId}.json`), { force: true });
}

export async function lastTurnChanges(agent: Agent, store: Store): Promise<{ base: string | null; files: ChangedFile[] }> {
  const snapshot = await load(agent.id);
  if (!snapshot) return { base: null, files: [] };
  const paths = new Set([...Object.keys(snapshot), ...(await dirtyPaths(agent, store))]);
  const untouched = await untouchedOriginals(agent, store, [...paths].filter((path) => !(path in snapshot)));
  const files = await compareWith(agent, paths, (path) => Promise.resolve(path in snapshot ? snapshot[path] : untouched.get(path)));
  return { base: "lastTurn", files };
}

export async function lastTurnOriginal(agent: Agent, store: Store, absolute: string) {
  const snapshot = await load(agent.id);
  if (snapshot && absolute in snapshot) return snapshot[absolute];
  return (await untouchedOriginal(agent, store, absolute)) ?? null;
}

async function untouchedOriginal(agent: Agent, store: Store, path: string): Promise<string | null | undefined> {
  if (await gitOps.headCommit(agent.cwd)) return gitOps.original(agent.cwd, "HEAD", path);
  const kept = store.change(agent.id, path);
  return kept ? kept.original : undefined;
}

async function untouchedOriginals(agent: Agent, store: Store, paths: string[]): Promise<Map<string, string | null | undefined>> {
  if (await gitOps.headCommit(agent.cwd)) return gitOps.originals(agent.cwd, "HEAD", paths);
  return new Map(paths.map((path) => [path, store.change(agent.id, path)?.original]));
}

async function load(agentId: string) {
  const known = memory.get(agentId);
  if (known) return known;
  const file = join(DIR, `${agentId}.json`);
  if (!existsSync(file)) return null;
  try {
    const snapshot = JSON.parse(await readFile(file, "utf8")) as Snapshot;
    memory.set(agentId, snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

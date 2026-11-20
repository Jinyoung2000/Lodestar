import { mkdirSync, existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, ChangedFile } from "../shared/protocol";
import * as gitOps from "./git";
import { compareWith, dirtyPaths, takeSnapshot, type Snapshot } from "./snapshotDiff";
import { HOME, type Store } from "./store";

// "Last Turn Changes": 턴이 시작될 때 이미 바뀌어 있던 파일의 내용을 저장해 두고, 지금 디스크와 비교한다.
// 그때 바뀌어 있지 않던 파일의 기준은 HEAD(없으면 수정 직전 스냅샷)라 따로 저장하지 않는다. 마지막 턴 하나만 보존한다(다음 턴 시작이 덮어씀).
const DIR = join(HOME, "lastturn");

const memory = new Map<string, Snapshot>();

// 턴이 시작될 때 부른다. 모델이 첫 도구를 부르기 전에 끝나도록 await 없이 시작만 한다.
export async function beginTurn(agent: Agent, store: Store) {
  const snapshot = await takeSnapshot(await dirtyPaths(agent, store));
  memory.set(agent.id, snapshot);
  try {
    mkdirSync(DIR, { recursive: true });
    await writeFile(join(DIR, `${agent.id}.json`), JSON.stringify(snapshot));
  } catch {
    // 저장 실패는 데몬을 다시 띄우면 마지막 턴 기록이 없어지는 것으로 끝난다
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

// 턴 시작 때 바뀌어 있지 않던 파일은 그때 내용이 곧 HEAD 내용이다. HEAD 가 없으면(커밋 0개, git 이 아닌 폴더) 첫 수정 직전 스냅샷.
async function untouchedOriginal(agent: Agent, store: Store, path: string): Promise<string | null | undefined> {
  if (await gitOps.headCommit(agent.cwd)) return gitOps.original(agent.cwd, "HEAD", path);
  const kept = store.change(agent.id, path);
  return kept ? kept.original : undefined;
}

// 위와 같은 기준을 여러 파일에 한 번에 구한다(git 프로세스 하나로).
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

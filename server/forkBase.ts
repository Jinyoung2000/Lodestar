import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, ChangedFile } from "../shared/protocol";
import * as gitOps from "./git";
import { compareWith, dirtyPaths, takeSnapshot, type Snapshot } from "./snapshotDiff";
import { HOME, type Store } from "./store";

// 갈래 세션(세션 Fork, 메시지 단위 Fork)의 Session 범위 기준. 갈래를 만든 시점의 작업 폴더 상태에서 출발해야 "No changed files" 로 시작한다.
// 기준은 갈래 시점의 HEAD 와, 그때 이미 바뀌어 있던 파일의 내용이다. 그때 바뀌어 있지 않던 파일의 기준은 그 HEAD 의 내용이다.
// HEAD 를 현재 HEAD 가 아닌 갈래 시점의 것으로 못박는 이유: 에이전트가 갈래 안에서 커밋해도 그 파일이 "변경 없음" 으로 사라지지 않게 하려는 것이다.
// 갈래 뒤에 pull 로 들어온 남의 커밋은 변경이 아니다: 비교하는 커밋은 gitOps.sessionBase 가 그만큼 앞으로 옮긴다.
type ForkBase = { head: string; files: Snapshot };

const DIR = join(HOME, "forkbase");
const memory = new Map<string, ForkBase>();

// 새 갈래 세션(agent)을 만들 때 부른다. 기준을 남기면 true, HEAD 가 없는 폴더(커밋 0개, git 이 아님)는 false.
// 그런 폴더는 수정 직전 스냅샷(server/snapshots.ts)이 기준이고, 갈래의 스냅샷 기록은 비어서 시작하므로 이미 "No changed files" 로 시작한다.
export async function captureForkBase(agent: Agent, store: Store, sourceId: string) {
  const head = await gitOps.headCommit(agent.cwd);
  if (!head) return false;
  // 원 세션의 수정 직전 스냅샷(store.changes)도 그 세션의 변경으로 보이던 파일이라 후보에 든다.
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

// 패널 머리가 "기준 없음" 으로 읽지 않게 base 자리에 들어가는 이름
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

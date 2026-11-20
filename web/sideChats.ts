// 곁다리 대화(/btw)는 세션마다 따로다. 화면에는 지금 보는 세션의 곁다리 하나만 뜨고, 다른 세션의 것은 stash 에 보관했다가 그 세션으로 돌아오면 되살린다.
// store 를 모르는 순수 함수라 단위 시험이 그대로 부른다(test/sidechats.test.ts).

type Side = { id: string; agentId: string; run: { id: string } | null; draft?: unknown };
export type SideStash<T extends Side> = Record<string, T>;

// 보는 세션이 from 에서 to 로 바뀌었을 때의 곁다리 화면. from 의 것은 보관하고(빈 곁다리는 버린다) to 의 것이 있으면 꺼내 온다.
export function swapSide<T extends Side>(side: T | null, stash: SideStash<T>, from: string | null, to: string | null): { side: T | null; stash: SideStash<T> } {
  if (from === to) return { side, stash };
  const next = { ...stash };
  if (side && side.agentId === from && (side.run || side.draft)) next[side.agentId] = side;
  const shown = side && side.agentId === to ? side : (to ? next[to] : undefined) ?? null;
  if (to) delete next[to];
  return { side: shown, stash: next };
}

// 데몬이 보낸 곁다리 실행 상태를 화면 것과 보관된 것 중 id 가 맞는 쪽에 반영한다.
export function applySideRun<T extends Side>(side: T | null, stash: SideStash<T>, run: { id: string }): { side: T | null; stash: SideStash<T> } {
  if (side && side.id === run.id) return { side: { ...side, run } as T, stash };
  const owner = Object.keys(stash).find((agentId) => stash[agentId].id === run.id);
  if (!owner) return { side, stash };
  return { side, stash: { ...stash, [owner]: { ...stash[owner], run } as T } };
}

// 세션이 지워지면 그 세션의 곁다리는 화면과 보관함 양쪽에서 사라진다.
export function dropSide<T extends Side>(side: T | null, stash: SideStash<T>, agentId: string): { side: T | null; stash: SideStash<T> } {
  const { [agentId]: _gone, ...rest } = stash;
  return { side: side?.agentId === agentId ? null : side, stash: rest };
}

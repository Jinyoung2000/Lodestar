
type Side = { id: string; agentId: string; run: { id: string } | null; draft?: unknown };
export type SideStash<T extends Side> = Record<string, T>;

export function swapSide<T extends Side>(side: T | null, stash: SideStash<T>, from: string | null, to: string | null): { side: T | null; stash: SideStash<T> } {
  if (from === to) return { side, stash };
  const next = { ...stash };
  if (side && side.agentId === from && (side.run || side.draft)) next[side.agentId] = side;
  const shown = side && side.agentId === to ? side : (to ? next[to] : undefined) ?? null;
  if (to) delete next[to];
  return { side: shown, stash: next };
}

export function applySideRun<T extends Side>(side: T | null, stash: SideStash<T>, run: { id: string }): { side: T | null; stash: SideStash<T> } {
  if (side && side.id === run.id) return { side: { ...side, run } as T, stash };
  const owner = Object.keys(stash).find((agentId) => stash[agentId].id === run.id);
  if (!owner) return { side, stash };
  return { side, stash: { ...stash, [owner]: { ...stash[owner], run } as T } };
}

export function dropSide<T extends Side>(side: T | null, stash: SideStash<T>, agentId: string): { side: T | null; stash: SideStash<T> } {
  const { [agentId]: _gone, ...rest } = stash;
  return { side: side?.agentId === agentId ? null : side, stash: rest };
}

export type WarmCandidate = {
  agentId: string;
  lastUsed: number;
  busy: boolean;
};

export function selectWarmEvictions(candidates: readonly WarmCandidate[], limit: number): string[] {
  if (!(limit > 0)) return [];
  return candidates
    .filter((c) => !c.busy)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(limit)
    .map((c) => c.agentId);
}

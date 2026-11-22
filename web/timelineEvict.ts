
export function pickEvictions(loaded: readonly string[], shown: ReadonlySet<string>, recent: readonly string[], busy: (id: string) => boolean, keep: number): string[] {
  const kept = new Set(recent.slice(0, keep));
  return loaded.filter((id) => !shown.has(id) && !kept.has(id) && !busy(id));
}

export function noteHidden(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)];
}

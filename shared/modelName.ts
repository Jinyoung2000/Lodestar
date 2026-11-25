export function versionedDisplayName(displayName: string, resolvedModel: string | null): string {
  if (/\d/.test(displayName) || !resolvedModel) return displayName;
  const derived = modelNameFromId(resolvedModel);
  return derived && derived.toLowerCase().startsWith(`${displayName.toLowerCase()} `) ? derived : displayName;
}

export function modelNameFromId(id: string): string | null {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!match) return null;
  const family = match[1]![0]!.toUpperCase() + match[1]!.slice(1);
  return match[3] ? `${family} ${match[2]}.${match[3]}` : `${family} ${match[2]}`;
}

const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"];

export function aliasModelName(alias: string, resolvedIds: readonly (string | null | undefined)[]): string | null {
  const family = alias.toLowerCase();
  if (!MODEL_FAMILIES.includes(family)) return null;
  let best: { name: string; version: number } | null = null;
  for (const id of resolvedIds) {
    const match = id ? /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/.exec(id) : null;
    if (!match || match[1] !== family) continue;
    const version = Number(match[2]) * 100 + Number(match[3] ?? 0);
    const name = modelNameFromId(id!.replace(/\[[^\]]*\]$/, ""));
    if (name && (!best || version > best.version)) best = { name, version };
  }
  return best?.name ?? family[0]!.toUpperCase() + family.slice(1);
}

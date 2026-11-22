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

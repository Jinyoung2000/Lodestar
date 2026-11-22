export type RowKind = "folder" | "file" | "hit";
export type SearchMenuAction = "replace" | "replaceAll" | "dismiss" | "restrictToFolder" | "expandRecursively" | "excludeFolder" | "excludeFileType" | "includeFileType" | "copy" | "copyPath" | "copyAll" | "reveal";

export type SearchMenuItem = { action: SearchMenuAction; separatorBefore?: boolean; key?: string };

const KEYS: Partial<Record<SearchMenuAction, string>> = { replace: "⇧⌘1", replaceAll: "⇧⌘1", dismiss: "⌘⌫", restrictToFolder: "⇧⌥F", copy: "⌘C", copyPath: "⌥⌘C" };

export function searchMenuItems(kind: RowKind, state: { replaceShown: boolean; hasResults: boolean }): SearchMenuItem[] {
  const groups: SearchMenuAction[][] = [
    [
      ...(state.replaceShown ? [kind === "hit" ? ("replace" as const) : ("replaceAll" as const)] : []),
      "dismiss",
      ...(kind === "folder" ? (["restrictToFolder", "expandRecursively", "excludeFolder"] as const) : []),
      ...(kind === "file" ? (["excludeFileType", "includeFileType"] as const) : []),
    ],
    [...(kind !== "folder" ? (["copy"] as const) : []), ...(kind !== "hit" ? (["copyPath"] as const) : []), ...(state.hasResults ? (["copyAll"] as const) : [])],
    kind === "file" && state.hasResults ? ["reveal"] : [],
  ];
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, g) => group.map((action, i): SearchMenuItem => ({ action, ...(g > 0 && i === 0 ? { separatorBefore: true } : {}), ...(KEYS[action] ? { key: KEYS[action] } : {}) })));
}

export function hoverActions(kind: RowKind, replaceShown: boolean): ("replace" | "replaceAll" | "dismiss")[] {
  return [...(replaceShown ? [kind === "hit" ? ("replace" as const) : ("replaceAll" as const)] : []), "dismiss"];
}

export function fileTypePattern(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `*${name.slice(dot)}` : null;
}

export function appendPattern(list: string, pattern: string): string {
  const parts = list.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.includes(pattern) ? list : [...parts, pattern].join(", ");
}

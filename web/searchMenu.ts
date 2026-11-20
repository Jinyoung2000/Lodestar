export type RowKind = "folder" | "file" | "hit";
export type SearchMenuAction = "replace" | "replaceAll" | "dismiss" | "restrictToFolder" | "expandRecursively" | "excludeFolder" | "excludeFileType" | "includeFileType" | "copy" | "copyPath" | "copyAll" | "reveal";

export type SearchMenuItem = { action: SearchMenuAction; separatorBefore?: boolean; key?: string };

const KEYS: Partial<Record<SearchMenuAction, string>> = { replace: "⇧⌘1", replaceAll: "⇧⌘1", dismiss: "⌘⌫", restrictToFolder: "⇧⌥F", copy: "⌘C", copyPath: "⌥⌘C" };

// 그룹 순서: search(Replace, Dismiss, Restrict, Expand Recursively, Exclude 계열), search_2(Copy 계열), search_3(Reveal). 구분선은 그룹 사이.
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

// hover 단추: 바꾸기 줄이 펼쳐져 있으면 Replace(파일과 폴더는 Replace All) 다음에 Dismiss, 아니면 Dismiss 하나.
export function hoverActions(kind: RowKind, replaceShown: boolean): ("replace" | "replaceAll" | "dismiss")[] {
  return [...(replaceShown ? [kind === "hit" ? ("replace" as const) : ("replaceAll" as const)] : []), "dismiss"];
}

// 파일 이름에서 확장자 패턴(*.ts). 확장자가 없으면 null.
export function fileTypePattern(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `*${name.slice(dot)}` : null;
}

// 쉼표 목록 입력에 패턴 하나를 더한다(이미 있으면 그대로)
export function appendPattern(list: string, pattern: string): string {
  const parts = list.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.includes(pattern) ? list : [...parts, pattern].join(", ");
}

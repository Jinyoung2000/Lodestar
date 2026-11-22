export type FilesRowKind = "file" | "folder" | "root";

export type FilesMenuAction = "open" | "openSide" | "newFile" | "newFolder" | "reveal" | "openTerminal" | "findInFolder" | "attach" | "copyPath" | "copyRelativePath" | "rename" | "delete";

export type FilesMenuItem = { action: FilesMenuAction; separatorBefore?: boolean; disabled?: boolean; key?: string };

const KEYS: Partial<Record<FilesMenuAction, string>> = { openSide: "⌃Enter", reveal: "⌥⌘R", copyPath: "⌥⌘C", copyRelativePath: "⇧⌥⌘C", rename: "F2", delete: "⌘⌫" };

export function filesMenuItems(kind: FilesRowKind, options: { canAttach: boolean }): FilesMenuItem[] {
  const groups: FilesMenuAction[][] =
    kind === "file"
      ? [["open", "openSide"], ["reveal"], ["attach"], ["copyPath", "copyRelativePath"], ["rename", "delete"], ["newFile", "newFolder"]]
      : kind === "folder"
        ? [["newFile", "newFolder"], ["reveal", "openTerminal", "findInFolder"], ["copyPath", "copyRelativePath"], ["rename", "delete"]]
        : [["newFile", "newFolder"], ["reveal", "openTerminal", "findInFolder"], ["copyPath"]];
  return groups.flatMap((group, g) =>
    group.map((action, i): FilesMenuItem => ({ action, ...(g > 0 && i === 0 ? { separatorBefore: true } : {}), ...(action === "attach" && !options.canAttach ? { disabled: true } : {}), ...(KEYS[action] && isBound(action, kind) ? { key: KEYS[action] } : {}) })),
  );
}

const isBound = (action: FilesMenuAction, kind: FilesRowKind) => (kind !== "root" || (action !== "rename" && action !== "delete")) && (action !== "openSide" || kind === "file");

export type RowKeyInput = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

export function filesKeyAction(event: RowKeyInput, kind: FilesRowKind): FilesMenuAction | null {
  const mod = event.metaKey && !event.ctrlKey;
  if (event.key === "Enter" && kind === "file" && (event.ctrlKey !== event.metaKey) && !event.altKey && !event.shiftKey) return "openSide";
  if (event.key === "F2" && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) return kind === "root" ? null : "rename";
  if (mod && !event.altKey && !event.shiftKey && event.key === "Backspace") return kind === "root" ? null : "delete";
  if (mod && event.altKey && event.code === "KeyR" && !event.shiftKey) return "reveal";
  if (mod && event.altKey && event.code === "KeyC") return event.shiftKey ? (kind === "root" ? null : "copyRelativePath") : "copyPath";
  return null;
}

export function renameSelection(name: string, isFile: boolean): [number, number] {
  const dot = name.lastIndexOf(".");
  return isFile && dot > 0 ? [0, dot] : [0, name.length];
}

export function renameProblem(name: string): "empty" | "invalid" | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\0")) return "invalid";
  return null;
}

export function renamedPath(path: string, newName: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? newName.trim() : `${path.slice(0, slash + 1)}${newName.trim()}`;
}

export function retargetPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
}

export const isSameOrUnder = (path: string, target: string) => path === target || path.startsWith(`${target}/`);

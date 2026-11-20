export type FilesRowKind = "file" | "folder" | "root";

export type FilesMenuAction = "open" | "openSide" | "newFile" | "newFolder" | "reveal" | "openTerminal" | "findInFolder" | "attach" | "copyPath" | "copyRelativePath" | "rename" | "delete";

// key 는 그 행에 포커스가 있을 때 실제로 묶여 있는 키만 적는다(안 묶인 키는 힌트로 보이지 않는다).
export type FilesMenuItem = { action: FilesMenuAction; separatorBefore?: boolean; disabled?: boolean; key?: string };

const KEYS: Partial<Record<FilesMenuAction, string>> = { openSide: "⌃Enter", reveal: "⌥⌘R", copyPath: "⌥⌘C", copyRelativePath: "⇧⌥⌘C", rename: "F2", delete: "⌘⌫" };

// 순서: 열기, 만들기, 밖으로(Finder, 터미널, 검색), 채팅에 붙이기, 경로 복사, 이름과 삭제. 구분선은 묶음 사이에만.
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

// 루트 행은 이름 바꾸기와 삭제 키를 받지 않으므로 힌트도 없다
const isBound = (action: FilesMenuAction, kind: FilesRowKind) => (kind !== "root" || (action !== "rename" && action !== "delete")) && (action !== "openSide" || kind === "file");

export type RowKeyInput = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

// 행에 포커스가 있을 때 키 하나가 부르는 항목. 앱 전역 키(F2 는 세션 이름 바꾸기, ⌘⌫ 는 완료 처리)보다 먼저 이 행이 받는다.
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

// 새 이름이 한 칸짜리 이름으로 쓸 수 있는가. 경로 구분자나 `.`, `..` 는 안 된다.
export function renameProblem(name: string): "empty" | "invalid" | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\0")) return "invalid";
  return null;
}

// path 의 마지막 이름만 newName 으로 바꾼 경로
export function renamedPath(path: string, newName: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? newName.trim() : `${path.slice(0, slash + 1)}${newName.trim()}`;
}

// from 이 파일이면 같은 경로일 때, 폴더이면 그 아래일 때 to 쪽 경로로 옮긴 경로. 상관없는 경로는 null.
export function retargetPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
}

// path 가 target 자신이거나 그 아래인가(삭제와 이름 바꾸기가 영향을 주는 열린 탭을 고른다)
export const isSameOrUnder = (path: string, target: string) => path === target || path.startsWith(`${target}/`);

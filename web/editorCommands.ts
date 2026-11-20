import type { EditorView } from "@codemirror/view";

export type EditorCommand = { id: string; title: string; run: (view: EditorView) => boolean | void };

const registry = new Map<string, EditorCommand>();

export function registerEditorCommands(list: readonly EditorCommand[]) {
  for (const command of list) registry.set(command.id, command);
}

export function editorCommandList(): EditorCommand[] {
  return [...registry.values()];
}

export function editorCommandTitle(id: string): string | null {
  return registry.get(id)?.title ?? null;
}

// 명령을 받을 에디터를 찾는 쪽(web/editorCommandTarget.ts)이 부팅 때 넣는다. 등록부 자체는 LSP 나 store 에 의존하지 않아 명령 팔레트(web/commands.ts)가 DOM 없이도 불러진다.
export type EditorTarget = { view: () => EditorView | null; workspaceIdOf: (view: EditorView) => string | null };
let target: EditorTarget | null = null;

export function setEditorTarget(next: EditorTarget) {
  target = next;
}

// 명령을 받을 에디터: 키보드 포커스가 있는 에디터, 없으면 활성 파일 탭의 에디터.
export function targetEditorView(): EditorView | null {
  return target?.view() ?? null;
}

export function runEditorCommand(id: string, view: EditorView | null = targetEditorView()): boolean {
  const command = registry.get(id);
  if (!command || !view) return false;
  const result = command.run(view);
  return result !== false;
}

// 이 에디터가 열린 탭의 워크스페이스. 등록 명령이 LSP 요청에 쓴다.
export function workspaceIdOfView(view: EditorView): string | null {
  return target?.workspaceIdOf(view) ?? null;
}

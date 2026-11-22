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

export type EditorTarget = { view: () => EditorView | null; workspaceIdOf: (view: EditorView) => string | null };
let target: EditorTarget | null = null;

export function setEditorTarget(next: EditorTarget) {
  target = next;
}

export function targetEditorView(): EditorView | null {
  return target?.view() ?? null;
}

export function runEditorCommand(id: string, view: EditorView | null = targetEditorView()): boolean {
  const command = registry.get(id);
  if (!command || !view) return false;
  const result = command.run(view);
  return result !== false;
}

export function workspaceIdOfView(view: EditorView): string | null {
  return target?.workspaceIdOf(view) ?? null;
}

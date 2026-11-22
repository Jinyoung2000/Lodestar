import type { EditorView } from "@codemirror/view";
import { editorCommandTitle, registerEditorCommands, runEditorCommand } from "./editorCommands";
import { eolOf } from "./editorEol";
import { changeEol } from "./editorViewCommands";
import { openEditorPick, type PickItem } from "./EditorPick";
import { focusLater } from "./GoToLine";


const INDENT_ACTIONS: { id: string; label: string; group?: string }[] = [
  { id: "indentUsingSpaces", label: "Indent Using Spaces", group: "change view" },
  { id: "indentUsingTabs", label: "Indent Using Tabs" },
  { id: "changeTabDisplaySize", label: "Change Tab Display Size" },
  { id: "detectIndentation", label: "Detect Indentation from Content", group: "convert file" },
  { id: "convertIndentationToSpaces", label: "Convert Indentation to Spaces" },
  { id: "convertIndentationToTabs", label: "Convert Indentation to Tabs" },
  { id: "trimTrailingWhitespace", label: "Trim Trailing Whitespace" },
];

export async function pickIndentationAction(view: EditorView) {
  const items: PickItem[] = INDENT_ACTIONS.filter((action) => editorCommandTitle(action.id) !== null);
  const picked = await openEditorPick({ placeholder: "Select Action", items });
  if (picked === null) {
    focusLater(view);
    return;
  }
  runEditorCommand(picked, view);
  if (!["indentUsingSpaces", "indentUsingTabs", "changeTabDisplaySize"].includes(picked)) focusLater(view);
}

export async function pickEndOfLine(view: EditorView) {
  const current = eolOf(view.state);
  const items: PickItem[] = [
    { id: "\n", label: "LF" },
    { id: "\r\n", label: "CRLF" },
  ];
  const picked = await openEditorPick({ placeholder: "Select End of Line Sequence", items, activeId: current });
  if (picked === "\n" || picked === "\r\n") changeEol(view, picked);
  focusLater(view);
}

registerEditorCommands([{ id: "changeEndOfLineSequence", title: "Change End of Line Sequence", run: (view) => (void pickEndOfLine(view), true) }]);

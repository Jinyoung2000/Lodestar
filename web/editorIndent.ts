import type { EditorState, Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import { registerEditorCommands } from "./editorCommands";
import { currentEditorOptions } from "./editorOptions";
import { formatOnPasteExtension } from "./formatOnPaste";
import { baseIndentation, convertIndentation, detectIndentation, indentEffect, indentInfoOf as indentInfoOfState, indentState, reindentLines, shiftTabCommand, tabCommand, type IndentInfo as IndentInfoShape } from "./indentLogic";
import { tabShouldMoveFocus } from "./tabFocus";

export type IndentInfo = IndentInfoShape;

export function indentInfoOf(state: EditorState): IndentInfo {
  return indentInfoOfState(state);
}

export function setIndentation(view: EditorView, next: { useSpaces: boolean; size: number }) {
  view.dispatch({ effects: indentEffect(next) });
}

export function indentExtension(options: EditorOptions, context: OptionContext): Extension {
  return [
    indentState(baseIndentation(options, context.text)),
    keymap.of([{ key: "Tab", run: (view) => !tabShouldMoveFocus() && tabCommand(view), shift: (view) => !tabShouldMoveFocus() && shiftTabCommand(view) }]),
    options.formatOnPaste ? formatOnPasteExtension() : [],
  ];
}


registerEditorCommands([
  { id: "indentUsingSpaces", title: "Indent Using Spaces", run: (view) => pickTabSize(view, true, false) },
  { id: "indentUsingTabs", title: "Indent Using Tabs", run: (view) => pickTabSize(view, false, false) },
  { id: "changeTabDisplaySize", title: "Change Tab Display Size", run: (view) => pickTabSize(view, indentInfoOf(view.state).useSpaces, true) },
  { id: "detectIndentation", title: "Detect Indentation from Content", run: (view) => detectIndentation(view, currentEditorOptions()) },
  { id: "convertIndentationToSpaces", title: "Convert Indentation to Spaces", run: (view) => convertIndentation(view, true) },
  { id: "convertIndentationToTabs", title: "Convert Indentation to Tabs", run: (view) => convertIndentation(view, false) },
  { id: "reindentLines", title: "Reindent Lines", run: (view) => reindentLines(view, false) },
  { id: "reindentSelectedLines", title: "Reindent Selected Lines", run: (view) => reindentLines(view, true) },
]);

function pickTabSize(view: EditorView, useSpaces: boolean, displaySizeOnly: boolean) {
  const current = indentInfoOf(view.state).size;
  const configured = currentEditorOptions().tabSize;
  const items = [1, 2, 3, 4, 5, 6, 7, 8].map((size) => ({
    id: String(size),
    label: String(size),
    detail: size === configured && size === current ? "Configured Tab Size" : size === configured ? "Default Tab Size" : size === current ? "Current Tab Size" : undefined,
  }));
  const title = displaySizeOnly ? "Change Tab Display Size" : useSpaces ? "Indent Using Spaces" : "Indent Using Tabs";
  void import("./QuickChoice").then(async ({ openChoice }) => {
    const picked = await openChoice({ title, placeholder: "Select Tab Size for Current File", items });
    if (picked === null || !view.dom.isConnected) return;
    const size = Number(picked);
    setIndentation(view, { useSpaces: displaySizeOnly ? indentInfoOf(view.state).useSpaces : useSpaces, size });
    view.focus();
  });
  return true;
}

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

// 지금 파일의 들여쓰기 설정. size 는 Tab 한 칸의 열 수(탭 문자로 들여써도 이 값만큼 보인다)
export function indentInfoOf(state: EditorState): IndentInfo {
  return indentInfoOfState(state);
}

// 사용자가 상태 표시줄이나 명령으로 고른 값을 이 파일에 적용한다(설정이 바뀌어도 이 파일에서는 유지된다).
export function setIndentation(view: EditorView, next: { useSpaces: boolean; size: number }) {
  view.dispatch({ effects: indentEffect(next) });
}

// 설정과 본문에서 감지한 값으로 만든 확장(Editor.tsx 가 설정 묶음에 넣는다)
export function indentExtension(options: EditorOptions, context: OptionContext): Extension {
  return [
    indentState(baseIndentation(options, context.text)),
    // 포커스 이동 모드(⌃⇧M, Esc 다음 Tab)이면 false 를 돌려줘 브라우저가 Tab 으로 포커스를 옮기게 한다.
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
  // 선택창이 열리는 동안 포커스가 에디터를 떠나므로 명령이 들어온 뷰를 붙들어 둔다.
  void import("./QuickChoice").then(async ({ openChoice }) => {
    const picked = await openChoice({ title, placeholder: "Select Tab Size for Current File", items });
    if (picked === null || !view.dom.isConnected) return;
    const size = Number(picked);
    setIndentation(view, { useSpaces: displaySizeOnly ? indentInfoOf(view.state).useSpaces : useSpaces, size });
    view.focus();
  });
  return true;
}

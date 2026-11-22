import type { EditorView } from "@codemirror/view";
import { registerEditorCommands } from "./editorCommands";
import { viewsOfSameFile } from "./editorDocs";
import { setEol } from "./editorEol";
import { toggleWordWrap } from "./editorWrap";
import { trimTrailingWhitespace } from "./saveTransforms";

export function changeEol(view: EditorView, eol: "\n" | "\r\n") {
  for (const target of viewsOfSameFile(view)) setEol(target, eol);
}

registerEditorCommands([
  { id: "toggleWordWrap", title: "View: Toggle Word Wrap", run: toggleWordWrap },
  {
    id: "trimTrailingWhitespace",
    title: "Trim Trailing Whitespace",
    run: (view) => {
      const changes = trimTrailingWhitespace(view.state.doc);
      if (!changes.empty && !view.state.readOnly) view.dispatch({ changes, userEvent: "delete" });
      return true;
    },
  },
]);

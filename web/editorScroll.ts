import type { Extension } from "@codemirror/state";
import { EditorView, scrollPastEnd } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import "./editorScroll.css";
import { editorMetrics } from "./editorMetrics";

export function scrollExtension(options: EditorOptions, context: OptionContext): Extension {
  void context;
  return [
    options.scrollBeyondLastLine ? scrollPastEnd() : [],
    editorMetrics(),
    EditorView.editorAttributes.of({
      class: options.smoothScrolling ? "cm-vsc-scroll cm-vsc-smooth-scroll" : "cm-vsc-scroll",
      style: `--editor-last-columns:${options.scrollBeyondLastColumn}`,
    }),
  ];
}

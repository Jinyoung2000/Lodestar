import type { Extension, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import "./editorWhitespace.css";
import { editorMetrics } from "./editorMetrics";
import { whitespaceOffsets, whitespaceRuns, type LineSelection } from "./editorWhitespaceModel";

const MAX_COLUMNS = 10_000;

export function renderWhitespaceExtension(options: EditorOptions, context: OptionContext): Extension {
  void context;
  const mode = options.renderWhitespace;
  if (mode === "none") return [];
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      constructor(view: EditorView) {
        this.decorations = build(view, mode);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || (mode === "selection" && update.selectionSet)) this.decorations = build(update.view, mode);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
  return [editorMetrics(), plugin];
}

const SPACE = Decoration.mark({ class: "cm-ws-space" });
const TABS = [Decoration.mark({ class: "cm-ws-tab", attributes: { "data-ws": "0" } }), Decoration.mark({ class: "cm-ws-tab", attributes: { "data-ws": "1" } })];

function build(view: EditorView, mode: EditorOptions["renderWhitespace"]): DecorationSet {
  const { doc, selection } = view.state;
  const marks: Range<Decoration>[] = [];
  const selected = mode === "selection" ? selection.ranges.filter((range) => !range.empty) : [];
  for (const { from, to } of view.visibleRanges) {
    for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number++) {
      const line = doc.line(number);
      let selections: LineSelection[] | null = null;
      if (mode === "selection") {
        selections = [];
        for (const range of selected) {
          if (range.to <= line.from || range.from > line.to) continue;
          const start = Math.max(range.from, line.from) - line.from;
          const end = Math.min(range.to, line.to) - line.from;
          if (start < end) selections.push({ from: start, to: end });
        }
        if (selections.length === 0) continue;
      }
      const text = line.length > MAX_COLUMNS ? line.text.slice(0, MAX_COLUMNS) : line.text;
      const offsets = whitespaceOffsets(text, mode, selections);
      let tabIndex = 0;
      for (const run of whitespaceRuns(text, offsets)) {
        marks.push((run.tab ? TABS[tabIndex++ % 2]! : SPACE).range(line.from + run.from, line.from + run.to));
      }
    }
  }
  return Decoration.set(marks, true);
}

import type { Extension, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import "./editorWhitespace.css";
import { editorMetrics } from "./editorMetrics";
import { whitespaceOffsets, whitespaceRuns, type LineSelection } from "./editorWhitespaceModel";

// 공백 표시(editor.renderWhitespace). 공백은 점, 탭은 오른쪽 화살표를 editorWhitespace.foreground 색으로 그린다.
// 어느 공백을 그릴지는 editorWhitespaceModel.ts 가 정하고, 여기서는 그 자리에 mark 를 붙인다. 그림은 editorWhitespace.css.

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
// 탭이 이어지면 같은 mark 끼리 하나의 요소로 합쳐져 화살표가 한 번만 그려진다. 속성을 번갈아 달아 탭마다 요소를 따로 만든다.
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

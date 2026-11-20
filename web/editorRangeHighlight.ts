import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

const setRange = StateEffect.define<{ from: number; to: number } | null>();

const rangeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setRange)) continue;
      next = effect.value ? Decoration.set(linesOf(tr.state.doc, effect.value.from, effect.value.to)) : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const lineMark = Decoration.line({ class: "cm-rangeHighlight" });

function linesOf(doc: Text, from: number, to: number) {
  const first = doc.lineAt(Math.min(from, doc.length)).number;
  const last = doc.lineAt(Math.min(Math.max(to, from), doc.length)).number;
  const marks = [];
  for (let n = first; n <= last; n++) marks.push(lineMark.range(doc.line(n).from));
  return marks;
}

export const rangeHighlightExtension: Extension = [rangeField, EditorView.baseTheme({ ".cm-rangeHighlight": { backgroundColor: "var(--editor-range-highlight)" } })];

export function showRangeHighlight(view: EditorView, from: number, to: number) {
  view.dispatch({ effects: setRange.of({ from, to }) });
}

export function clearRangeHighlight(view: EditorView) {
  if (view.state.field(rangeField, false) !== undefined) view.dispatch({ effects: setRange.of(null) });
}

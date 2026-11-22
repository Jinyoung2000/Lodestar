import { Chunk, getChunks } from "@codemirror/merge";
import { RangeSet, StateEffect, StateField, Text, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { chunkKind, QUICK_DIFF_CONFIG, visibleLineCount } from "./diffMarks";


export type GutterKind = "added" | "modified" | "removed";
export type GutterMark = { line: number; kind: GutterKind };

export const GUTTER_MAX_LINES = 20_000;
const RECOMPUTE_MS = 250;

export const setGutterBase = StateEffect.define<string | null>();
const setMarks = StateEffect.define<RangeSet<ChangeMarker>>();

export type QuickDiff = { extension: Extension; open: (view: EditorView, base: Text, line: number) => void };

export function changeGutter(quickDiff: QuickDiff): Extension {
  return [changeField, recomputeLater, changeGutterView(quickDiff), gutterTheme, quickDiff.extension];
}

function openQuickDiff(view: EditorView, line: number, quickDiff: QuickDiff) {
  const base = view.state.field(changeField).base;
  if (!base || getChunks(view.state)) return;
  quickDiff.open(view, base, line);
}

type ChangeState = { base: Text | null; marks: RangeSet<ChangeMarker> };

const changeField = StateField.define<ChangeState>({
  create: () => ({ base: null, marks: RangeSet.empty }),
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setGutterBase)) {
        const base = effect.value === null ? null : Text.of(effect.value.replace(/\r\n/g, "\n").split("\n"));
        next = { base, marks: base ? markSet(gutterMarks(base, tr.state.doc), tr.state.doc) : RangeSet.empty };
      } else if (effect.is(setMarks)) next = { ...next, marks: effect.value };
    }
    if (tr.docChanged && next === value) next = { ...next, marks: next.marks.map(tr.changes) };
    return next;
  },
});

export function changeMarksOf(state: EditorState): { set: RangeSet<GutterMarker>; kindOf: (marker: GutterMarker) => GutterKind | null } {
  return { set: state.field(changeField, false)?.marks ?? RangeSet.empty, kindOf: (marker) => (marker instanceof ChangeMarker ? marker.kind : null) };
}

const recomputeLater = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(private view: EditorView) {}
    update(update: ViewUpdate) {
      if (!update.docChanged || !update.state.field(changeField).base) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        const base = this.view.state.field(changeField).base;
        if (base) this.view.dispatch({ effects: setMarks.of(markSet(gutterMarks(base, this.view.state.doc), this.view.state.doc)) });
      }, RECOMPUTE_MS);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

const changeGutterView = (quickDiff: QuickDiff) => gutter({
  class: "cm-change-gutter",
  markers: (view) => view.state.field(changeField).marks,
  domEventHandlers: {
    mousedown(view, line, event) {
      let marked = false;
      view.state.field(changeField).marks.between(line.from, line.from, () => ((marked = true), false));
      if (!marked) return false;
      event.preventDefault();
      openQuickDiff(view, view.state.doc.lineAt(line.from).number, quickDiff);
      return true;
    },
  },
  initialSpacer: () => new ChangeMarker("added"),
});

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: GutterKind) {
    super();
  }
  eq(other: ChangeMarker) {
    return other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-change-mark cm-change-${this.kind}`;
    return el;
  }
}

const gutterTheme = EditorView.baseTheme({
  ".cm-change-gutter": { width: "var(--space-1)", marginRight: "var(--space-0_5)" },
  ".cm-change-gutter .cm-gutterElement": { padding: "0", position: "relative" },
  ".cm-change-mark": { position: "absolute", left: "0", right: "0", top: "0", bottom: "0", cursor: "pointer" },
  ".cm-change-added": { background: "var(--success)" },
  ".cm-change-modified": { background: "var(--accent)" },
  ".cm-change-removed": { top: "calc(var(--space-1) * -1)", bottom: "auto", height: "var(--space-2)", background: "var(--danger)", clipPath: "polygon(0 0, 100% 50%, 0 100%)" },
});

export function gutterMarks(base: Text, current: Text): GutterMark[] {
  if (base.lines > GUTTER_MAX_LINES || current.lines > GUTTER_MAX_LINES) return [];
  const marks: GutterMark[] = [];
  for (const chunk of Chunk.build(base, current, QUICK_DIFF_CONFIG)) {
    const kind = chunkKind(chunk, base, current);
    if (kind === "removed") {
      marks.push({ line: current.lineAt(Math.min(chunk.fromB, current.length)).number, kind });
      continue;
    }
    const first = current.lineAt(chunk.fromB).number;
    const count = visibleLineCount(chunk, "b", current);
    for (let line = first; line < first + count; line++) marks.push({ line, kind });
  }
  return marks;
}

function markSet(marks: GutterMark[], doc: Text) {
  const kinds: Record<GutterKind, ChangeMarker> = { added: new ChangeMarker("added"), modified: new ChangeMarker("modified"), removed: new ChangeMarker("removed") };
  const byLine = new Map<number, GutterKind>();
  for (const mark of marks) if (mark.kind !== "removed" || !byLine.has(mark.line)) byLine.set(mark.line, mark.kind);
  return RangeSet.of(
    [...byLine].sort((a, b) => a[0] - b[0]).map(([line, kind]) => kinds[kind].range(doc.line(line).from)),
  );
}

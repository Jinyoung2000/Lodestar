import { LSPPlugin } from "@codemirror/lsp-client";
import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import { announce } from "./announce";
import { highlightAnnouncement, highlightKind, stepHighlight, textualOccurrences, wordRangeAt, type Highlight, type HighlightKind } from "./wordHighlightModel";
import "./editorWordHighlight.css";


const RUN_DELAY_MS = 50;
const TEXTUAL_LIMIT = 2_000_000;

const setHighlights = StateEffect.define<Highlight[]>();

type Field = { ranges: Highlight[]; deco: DecorationSet };
const EMPTY: Field = { ranges: [], deco: Decoration.none };

const CLASS_OF: Record<HighlightKind, string> = { read: "cm-wordHighlight", write: "cm-wordHighlightStrong", text: "cm-wordHighlightText" };

const highlightField = StateField.define<Field>({
  create: () => EMPTY,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHighlights)) {
        const ranges = effect.value.filter((r) => r.to > r.from && r.to <= tr.state.doc.length).sort((a, b) => a.from - b.from);
        return ranges.length ? { ranges, deco: Decoration.set(ranges.map((r) => Decoration.mark({ class: CLASS_OF[r.kind] }).range(r.from, r.to)), true) } : EMPTY;
      }
    }
    return tr.docChanged ? EMPTY : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});

export function wordHighlightRangesOf(state: EditorState): readonly Highlight[] {
  return state.field(highlightField, false)?.ranges ?? [];
}

export function wordHighlightExtension(options: Pick<EditorOptions, "occurrencesHighlight">): Extension {
  if (options.occurrencesHighlight === "off") return [];
  return [
    highlightField,
    ViewPlugin.fromClass(WordHighlighter),
    Prec.high(
      keymap.of([
        { key: "F7", run: (view) => moveHighlight(view, 1), preventDefault: true },
        { key: "Shift-F7", run: (view) => moveHighlight(view, -1), preventDefault: true },
      ]),
    ),
  ];
}

class WordHighlighter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;

  constructor(private view: EditorView) {
    if (view.hasFocus) this.schedule();
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      this.cancel();
      return;
    }
    if (update.focusChanged) {
      if (update.view.hasFocus) this.schedule();
      else this.stop();
      return;
    }
    if (update.selectionSet) this.schedule();
  }

  destroy() {
    this.cancel();
  }

  private cancel() {
    this.token++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.cancel();
    this.timer = setTimeout(() => void this.run(), RUN_DELAY_MS);
  }

  private stop() {
    this.cancel();
    setTimeout(() => this.clear(), 0);
  }

  private clear() {
    if (this.view.dom.isConnected && this.view.state.field(highlightField).ranges.length) this.view.dispatch({ effects: setHighlights.of([]) });
  }

  private async run() {
    this.timer = null;
    const view = this.view;
    const token = ++this.token;
    const selection = view.state.selection.main;
    if (!view.hasFocus || !selection.empty) return this.clear();
    const line = view.state.doc.lineAt(selection.head);
    const word = wordRangeAt(line.text, selection.head - line.from);
    if (!word) return this.clear();
    if (view.state.field(highlightField).ranges.some((r) => r.from <= selection.head && selection.head <= r.to)) return;
    this.clear();
    const doc = view.state.doc;
    const found = await highlightsFor(view, selection.head, line.from + word.from, line.from + word.to);
    if (token !== this.token || view.state.doc !== doc || !view.dom.isConnected) return;
    view.dispatch({ effects: setHighlights.of(found) });
  }
}

async function highlightsFor(view: EditorView, head: number, wordFrom: number, wordTo: number): Promise<Highlight[]> {
  const plugin = LSPPlugin.get(view);
  if (plugin?.client.serverCapabilities?.documentHighlightProvider) {
    try {
      plugin.client.sync();
      const result = await plugin.client.request<object, { range: { start: { line: number; character: number }; end: { line: number; character: number } }; kind?: number }[] | null>("textDocument/documentHighlight", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(head),
      });
      if (result) return result.map((item) => ({ from: plugin.fromPosition(item.range.start), to: plugin.fromPosition(item.range.end), kind: highlightKind(item.kind) }));
    } catch {
    }
  }
  if (view.state.doc.length > TEXTUAL_LIMIT) return [];
  const word = view.state.sliceDoc(wordFrom, wordTo);
  return textualOccurrences(view.state.doc.toString(), word).map((range) => ({ ...range, kind: "text" as const }));
}

export function moveHighlight(view: EditorView, delta: 1 | -1) {
  const field = view.state.field(highlightField, false);
  if (!field || !field.ranges.length) return false;
  const index = stepHighlight(field.ranges, view.state.selection.main.head, delta);
  const target = field.ranges[index]!;
  view.dispatch({ selection: { anchor: target.from }, effects: scrollIfHidden(view, target.from), userEvent: "select.wordHighlight" });
  const line = view.state.doc.lineAt(target.from);
  const word = wordRangeAt(line.text, target.from - line.from);
  if (word) announce(highlightAnnouncement(line.text, index, field.ranges.length, line.text.slice(word.from, word.to)));
  return true;
}

function scrollIfHidden(view: EditorView, pos: number) {
  const box = view.coordsAtPos(pos);
  const area = view.scrollDOM.getBoundingClientRect();
  const visible = !!box && box.top >= area.top && box.bottom <= area.bottom;
  return visible ? [] : [EditorView.scrollIntoView(pos, { y: "center" })];
}

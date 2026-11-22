import { EditorSelection, type ChangeSpec, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";


export type CopyMeta = { text: string; fromEmptySelection: boolean; multicursorText: string[] | null };

let lastCopy: CopyMeta | null = null;

export function clipboardHandlers(options: EditorOptions): Extension {
  const empty = options.emptySelectionClipboard;
  return EditorView.domEventHandlers({
    copy: (event, view) => handleCopy(event, view, empty, false),
    cut: (event, view) => handleCopy(event, view, empty, true),
    paste: (event, view) => {
      const data = event.clipboardData;
      const text = data?.getData("text/plain");
      if (!text || view.state.readOnly) return false;
      view.dispatch(pasteSpec(view.state, text, lastCopy?.text === text ? lastCopy : null, empty));
      return true;
    },
  });
}

function handleCopy(event: ClipboardEvent, view: EditorView, emptyClipboard: boolean, cut: boolean): boolean {
  const data = event.clipboardData;
  if (!data || !view.hasFocus) return false;
  const copied = copyPayload(view.state, emptyClipboard);
  if (!copied) return false;
  data.clearData();
  data.setData("text/plain", copied.text);
  lastCopy = copied;
  if (cut && !view.state.readOnly) {
    const changes = cutChanges(view.state, emptyClipboard);
    if (changes.length) view.dispatch({ changes, scrollIntoView: true, userEvent: "delete.cut" });
  }
  return true;
}

export function copyPayload(state: EditorState, emptyClipboard: boolean): CopyMeta | null {
  const ranges = state.selection.ranges;
  const hasEmpty = ranges.some((r) => r.empty);
  const hasText = ranges.some((r) => !r.empty);
  if (!hasText && !emptyClipboard) return null;
  const eol = state.lineBreak;
  const items: string[] = [];
  if (hasEmpty && emptyClipboard) {
    let lastLine = 0;
    for (const range of ranges) {
      const line = state.doc.lineAt(range.from);
      if (range.empty) {
        if (line.number !== lastLine) items.push(line.text + eol);
      } else items.push(state.sliceDoc(range.from, range.to));
      lastLine = line.number;
    }
  } else for (const range of ranges) if (!range.empty) items.push(state.sliceDoc(range.from, range.to));
  if (!items.length) return null;
  return { text: items.join(eol), fromEmptySelection: emptyClipboard && ranges.length === 1 && ranges[0].empty, multicursorText: items.length > 1 ? items : null };
}

export function cutChanges(state: EditorState, emptyClipboard: boolean): ChangeSpec[] {
  const doc = state.doc;
  const changes: { from: number; to: number }[] = [];
  let lastCutEndLine = -1;
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      changes.push({ from: range.from, to: range.to });
      continue;
    }
    if (!emptyClipboard) continue;
    const line = doc.lineAt(range.head);
    let cut: { from: number; to: number };
    if (line.number < doc.lines) cut = { from: line.from, to: line.to + 1 };
    else if (line.number > 1 && lastCutEndLine !== line.number) cut = { from: doc.line(line.number - 1).to, to: line.to };
    else cut = { from: line.from, to: line.to };
    if (cut.to === cut.from) continue;
    const previous = changes[changes.length - 1];
    if (previous && previous.from === cut.from && previous.to === cut.to) continue;
    changes.push(cut);
    lastCutEndLine = doc.lineAt(cut.to).number;
  }
  return changes;
}

export function pasteSpec(state: EditorState, text: string, meta: CopyMeta | null, emptyClipboard: boolean): TransactionSpec {
  const ranges = state.selection.ranges;
  const mainIndex = state.selection.mainIndex;
  let onNewLine = emptyClipboard && !!meta?.fromEmptySelection;
  const pieces = distribution(ranges.length, text, meta, onNewLine);
  if (pieces) {
    const set = state.changeByRange((range) => {
      const piece = pieces[ranges.indexOf(range)];
      const insert = state.toText(piece);
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
    });
    return { ...set, scrollIntoView: true, userEvent: "input.paste" };
  }
  if (ranges.some((r) => !r.empty) || text.indexOf("\n") !== text.length - 1) onNewLine = false;
  const insert = state.toText(text);
  let lastLine = -1;
  const set = state.changeByRange((range) => {
    if (onNewLine) {
      const line = state.doc.lineAt(range.head);
      if (line.from === lastLine) return { range };
      lastLine = line.from;
      return { changes: { from: line.from, insert }, range: EditorSelection.cursor(range.head + insert.length) };
    }
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
  });
  void mainIndex;
  return { ...set, scrollIntoView: true, userEvent: "input.paste" };
}

function distribution(count: number, text: string, meta: CopyMeta | null, onNewLine: boolean): string[] | null {
  if (count === 1) return null;
  if (meta?.multicursorText && meta.multicursorText.length === count) return meta.multicursorText;
  if (onNewLine) return null;
  let body = text;
  if (body.endsWith("\n")) body = body.slice(0, -1);
  if (body.endsWith("\r")) body = body.slice(0, -1);
  const lines = body.split(/\r\n|\r|\n/);
  return lines.length === count ? lines : null;
}

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export function formatOnPasteExtension(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged || update.state.readOnly || update.state.selection.ranges.length > 1) return;
    const pasted = pastedRange(update);
    if (!pasted) return;
    const { view } = update;
    queueMicrotask(() => void import("./editorDocs").then((docs) => docs.formatPastedRange(view, pasted)));
  });
}

function pastedRange(update: { transactions: readonly { isUserEvent(event: string): boolean; changes: { iterChangedRanges(f: (fromA: number, toA: number, fromB: number, toB: number) => void): void } }[] }) {
  let range: { from: number; to: number } | null = null;
  for (const tr of update.transactions) {
    if (!tr.isUserEvent("input.paste")) continue;
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      if (toB <= fromB) return;
      range = range ? { from: Math.min(range.from, fromB), to: Math.max(range.to, toB) } : { from: fromB, to: toB };
    });
  }
  return range as { from: number; to: number } | null;
}

import { forEachDiagnostic } from "@codemirror/lint";
import type { EditorState, Text } from "@codemirror/state";
import { wordHighlightRangesOf } from "./editorWordHighlight";
import { selectionMatches, type DiagnosticSeverity } from "./editorRulerModel";
import { buildQuery, collectMatches } from "./findModel";
import { findStateOf } from "./findWidget";

export type MarkRange = { from: number; to: number };
export type DiagnosticRange = MarkRange & { severity: Exclude<DiagnosticSeverity, "hint"> };

const NONE: MarkRange[] = [];

type Entry<T> = { key: string; value: T };
const findCache = new WeakMap<Text, Entry<MarkRange[]>>();
const selectionCache = new WeakMap<Text, Entry<MarkRange[]>>();

export function findMatchRanges(state: EditorState): MarkRange[] {
  const find = findStateOf(state);
  if (!find) return NONE;
  const key = `${find.search}\u0000${find.options.caseSensitive}${find.options.wholeWord}${find.options.regexp}\u0000${find.scope ? `${find.scope.from}-${find.scope.to}` : ""}`;
  const cached = findCache.get(state.doc);
  if (cached?.key === key) return cached.value;
  const value = collectMatches(buildQuery(find.search, find.options), state, find.scope).list.map(({ from, to }) => ({ from, to }));
  findCache.set(state.doc, { key, value });
  return value;
}

export function selectionMatchRanges(state: EditorState): MarkRange[] {
  const range = state.selection.main;
  const key = `${state.selection.ranges.length}:${range.from}-${range.to}`;
  const cached = selectionCache.get(state.doc);
  if (cached?.key === key) return cached.value;
  const value = selectionMatches(state);
  selectionCache.set(state.doc, { key, value });
  return value;
}

export function diagnosticRanges(state: EditorState): DiagnosticRange[] {
  const ranges: DiagnosticRange[] = [];
  forEachDiagnostic(state, (diagnostic, from, to) => {
    if (diagnostic.severity !== "hint") ranges.push({ from, to: Math.max(from, to), severity: diagnostic.severity });
  });
  return ranges;
}

export function wordHighlightMarks(state: EditorState): { from: number; to: number; kind: "read" | "write" | "text" }[] {
  return wordHighlightRangesOf(state).map(({ from, to, kind }) => ({ from, to, kind }));
}

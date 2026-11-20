// 개요 눈금자(editorRuler.ts)와 미니맵(editorMinimap.ts)이 같이 읽는 표시 원본: 찾기 일치, 선택 일치, 진단.
// 둘이 같은 문서에서 같은 값을 따로 세지 않도록 문서(Text) 단위로 마지막 결과를 들고 있는다.
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

// 찾기 위젯이 열려 있고 검색어가 있을 때 그 일치(findModel.MATCH_LIMIT 까지)
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

// highlightSelectionMatches() 와 같은 조건의 선택 일치(선택 자신은 뺀다)
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

// 같은 단어 강조(F7 로 오가는 그것). kind 는 읽기, 쓰기, 텍스트 일치.
export function wordHighlightMarks(state: EditorState): { from: number; to: number; kind: "read" | "write" | "text" }[] {
  return wordHighlightRangesOf(state).map(({ from, to, kind }) => ({ from, to, kind }));
}

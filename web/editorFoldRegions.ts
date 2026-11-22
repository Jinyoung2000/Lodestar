import { foldEffect, foldedRanges, foldNodeProp, language, syntaxTree, unfoldEffect } from "@codemirror/language";
import { EditorSelection, Facet, type EditorState, type Text, type TransactionSpec } from "@codemirror/state";
import {
  buildRegionTree,
  computeIndentRegions,
  planByStartLine,
  planExcept,
  planFoldAtLines,
  planIconClick,
  planLevel,
  planSetState,
  planToggle,
  type ClickModifier,
  type FoldRegion,
  type PlanInput,
  type RegionMarkers,
} from "./editorFoldModel";
import { indentColumns } from "./editorGuidesModel";


export type FoldSetup = { strategy: "auto" | "indentation"; markers: RegionMarkers | null; offSide: boolean };

export const foldSetup = Facet.define<FoldSetup, FoldSetup | null>({ combine: (values) => values[0] ?? null });

export function regionAtLine(state: EditorState, lineNumber: number): FoldRegion | null {
  const setup = state.facet(foldSetup);
  if (!setup) return null;
  const line = state.doc.line(lineNumber);
  if (setup.markers?.start.test(line.text)) {
    const marked = markerRegion(state.doc, lineNumber, setup.markers);
    if (marked) return marked;
  }
  if (setup.strategy === "auto" && hasSyntaxFolding(state)) return syntaxRegion(state, line.number, line.from, line.to);
  const end = indentRegions(state.doc, state.tabSize, setup.offSide).get(lineNumber);
  return end === undefined ? null : { start: lineNumber, end };
}

function markerRegion(doc: Text, lineNumber: number, markers: RegionMarkers): FoldRegion | null {
  let depth = 1;
  for (let n = lineNumber + 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (markers.start.test(text)) depth++;
    else if (markers.end.test(text) && --depth === 0) return { start: lineNumber, end: n };
  }
  return null;
}

const syntaxCapable = new WeakMap<object, boolean>();
function hasSyntaxFolding(state: EditorState): boolean {
  const lang = state.facet(language);
  if (!lang) return false;
  let capable = syntaxCapable.get(lang);
  if (capable === undefined) {
    const types = (lang.parser as { nodeSet?: { types: readonly { prop: (prop: typeof foldNodeProp) => unknown }[] } }).nodeSet?.types ?? [];
    capable = types.some((type) => type.prop(foldNodeProp) !== undefined);
    syntaxCapable.set(lang, capable);
  }
  return capable;
}

function syntaxRegion(state: EditorState, lineNumber: number, lineStart: number, lineEnd: number): FoldRegion | null {
  const tree = syntaxTree(state);
  if (tree.length < lineEnd) return null;
  let found: { from: number; to: number } | null = null;
  let iter: ReturnType<typeof tree.resolveStack> | null = tree.resolveStack(lineEnd, 1);
  for (; iter; iter = iter.next) {
    const node = iter.node;
    if (node.to <= lineEnd || node.from > lineEnd) continue;
    if (found && node.from < lineStart) break;
    const prop = node.type.prop(foldNodeProp);
    if (prop && (node.to < tree.length - 50 || tree.length === state.doc.length || !isUnfinished(node))) {
      const value = prop(node, state);
      if (value && value.from <= lineEnd && value.from >= lineStart && value.to > lineEnd) found = value;
    }
  }
  if (!found) return null;
  const { doc } = state;
  const endLine = doc.lineAt(found.to);
  const before = doc.sliceString(endLine.from, found.to);
  const after = doc.sliceString(found.to, Math.min(found.to + 3, doc.length));
  let end = endLine.number;
  if (!(after.startsWith("*/") || after.startsWith("-->")) && (/^\s*$/.test(before) || /^[}\])`]/.test(after))) end--;
  return end > lineNumber ? { start: lineNumber, end } : null;
}

function isUnfinished(node: { lastChild: { to: number; type: { isError: boolean } } | null; to: number }) {
  const child = node.lastChild;
  return child !== null && child.to === node.to && child.type.isError;
}

const indentCache = new WeakMap<Text, Map<string, Map<number, number>>>();
const INDENT_FOLD_MAX_LINES = 200_000;

function indentRegions(doc: Text, tabSize: number, offSide: boolean): Map<number, number> {
  const key = `${tabSize}:${offSide}`;
  let byKey = indentCache.get(doc);
  if (!byKey) indentCache.set(doc, (byKey = new Map()));
  let found = byKey.get(key);
  if (found) return found;
  found = new Map();
  byKey.set(key, found);
  if (doc.lines > INDENT_FOLD_MAX_LINES) return found;
  const indents = new Int32Array(doc.lines);
  let index = 0;
  for (const text of doc.iterLines()) indents[index++] = indentColumns(text, tabSize);
  for (const region of computeIndentRegions({ lineCount: doc.lines, indentOf: (i) => indents[i]!, offSide })) found.set(region.start, region.end);
  return found;
}

export function rangeOf(doc: Text, region: FoldRegion): { from: number; to: number } {
  return { from: doc.line(region.start).to, to: doc.line(region.end).to };
}

function allRegions(state: EditorState): FoldRegion[] {
  const regions: FoldRegion[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const region = regionAtLine(state, n);
    if (region) regions.push(region);
  }
  return regions;
}

export function foldedAt(state: EditorState, line: { to: number }): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(line.to, line.to, (from, to) => {
    if (from === line.to && !found) found = { from, to };
  });
  return found;
}

export type FoldModel = PlanInput & { regions: readonly FoldRegion[] };

export function foldModelOf(state: EditorState): FoldModel {
  const tree = buildRegionTree(allRegions(state));
  const starts = new Set<number>();
  foldedRanges(state).between(0, state.doc.length, (from) => {
    starts.add(from);
  });
  return { tree, regions: tree.regions, collapsed: (index) => starts.has(state.doc.line(tree.regions[index]!.start).to) };
}

export function toggleSpec(state: EditorState, regions: readonly FoldRegion[]): TransactionSpec | null {
  const effects = [];
  const folded: { from: number; to: number }[] = [];
  for (const region of regions) {
    const current = foldedAt(state, state.doc.line(region.start));
    if (current) {
      effects.push(unfoldEffect.of(current));
    } else {
      const range = rangeOf(state.doc, region);
      if (range.from < range.to) {
        effects.push(foldEffect.of(range));
        folded.push(range);
      }
    }
  }
  if (effects.length === 0) return null;
  const move = (pos: number) => {
    let next = pos;
    for (const range of folded) if (next > range.from && next <= range.to) next = range.from;
    return next;
  };
  const moved = state.selection.ranges.some((r) => move(r.anchor) !== r.anchor || move(r.head) !== r.head);
  const selection = moved ? EditorSelection.create(state.selection.ranges.map((r) => EditorSelection.range(move(r.anchor), move(r.head))), state.selection.mainIndex) : undefined;
  return { effects, selection, scrollIntoView: true };
}

export function iconClickSpec(state: EditorState, lineNumber: number, modifier: ClickModifier): TransactionSpec | null {
  const region = regionAtLine(state, lineNumber);
  if (!region) return null;
  if (modifier === "plain") return toggleSpec(state, [region]);
  const model = foldModelOf(state);
  const index = model.regions.findIndex((candidate) => candidate.start === region.start);
  return index < 0 ? null : toggleSpec(state, planIconClick(model, index, modifier).map((i) => model.regions[i]!));
}

type Planner = (model: FoldModel, state: EditorState) => number[];

export type FoldCommandDef = { id: string; title: string; plan: Planner };

function selectedLines(state: EditorState): number[] {
  return state.selection.ranges.map((range) => state.doc.lineAt(range.from).number);
}

const MAX = Number.MAX_VALUE;

function blockCommentMatcher(state: EditorState): (startLine: number) => boolean {
  return (startLine) => {
    const line = state.doc.line(startLine);
    const open = state.languageDataAt<{ block?: { open: string } }>("commentTokens", line.from).find((tokens) => tokens.block)?.block?.open;
    return open !== undefined && new RegExp(`^\\s*${open.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`).test(line.text);
  };
}

function markerMatcher(state: EditorState): (startLine: number) => boolean {
  const markers = state.facet(foldSetup)?.markers;
  return (startLine) => !!markers && markers.start.test(state.doc.line(startLine).text);
}

export const FOLD_COMMANDS: readonly FoldCommandDef[] = [
  { id: "fold", title: "Fold", plan: (m, s) => planFoldAtLines(m, true, selectedLines(s)) },
  { id: "unfold", title: "Unfold", plan: (m, s) => planSetState(m, false, 1, selectedLines(s)) },
  { id: "foldRecursively", title: "Fold Recursively", plan: (m, s) => planSetState(m, true, MAX, selectedLines(s)) },
  { id: "unfoldRecursively", title: "Unfold Recursively", plan: (m, s) => planSetState(m, false, MAX, selectedLines(s)) },
  { id: "toggleFold", title: "Toggle Fold", plan: (m, s) => planToggle(m, 1, selectedLines(s)) },
  { id: "toggleFoldRecursively", title: "Toggle Fold Recursively", plan: (m, s) => planToggle(m, MAX, selectedLines(s)) },
  { id: "foldAll", title: "Fold All", plan: (m) => planSetState(m, true, MAX) },
  { id: "unfoldAll", title: "Unfold All", plan: (m) => planSetState(m, false, MAX) },
  ...[1, 2, 3, 4, 5, 6, 7].map((level) => ({ id: `foldLevel${level}`, title: `Fold Level ${level}`, plan: ((m, s) => planLevel(m, level, true, selectedLines(s))) as Planner })),
  { id: "foldAllBlockComments", title: "Fold All Block Comments", plan: (m, s) => planByStartLine(m, true, blockCommentMatcher(s)) },
  { id: "foldAllMarkerRegions", title: "Fold All Regions", plan: (m, s) => planByStartLine(m, true, markerMatcher(s)) },
  { id: "unfoldAllMarkerRegions", title: "Unfold All Regions", plan: (m, s) => planByStartLine(m, false, markerMatcher(s)) },
  { id: "foldAllExcept", title: "Fold All Except Selected", plan: (m, s) => planExcept(m, true, selectedLines(s)) },
  { id: "unfoldAllExcept", title: "Unfold All Except Selected", plan: (m, s) => planExcept(m, false, selectedLines(s)) },
];

export function foldCommandSpec(state: EditorState, command: FoldCommandDef): TransactionSpec | null {
  if (!state.facet(foldSetup)) return null;
  const model = foldModelOf(state);
  return toggleSpec(state, command.plan(model, state).map((index) => model.regions[index]!));
}

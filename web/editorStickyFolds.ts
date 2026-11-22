import { ensureSyntaxTree, foldNodeProp, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SymbolNode } from "./documentSymbols";
import { indentRanges, nestRanges, symbolsToSticky, type StickyNode, type StickySymbol } from "./editorStickyModel";

export const STICKY_SCAN_MAX_CHARS = 2_000_000;
const PARSE_BUDGET_MS = 50;

export function foldSymbols(state: EditorState): SymbolNode[] {
  const doc = state.doc;
  if (doc.length > STICKY_SCAN_MAX_CHARS) return [];
  const tree = ensureSyntaxTree(state, doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  const ranges: { start: number; end: number }[] = [];
  tree.iterate({
    enter: (node) => {
      const fold = node.type.prop(foldNodeProp);
      if (!fold) return;
      const range = fold(node.node, state);
      if (!range) return;
      const start = doc.lineAt(range.from).number;
      const end = doc.lineAt(range.to).number;
      if (end > start) ranges.push({ start, end });
    },
  });
  if (ranges.length === 0) return indentSymbols(state);
  return rangesToSymbols(nestRanges(dedupe(ranges)), state);
}

export function indentSymbols(state: EditorState): SymbolNode[] {
  const doc = state.doc;
  if (doc.length > STICKY_SCAN_MAX_CHARS) return [];
  const lines: string[] = [];
  for (let n = 1; n <= doc.lines; n++) lines.push(doc.line(n).text);
  return rangesToSymbols(nestRanges(indentRanges(lines, state.tabSize)), state);
}

function dedupe(ranges: { start: number; end: number }[]) {
  const widest = new Map<number, { start: number; end: number }>();
  for (const range of ranges) {
    const known = widest.get(range.start);
    if (!known || range.end > known.end) widest.set(range.start, range);
  }
  return [...widest.values()];
}

function rangesToSymbols(nodes: readonly StickyNode[], state: EditorState): SymbolNode[] {
  const doc = state.doc;
  return nodes.map((node) => {
    const from = doc.line(node.start).from;
    return { name: "", detail: "", kind: 0, from, to: doc.line(Math.min(node.end, doc.lines)).to, nameFrom: from, nameTo: from, children: rangesToSymbols(node.children, state) };
  });
}

export function stickyFromSymbols(tree: readonly SymbolNode[], lineOf: (pos: number) => number): StickyNode[] {
  const convert = (node: SymbolNode): StickySymbol => ({ rangeStartLine: lineOf(node.from), selStartLine: lineOf(node.nameFrom), rangeEndLine: lineOf(node.to), children: node.children.map(convert) });
  return symbolsToSticky(tree.map(convert));
}

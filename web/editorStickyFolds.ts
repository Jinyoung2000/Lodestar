import { ensureSyntaxTree, foldNodeProp, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SymbolNode } from "./documentSymbols";
import { indentRanges, nestRanges, symbolsToSticky, type StickyNode, type StickySymbol } from "./editorStickyModel";

// 구문 트리를 훑는 데 허용하는 문서 길이(이보다 길면 들여쓰기도 건너뛰고 고정 스크롤을 비운다)
export const STICKY_SCAN_MAX_CHARS = 2_000_000;
const PARSE_BUDGET_MS = 50;

// 구문 트리의 foldNodeProp 가 접을 수 있다고 한 블록(여러 줄)을 포함 관계로 묶는다. 접기 시작 줄이 선언 줄이다.
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

// 구문 트리가 없는 언어(일반 텍스트 등)는 들여쓰기로 블록을 찾는다
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

// 심볼 트리(LSP 이든 위에서 만든 것이든)를 고정 후보 트리로. 위치를 줄 번호로 바꾼다.
export function stickyFromSymbols(tree: readonly SymbolNode[], lineOf: (pos: number) => number): StickyNode[] {
  const convert = (node: SymbolNode): StickySymbol => ({ rangeStartLine: lineOf(node.from), selStartLine: lineOf(node.nameFrom), rangeEndLine: lineOf(node.to), children: node.children.map(convert) });
  return symbolsToSticky(tree.map(convert));
}

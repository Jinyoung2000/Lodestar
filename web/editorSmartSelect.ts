import { syntaxTree } from "@codemirror/language";
import { EditorSelection, StateEffect, StateField, type EditorState, type Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { Target } from "./editorLineOps";
import { enclosingBrackets } from "./editorSelectOps";


type Span = { from: number; to: number };

const SELECT_LEADING_AND_TRAILING_WHITESPACE = true;

type Stack = { lists: Span[][]; index: number[] };

const setStack = StateEffect.define<Stack | null>();

export const smartSelectStack = StateField.define<Stack | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setStack)) return effect.value;
    return value && (tr.selection || tr.docChanged) ? null : value;
  },
});

export const expandSelection = (target: Target) => step(target, true);
export const shrinkSelection = (target: Target) => step(target, false);

function step({ state, dispatch }: Target, forward: boolean): boolean {
  let stack = state.field(smartSelectStack, false) ?? null;
  if (!stack) {
    const lists = state.selection.ranges.map((range) => {
      const candidates = smartSelectCandidates(state, range.head).filter((c) => c.from <= range.from && range.to <= c.to);
      return [{ from: range.from, to: range.to }, ...candidates];
    });
    stack = { lists, index: lists.map(() => 0) };
  }
  const index = stack.lists.map((list, i) => move(list, stack!.index[i], forward));
  const ranges = stack.lists.map((list, i) => EditorSelection.range(list[index[i]].from, list[index[i]].to));
  dispatch(state.update({ selection: EditorSelection.create(ranges, state.selection.mainIndex), effects: setStack.of({ lists: stack.lists, index }), scrollIntoView: true, userEvent: "select" }));
  return true;
}

function move(list: Span[], index: number, forward: boolean): number {
  const next = index + (forward ? 1 : -1);
  if (next < 0 || next >= list.length) return index;
  return list[next].from === list[index].from && list[next].to === list[index].to ? move(list, next, forward) : next;
}

const contains = (outer: Span, inner: Span) => outer.from <= inner.from && inner.to <= outer.to;
const same = (a: Span, b: Span) => a.from === b.from && a.to === b.to;

export function smartSelectCandidates(state: EditorState, pos: number): Span[] {
  const doc = state.doc;
  const found: Span[] = [];
  addSubword(state, pos, found);
  const word = state.wordAt(pos);
  if (word && word.to > word.from) found.push({ from: word.from, to: word.to });
  const line = doc.lineAt(pos);
  if (line.length > 0 && !/\S/.test(line.text)) found.push({ from: line.from, to: line.to });
  found.push({ from: 0, to: doc.length });
  addBrackets(state, pos, found);
  addSyntax(state, pos, found);

  const inside = found.filter((s) => s.from <= pos && pos <= s.to && s.to > s.from);
  inside.sort((a, b) => (a.from < b.from ? 1 : b.from < a.from || a.to < b.to ? -1 : b.to < a.to ? 1 : 0));
  const chain: Span[] = [];
  let last: Span | undefined;
  for (const s of inside) {
    if (!last || (contains(s, last) && !same(s, last))) {
      chain.push(s);
      last = s;
    }
  }
  return SELECT_LEADING_AND_TRAILING_WHITESPACE ? withWhitespaceSteps(doc, chain) : chain;
}

function withWhitespaceSteps(doc: Text, chain: Span[]): Span[] {
  if (!chain.length) return chain;
  const out: Span[] = [chain[0]];
  for (let i = 1; i < chain.length; i++) {
    const g = chain[i - 1];
    const f = chain[i];
    const gStart = doc.lineAt(g.from);
    const gEnd = doc.lineAt(g.to);
    const fStart = doc.lineAt(f.from);
    const fEnd = doc.lineAt(f.to);
    if (fStart.number !== gStart.number || fEnd.number !== gEnd.number) {
      const first = gStart.text.search(/\S/);
      const lastNonSpace = gEnd.text.search(/\s*$/) - 1;
      const v: Span | null = first >= 0 && lastNonSpace >= 0 ? { from: gStart.from + first, to: gEnd.from + lastNonSpace + 1 } : null;
      if (v && contains(v, g) && !same(v, g) && contains(f, v) && !same(f, v)) out.push(v);
      const b: Span = { from: gStart.from, to: gEnd.to };
      if (contains(b, g) && !(v && same(b, v)) && contains(f, b) && !same(f, b)) out.push(b);
    }
    out.push(f);
  }
  return out;
}

const isLower = (code: number) => code >= 97 && code <= 122;
const isUpper = (code: number) => code >= 65 && code <= 90;

function addSubword(state: EditorState, pos: number, out: Span[]) {
  const word = state.wordAt(pos);
  if (!word) return;
  const text = state.sliceDoc(word.from, word.to);
  const at = pos - word.from;
  let start = at;
  let end = at;
  let prev = 0;
  for (; start >= 0; start--) {
    const code = text.charCodeAt(start);
    if (start !== at && (code === 95 || code === 45)) break;
    if (isLower(code) && isUpper(prev)) break;
    prev = code;
  }
  for (start += 1; end < text.length; end++) {
    const code = text.charCodeAt(end);
    if (isUpper(code) && isLower(prev)) break;
    if (code === 95 || code === 45) break;
    prev = code;
  }
  if (start < end) out.push({ from: word.from + start, to: word.from + end });
}

function addBrackets(state: EditorState, pos: number, out: Span[]) {
  let at = pos;
  for (let level = 0; level < 20; level++) {
    const pair = enclosingBrackets(state, at);
    if (!pair) break;
    const inner = { from: pair.open.to, to: pair.close.from };
    const outer = { from: pair.open.from, to: pair.close.to };
    out.push(inner, outer);
    addBracketLeading(state, outer, out);
    at = pair.open.from;
  }
}

function addBracketLeading(state: EditorState, outer: Span, out: Span[]) {
  const doc = state.doc;
  const startLine = doc.lineAt(outer.from);
  if (startLine.number === doc.lineAt(outer.to).number) return;
  const first = startLine.text.search(/\S/);
  if (first >= 0 && startLine.from + first !== outer.from) {
    out.push({ from: startLine.from + first, to: outer.to }, { from: startLine.from, to: outer.to });
  }
  if (startLine.number > 1) {
    const above = doc.line(startLine.number - 1);
    const aboveFirst = above.text.search(/\S/);
    const aboveLast = above.text.search(/\s*$/) - 1;
    if (aboveFirst >= 0 && aboveFirst === outer.from - startLine.from && aboveFirst !== aboveLast) {
      out.push({ from: above.from + aboveFirst, to: outer.to }, { from: above.from, to: outer.to });
    }
  }
}

const BRACKET_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

function addSyntax(state: EditorState, pos: number, out: Span[]) {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.to > node.from) out.push({ from: node.from, to: node.to });
      const first = node.firstChild;
      const last = node.lastChild;
      if (first && last && first !== last && BRACKET_PAIRS[state.sliceDoc(first.from, first.to)] === state.sliceDoc(last.from, last.to)) out.push({ from: first.to, to: last.from });
    }
  }
}

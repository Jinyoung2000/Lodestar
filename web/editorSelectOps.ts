import { matchBrackets, syntaxTree } from "@codemirror/language";
import { SearchQuery } from "@codemirror/search";
import { EditorSelection, StateEffect, StateField, countColumn, findColumn, type ChangeSpec, type EditorState, type SelectionRange } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { Target } from "./editorLineOps";
import { deleteWordPartLeftRange, deleteWordPartRightRange, wordPartLeft, wordPartRight } from "./editorWordPart";


export function addCursorsToLineEnds({ state, dispatch }: Target): boolean {
  const doc = state.doc;
  const cursors: SelectionRange[] = [];
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const startLine = doc.lineAt(range.from).number;
    const endLine = doc.lineAt(range.to);
    for (let n = startLine; n < endLine.number; n++) cursors.push(EditorSelection.cursor(doc.line(n).to));
    if (range.to > endLine.from) cursors.push(EditorSelection.cursor(range.to));
  }
  if (!cursors.length) return false;
  dispatch(state.update({ selection: EditorSelection.create(cursors, cursors.length - 1), scrollIntoView: true, userEvent: "select" }));
  return true;
}

type Session = { text: string; wholeWord: boolean; matchCase: boolean; current: { from: number; to: number } | null };

const setSession = StateEffect.define<Session | null>();

export const findSession = StateField.define<Session | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setSession)) return effect.value;
    return value && (tr.selection || tr.docChanged) ? null : value;
  },
});

function sessionOf(state: EditorState): Session | null {
  const existing = state.field(findSession, false);
  if (existing) return existing;
  const main = state.selection.main;
  const single = state.selection.ranges.length === 1 && main.empty;
  if (main.empty) {
    const word = state.wordAt(main.head);
    if (!word || word.from === word.to) return null;
    return { text: state.sliceDoc(word.from, word.to), wholeWord: single, matchCase: single, current: { from: word.from, to: word.to } };
  }
  return { text: state.sliceDoc(main.from, main.to).replace(/\r\n/g, "\n"), wholeWord: false, matchCase: false, current: null };
}

function queryOf(session: Session): SearchQuery {
  return new SearchQuery({ search: session.text, caseSensitive: session.matchCase, wholeWord: session.wholeWord, literal: true });
}

const MULTI_CURSOR_LIMIT = 10000;

function allMatches(state: EditorState, session: Session): { from: number; to: number }[] {
  const list: { from: number; to: number }[] = [];
  const cursor = queryOf(session).getCursor(state) as Iterator<{ from: number; to: number }>;
  for (let step = cursor.next(); !step.done && list.length < MULTI_CURSOR_LIMIT; step = cursor.next()) if (step.value.to > step.value.from) list.push({ from: step.value.from, to: step.value.to });
  return list;
}

function nextMatch(state: EditorState, session: Session, pos: number): { from: number; to: number } | null {
  const query = queryOf(session);
  for (const [from, to] of [[pos, state.doc.length] as const, [0, Math.min(state.doc.length, pos + session.text.length)] as const]) {
    const cursor = query.getCursor(state, from, to) as Iterator<{ from: number; to: number }>;
    for (let step = cursor.next(); !step.done; step = cursor.next()) if (step.value.to > step.value.from) return { from: step.value.from, to: step.value.to };
  }
  return null;
}

function previousMatch(state: EditorState, session: Session, pos: number): { from: number; to: number } | null {
  const all = allMatches(state, session);
  let found: { from: number; to: number } | null = null;
  for (const match of all) if (match.to <= pos) found = match;
  return found ?? all[all.length - 1] ?? null;
}

export function selectAllOccurrences({ state, dispatch }: Target): boolean {
  const session = sessionOf(state);
  if (!session) return false;
  const matches = allMatches(state, session);
  if (!matches.length) return false;
  const head = state.selection.main.head;
  let mainIndex = matches.findIndex((m) => m.from <= head && head <= m.to);
  if (mainIndex < 0) mainIndex = 0;
  dispatch(state.update({ selection: EditorSelection.create(matches.map((m) => EditorSelection.range(m.from, m.to)), mainIndex), scrollIntoView: true, userEvent: "select", effects: setSession.of(null) }));
  return true;
}

type Direction = "next" | "previous";

function findMatchSelection(direction: Direction, keepLast: boolean) {
  return ({ state, dispatch }: Target): boolean => {
    const session = sessionOf(state);
    if (!session) return false;
    const main = state.selection.main;
    const match = session.current ?? (direction === "next" ? nextMatch(state, session, main.to) : previousMatch(state, session, main.from));
    if (!match) return false;
    const others = state.selection.ranges.filter((_, index) => index !== state.selection.mainIndex);
    const ranges = keepLast ? [...others, state.selection.main, EditorSelection.range(match.from, match.to)] : [...others, EditorSelection.range(match.from, match.to)];
    dispatch(state.update({ selection: EditorSelection.create(ranges, ranges.length - 1), scrollIntoView: true, userEvent: "select", effects: setSession.of({ ...session, current: null }) }));
    return true;
  };
}

export const moveSelectionToNextFindMatch = findMatchSelection("next", false);
export const moveSelectionToPreviousFindMatch = findMatchSelection("previous", false);
export const addSelectionToPreviousFindMatch = findMatchSelection("previous", true);

export function removeBrackets({ state, dispatch }: Target): boolean {
  if (state.readOnly) return false;
  const seen = new Set<number>();
  const changes: ChangeSpec[] = [];
  for (const range of state.selection.ranges) {
    const pair = bracketPairAt(state, range.head);
    if (!pair || seen.has(pair.open.from)) continue;
    seen.add(pair.open.from);
    changes.push({ from: pair.open.from, to: pair.open.to }, { from: pair.close.from, to: pair.close.to });
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: "delete.brackets", scrollIntoView: true }));
  return true;
}

type Token = { from: number; to: number };

export function bracketPairAt(state: EditorState, pos: number): { open: Token; close: Token } | null {
  for (const dir of [-1, 1] as const) {
    const match = matchBrackets(state, pos, dir);
    if (match?.matched && match.end) return match.start.from < match.end.from ? { open: match.start, close: match.end } : { open: match.end, close: match.start };
  }
  return enclosingBrackets(state, pos);
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSER_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

export function enclosingBrackets(state: EditorState, pos: number): { open: Token; close: Token } | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    const first = node.firstChild;
    const last = node.lastChild;
    if (!first || !last || first === last || first.from >= pos || last.to <= pos) continue;
    const open = state.sliceDoc(first.from, first.to);
    if (OPENERS.has(open) && state.sliceDoc(last.from, last.to) === CLOSER_OF[open]) return { open: { from: first.from, to: first.to }, close: { from: last.from, to: last.to } };
  }
  return scanBrackets(state, pos);
}

const SCAN_LIMIT = 200_000;

function scanBrackets(state: EditorState, pos: number): { open: Token; close: Token } | null {
  const doc = state.doc;
  const stack: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  for (let i = pos - 1; i >= Math.max(0, pos - SCAN_LIMIT); i--) {
    const ch = doc.sliceString(i, i + 1);
    if (ch in stack) stack[ch]++;
    else if (OPENERS.has(ch)) {
      const closer = CLOSER_OF[ch];
      if (stack[closer] > 0) stack[closer]--;
      else {
        const close = findCloser(state, pos, ch);
        return close === null ? null : { open: { from: i, to: i + 1 }, close: { from: close, to: close + 1 } };
      }
    }
  }
  return null;
}

function findCloser(state: EditorState, pos: number, opener: string): number | null {
  const doc = state.doc;
  const closer = CLOSER_OF[opener];
  let depth = 0;
  for (let i = pos; i < Math.min(doc.length, pos + SCAN_LIMIT); i++) {
    const ch = doc.sliceString(i, i + 1);
    if (ch === opener) depth++;
    else if (ch === closer) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

const setAnchor = StateEffect.define<number | null>();

export const selectionAnchor = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    let next = value !== null && tr.docChanged ? tr.changes.mapPos(value, -1) : value;
    for (const effect of tr.effects) if (effect.is(setAnchor)) next = effect.value;
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (pos): DecorationSet => (pos === null ? Decoration.none : Decoration.set([Decoration.widget({ widget: new AnchorWidget(), side: -1 }).range(pos)]))),
});

class AnchorWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-selection-anchor";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

export function setSelectionAnchor({ state, dispatch }: Target): boolean {
  dispatch(state.update({ effects: setAnchor.of(state.selection.main.head) }));
  return true;
}

export function selectionAnchorPosition(state: EditorState): number | null {
  return state.field(selectionAnchor, false) ?? null;
}

export function selectFromAnchorToCursor({ state, dispatch }: Target): boolean {
  const anchor = selectionAnchorPosition(state);
  if (anchor === null) return false;
  dispatch(state.update({ selection: EditorSelection.single(anchor, state.selection.main.head), effects: setAnchor.of(null), scrollIntoView: true, userEvent: "select" }));
  return true;
}

export function cancelSelectionAnchor({ state, dispatch }: Target): boolean {
  if (selectionAnchorPosition(state) === null) return false;
  dispatch(state.update({ effects: setAnchor.of(null) }));
  return true;
}

type ColumnData = { fromLine: number; fromColumn: number; toLine: number; toColumn: number };

const setColumn = StateEffect.define<ColumnData>();

export const columnSelection = StateField.define<ColumnData | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setColumn)) return effect.value;
    return value && (tr.selection || tr.docChanged) ? null : value;
  },
});

export type ColumnMove = "left" | "right" | "up" | "down" | "pageUp" | "pageDown";

export function columnSelect(move: ColumnMove, pageSize = 20) {
  return ({ state, dispatch }: Target): boolean => {
    const doc = state.doc;
    const tab = state.tabSize;
    const visual = (offset: number) => {
      const line = doc.lineAt(offset);
      return countColumn(line.text, tab, offset - line.from);
    };
    const main = state.selection.main;
    const data: ColumnData = state.field(columnSelection, false) ?? { fromLine: doc.lineAt(main.anchor).number, fromColumn: visual(main.anchor), toLine: doc.lineAt(main.head).number, toColumn: visual(main.head) };
    let { toLine, toColumn } = data;
    if (move === "left") toColumn = Math.max(0, toColumn - 1);
    else if (move === "right") {
      let widest = 0;
      for (let n = Math.min(data.fromLine, toLine); n <= Math.max(data.fromLine, toLine); n++) widest = Math.max(widest, countColumn(doc.line(n).text, tab));
      if (toColumn < widest) toColumn += 1;
    } else if (move === "up") toLine = Math.max(1, toLine - 1);
    else if (move === "down") toLine = Math.min(doc.lines, toLine + 1);
    else if (move === "pageUp") toLine = Math.max(1, toLine - pageSize);
    else toLine = Math.min(doc.lines, toLine + pageSize);
    const next: ColumnData = { ...data, toLine, toColumn };
    const ranges = columnRanges(state, next);
    dispatch(state.update({ selection: EditorSelection.create(ranges.ranges, ranges.mainIndex), effects: setColumn.of(next), scrollIntoView: true, userEvent: "select" }));
    return true;
  };
}

export function columnRanges(state: EditorState, data: ColumnData): { ranges: SelectionRange[]; mainIndex: number } {
  const doc = state.doc;
  const tab = state.tabSize;
  const { fromLine, fromColumn, toLine, toColumn } = data;
  const count = Math.abs(toLine - fromLine) + 1;
  const upward = toLine < fromLine;
  const leftToRight = fromColumn < toColumn;
  const rightToLeft = fromColumn > toColumn;
  const ranges: SelectionRange[] = [];
  let mainIndex = 0;
  for (let i = 0; i < count; i++) {
    const n = fromLine + (upward ? -i : i);
    const line = doc.line(n);
    const fromOffset = findColumn(line.text, fromColumn, tab);
    const toOffset = findColumn(line.text, toColumn, tab);
    const fromActual = countColumn(line.text, tab, fromOffset);
    const toActual = countColumn(line.text, tab, toOffset);
    if ((leftToRight && (fromActual > toColumn || toActual < fromColumn)) || (rightToLeft && (toActual > fromColumn || fromActual < toColumn))) continue;
    if (n === toLine) mainIndex = ranges.length;
    ranges.push(EditorSelection.range(line.from + fromOffset, line.from + toOffset));
  }
  if (!ranges.length) {
    for (let i = 0; i < count; i++) {
      const n = fromLine + (upward ? -i : i);
      if (n === toLine) mainIndex = ranges.length;
      ranges.push(EditorSelection.cursor(doc.line(n).to));
    }
  }
  return { ranges, mainIndex };
}

export function cursorWordPart(forward: boolean, select: boolean) {
  return ({ state, dispatch }: Target): boolean => {
    const ranges = state.selection.ranges.map((range) => {
      const head = forward ? wordPartRight(state.doc, range.head) : wordPartLeft(state.doc, range.head);
      return select ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head);
    });
    dispatch(state.update({ selection: EditorSelection.create(ranges, state.selection.mainIndex), scrollIntoView: true, userEvent: "select" }));
    return true;
  };
}

export function deleteWordPart(forward: boolean) {
  return ({ state, dispatch }: Target): boolean => {
    if (state.readOnly) return false;
    const changes: ChangeSpec[] = [];
    for (const range of state.selection.ranges) {
      const span = range.empty ? (forward ? deleteWordPartRightRange(state.doc, range.head) : deleteWordPartLeftRange(state.doc, range.head)) : range;
      if (span && span.to > span.from) changes.push({ from: span.from, to: span.to });
    }
    if (!changes.length) return false;
    dispatch(state.update({ changes, userEvent: forward ? "delete.forward" : "delete.backward", scrollIntoView: true }));
    return true;
  };
}

import { indentRange, indentString, indentUnit, getIndentation } from "@codemirror/language";
import { countColumn, EditorSelection, EditorState, Facet, StateEffect, StateField, type ChangeSpec, type Extension, type Transaction } from "@codemirror/state";
import { indentSelection, isolateHistory } from "@codemirror/commands";


export type IndentInfo = { useSpaces: boolean; size: number; source: "config" | "detected" | "manual" };
export type IndentTarget = { state: EditorState; dispatch: (tr: Transaction) => void };
export type IndentDefaults = { tabSize: number; insertSpaces: boolean };

export const MIN_TAB_SIZE = 1;
export const MAX_TAB_SIZE = 16;


const MAX_GUESS_LINES = 10_000;
const CANDIDATE_SIZES = [2, 4, 6, 8, 3, 5, 7];
const MAX_DIFF = 8;

type SpacesDiff = { spacesDiff: number; looksLikeAlignment: boolean };

function spacesDiffBetween(previous: string, previousLength: number, current: string, currentLength: number, result: SpacesDiff) {
  result.spacesDiff = 0;
  result.looksLikeAlignment = false;
  let commonLength = 0;
  while (commonLength < previousLength && commonLength < currentLength && previous.charCodeAt(commonLength) === current.charCodeAt(commonLength)) commonLength++;
  let previousSpaces = 0;
  let previousTabs = 0;
  for (let i = commonLength; i < previousLength; i++) {
    if (previous.charCodeAt(i) === 32) previousSpaces++;
    else previousTabs++;
  }
  let currentSpaces = 0;
  let currentTabs = 0;
  for (let i = commonLength; i < currentLength; i++) {
    if (current.charCodeAt(i) === 32) currentSpaces++;
    else currentTabs++;
  }
  if ((previousSpaces > 0 && previousTabs > 0) || (currentSpaces > 0 && currentTabs > 0)) return;
  const tabsDiff = Math.abs(previousTabs - currentTabs);
  const spacesDiff = Math.abs(previousSpaces - currentSpaces);
  if (tabsDiff === 0) {
    result.spacesDiff = spacesDiff;
    if (spacesDiff > 0 && 0 <= currentSpaces - 1 && currentSpaces - 1 < previous.length && currentSpaces < current.length && current.charCodeAt(currentSpaces) !== 32 && previous.charCodeAt(currentSpaces - 1) === 32 && previous.charCodeAt(previous.length - 1) === 44) {
      result.looksLikeAlignment = true;
    }
    return;
  }
  if (spacesDiff % tabsDiff === 0) result.spacesDiff = spacesDiff / tabsDiff;
}

export function guessIndentation(lines: readonly string[], defaultTabSize: number, defaultInsertSpaces: boolean): { insertSpaces: boolean; tabSize: number } {
  const count = Math.min(lines.length, MAX_GUESS_LINES);
  let tabLines = 0;
  let spaceLines = 0;
  let previous = "";
  let previousIndentLength = 0;
  const histogram = new Array<number>(MAX_DIFF + 1).fill(0);
  const diff: SpacesDiff = { spacesDiff: 0, looksLikeAlignment: false };
  for (let index = 0; index < count; index++) {
    const content = lines[index];
    let foundContent = false;
    let indentLength = 0;
    let spaces = 0;
    let tabs = 0;
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i);
      if (code === 9) tabs++;
      else if (code === 32) spaces++;
      else {
        foundContent = true;
        indentLength = i;
        break;
      }
    }
    if (!foundContent) continue;
    if (tabs > 0) tabLines++;
    else if (spaces > 1) spaceLines++;
    spacesDiffBetween(previous, previousIndentLength, content, indentLength, diff);
    if (diff.looksLikeAlignment && !(defaultInsertSpaces && defaultTabSize === diff.spacesDiff)) continue;
    if (diff.spacesDiff <= MAX_DIFF) histogram[diff.spacesDiff]++;
    previous = content;
    previousIndentLength = indentLength;
  }
  let insertSpaces = defaultInsertSpaces;
  if (tabLines !== spaceLines) insertSpaces = tabLines < spaceLines;
  let tabSize = defaultTabSize;
  if (insertSpaces) {
    let best = 0;
    for (const size of CANDIDATE_SIZES) {
      if (histogram[size] > best) {
        best = histogram[size];
        tabSize = size;
      }
    }
    if (tabSize === 4 && histogram[4] > 0 && histogram[2] > 0 && histogram[2] >= (histogram[4] * 2) / 3) tabSize = 2;
  }
  return { insertSpaces, tabSize };
}

export function leadingLines(text: string, max = MAX_GUESS_LINES): string[] {
  const lines: string[] = [];
  let start = 0;
  while (lines.length < max) {
    const end = text.indexOf("\n", start);
    if (end === -1) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, text.charCodeAt(end - 1) === 13 && end > start ? end - 1 : end));
    start = end + 1;
  }
  return lines;
}

export function baseIndentation(options: IndentDefaults & { detectIndentation: boolean }, text: string): IndentInfo {
  if (!options.detectIndentation) return { useSpaces: options.insertSpaces, size: clampSize(options.tabSize), source: "config" };
  const guessed = guessIndentation(leadingLines(text), options.tabSize, options.insertSpaces);
  return { useSpaces: guessed.insertSpaces, size: clampSize(guessed.tabSize), source: "detected" };
}

export function clampSize(size: number): number {
  return Math.min(MAX_TAB_SIZE, Math.max(MIN_TAB_SIZE, Math.round(size)));
}

const DEFAULT_INFO: IndentInfo = { useSpaces: true, size: 4, source: "config" };

const baseFacet = Facet.define<IndentInfo, IndentInfo>({ combine: (values) => values[0] ?? DEFAULT_INFO });
const overrideEffect = StateEffect.define<IndentInfo>();
const overrideField = StateField.define<IndentInfo | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(overrideEffect)) value = effect.value;
    return value;
  },
});

export function indentInfoOf(state: EditorState): IndentInfo {
  return state.field(overrideField, false) ?? state.facet(baseFacet);
}

export function indentEffect(next: { useSpaces: boolean; size: number }, source: "manual" | "detected" = "manual") {
  return overrideEffect.of({ useSpaces: next.useSpaces, size: clampSize(next.size), source });
}

export const indentUnitOf = (info: Pick<IndentInfo, "useSpaces" | "size">) => (info.useSpaces ? " ".repeat(info.size) : "\t");

export function indentState(base: IndentInfo): Extension {
  return [
    overrideField,
    baseFacet.of(base),
    indentUnit.compute([overrideField, baseFacet], (state) => indentUnitOf(indentInfoOf(state))),
    EditorState.tabSize.compute([overrideField, baseFacet], (state) => indentInfoOf(state).size),
  ];
}


const nextTabStop = (column: number, size: number) => column + size - (column % size);
const prevTabStop = (column: number, size: number) => Math.max(0, column - 1 - ((column - 1) % size));

function indentsLines(state: EditorState, from: number, to: number) {
  if (from === to) return false;
  const line = state.doc.lineAt(from);
  return to > line.to || (from === line.from && to === line.to);
}

export function tabCommand(target: IndentTarget): boolean {
  const { state } = target;
  if (state.readOnly) return false;
  if (state.selection.ranges.some((range) => indentsLines(state, range.from, range.to))) return shiftLines(target, 1);
  const info = indentInfoOf(state);
  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    if (range.empty && /^\s*$/.test(line.text)) {
      const columns = getIndentation(state, line.from);
      const wanted = indentString(state, columns !== null && columns > 0 ? columns : info.size);
      if (!line.text.startsWith(wanted)) return { changes: { from: line.from, to: line.to, insert: wanted }, range: EditorSelection.cursor(line.from + wanted.length) };
    }
    const column = countColumn(state.doc.sliceString(line.from, range.from), info.size);
    const insert = info.useSpaces ? " ".repeat(info.size - (column % info.size)) : "\t";
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
  });
  target.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.indent" }));
  return true;
}

export function shiftTabCommand(target: IndentTarget): boolean {
  return shiftLines(target, -1);
}

function shiftLines(target: IndentTarget, direction: 1 | -1): boolean {
  const { state } = target;
  if (state.readOnly) return false;
  const { size } = indentInfoOf(state);
  const seen = new Set<number>();
  const specs: { from: number; to: number; insert: string }[] = [];
  const firstWhitespaceEnd = new Map<number, number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    let last = state.doc.lineAt(range.to);
    if (last.number > first.number && range.to === last.from) last = state.doc.line(last.number - 1);
    const single = first.number === last.number;
    for (let number = first.number; number <= last.number; number++) {
      if (seen.has(number)) continue;
      seen.add(number);
      const line = state.doc.line(number);
      const whitespace = /^[ \t]*/.exec(line.text)![0];
      if (direction < 0 && (line.length === 0 || whitespace.length === 0)) continue;
      if (direction > 0 && !single && line.length === 0) continue;
      const column = countColumn(whitespace, size);
      const next = indentString(state, direction > 0 ? nextTabStop(column, size) : prevTabStop(column, size));
      firstWhitespaceEnd.set(number, line.from + whitespace.length);
      if (next !== whitespace) specs.push({ from: line.from, to: line.from + whitespace.length, insert: next });
    }
  }
  if (!specs.length) return true;
  const changes = state.changes(specs);
  const ranges = state.selection.ranges.map((range) => {
    const startLine = state.doc.lineAt(range.from);
    const staysPut = !range.empty && range.from <= (firstWhitespaceEnd.get(startLine.number) ?? -1);
    const from = staysPut ? range.from : changes.mapPos(range.from, 1);
    const to = changes.mapPos(range.to, 1);
    return range.anchor <= range.head ? EditorSelection.range(Math.min(from, to), to) : EditorSelection.range(to, Math.min(from, to));
  });
  target.dispatch(state.update({ changes, selection: EditorSelection.create(ranges, state.selection.mainIndex), scrollIntoView: true, userEvent: direction > 0 ? "input.indent" : "delete.dedent" }));
  return true;
}

export function convertIndentation(target: IndentTarget, toSpaces: boolean): boolean {
  const { state } = target;
  if (state.readOnly) return false;
  const { size } = indentInfoOf(state);
  const spaces = " ".repeat(size);
  const pattern = new RegExp(spaces, "g");
  const changes: ChangeSpec[] = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const lead = /^[ \t]*/.exec(line.text)![0];
    if (!lead) continue;
    const converted = toSpaces ? lead.replace(/\t/g, spaces) : lead.replace(pattern, "\t");
    if (converted !== lead) changes.push({ from: line.from, to: line.from + lead.length, insert: converted });
  }
  target.dispatch(state.update({ changes, effects: indentEffect({ useSpaces: toSpaces, size }), annotations: isolateHistory.of("full"), userEvent: "input.indentation" }));
  return true;
}

export function detectIndentation(target: IndentTarget, defaults: IndentDefaults): boolean {
  const { state } = target;
  const lines: string[] = [];
  const limit = Math.min(state.doc.lines, MAX_GUESS_LINES);
  for (const text of state.doc.iterLines(1, limit + 1)) lines.push(text);
  const guessed = guessIndentation(lines, defaults.tabSize, defaults.insertSpaces);
  target.dispatch(state.update({ effects: indentEffect({ useSpaces: guessed.insertSpaces, size: guessed.tabSize }, "detected") }));
  return true;
}

export function reindentLines(target: IndentTarget, selectionOnly: boolean): boolean {
  const { state } = target;
  if (state.readOnly) return false;
  if (selectionOnly) return indentSelection(target);
  const changes = indentRange(state, 0, state.doc.length);
  if (!changes.empty) target.dispatch(state.update({ changes, userEvent: "indent", annotations: isolateHistory.of("full") }));
  return true;
}

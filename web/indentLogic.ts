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

// 앞 줄과 이 줄의 들여쓰기 차이를 공백 몇 칸(탭 차이가 있으면 탭 하나당 몇 칸)으로 볼지
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
    // 앞 줄이 쉼표로 끝나고 이 줄이 그 아래 정렬한 모양이면 들여쓰기 단위 증거로 쓰지 않는다
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
    // 4 칸 단위 파일에 2 칸 증거가 4 칸의 2/3 이상이면 2 칸이다
    if (tabSize === 4 && histogram[4] > 0 && histogram[2] > 0 && histogram[2] >= (histogram[4] * 2) / 3) tabSize = 2;
  }
  return { insertSpaces, tabSize };
}

// 본문 앞쪽 줄만 잘라 낸다(큰 파일 전체를 쪼개지 않는다). 줄 끝의 \r 은 뺀다.
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

// 설정(editor.tabSize, insertSpaces, detectIndentation)과 본문으로 정한 이 파일의 들여쓰기
export function baseIndentation(options: IndentDefaults & { detectIndentation: boolean }, text: string): IndentInfo {
  if (!options.detectIndentation) return { useSpaces: options.insertSpaces, size: clampSize(options.tabSize), source: "config" };
  const guessed = guessIndentation(leadingLines(text), options.tabSize, options.insertSpaces);
  return { useSpaces: guessed.insertSpaces, size: clampSize(guessed.tabSize), source: "detected" };
}

export function clampSize(size: number): number {
  return Math.min(MAX_TAB_SIZE, Math.max(MIN_TAB_SIZE, Math.round(size)));
}

// --- 파일별 상태 ---

const DEFAULT_INFO: IndentInfo = { useSpaces: true, size: 4, source: "config" };

// 확장을 만들 때(파일을 열거나 설정이 바뀔 때) 정한 값
const baseFacet = Facet.define<IndentInfo, IndentInfo>({ combine: (values) => values[0] ?? DEFAULT_INFO });
// 사용자가 고르거나 명령(Detect Indentation from Content)이 정한 값. 모듈 하나뿐인 필드라서 Compartment 를 갈아 끼워도 값이 남는다.
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

// indentUnit, EditorState.tabSize 를 이 파일의 들여쓰기 값에서 계산한다.
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

// 선택이 여러 줄이거나 한 줄 전체이면 줄 단위 들여쓰기, 그 밖에는 다음 탭 칸까지 넣는다.
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
    // 빈 줄이나 공백뿐인 줄의 커서는 언어가 정하는 들여쓰기로 보낸다(없으면 한 단계)
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

// 선택에 걸친 줄의 앞 공백을 다음(이전) 탭 칸에 맞게 바꾼다. ShiftCommand 와 같은 규칙: 여러 줄 선택의 빈 줄과 내어쓰기의 들여쓰기 없는 줄은 건너뛴다.
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

// --- 들여쓰기 변환 (editor.action.indentationToSpaces, indentationToTabs 의 l5o) ---

export function convertIndentation(target: IndentTarget, toSpaces: boolean): boolean {
  const { state } = target;
  if (state.readOnly) return false;
  const { size } = indentInfoOf(state);
  const spaces = " ".repeat(size);
  const pattern = new RegExp(spaces, "g");
  const changes: ChangeSpec[] = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    // 공백뿐인 줄은 줄 전체가 들여쓰기로 취급된다
    const lead = /^[ \t]*/.exec(line.text)![0];
    if (!lead) continue;
    const converted = toSpaces ? lead.replace(/\t/g, spaces) : lead.replace(pattern, "\t");
    if (converted !== lead) changes.push({ from: line.from, to: line.from + lead.length, insert: converted });
  }
  target.dispatch(state.update({ changes, effects: indentEffect({ useSpaces: toSpaces, size }), annotations: isolateHistory.of("full"), userEvent: "input.indentation" }));
  return true;
}

// --- 내용에서 다시 감지 (editor.action.detectIndentation) ---

export function detectIndentation(target: IndentTarget, defaults: IndentDefaults): boolean {
  const { state } = target;
  const lines: string[] = [];
  const limit = Math.min(state.doc.lines, MAX_GUESS_LINES);
  for (const text of state.doc.iterLines(1, limit + 1)) lines.push(text);
  const guessed = guessIndentation(lines, defaults.tabSize, defaults.insertSpaces);
  target.dispatch(state.update({ effects: indentEffect({ useSpaces: guessed.insertSpaces, size: guessed.tabSize }, "detected") }));
  return true;
}

// --- 다시 들여쓰기 (editor.action.reindentlines, reindentselectedlines) ---

// 언어의 들여쓰기 규칙(CodeMirror 의 syntax tree 규칙)으로 다시 계산한다. 규칙이 없는 언어는 아무것도 바꾸지 않는다.
export function reindentLines(target: IndentTarget, selectionOnly: boolean): boolean {
  const { state } = target;
  if (state.readOnly) return false;
  if (selectionOnly) return indentSelection(target);
  const changes = indentRange(state, 0, state.doc.length);
  if (!changes.empty) target.dispatch(state.update({ changes, userEvent: "indent", annotations: isolateHistory.of("full") }));
  return true;
}

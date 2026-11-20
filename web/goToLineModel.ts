import type { Text } from "@codemirror/state";

export type GoToTarget = { line: number; column: number; pos: number };
export type GoToParse = { label: string; offsetMode: boolean; target: GoToTarget | null };

export type GoToInput = {
  doc: Text;
  // 줄끝 글자 수(LF 1, CRLF 2). 글자 위치는 줄끝을 이 길이로 센다.
  eolLength: number;
  tabSize: number;
  zeroBasedOffset?: boolean;
};

export function parseGoTo(input: GoToInput, value: string): GoToParse {
  const rest = value.trim().slice(1);
  return rest.startsWith(":") ? parseOffset(input, rest.slice(1)) : parseLine(input, rest);
}

function parseLine({ doc, tabSize }: GoToInput, rest: string): GoToParse {
  const parts = rest.split(/,|:|#/);
  const total = doc.lines;
  let line = parseInt(parts[0]?.trim() ?? "", 10);
  if (Number.isNaN(line)) return { label: `Type a line number to go to (from 1 to ${total}).`, offsetMode: false, target: null };
  line = Math.min(Math.max(line >= 0 ? line : total + 1 + line, 1), total);
  const text = doc.line(line).text;
  const columns = visibleColumn(text, text.length + 1, tabSize) + 1;
  let wanted = parseInt(parts[1]?.trim() ?? "", 10);
  if (parts.length < 2 || Number.isNaN(wanted)) {
    const label = parts.length < 2 ? `Press 'Enter' to go to line ${line} or enter colon : to add a column number.` : `Press 'Enter' to go to line ${line} or enter a column number (from 1 to ${columns}).`;
    return { label, offsetMode: false, target: { line, column: 1, pos: doc.line(line).from } };
  }
  wanted = Math.min(Math.max(wanted >= 0 ? wanted : columns + wanted, 1), columns);
  const column = columnFromVisible(text, wanted - 1, tabSize);
  return { label: `Press 'Enter' to go to line ${line} at column ${wanted}.`, offsetMode: false, target: { line, column, pos: doc.line(line).from + column - 1 } };
}

function parseOffset({ doc, eolLength, tabSize, zeroBasedOffset = false }: GoToInput, rest: string): GoToParse {
  const length = doc.length + (doc.lines - 1) * (eolLength - 1);
  let offset = parseInt(rest, 10);
  if (Number.isNaN(offset)) return { label: zeroBasedOffset ? `Type a character position to go to (from 0 to ${length - 1}).` : `Type a character position to go to (from 1 to ${length}).`, offsetMode: true, target: null };
  const fromEnd = offset < 0;
  if (!zeroBasedOffset) offset -= Math.sign(offset);
  if (fromEnd) offset += length;
  const { line, column } = positionAt(doc, eolLength, offset);
  const text = doc.line(line).text;
  const shown = visibleColumn(text, column, tabSize) + 1;
  return { label: `Press 'Enter' to go to line ${line} at column ${shown}.`, offsetMode: true, target: { line, column, pos: doc.line(line).from + column - 1 } };
}

export function positionAt(doc: Text, eolLength: number, offset: number): { line: number; column: number } {
  let remaining = Math.max(offset, 0);
  for (let n = 1; n <= doc.lines; n++) {
    const length = doc.line(n).length;
    if (remaining <= length) return { line: n, column: remaining + 1 };
    remaining -= length + eolLength;
    if (remaining < 0) return { line: n, column: length + 1 };
  }
  const last = doc.line(doc.lines);
  return { line: doc.lines, column: last.length + 1 };
}

export function visibleColumn(text: string, column: number, tabSize: number): number {
  let visible = 0;
  for (const { segment } of graphemes(text.slice(0, Math.min(column - 1, text.length)))) visible = nextVisible(segment.codePointAt(0)!, visible, tabSize);
  return visible;
}

export function columnFromVisible(text: string, wanted: number, tabSize: number): number {
  if (wanted <= 0) return 1;
  let visible = 0;
  let before = 1;
  let offset = 0;
  for (const { segment } of graphemes(text)) {
    const next = nextVisible(segment.codePointAt(0)!, visible, tabSize);
    offset += segment.length;
    if (next >= wanted) return next - wanted < wanted - visible ? offset + 1 : before;
    visible = next;
    before = offset + 1;
  }
  return text.length + 1;
}

function nextVisible(code: number, visible: number, tabSize: number) {
  if (code === 9) return visible + tabSize - (visible % tabSize);
  return isWide(code) ? visible + 2 : visible + 1;
}

function isWide(code: number) {
  return (
    (code >= 11904 && code <= 55215) ||
    (code >= 63744 && code <= 64255) ||
    (code >= 65281 && code <= 65374) ||
    (code >= 65504 && code <= 65510) ||
    (code >= 127462 && code <= 127487) ||
    code === 8986 ||
    code === 8987 ||
    code === 9200 ||
    code === 9203 ||
    (code >= 9728 && code <= 10175) ||
    code === 11088 ||
    code === 11093 ||
    (code >= 127744 && code <= 128591) ||
    (code >= 128640 && code <= 128764) ||
    (code >= 128992 && code <= 129008) ||
    (code >= 129280 && code <= 129535) ||
    (code >= 129648 && code <= 129782)
  );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => segmenter.segment(text);

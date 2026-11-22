
export type MarkdownEdit = { from: number; to: number; insert: string; selStart: number; selEnd: number };

const LIST = /^(\s*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;
const FENCE = /^\s*(```|~~~)/;
const INDENT = "  ";

const lineStartOf = (text: string, pos: number) => text.lastIndexOf("\n", pos - 1) + 1;
const lineEndOf = (text: string, pos: number) => {
  const end = text.indexOf("\n", pos);
  return end === -1 ? text.length : end;
};

function insideFence(text: string, pos: number): boolean {
  const lineStart = lineStartOf(text, pos);
  let open = false;
  for (const line of text.slice(0, lineStart).split("\n")) if (FENCE.test(line)) open = !open;
  return open && !FENCE.test(text.slice(lineStart, lineEndOf(text, pos)));
}

const nextMarker = (marker: string) => {
  const number = /^(\d+)([.)])$/.exec(marker);
  return number ? `${Number(number[1]) + 1}${number[2]}` : marker;
};

export function continueMarkdown(text: string, start: number, end: number): MarkdownEdit | null {
  if (start !== end) return null;
  const lineStart = lineStartOf(text, start);
  const line = text.slice(lineStart, lineEndOf(text, start));
  const before = text.slice(lineStart, start);
  if (insideFence(text, start)) {
    const indent = /^[ \t]*/.exec(before)![0];
    if (!indent) return null;
    const insert = `\n${indent}`;
    return { from: start, to: start, insert, selStart: start + insert.length, selEnd: start + insert.length };
  }
  const match = LIST.exec(line);
  if (!match || start < lineStart + match[0].length) return null;
  const [prefix, indent, marker, gap, task] = match;
  if (line.length === prefix.length) {
    const previous = lineStart > 0 ? text.slice(lineStartOf(text, lineStart - 1), lineStart - 1) : "";
    if (LIST.test(previous)) return { from: lineStart, to: start, insert: "", selStart: lineStart, selEnd: lineStart };
    return null;
  }
  const insert = `\n${indent}${nextMarker(marker)}${gap}${task ? "[ ] " : ""}`;
  return { from: start, to: start, insert, selStart: start + insert.length, selEnd: start + insert.length };
}

function renumber(line: string, before: string[]): string {
  const match = LIST.exec(line);
  const number = match ? /^\d+([.)])$/.exec(match[2]) : null;
  if (!match || !number) return line;
  const indent = match[1].length;
  let value = 1;
  for (let i = before.length - 1; i >= 0; i--) {
    const prev = LIST.exec(before[i]);
    if (!prev) break;
    if (prev[1].length > indent) continue;
    const prevNumber = prev[1].length === indent ? /^(\d+)[.)]$/.exec(prev[2]) : null;
    if (prevNumber) value = Number(prevNumber[1]) + 1;
    break;
  }
  return `${match[1]}${value}${number[1]}${line.slice(match[1].length + match[2].length)}`;
}

export function indentMarkdown(text: string, start: number, end: number, outdent: boolean): MarkdownEdit | null {
  const firstStart = lineStartOf(text, start);
  const lastEnd = lineEndOf(text, end);
  const firstLine = text.slice(firstStart, lineEndOf(text, start));
  const inCode = insideFence(text, start);
  if (!inCode && !LIST.test(firstLine)) return null;
  if (inCode && !outdent && start === end) {
    return { from: start, to: start, insert: INDENT, selStart: start + INDENT.length, selEnd: start + INDENT.length };
  }
  const lines = text.slice(firstStart, lastEnd).split("\n");
  const above = firstStart > 0 ? text.slice(0, firstStart - 1).split("\n") : [];
  let delta = 0;
  let firstDelta = 0;
  const changed: string[] = [];
  lines.forEach((line, index) => {
    let next = line;
    if (outdent) next = line.replace(/^(\t| {1,2})/, "");
    else if (line.length > 0) next = INDENT + line;
    if (!inCode) next = renumber(next, [...above, ...changed]);
    if (index === 0) firstDelta = next.length - line.length;
    delta += next.length - line.length;
    changed.push(next);
  });
  const insert = changed.join("\n");
  return { from: firstStart, to: lastEnd, insert, selStart: Math.max(firstStart, start + firstDelta), selEnd: Math.max(firstStart, end + delta) };
}

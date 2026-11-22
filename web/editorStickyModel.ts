export const STICKY_UPDATE_MS = 50;
export const STICKY_MODEL_MS = 300;

export type StickyNode = { start: number; end: number; children: StickyNode[] };

export type StickySymbol = { rangeStartLine: number; selStartLine: number; rangeEndLine: number; children: StickySymbol[] };

const byRange = (a: { start: number; end: number }, b: { start: number; end: number }) => (a.start !== b.start ? a.start - b.start : b.end - a.end);

export function symbolsToSticky(symbols: readonly StickySymbol[]): StickyNode[] {
  const sorted = [...symbols].sort((a, b) => (a.rangeStartLine !== b.rangeStartLine ? a.rangeStartLine - b.rangeStartLine : b.rangeEndLine - a.rangeEndLine));
  return sorted.map((symbol) => fromSymbol(symbol, symbol.selStartLine));
}

function fromSymbol(symbol: StickySymbol, parentSelLine: number): StickyNode {
  const children: StickyNode[] = [];
  for (const child of symbol.children) {
    if (child.selStartLine === child.rangeEndLine) continue;
    if (child.selStartLine !== parentSelLine) children.push(fromSymbol(child, child.selStartLine));
    else for (const grandchild of child.children) children.push(fromSymbol(grandchild, child.selStartLine));
  }
  children.sort(byRange);
  return { start: symbol.selStartLine, end: symbol.rangeEndLine, children };
}

export function nestRanges(ranges: readonly { start: number; end: number }[]): StickyNode[] {
  const sorted = [...ranges].sort(byRange);
  const roots: StickyNode[] = [];
  const stack: StickyNode[] = [];
  for (const range of sorted) {
    while (stack.length && stack[stack.length - 1]!.end < range.end) stack.pop();
    const node: StickyNode = { start: range.start, end: range.end, children: [] };
    (stack.length ? stack[stack.length - 1]!.children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

export function indentRanges(lines: readonly string[], tabSize: number): { start: number; end: number }[] {
  const indents = lines.map((text) => (text.trim() === "" ? -1 : indentOf(text, tabSize)));
  const ranges: { start: number; end: number }[] = [];
  const open: { line: number; indent: number }[] = [];
  const close = (line: number, indent: number) => {
    while (open.length && open[open.length - 1]!.indent >= indent) {
      const top = open.pop()!;
      let end = line - 1;
      while (end > top.line && indents[end - 1]! === -1) end--;
      if (end > top.line) ranges.push({ start: top.line, end: end + 1 });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const indent = indents[i]!;
    if (indent === -1) continue;
    close(i + 1, indent);
    open.push({ line: i + 1, indent });
  }
  close(lines.length + 1, 0);
  return ranges.filter((range) => range.end - range.start >= 1);
}

function indentOf(text: string, tabSize: number): number {
  let column = 0;
  for (const ch of text) {
    if (ch === " ") column++;
    else if (ch === "\t") column += tabSize - (column % tabSize);
    else break;
  }
  return column;
}

export type StickyCandidate = { start: number; end: number; top: number; height: number };

function lastAtOrBefore(starts: readonly number[], target: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! < target) low = mid + 1;
    else if (starts[mid]! > target) high = mid - 1;
    else return mid;
  }
  const result = -(low + 1);
  return result === -1 ? 0 : -result - 2;
}

export function candidateLines(roots: readonly StickyNode[], visible: { start: number; end: number }, lineHeight: number, lineCount: number): StickyCandidate[] {
  const out: StickyCandidate[] = [];
  const walk = (children: readonly StickyNode[], top: number, lastStart: number) => {
    if (children.length === 0) return;
    let last = lastStart;
    const starts = children.map((child) => child.start);
    const from = lastAtOrBefore(starts, visible.start);
    const to = lastAtOrBefore(starts, visible.end);
    for (let i = from; i <= to; i++) {
      const child = children[i];
      if (!child) continue;
      const { start, end } = child;
      if (end > start + 1 && visible.start <= end + 1 && start - 1 <= visible.end && start !== last && start >= 1 && end <= lineCount) {
        last = start;
        out.push({ start, end: end - 1, top, height: lineHeight });
        walk(child.children, top + lineHeight, start);
      }
    }
  };
  walk(roots, 0, -1);
  return out;
}

export type StickyState = { startLines: number[]; endLines: number[]; lastLineRelativePosition: number };
export const EMPTY_STICKY: StickyState = { startLines: [], endLines: [], lastLineRelativePosition: 0 };

export function maxStickyLines(editorHeight: number, lineHeight: number): number {
  return Math.round((editorHeight / lineHeight) * 0.25);
}

export function findStickyState(candidates: readonly StickyCandidate[], max: number, scrollTop: number, topOfLine: (line: number) => number, bottomOfLine: (line: number) => number): StickyState {
  const startLines: number[] = [];
  const endLines: number[] = [];
  let lastLineRelativePosition = 0;
  for (const candidate of candidates) {
    const slotTop = candidate.top;
    const slotBottom = slotTop + candidate.height;
    const startTop = topOfLine(candidate.start) - scrollTop;
    const endBottom = bottomOfLine(candidate.end) - scrollTop;
    if (slotTop > startTop && slotTop <= endBottom) {
      startLines.push(candidate.start);
      endLines.push(candidate.end + 1);
      if (slotBottom > endBottom) lastLineRelativePosition = endBottom - slotBottom;
    }
    if (startLines.length === max) break;
  }
  return { startLines, endLines, lastLineRelativePosition };
}

export function stickyStateEquals(a: StickyState, b: StickyState): boolean {
  return a.lastLineRelativePosition === b.lastLineRelativePosition && a.startLines.length === b.startLines.length && a.startLines.every((line, i) => line === b.startLines[i]);
}

export function stickyLayout(state: StickyState, lineHeight: number): { tops: number[]; height: number } {
  const count = state.startLines.length;
  if (count === 0) return { tops: [], height: 0 };
  const tops = state.startLines.map((_, index) => index * lineHeight + (index === count - 1 ? state.lastLineRelativePosition : 0));
  return { tops, height: count * lineHeight + state.lastLineRelativePosition };
}

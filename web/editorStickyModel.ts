export const STICKY_UPDATE_MS = 50;
export const STICKY_MODEL_MS = 300;

// 고정 후보의 범위. start 는 선언이 시작하는 줄(심볼 이름 줄), end 는 그 블록이 끝나는 줄(닫는 괄호 줄). 둘 다 1부터.
export type StickyNode = { start: number; end: number; children: StickyNode[] };

// 심볼 하나를 줄 번호로 적은 것. selStartLine 은 이름 범위가 시작하는 줄, rangeEndLine 은 심볼 전체 범위가 끝나는 줄.
export type StickySymbol = { rangeStartLine: number; selStartLine: number; rangeEndLine: number; children: StickySymbol[] };

// 줄 범위 정렬: 시작이 이르고, 같으면 끝이 늦은(바깥) 것이 먼저
const byRange = (a: { start: number; end: number }, b: { start: number; end: number }) => (a.start !== b.start ? a.start - b.start : b.end - a.end);

// _stickyModelFromOutlineModel: 최상위 심볼은 범위 시작순으로 정렬해 모두 후보로 두고, 자식은 한 줄짜리를 버린다.
// 자식의 이름 줄이 부모의 이름 줄과 같으면 그 자식 자리에 자식의 자식들을 올린다(같은 줄에 선언이 겹쳐 두 줄이 안 되게).
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

// 줄 범위(안쪽 포함 관계)를 트리로 묶는다. 접기 범위와 들여쓰기 범위가 쓴다.
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

// --- 보이는 범위와 겹치는 후보 ---

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

// getCandidateStickyLinesIntersectingFromStickyModel. 보이는 줄 범위와 겹치고, 3줄 이상이고, 부모와 같은 줄에서 시작하지 않는 블록만. top 은 조상 줄들을 쌓은 높이.
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

// --- 실제로 고정할 줄 ---

export type StickyState = { startLines: number[]; endLines: number[]; lastLineRelativePosition: number };
export const EMPTY_STICKY: StickyState = { startLines: [], endLines: [], lastLineRelativePosition: 0 };

// 에디터 높이의 4분의 1 줄까지만(Ak._onDidResize: round(높이 / 줄높이 * 0.25))
export function maxStickyLines(editorHeight: number, lineHeight: number): number {
  return Math.round((editorHeight / lineHeight) * 0.25);
}

// findScrollWidgetState. 후보 줄이 자기 칸(top)보다 위로 올라갔고 그 블록이 아직 칸 위쪽 아래로 이어지면 고정한다.
// 블록 끝이 칸 바닥보다 위에 있으면 마지막 줄만 그만큼 위로 밀어 다음 선언과 겹치지 않게 한다.
// topOfLine, bottomOfLine 은 줄의 문서 안 위쪽, 아래쪽 위치, scrollTop 은 지금 스크롤 위치다.
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

// 줄 i(0부터) 가 놓일 y 와 전체 높이: 앞선 줄들의 높이를 쌓고, 마지막 줄만 lastLineRelativePosition 만큼 올린다.
export function stickyLayout(state: StickyState, lineHeight: number): { tops: number[]; height: number } {
  const count = state.startLines.length;
  if (count === 0) return { tops: [], height: 0 };
  const tops = state.startLines.map((_, index) => index * lineHeight + (index === count - 1 ? state.lastLineRelativePosition : 0));
  return { tops, height: count * lineHeight + state.lastLineRelativePosition };
}

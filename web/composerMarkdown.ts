// 입력창의 마크다운 편집 보조. 목록(불릿, 번호, 체크박스)과 코드 블록 안에서 줄바꿈과 Tab 이 손으로 칠 필요 없게 동작한다.
// DOM 에 의존하지 않는 순수 함수라서 (본문, 선택) 만 있으면 시험된다. 붙이는 쪽은 web/Composer.tsx 의 onKeyDown.

export type MarkdownEdit = { from: number; to: number; insert: string; selStart: number; selEnd: number };

const LIST = /^(\s*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;
const FENCE = /^\s*(```|~~~)/;
const INDENT = "  ";

const lineStartOf = (text: string, pos: number) => text.lastIndexOf("\n", pos - 1) + 1;
const lineEndOf = (text: string, pos: number) => {
  const end = text.indexOf("\n", pos);
  return end === -1 ? text.length : end;
};

// pos 가 속한 줄이 코드 블록 안(여는 줄과 닫는 줄은 제외)인지
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

// Shift+Enter(줄바꿈). 목록 줄이면 다음 항목 표시를 이어 붙이고, 빈 항목이면 표시를 지워 목록을 끝낸다. 코드 블록 안이면 앞 줄의 들여쓰기를 잇는다.
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
    // 앞 줄도 목록 항목일 때만 빈 항목이 목록을 끝낸다. 막 쓴 "1. " 한 줄은 표시를 지우지 않고 줄만 바꾼다.
    const previous = lineStart > 0 ? text.slice(lineStartOf(text, lineStart - 1), lineStart - 1) : "";
    if (LIST.test(previous)) return { from: lineStart, to: start, insert: "", selStart: lineStart, selEnd: lineStart };
    return null;
  }
  const insert = `\n${indent}${nextMarker(marker)}${gap}${task ? "[ ] " : ""}`;
  return { from: start, to: start, insert, selStart: start + insert.length, selEnd: start + insert.length };
}

// Tab, Shift+Tab. 목록 줄과 코드 블록 안에서만 들여쓰기를 바꾸고, 그 밖에서는 null 을 돌려 기본 동작(포커스 이동)에 맡긴다.
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
  let delta = 0;
  let firstDelta = 0;
  const changed = lines.map((line, index) => {
    let next = line;
    if (outdent) next = line.replace(/^(\t| {1,2})/, "");
    else if (line.length > 0) next = INDENT + line;
    if (index === 0) firstDelta = next.length - line.length;
    delta += next.length - line.length;
    return next;
  });
  const insert = changed.join("\n");
  return { from: firstStart, to: lastEnd, insert, selStart: Math.max(firstStart, start + firstDelta), selEnd: Math.max(firstStart, end + delta) };
}

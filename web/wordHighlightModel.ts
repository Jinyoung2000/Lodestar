// editor.wordSeparators 기본값
export const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

// 낱말 정의(getWordAtPosition)는 언어의 wordPattern 이다. JS 계열은 $ 를 글자로 보고, 일치 검색의 wordSeparators 는 $ 를 구분 기호로 본다.
const WORD_PATTERN_EXCLUDED = WORD_SEPARATORS.replace("$", "");

const isSpace = (ch: string) => /\s/.test(ch);
const isSeparator = (ch: string, separators: string) => isSpace(ch) || separators.includes(ch);

// 열(0부터) 위치의 단어 범위. 단어 정의는 JS 계열 언어의 기본 모양(구분 기호와 공백이 아닌 글자의 연속, $ 와 _ 는 글자)이고,
// 커서가 단어 오른쪽 끝에 닿아 있어도 그 단어로 본다(getWordAtPosition). 단어가 없으면 null.
export function wordRangeAt(line: string, column: number): { from: number; to: number } | null {
  const at = (index: number) => index >= 0 && index < line.length && !isSeparator(line[index]!, WORD_PATTERN_EXCLUDED);
  let anchor = column;
  if (!at(anchor)) anchor = column - 1;
  if (!at(anchor)) return null;
  let from = anchor;
  while (at(from - 1)) from--;
  let to = anchor + 1;
  while (at(to)) to++;
  return { from, to };
}

export function textualOccurrences(text: string, word: string, separators = WORD_SEPARATORS): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  if (!word) return found;
  const leftBoundary = (start: number) => start === 0 || isSeparator(text[start - 1]!, separators) || isSeparator(word[0]!, separators);
  const rightBoundary = (end: number) => end === text.length || isSeparator(text[end]!, separators) || isSeparator(word[word.length - 1]!, separators);
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (leftBoundary(at) && rightBoundary(at + word.length)) found.push({ from: at, to: at + word.length });
  }
  return found;
}

export type HighlightKind = "text" | "read" | "write";

// LSP DocumentHighlightKind: 1 Text, 2 Read, 3 Write. 번들 h5o 는 Write 를 Strong, Text 를 Text, 그 밖(Read)을 기본 강조로 칠한다.
export function highlightKind(lspKind: number | undefined): HighlightKind {
  return lspKind === 3 ? "write" : lspKind === 2 ? "read" : lspKind === 1 ? "text" : "read";
}

export type Highlight = { from: number; to: number; kind: HighlightKind };

// 정렬된 강조 목록에서 커서가 든 것의 다음/이전(처음과 끝은 돌아간다, 번들 moveNext/moveBack). 커서가 어느 것에도 없으면 -1 기준이다.
export function stepHighlight(sorted: readonly { from: number; to: number }[], cursor: number, delta: 1 | -1) {
  if (!sorted.length) return -1;
  const current = sorted.findIndex((range) => range.from <= cursor && cursor <= range.to);
  return (current + delta + sorted.length) % sorted.length;
}

// 번들 안내문: `${줄 내용}, ${번호} of ${개수} for '${단어}'`
export const highlightAnnouncement = (lineText: string, index: number, count: number, word: string) => `${lineText}, ${index + 1} of ${count} for '${word}'`;

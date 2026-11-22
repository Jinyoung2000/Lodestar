export const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

const WORD_PATTERN_EXCLUDED = WORD_SEPARATORS.replace("$", "");

const isSpace = (ch: string) => /\s/.test(ch);
const isSeparator = (ch: string, separators: string) => isSpace(ch) || separators.includes(ch);

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

export function highlightKind(lspKind: number | undefined): HighlightKind {
  return lspKind === 3 ? "write" : lspKind === 2 ? "read" : lspKind === 1 ? "text" : "read";
}

export type Highlight = { from: number; to: number; kind: HighlightKind };

export function stepHighlight(sorted: readonly { from: number; to: number }[], cursor: number, delta: 1 | -1) {
  if (!sorted.length) return -1;
  const current = sorted.findIndex((range) => range.from <= cursor && cursor <= range.to);
  return (current + delta + sorted.length) % sorted.length;
}

export const highlightAnnouncement = (lineText: string, index: number, count: number, word: string) => `${lineText}, ${index + 1} of ${count} for '${word}'`;

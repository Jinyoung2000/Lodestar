import type { Text } from "@codemirror/state";


const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

const REGULAR = 0;
const WHITESPACE = 1;
const SEPARATOR = 2;
const WORD_NONE = 0;
const WORD_REGULAR = 1;
const WORD_SEPARATOR = 2;

type Word = { start: number; end: number; wordType: number; nextCharClass: number };

function charClass(code: number): number {
  if (code === 32 || code === 9) return WHITESPACE;
  return WORD_SEPARATORS.includes(String.fromCharCode(code)) ? SEPARATOR : REGULAR;
}

const isLower = (code: number) => code >= 97 && code <= 122;
const isUpper = (code: number) => code >= 65 && code <= 90;
const isDigit = (code: number) => code >= 48 && code <= 57;

type Pos = { line: number; col: number };

// 단어 부분 왼쪽 이동의 도착 오프셋: 후보 셋 중 커서에 가장 가까운 것
export function wordPartLeft(doc: Text, offset: number): number {
  const pos = posOf(doc, offset);
  const candidates = [moveWordLeft(doc, pos, 0), moveWordLeft(doc, pos, 2), partLeft(doc, pos)];
  return offsetOf(doc, candidates.reduce((best, next) => (before(best, next) ? next : best)));
}

export function wordPartRight(doc: Text, offset: number): number {
  const pos = posOf(doc, offset);
  const candidates = [moveWordRight(doc, pos, 0), moveWordRight(doc, pos, 2), partRight(doc, pos)];
  return offsetOf(doc, candidates.reduce((best, next) => (before(next, best) ? next : best)));
}

export function deleteWordPartLeftRange(doc: Text, offset: number): { from: number; to: number } | null {
  const pos = posOf(doc, offset);
  if (pos.line === 1 && pos.col === 1) return null;
  const text = doc.line(pos.line).text;
  const index = pos.col - 2;
  let lastNonSpace = index;
  while (lastNonSpace >= 0 && (text.charCodeAt(lastNonSpace) === 32 || text.charCodeAt(lastNonSpace) === 9)) lastNonSpace--;
  const spaces: Pos | null = lastNonSpace + 1 < index ? { line: pos.line, col: lastNonSpace + 2 } : null;
  const candidates = [spaces ?? deleteWordLeft(doc, pos, 0), spaces ?? deleteWordLeft(doc, pos, 2), partLeft(doc, pos)];
  // 지울 범위는 모두 커서에서 왼쪽으로 뻗는다. 시작이 커서에 가장 가까운 것이 가장 짧다.
  const start = candidates.reduce((best, next) => (before(best, next) ? next : best));
  return { from: offsetOf(doc, start), to: offset };
}

export function deleteWordPartRightRange(doc: Text, offset: number): { from: number; to: number } | null {
  const pos = posOf(doc, offset);
  const lastLine = doc.lines;
  if (pos.line === lastLine && pos.col === maxCol(doc, lastLine)) return null;
  const text = doc.line(pos.line).text;
  let firstNonSpace = pos.col - 1;
  while (firstNonSpace < text.length && (text[firstNonSpace] === " " || text[firstNonSpace] === "\t")) firstNonSpace++;
  const spaces: Pos | null = pos.col - 1 < firstNonSpace ? { line: pos.line, col: firstNonSpace + 1 } : null;
  const candidates = [spaces ?? deleteWordRight(doc, pos, 0), spaces ?? deleteWordRight(doc, pos, 2), partRight(doc, pos)];
  const end = candidates.reduce((best, next) => (before(next, best) ? next : best));
  return { from: offset, to: offsetOf(doc, end) };
}

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col < b.col);

function posOf(doc: Text, offset: number): Pos {
  const line = doc.lineAt(offset);
  return { line: line.number, col: offset - line.from + 1 };
}

function offsetOf(doc: Text, pos: Pos): number {
  return doc.line(pos.line).from + pos.col - 1;
}

const maxCol = (doc: Text, line: number) => doc.line(line).length + 1;

function findEndOfWord(text: string, wordType: number, start: number): number {
  for (let i = start; i < text.length; i++) {
    const cls = charClass(text.charCodeAt(i));
    if (cls === WHITESPACE || (wordType === WORD_REGULAR && cls === SEPARATOR) || (wordType === WORD_SEPARATOR && cls === REGULAR)) return i;
  }
  return text.length;
}

function findStartOfWord(text: string, wordType: number, start: number): number {
  for (let i = start; i >= 0; i--) {
    const cls = charClass(text.charCodeAt(i));
    if (cls === WHITESPACE || (wordType === WORD_REGULAR && cls === SEPARATOR) || (wordType === WORD_SEPARATOR && cls === REGULAR)) return i + 1;
  }
  return 0;
}

function previousWordOnLine(text: string, col: number): Word | null {
  let wordType = WORD_NONE;
  for (let i = col - 2; i >= 0; i--) {
    const cls = charClass(text.charCodeAt(i));
    if (cls === REGULAR) {
      if (wordType === WORD_SEPARATOR) return { start: i + 1, end: findEndOfWord(text, wordType, i + 1), wordType, nextCharClass: cls };
      wordType = WORD_REGULAR;
    } else if (cls === SEPARATOR) {
      if (wordType === WORD_REGULAR) return { start: i + 1, end: findEndOfWord(text, wordType, i + 1), wordType, nextCharClass: cls };
      wordType = WORD_SEPARATOR;
    } else if (wordType !== WORD_NONE) {
      return { start: i + 1, end: findEndOfWord(text, wordType, i + 1), wordType, nextCharClass: cls };
    }
  }
  return wordType !== WORD_NONE ? { start: 0, end: findEndOfWord(text, wordType, 0), wordType, nextCharClass: WHITESPACE } : null;
}

function nextWordOnLine(text: string, col: number): Word | null {
  let wordType = WORD_NONE;
  const length = text.length;
  for (let i = col - 1; i < length; i++) {
    const cls = charClass(text.charCodeAt(i));
    if (cls === REGULAR) {
      if (wordType === WORD_SEPARATOR) return { start: findStartOfWord(text, wordType, i - 1), end: i, wordType, nextCharClass: cls };
      wordType = WORD_REGULAR;
    } else if (cls === SEPARATOR) {
      if (wordType === WORD_REGULAR) return { start: findStartOfWord(text, wordType, i - 1), end: i, wordType, nextCharClass: cls };
      wordType = WORD_SEPARATOR;
    } else if (wordType !== WORD_NONE) {
      return { start: findStartOfWord(text, wordType, i - 1), end: i, wordType, nextCharClass: cls };
    }
  }
  return wordType !== WORD_NONE ? { start: findStartOfWord(text, wordType, length - 1), end: length, wordType, nextCharClass: WHITESPACE } : null;
}

// 낱말 시작(type 0)과 낱말 끝(type 2)으로 가는 왼쪽 이동
function moveWordLeft(doc: Text, pos: Pos, type: 0 | 2): Pos {
  let { line, col } = pos;
  if (col === 1 && line > 1) {
    line -= 1;
    col = maxCol(doc, line);
  }
  let word = previousWordOnLine(doc.line(line).text, col);
  if (type === 0) return { line, col: word ? word.start + 1 : 1 };
  if (word && col <= word.end + 1) word = previousWordOnLine(doc.line(line).text, word.start + 1);
  return { line, col: word ? word.end + 1 : 1 };
}

function moveWordRight(doc: Text, pos: Pos, type: 0 | 2): Pos {
  let { line, col } = pos;
  let crossed = false;
  if (col === maxCol(doc, line) && line < doc.lines) {
    crossed = true;
    line += 1;
    col = 1;
  }
  let word = nextWordOnLine(doc.line(line).text, col);
  if (type === 2) {
    if (word && word.wordType === WORD_SEPARATOR && word.end - word.start === 1 && word.nextCharClass === REGULAR) word = nextWordOnLine(doc.line(line).text, word.end + 1);
    col = word ? word.end + 1 : maxCol(doc, line);
  } else {
    if (word && !crossed && col >= word.start + 1) word = nextWordOnLine(doc.line(line).text, word.end + 1);
    col = word ? word.start + 1 : maxCol(doc, line);
  }
  return { line, col };
}

function partLeft(doc: Text, pos: Pos): Pos {
  const max = maxCol(doc, pos.line);
  if (pos.col === 1) return pos.line > 1 ? { line: pos.line - 1, col: maxCol(doc, pos.line - 1) } : pos;
  const text = doc.line(pos.line).text;
  for (let col = pos.col - 1; col > 1; col--) {
    const prev = text.charCodeAt(col - 2);
    const cur = text.charCodeAt(col - 1);
    if (prev === 95 && cur !== 95) return { line: pos.line, col };
    if (prev === 45 && cur !== 45) return { line: pos.line, col };
    if ((isLower(prev) || isDigit(prev)) && isUpper(cur)) return { line: pos.line, col };
    if (isUpper(prev) && isUpper(cur) && col + 1 < max) {
      const next = text.charCodeAt(col);
      if (isLower(next) || isDigit(next)) return { line: pos.line, col };
    }
  }
  return { line: pos.line, col: 1 };
}

function partRight(doc: Text, pos: Pos): Pos {
  const max = maxCol(doc, pos.line);
  if (pos.col === max) return pos.line < doc.lines ? { line: pos.line + 1, col: 1 } : pos;
  const text = doc.line(pos.line).text;
  for (let col = pos.col + 1; col < max; col++) {
    const prev = text.charCodeAt(col - 2);
    const cur = text.charCodeAt(col - 1);
    if (prev !== 95 && cur === 95) return { line: pos.line, col };
    if (prev !== 45 && cur === 45) return { line: pos.line, col };
    if ((isLower(prev) || isDigit(prev)) && isUpper(cur)) return { line: pos.line, col };
    if (isUpper(prev) && isUpper(cur) && col + 1 < max) {
      const next = text.charCodeAt(col);
      if (isLower(next) || isDigit(next)) return { line: pos.line, col };
    }
  }
  return { line: pos.line, col: max };
}

function deleteWordLeft(doc: Text, pos: Pos, type: 0 | 2): Pos {
  let { line, col } = pos;
  let word = previousWordOnLine(doc.line(line).text, col);
  if (type === 0) {
    if (word) col = word.start + 1;
    else if (col > 1) col = 1;
    else {
      line -= 1;
      col = maxCol(doc, line);
    }
    return { line, col };
  }
  if (word && col <= word.end + 1) word = previousWordOnLine(doc.line(line).text, word.start + 1);
  if (word) col = word.end + 1;
  else if (col > 1) col = 1;
  else {
    line -= 1;
    col = maxCol(doc, line);
  }
  return { line, col };
}

function deleteWordRight(doc: Text, pos: Pos, type: 0 | 2): Pos {
  let { line, col } = pos;
  const lastLine = doc.lines;
  const max = maxCol(doc, line);
  let word = nextWordOnLine(doc.line(line).text, col);
  if (type === 2) {
    if (word) col = word.end + 1;
    else if (col < max || line === lastLine) col = max;
    else {
      line += 1;
      word = nextWordOnLine(doc.line(line).text, 1);
      col = word ? word.start + 1 : maxCol(doc, line);
    }
    return { line, col };
  }
  if (word && col >= word.start + 1) word = nextWordOnLine(doc.line(line).text, word.end + 1);
  if (word) col = word.start + 1;
  else if (col < max || line === lastLine) col = max;
  else {
    line += 1;
    word = nextWordOnLine(doc.line(line).text, 1);
    col = word ? word.start + 1 : maxCol(doc, line);
  }
  return { line, col };
}

import { MATCH_LIMIT, regexError } from "./findModel";

export type ChatFindOptions = { caseSensitive: boolean; wholeWord: boolean; regexp: boolean };
export type TextMatch = { from: number; to: number };

const WORD_BEFORE = "(?<![\\p{L}\\p{N}_])";
const WORD_AFTER = "(?![\\p{L}\\p{N}_])";

export function buildPattern(query: string, options: ChatFindOptions): { regex: RegExp | null; error: string | null } {
  if (!query) return { regex: null, error: null };
  const error = options.regexp ? regexError(query) : null;
  if (error) return { regex: null, error };
  const body = options.regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = options.wholeWord ? `${WORD_BEFORE}(?:${body})${WORD_AFTER}` : body;
  return { regex: new RegExp(source, `gmu${options.caseSensitive ? "" : "i"}`), error: null };
}

export function textMatches(text: string, regex: RegExp, limit = MATCH_LIMIT): { list: TextMatch[]; capped: boolean } {
  const list: TextMatch[] = [];
  regex.lastIndex = 0;
  for (let hit = regex.exec(text); hit; hit = regex.exec(text)) {
    if (hit[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    if (list.length >= limit) return { list, capped: true };
    list.push({ from: hit.index, to: hit.index + hit[0].length });
  }
  return { list, capped: false };
}

export function partIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function stepIndex(index: number, total: number, backwards: boolean): number {
  if (total === 0) return -1;
  if (index < 0) return backwards ? total - 1 : 0;
  return backwards ? (index - 1 + total) % total : (index + 1) % total;
}

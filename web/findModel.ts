import { SearchQuery } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";

export const MATCH_LIMIT = 19999;

export type FindOptions = { caseSensitive: boolean; wholeWord: boolean; regexp: boolean; preserveCase: boolean };
export type Scope = { from: number; to: number } | null;
export type FoundMatch = { from: number; to: number; match: RegExpExecArray | null };
export type Matches = { list: FoundMatch[]; capped: boolean };

export const NO_RESULTS = "No results";

export function buildQuery(search: string, options: FindOptions): SearchQuery {
  return new SearchQuery({ search, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, regexp: options.regexp, literal: true });
}

export function regexError(search: string): string | null {
  if (!search) return null;
  try {
    new RegExp(search, "gmu");
    return null;
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).replace(/\/gmu:/, "/:");
  }
}

export function collectMatches(query: SearchQuery, state: EditorState, scope: Scope, limit = MATCH_LIMIT): Matches {
  const list: FoundMatch[] = [];
  if (!query.valid) return { list, capped: false };
  const cursor = query.getCursor(state, scope?.from ?? 0, scope?.to ?? state.doc.length) as Iterator<{ from: number; to: number; match?: RegExpExecArray }>;
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    if (step.value.to === step.value.from) continue;
    if (list.length >= limit) return { list, capped: true };
    list.push({ from: step.value.from, to: step.value.to, match: step.value.match ?? null });
  }
  return { list, capped: false };
}

export function containingIndex(list: FoundMatch[], from: number, to: number): number {
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const m = list[mid];
    if (m.to < from) low = mid + 1;
    else if (m.from > from) high = mid - 1;
    else return m.from <= from && to <= m.to ? mid : -1;
  }
  return -1;
}

export function nextIndex(list: FoundMatch[], pos: number): number {
  if (!list.length) return -1;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].from < pos) low = mid + 1;
    else high = mid;
  }
  return low === list.length ? 0 : low;
}

export function previousIndex(list: FoundMatch[], pos: number): number {
  if (!list.length) return -1;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].from < pos) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? list.length - 1 : low - 1;
}

export function firstMatchFrom(query: SearchQuery, state: EditorState, pos: number, scope: Scope): { from: number; to: number } | null {
  if (!query.valid) return null;
  const start = Math.max(pos, scope?.from ?? 0);
  const end = scope?.to ?? state.doc.length;
  const first = (from: number, to: number) => {
    const cursor = query.getCursor(state, from, to);
    for (let step = cursor.next(); !step.done; step = cursor.next()) if (step.value.to > step.value.from) return step.value;
    return null;
  };
  return first(start, end) ?? first(scope?.from ?? 0, end);
}

export function seedText(state: EditorState): string | null {
  const range = state.selection.main;
  if (!range.empty) {
    const text = state.sliceDoc(range.from, range.to);
    return text.includes("\n") || text.length > 200 ? null : text;
  }
  const word = state.wordAt(range.head);
  return word && word.to > word.from ? state.sliceDoc(word.from, word.to) : null;
}

export function preserveCase(matched: string, replacement: string): string {
  if (!/\p{L}/u.test(matched) || !replacement) return replacement;
  if (matched === matched.toUpperCase()) return replacement.toUpperCase();
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();
  const first = matched[0];
  const rest = matched.slice(1);
  if (first === first.toUpperCase() && first !== first.toLowerCase() && rest === rest.toLowerCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

export function expandReplacement(found: FoundMatch, replace: string, options: FindOptions): string {
  const text = options.regexp && found.match ? replace.replace(/\$(\$|&|\d{1,2})|\\([nrt\\])/g, (_all, dollar: string | undefined, escape: string | undefined) => {
    if (escape) return escape === "n" ? "\n" : escape === "r" ? "\r" : escape === "t" ? "\t" : "\\";
    if (dollar === "$") return "$";
    if (dollar === "&") return found.match![0];
    return found.match![Number(dollar)] ?? "";
  }) : replace;
  return options.preserveCase && found.match ? preserveCase(found.match[0], text) : text;
}

export function replacementFor(state: EditorState, found: FoundMatch, replace: string, options: FindOptions): string {
  const matched = found.match ?? ({ 0: state.sliceDoc(found.from, found.to), length: 1 } as unknown as RegExpExecArray);
  return expandReplacement({ ...found, match: options.regexp || options.preserveCase ? matched : null }, replace, options);
}

export function countLabel(total: number, index: number, capped: boolean): string {
  if (total === 0) return NO_RESULTS;
  return `${index >= 0 ? index + 1 : "?"} of ${total}${capped ? "+" : ""}`;
}

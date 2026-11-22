
export function highlightPattern(query: string, options: { matchCase: boolean; wholeWord: boolean; regex: boolean }): RegExp | null {
  if (!query) return null;
  const body = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(options.wholeWord ? `\\b(?:${body})\\b` : body, options.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

export function matchColumn(text: string, pattern: RegExp | null): number {
  if (!pattern) return 1;
  pattern.lastIndex = 0;
  const m = pattern.exec(text);
  pattern.lastIndex = 0;
  return m && m[0] !== "" ? m.index + 1 : 1;
}

export function searchSummary(matches: number, files: number, truncated: boolean): string {
  const text = `${matches === 1 ? "1 result" : `${matches} results`} - ${files === 1 ? "1 file" : `${files} files`}`;
  return truncated ? `${text} (showing the first matches)` : text;
}

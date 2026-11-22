
export type SearchFlags = { matchCase: boolean; wholeWord: boolean; regex: boolean };

export type MatchRange = { start: number; end: number };

export function searchRegExp(query: string, flags: SearchFlags): RegExp | null {
  if (!query) return null;
  const body = flags.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = flags.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body;
  const base = flags.matchCase ? "g" : "gi";
  try {
    return new RegExp(source, `${base}u`);
  } catch {
    try {
      return new RegExp(flags.wholeWord ? `(?<!\\w)(?:${body})(?!\\w)` : body, base);
    } catch {
      return null;
    }
  }
}

export function findRanges(text: string, pattern: RegExp, limit = 10_000): MatchRange[] {
  const out: MatchRange[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

import { flattenSymbols, type SymbolNode } from "./documentSymbols";
import { prepareQuery, scoreFileItem, type Range } from "./quickOpenScore";

export type SymbolRow =
  | { type: "separator"; label: string }
  | { type: "symbol"; index: number; node: SymbolNode; container: string; labelMatch: Range[]; containerMatch: Range[] };

export type SymbolPicks = { rows: SymbolRow[]; active: number | null; empty: string | null; byCategory: boolean };

export const NO_EDITOR_MESSAGE = "To go to a symbol, first open a text editor with symbol information.";
export const NO_PROVIDER_MESSAGE = "The active text editor does not provide symbol information.";
export const NO_SYMBOLS_MESSAGE = "No editor symbols";
export const NO_MATCH_MESSAGE = "No matching editor symbols";

type Flat = { node: SymbolNode; container: string };

export function symbolList(tree: readonly SymbolNode[]): Flat[] {
  return flattenSymbols(tree)
    .map(({ node, container }) => ({ node, container }))
    .sort((a, b) => a.node.from - b.node.from || b.node.to - a.node.to);
}

export function buildSymbolPicks(list: readonly Flat[], value: string, cursor: number | null): SymbolPicks {
  const rest = value.trim().replace(/^@/, "").trim();
  const byCategory = rest.startsWith(":");
  const filter = byCategory ? rest.slice(1).trim() : rest;
  const matched: { index: number; flat: Flat; score: number | null; labelMatch: Range[]; containerMatch: Range[] }[] = [];
  list.forEach((flat, index) => {
    if (!filter) {
      matched.push({ index, flat, score: null, labelMatch: [], containerMatch: [] });
      return;
    }
    const hit = scoreSymbol(flat.node.name, flat.container, filter);
    if (hit) matched.push({ index, flat, ...hit });
  });
  const byScore = (a: (typeof matched)[number], b: (typeof matched)[number]) => (b.score ?? 0) - (a.score ?? 0) || a.index - b.index;
  const sorted = byCategory ? [...matched].sort((a, b) => categoryOf(a.flat.node.kind).localeCompare(categoryOf(b.flat.node.kind)) || byScore(a, b)) : [...matched].sort(byScore);
  const rows: SymbolRow[] = [];
  const toRow = (m: (typeof matched)[number]): SymbolRow => ({ type: "symbol", index: m.index, node: m.flat.node, container: m.flat.container, labelMatch: m.labelMatch, containerMatch: m.containerMatch });
  if (byCategory) {
    let header: { label: string; count: number; row: Extract<SymbolRow, { type: "separator" }> } | null = null;
    let kind = -1;
    for (const m of sorted) {
      if (m.flat.node.kind !== kind) {
        kind = m.flat.node.kind;
        const row = { type: "separator" as const, label: "" };
        header = { label: categoryOf(kind), count: 0, row };
        rows.push(row);
      }
      header!.count++;
      header!.row.label = `${header!.label} (${header!.count})`;
      rows.push(toRow(m));
    }
  } else if (sorted.length) {
    rows.push({ type: "separator", label: `symbols (${sorted.length})` });
    for (const m of sorted) rows.push(toRow(m));
  }
  const empty = rows.length ? null : filter ? NO_MATCH_MESSAGE : NO_SYMBOLS_MESSAGE;
  return { rows, active: rows.length && !filter && cursor !== null ? activeAt(rows, cursor) : null, empty, byCategory };
}

// 커서를 품은 마지막 심볼(문서 순서라 가장 안쪽). 없으면 null(첫 심볼 행이 활성이 된다).
function activeAt(rows: readonly SymbolRow[], cursor: number): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type === "symbol" && row.node.from <= cursor && cursor <= row.node.to) return i;
  }
  return null;
}

function scoreSymbol(name: string, container: string, filter: string) {
  const query = prepareQuery(filter);
  const words = query.values;
  if (words && words.length > 1) {
    const whole = scoreFileItem({ label: name }, { ...query, values: undefined }, true);
    if (whole.score) return { score: whole.score, labelMatch: whole.labelMatch ?? [], containerMatch: [] };
    const first = scoreFileItem({ label: name }, prepareQuery(words[0]!.original), true);
    const others = scoreFileItem({ label: container }, prepareQuery(words.slice(1).map((w) => w.original).join(" ")), true);
    if (!first.score || !others.score) return null;
    return { score: first.score + others.score, labelMatch: first.labelMatch ?? [], containerMatch: others.labelMatch ?? [] };
  }
  const single = scoreFileItem({ label: name }, query, true);
  return single.score ? { score: single.score, labelMatch: single.labelMatch ?? [], containerMatch: [] } : null;
}

const CATEGORY: Record<number, string> = {
  1: "files", 2: "modules", 3: "namespaces", 4: "packages", 5: "classes", 6: "methods", 7: "properties", 8: "fields", 9: "constructors", 10: "enumerations", 11: "interfaces", 12: "functions", 13: "variables", 14: "constants", 15: "strings", 16: "numbers", 17: "booleans", 18: "arrays", 19: "objects", 20: "keys", 22: "enumeration members", 23: "structs", 24: "events", 25: "operators", 26: "type parameters",
};
export const categoryOf = (kind: number) => CATEGORY[kind] ?? "properties";

export function symbolTone(kind: number): "class" | "function" | "variable" | "default" {
  if (kind === 5 || kind === 10 || kind === 24) return "class";
  if (kind === 6 || kind === 9 || kind === 12) return "function";
  if (kind === 8 || kind === 11 || kind === 13 || kind === 22) return "variable";
  return "default";
}

// 일치 범위로 글자를 일치한 조각과 아닌 조각으로 나눈다(일치한 글자는 굵게 파랗게 그린다)
export function splitMatches(text: string, ranges: readonly Range[]): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.start > at) parts.push({ text: text.slice(at, range.start), hit: false });
    parts.push({ text: text.slice(range.start, range.end), hit: true });
    at = range.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

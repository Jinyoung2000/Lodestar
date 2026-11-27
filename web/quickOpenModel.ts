import { displayPath } from "./displayPath";
import { compareScored, mightMatch, prepareQuery, scoreFileItem, type PreparedQuery, type Range, type Scored, type ScoreItem } from "./quickOpenScore";

const EXCLUDED_SEGMENTS = new Set(["node_modules", "bower_components", ".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"]);
const EXCLUDED_SUFFIXES = [".code-search"];

export type QuickOpenPick = {
  key: string;
  path: string;
  label: string;
  description: string;
  labelMatch?: Range[];
  descriptionMatch?: Range[];
  recent: boolean;
};

export type QuickOpenPicks = { history: QuickOpenPick[]; results: QuickOpenPick[]; matched: number };

export type QuickOpenInput = {
  files: string[];
  recent: string[];
  filter: string;
  workspaceDir: string | null;
  includeExcluded: boolean;
  limit?: number;
};

export const QUICK_OPEN_LIMIT = 200;

export function splitLineSuffix(value: string): { filter: string; line?: number; column?: number } {
  const match = /\s?[#:(](\d*)(?:[#:,](\d*))?\)?\s*$/.exec(value);
  if (!match) return { filter: value };
  const line = match[1] === "" ? 1 : Number(match[1]);
  const column = match[2] ? Number(match[2]) : undefined;
  return { filter: value.slice(0, match.index), line: line > 0 ? line : 1, column: column && column > 0 ? column : undefined };
}

export function isExcludedPath(path: string) {
  const segments = path.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true;
  const name = segments[segments.length - 1];
  return EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

type FileIndex = { lower: string[]; excluded: boolean[]; set: Set<string> };
const indexes = new WeakMap<string[], FileIndex>();

function indexOf(files: string[]): FileIndex {
  let index = indexes.get(files);
  if (!index) {
    index = { lower: files.map((f) => f.toLowerCase()), excluded: files.map(isExcludedPath), set: new Set(files) };
    indexes.set(files, index);
  }
  return index;
}

export function describePath(path: string, workspaceDir: string | null): { label: string; description: string; scorePath: string } {
  const slash = path.lastIndexOf("/");
  const label = path.slice(slash + 1);
  const outside = path.startsWith("/") || path.startsWith("../");
  if (!outside || workspaceDir === null) return { label, description: slash < 0 ? "" : path.slice(0, slash), scorePath: path };
  const absolute = path.startsWith("/") ? path : resolveAgainst(workspaceDir, path);
  const folder = displayPath(absolute.slice(0, absolute.lastIndexOf("/")));
  return { label, description: folder, scorePath: `${folder}/${label}` };
}

function resolveAgainst(base: string, relative: string) {
  const parts = base.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

export function buildPicks(input: QuickOpenInput): QuickOpenPicks {
  const { files, recent, filter, workspaceDir, includeExcluded } = input;
  const limit = input.limit ?? QUICK_OPEN_LIMIT;
  const query = prepareQuery(filter);
  const make = (path: string, isRecent: boolean): { pick: QuickOpenPick; item: ScoreItem } => {
    const { label, description, scorePath } = describePath(path, workspaceDir);
    return { pick: { key: `${isRecent ? "r" : "f"}:${path}`, path, label, description, recent: isRecent }, item: { label, description: description || undefined, path: scorePath } };
  };

  if (!query.normalized) return { history: recent.map((path) => make(path, true).pick), results: [], matched: 0 };

  const historyScored: Scored<ScoreItem & { pick: QuickOpenPick }>[] = [];
  for (const path of recent) {
    const { pick, item } = make(path, true);
    const scored = query.containsPathSeparator ? item : { label: item.label };
    const match = scoreFileItem(scored, query, false);
    if (match.score) historyScored.push({ item: { ...scored, pick }, match });
  }
  historyScored.sort((a, b) => compareScored(a, b, query));
  const history = historyScored.map(({ item, match }) => ({ ...item.pick, labelMatch: match.labelMatch, descriptionMatch: match.descriptionMatch }));

  const index = indexOf(files);
  const inHistory = new Set(history.map((pick) => pick.path));
  const scored: Scored<ScoreItem & { pick: QuickOpenPick }>[] = [];
  for (let i = 0; i < files.length; i++) {
    if (!includeExcluded && index.excluded[i]) continue;
    if (!mightMatch(index.lower[i], query) || inHistory.has(files[i])) continue;
    const { pick, item } = make(files[i], false);
    const match = scoreFileItem(item, query, true);
    if (match.score) scored.push({ item: { ...item, pick }, match });
  }
  const results = topScored(scored, limit, query).map(({ item, match }) => ({ ...item.pick, labelMatch: match.labelMatch, descriptionMatch: match.descriptionMatch }));
  return { history, results, matched: scored.length };
}

function topScored<T extends ScoreItem>(scored: Scored<T>[], limit: number, query: PreparedQuery) {
  let kept = scored;
  if (scored.length > limit * 4) {
    const scores = Float64Array.from(scored, (s) => s.match.score).sort();
    const threshold = scores[scores.length - limit];
    kept = scored.filter((s) => s.match.score >= threshold);
  }
  return kept.sort((a, b) => compareScored(a, b, query)).slice(0, limit);
}

export function usableRecent(recent: { workspaceId: string; path: string }[], workspaceId: string | null, files: string[] | undefined) {
  const known = files ? indexOf(files).set : null;
  return recent.filter((f) => f.workspaceId === workspaceId && (!known || known.has(f.path) || f.path.startsWith("../") || f.path.startsWith("/"))).map((f) => f.path);
}

export function routeOf(value: string): { kind: "commands" } | { kind: "gotoSymbol"; query: string } | null {
  if (value.startsWith(">")) return { kind: "commands" };
  if (value.startsWith("@")) return { kind: "gotoSymbol", query: value };
  return null;
}

export function splitByRanges(text: string, ranges: Range[] | undefined): { text: string; hit: boolean }[] {
  if (!ranges?.length) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, text.length);
    if (end <= start) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

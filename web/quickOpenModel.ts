import { displayPath } from "./displayPath";
import { compareScored, mightMatch, prepareQuery, scoreFileItem, type PreparedQuery, type Range, type Scored, type ScoreItem } from "./quickOpenScore";

// 빠른 열기(⌘P)의 목록 계산. 화면 없이 입력(파일 목록, 최근 연 파일, 질의)만으로 행을 만든다.

const EXCLUDED_SEGMENTS = new Set(["node_modules", "bower_components", ".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"]);
const EXCLUDED_SUFFIXES = [".code-search"];

export type QuickOpenPick = {
  key: string;
  // 워크스페이스 기준 경로. 워크스페이스 밖이면 ../ 로 시작하거나 절대 경로다(열 때 그대로 넘긴다).
  path: string;
  label: string;
  // 폴더 경로. 워크스페이스 안이면 상대, 밖이면 ~/ 로 줄인 절대 경로. 워크스페이스 바로 아래 파일이면 빈 문자열.
  description: string;
  labelMatch?: Range[];
  descriptionMatch?: Range[];
  recent: boolean;
};

export type QuickOpenPicks = { history: QuickOpenPick[]; results: QuickOpenPick[]; matched: number };

export type QuickOpenInput = {
  files: string[];
  // 최근 연 파일, 가장 최근이 앞
  recent: string[];
  // 줄 이동 접미사를 뗀 질의
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

// 파일 목록마다 한 번만 만드는 값. 입력할 때마다 5 만 개를 다시 소문자로 바꾸지 않는다.
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

  // 최근 연 파일: 이름만으로(경로를 친 질의면 경로까지) 이어서 맞는 것만. 고른 질의와 같은 규칙으로 정렬한다.
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

// 점수만으로 한도 밖이 확실한 것은 비교 없이 버리고(후보가 수만 개일 때 정렬이 병목), 남은 것만 전체 규칙으로 정렬한다.
function topScored<T extends ScoreItem>(scored: Scored<T>[], limit: number, query: PreparedQuery) {
  let kept = scored;
  if (scored.length > limit * 4) {
    const scores = Float64Array.from(scored, (s) => s.match.score).sort();
    const threshold = scores[scores.length - limit];
    kept = scored.filter((s) => s.match.score >= threshold);
  }
  return kept.sort((a, b) => compareScored(a, b, query)).slice(0, limit);
}

// 최근 연 파일 중 지금도 열 수 있는 것: 이 폴더 안 파일은 목록에 있어야 하고(지워졌거나 무시된 파일은 뺀다), 밖의 파일은 확인할 수 없어 그대로 둔다.
export function usableRecent(recent: { workspaceId: string; path: string }[], workspaceId: string | null, files: string[] | undefined) {
  const known = files ? indexOf(files).set : null;
  return recent.filter((f) => f.workspaceId === workspaceId && (!known || known.has(f.path) || f.path.startsWith("../") || f.path.startsWith("/"))).map((f) => f.path);
}

// 질의 앞머리로 가는 곳: ">" 는 명령 팔레트, "@" 는 심볼 검색
export function routeOf(value: string): { kind: "commands" } | { kind: "symbols"; query: string } | null {
  if (value.startsWith(">")) return { kind: "commands" };
  if (value.startsWith("@")) return { kind: "symbols", query: value.slice(1) };
  return null;
}

// 칸 안에 그릴 조각: 일치한 구간과 아닌 구간으로 자른다.
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

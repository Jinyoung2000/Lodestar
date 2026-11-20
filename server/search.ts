import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { findRanges, searchRegExp, type MatchRange } from "../shared/searchMatch";
import { resolveInside } from "./files";
import { T } from "./strings";

const run = promisify(execFile);
const MAX_MATCHES = 2000;
const MAX_MATCHES_RANGES = 20_000;
const MAX_LINE_CHARS = 400;
const MAX_LINE_CHARS_RANGES = 1000;
// 일치가 아주 긴 줄의 뒤쪽에 있을 때 미리보기를 일치 앞 몇 글자부터 보여 줄지
const WINDOW_LEAD = 100;
const MAX_CONTEXT = 5;
const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export type SearchOptions = { query: string; matchCase: boolean; wholeWord: boolean; regex: boolean; context: number; include?: string; exclude?: string; ignore?: boolean; ranges?: boolean; excludeGlobs?: string[] };

// 사용자가 쓴 패턴 하나를 glob 들로 푼다. 슬래시가 없는 패턴(`*.ts`, `node_modules`)은 어느 깊이에서든 파일 이름이나 폴더 이름에 맞고, 폴더면 그 안 전체에도 맞는다. 슬래시가 있으면 작업 폴더 기준 경로다.
export function globVariants(pattern: string): string[] {
  const anchored = pattern.trim().startsWith("./");
  const p = pattern.trim().replace(/^\.\//, "");
  if (!p) return [];
  if (!p.includes("/") && !anchored) return [`**/${p}`, `**/${p}/**`];
  const rooted = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return rooted ? [rooted, `${rooted}/**`] : [];
}

export const splitPatterns = (text: string | undefined): string[] => (text ?? "").split(",").flatMap(globVariants);
// ranges 와 offset 은 ranges 모드의 일치한 줄에만 있다. ranges 는 text 안의 구간이고, 줄이 길어 앞을 잘랐으면 offset 은 text 가 줄의 몇 번째 글자에서 시작하는지다.
export type SearchRow = { line: number; text: string; match: boolean; ranges?: MatchRange[]; offset?: number };
export type SearchFile = { path: string; rows: SearchRow[] };
export type SearchResponse = { files: SearchFile[]; matches: number; truncated: boolean; engine: "rg" | "git" };
// raw 는 자르지 않은 줄, spans 는 엔진이 알려 준 일치 구간(rg 만)이다.
export type Hit = { path: string; line: number; text: string; raw?: string; spans?: MatchRange[] };

// ripgrep 은 시험이 경로를 직접 줄 수 있다(undefined 면 PATH 에서 찾고, null 이면 git grep).
export async function searchWorkspace(dir: string, options: SearchOptions, ripgrep?: string | null): Promise<SearchResponse> {
  const query = options.query;
  if (!query.trim()) return { files: [], matches: 0, truncated: false, engine: "git" };
  const context = options.ranges ? 0 : Math.max(0, Math.min(MAX_CONTEXT, Math.floor(options.context) || 0));
  const rg = ripgrep === undefined ? await findRipgrep() : ripgrep;
  const { hits, truncated } = rg ? await grepWithRipgrep(rg, dir, options) : await grepWithGit(dir, options);
  const files = await withContext(dir, hits, context, options.ranges ? { pattern: searchRegExp(query, options) } : undefined);
  const matches = options.ranges ? files.reduce((sum, file) => sum + file.rows.reduce((n, row) => n + (row.match ? Math.max(1, row.ranges?.length ?? 0) : 0), 0), 0) : hits.length;
  return { files, matches, truncated, engine: rg ? "rg" : "git" };
}

let ripgrep: Promise<string | null> | null = null;
export function findRipgrep(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env !== process.env) return locateRipgrep(env);
  ripgrep ??= locateRipgrep(env);
  return ripgrep;
}

const VSCODE_RG_DIR = "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin";

async function locateRipgrep(env: NodeJS.ProcessEnv) {
  const vscodeRg = join(VSCODE_RG_DIR, process.arch === "arm64" ? "darwin-arm64" : "darwin-x64");
  const dirs = [...(env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".cargo", "bin"), vscodeRg].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, "rg");
    try {
      accessSync(candidate, constants.X_OK);
      await run(candidate, ["--version"], { timeout: 3000 });
      return candidate;
    } catch {
      // 이 위치에는 없다
    }
  }
  return null;
}

// 사용자가 쓴 exclude 에, ignore 가 켜졌을 때만 설정의 제외 패턴을 더한다.
function excludePatterns(o: SearchOptions): string[] {
  const own = splitPatterns(o.exclude);
  if (o.ignore === false || !o.excludeGlobs) return own;
  return [...own, ...o.excludeGlobs.flatMap(globVariants)];
}

async function grepWithRipgrep(bin: string, dir: string, o: SearchOptions) {
  const globs = [...splitPatterns(o.include).flatMap((g) => ["--glob", g]), ...excludePatterns(o).flatMap((g) => ["--glob", `!${g}`])];
  const args = ["--json", "--no-config", "--sort", "path", "--hidden", "--glob", "!.git", ...(o.ignore === false ? ["--no-ignore"] : []), o.matchCase ? "--case-sensitive" : "--ignore-case", ...(o.regex ? [] : ["--fixed-strings"]), ...(o.wholeWord ? ["--word-regexp"] : []), ...globs, "--max-columns", "2000", "-e", o.query, "--", "."];
  const out = await grep(bin, args, dir);
  return parseRipgrepJson(out, o.ranges ? MAX_MATCHES_RANGES : MAX_MATCHES);
}

async function grepWithGit(dir: string, o: SearchOptions) {
  const inRepo = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir }).then(
    () => true,
    () => false,
  );
  const pathspecs = [...splitPatterns(o.include).map((g) => `:(glob)${g}`), ...excludePatterns(o).map((g) => `:(exclude,glob)${g}`)];
  // git grep 은 추적하는 파일과 추적하지 않는 파일(.gitignore 가 가린 것은 제외)만 본다. ignore 를 끄는 옵션이 없어 그때도 같은 범위다(rg 가 있으면 rg 가 끈다).
  const args = ["grep", "-n", "-I", "-z", ...(inRepo ? ["--untracked"] : ["--no-index", "--exclude-standard"]), ...(o.matchCase ? [] : ["-i"]), ...(o.regex ? ["-E"] : ["-F"]), ...(o.wholeWord ? ["-w"] : []), "-e", o.query, "--", ...pathspecs];
  const out = await grep("git", args, dir);
  return parseGitGrep(out, o.ranges ? MAX_MATCHES_RANGES : MAX_MATCHES);
}

// 일치가 없으면 두 도구 모두 종료 코드 1 이다. 그 밖의 실패(정규식 오류 등)는 stderr 의 첫 줄을 그대로 알린다.
async function grep(bin: string, args: string[], cwd: string) {
  try {
    const { stdout } = await run(bin, args, { cwd, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS });
    return stdout;
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; message: string };
    if (failed.code === 1) return failed.stdout ?? "";
    if (failed.killed) throw new Error(T.errSearchTimeout);
    const reason = (failed.stderr ?? "").split("\n").find((line) => line.trim()) ?? failed.message;
    throw new Error(reason.replace(/^(fatal|error): /i, ""));
  }
}

// rg 가 알려 주는 일치 구간은 UTF-8 바이트 오프셋이다. 줄 안의 UTF-16 글자 위치로 바꾼다.
function byteSpansToUnits(raw: string, spans: { start: number; end: number }[]): MatchRange[] {
  // 줄이 전부 ASCII 면 바이트와 글자가 같다
  if (Buffer.byteLength(raw) === raw.length) return spans.map((span) => ({ start: span.start, end: span.end }));
  const bytes = Buffer.from(raw);
  const unit = (offset: number) => bytes.subarray(0, offset).toString("utf8").length;
  return spans.map((span) => ({ start: unit(span.start), end: unit(span.end) }));
}

// `rg --json` 의 한 줄이 한 사건이다. match 사건만 읽는다(path.text, line_number, lines.text, submatches).
export function parseRipgrepJson(out: string, max = MAX_MATCHES): { hits: Hit[]; truncated: boolean } {
  const hits: Hit[] = [];
  for (const raw of out.split("\n")) {
    if (!raw) continue;
    let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string }; submatches?: { start: number; end: number }[] } };
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (event.type !== "match" || !event.data?.path?.text || !event.data.line_number) continue;
    if (hits.length >= max) return { hits, truncated: true };
    const lineText = (event.data.lines?.text ?? "").replace(/\r?\n$/, "");
    const spans = event.data.submatches?.length ? byteSpansToUnits(event.data.lines?.text ?? "", event.data.submatches).filter((s) => s.end > s.start) : undefined;
    hits.push({ path: event.data.path.text.replace(/^\.\//, ""), line: event.data.line_number, text: trimLine(lineText), raw: lineText, spans });
  }
  return { hits, truncated: false };
}

// `git grep -n -z` 는 `경로 NUL 줄번호 NUL 본문` 이다.
export function parseGitGrep(out: string, max = MAX_MATCHES): { hits: Hit[]; truncated: boolean } {
  const hits: Hit[] = [];
  for (const raw of out.split("\n")) {
    const first = raw.indexOf("\0");
    const second = first === -1 ? -1 : raw.indexOf("\0", first + 1);
    if (second === -1) continue;
    const line = Number(raw.slice(first + 1, second));
    if (!Number.isInteger(line)) continue;
    if (hits.length >= max) return { hits, truncated: true };
    const lineText = raw.slice(second + 1).replace(/\r$/, "");
    hits.push({ path: raw.slice(0, first), line, text: trimLine(lineText), raw: lineText });
  }
  return { hits, truncated: false };
}

const trimLine = (text: string) => {
  const line = text.replace(/\r?\n$/, "");
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
};

// ranges 모드의 일치한 줄. 일치 구간은 엔진이 알려 준 것, 없으면(git grep) 검색 조건을 JS 정규식으로 바꿔 줄에서 다시 찾은 것이다.
// 줄이 MAX_LINE_CHARS_RANGES 를 넘으면 첫 일치 앞 WINDOW_LEAD 글자부터 그 길이만 보낸다.
function matchRow(hit: Hit, pattern: RegExp | null): SearchRow {
  const raw = hit.raw ?? hit.text;
  const spans = hit.spans ?? (pattern ? findRanges(raw, pattern) : []);
  if (raw.length <= MAX_LINE_CHARS_RANGES) return { line: hit.line, text: raw, match: true, ranges: spans };
  const offset = spans.length > 0 ? Math.max(0, spans[0].start - WINDOW_LEAD) : 0;
  const text = raw.slice(offset, offset + MAX_LINE_CHARS_RANGES);
  const ranges = spans.filter((s) => s.start >= offset && s.end <= offset + text.length).map((s) => ({ start: s.start - offset, end: s.end - offset }));
  return { line: hit.line, text, match: true, ranges, ...(offset > 0 ? { offset } : {}) };
}

// 일치한 줄에 앞뒤 `context` 줄을 붙여 파일별로 묶는다. 줄이 겹치면 한 번만 나온다.
// detail 이 있으면 ranges 모드다: 일치한 줄마다 일치 구간을 붙이고 줄을 MAX_LINE_CHARS_RANGES 까지 보낸다.
export async function withContext(dir: string, hits: Hit[], context: number, detail?: { pattern: RegExp | null }): Promise<SearchFile[]> {
  const byFile = new Map<string, Hit[]>();
  for (const hit of hits) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit]);
  const files: SearchFile[] = [];
  for (const [path, fileHits] of byFile) {
    const rows = new Map<number, SearchRow>();
    if (context > 0) {
      const lines = await readLines(dir, path);
      for (const hit of fileHits) {
        for (let n = Math.max(1, hit.line - context); n <= Math.min(lines.length, hit.line + context); n++) if (!rows.has(n)) rows.set(n, { line: n, text: trimLine(lines[n - 1]), match: false });
      }
    }
    for (const hit of fileHits) rows.set(hit.line, detail ? matchRow(hit, detail.pattern) : { line: hit.line, text: hit.text, match: true });
    files.push({ path, rows: [...rows.values()].sort((a, b) => a.line - b.line) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function readLines(dir: string, path: string) {
  try {
    const lines = (await readFile(resolveInside(dir, path), "utf8")).split("\n");
    // 끝 개행 뒤의 빈 조각은 줄이 아니다
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.map((line) => line.replace(/\r$/, ""));
  } catch {
    return [] as string[];
  }
}

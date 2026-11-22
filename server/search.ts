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
const WINDOW_LEAD = 100;
const MAX_CONTEXT = 5;
const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export type SearchOptions = { query: string; matchCase: boolean; wholeWord: boolean; regex: boolean; context: number; include?: string; exclude?: string; ignore?: boolean; ranges?: boolean; excludeGlobs?: string[] };

export function globVariants(pattern: string): string[] {
  const anchored = pattern.trim().startsWith("./");
  const p = pattern.trim().replace(/^\.\//, "");
  if (!p) return [];
  if (!p.includes("/") && !anchored) return [`**/${p}`, `**/${p}/**`];
  const rooted = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return rooted ? [rooted, `${rooted}/**`] : [];
}

export const splitPatterns = (text: string | undefined): string[] => (text ?? "").split(",").flatMap(globVariants);
export type SearchRow = { line: number; text: string; match: boolean; ranges?: MatchRange[]; offset?: number };
export type SearchFile = { path: string; rows: SearchRow[] };
export type SearchResponse = { files: SearchFile[]; matches: number; truncated: boolean; engine: "rg" | "git" };
export type Hit = { path: string; line: number; text: string; raw?: string; spans?: MatchRange[] };

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
    }
  }
  return null;
}

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
  const args = ["grep", "-n", "-I", "-z", ...(inRepo ? ["--untracked"] : ["--no-index", "--exclude-standard"]), ...(o.matchCase ? [] : ["-i"]), ...(o.regex ? ["-E"] : ["-F"]), ...(o.wholeWord ? ["-w"] : []), "-e", o.query, "--", ...pathspecs];
  const out = await grep("git", args, dir);
  return parseGitGrep(out, o.ranges ? MAX_MATCHES_RANGES : MAX_MATCHES);
}

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
  if (Buffer.byteLength(raw) === raw.length) return spans.map((span) => ({ start: span.start, end: span.end }));
  const bytes = Buffer.from(raw);
  const unit = (offset: number) => bytes.subarray(0, offset).toString("utf8").length;
  return spans.map((span) => ({ start: unit(span.start), end: unit(span.end) }));
}

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

function matchRow(hit: Hit, pattern: RegExp | null): SearchRow {
  const raw = hit.raw ?? hit.text;
  const spans = hit.spans ?? (pattern ? findRanges(raw, pattern) : []);
  if (raw.length <= MAX_LINE_CHARS_RANGES) return { line: hit.line, text: raw, match: true, ranges: spans };
  const offset = spans.length > 0 ? Math.max(0, spans[0].start - WINDOW_LEAD) : 0;
  const text = raw.slice(offset, offset + MAX_LINE_CHARS_RANGES);
  const ranges = spans.filter((s) => s.start >= offset && s.end <= offset + text.length).map((s) => ({ start: s.start - offset, end: s.end - offset }));
  return { line: hit.line, text, match: true, ranges, ...(offset > 0 ? { offset } : {}) };
}

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
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.map((line) => line.replace(/\r$/, ""));
  } catch {
    return [] as string[];
  }
}

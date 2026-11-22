import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { REPLACE_MAX_EDITS_PER_FILE, REPLACE_MAX_FILES, type ReplaceEdit, type ReplaceFileRequest, type ReplaceFileResult } from "../shared/searchReplace";
import { resolveWritable } from "./files";
import { realDir } from "./paths";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export type ReplaceResponse = { results: ReplaceFileResult[] };

let queue: Promise<unknown> = Promise.resolve();

export async function replaceInWorkspace(dir: string, files: ReplaceFileRequest[]): Promise<ReplaceResponse> {
  assertWithinLimits(files);
  const run = queue.then(() => replaceFiles(dir, files));
  queue = run.catch(() => undefined);
  return run;
}

function assertWithinLimits(files: unknown): asserts files is ReplaceFileRequest[] {
  if (!Array.isArray(files)) throw new Error("files must be an array");
  if (files.length > REPLACE_MAX_FILES) throw new Error(`Too many files: ${files.length} (limit ${REPLACE_MAX_FILES})`);
  for (const file of files) {
    const edits = (file as { edits?: unknown } | null)?.edits;
    if (Array.isArray(edits) && edits.length > REPLACE_MAX_EDITS_PER_FILE) throw new Error(`Too many edits in one file: ${edits.length} (limit ${REPLACE_MAX_EDITS_PER_FILE})`);
  }
}

async function replaceFiles(dir: string, files: ReplaceFileRequest[]): Promise<ReplaceResponse> {
  const results: ReplaceFileResult[] = [];
  const seen = new Set<string>();
  for (const file of files) results.push(await replaceOne(dir, file, seen));
  return { results };
}

async function replaceOne(dir: string, file: ReplaceFileRequest, seen: Set<string>): Promise<ReplaceFileResult> {
  const path = typeof file?.path === "string" ? file.path : "";
  try {
    return await replaceFile(dir, path, file, seen);
  } catch (error) {
    return failureOf(path, error);
  }
}

async function replaceFile(dir: string, path: string, file: ReplaceFileRequest, seen: Set<string>): Promise<ReplaceFileResult> {
  const real = await locate(dir, path);
  if (typeof real !== "string") return real;
  if (seen.has(real)) return error(path, "The same file appears twice in this request");
  seen.add(real);

  const edits = readEdits(file.edits);
  if (typeof edits === "string") return error(path, edits);

  const info = await stat(real);
  if (!info.isFile()) return error(path, "Not a regular file");
  if (info.size > MAX_FILE_BYTES) return error(path, `File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  try {
    await access(real, constants.W_OK);
  } catch {
    return error(path, "File is read-only");
  }

  const original = await readFile(real);
  const decoded = decodeUtf8(original);
  if (decoded === null) return error(path, "File is not UTF-8 text");

  const spliced = splice(decoded.text, edits);
  if (spliced === "conflict") return { path, status: "conflict", applied: 0, message: "The file changed since the search" };
  if (spliced === decoded.text) return { path, status: "applied", applied: edits.length };

  const output = Buffer.concat([decoded.bom ? BOM : Buffer.alloc(0), Buffer.from(spliced, "utf8")]);
  if (!(await writeAtomically(real, info, original, output))) return { path, status: "conflict", applied: 0, message: "The file changed while writing" };
  return { path, status: "applied", applied: edits.length };
}

async function locate(dir: string, path: string): Promise<string | ReplaceFileResult> {
  if (!path || path.includes("\0")) return error(path, "Invalid path");
  let absolute: string;
  try {
    absolute = resolveWritable(dir, path);
  } catch {
    return { path, status: "outsideWorkspace", applied: 0, message: "Path is outside the workspace" };
  }
  let real: string;
  try {
    real = await realpath(absolute);
  } catch (caught) {
    if (isMissing(caught)) return { path, status: "notFound", applied: 0, message: "File not found" };
    throw caught;
  }
  const root = realDir(dir);
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) return { path, status: "outsideWorkspace", applied: 0, message: "Path is outside the workspace" };
  if (rel.split(/[\\/]/).includes(".git")) return error(path, "Refusing to edit files inside .git");
  return real;
}

type Position = { line: number; col: number };
type ParsedEdit = { start: Position; end: Position; expected: string; replacement: string };

function readEdits(raw: ReplaceEdit[]): ParsedEdit[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "No edits";
  const edits: ParsedEdit[] = [];
  for (const edit of raw) {
    const range = edit?.range;
    const numbers = range ? [range.startLine, range.startCol, range.endLine, range.endCol] : [];
    if (numbers.length !== 4 || !numbers.every((n) => Number.isSafeInteger(n) && n >= 0)) return "Invalid range";
    if (typeof edit.expected !== "string" || typeof edit.replacement !== "string") return "expected and replacement must be strings";
    const start = { line: range.startLine, col: range.startCol };
    const end = { line: range.endLine, col: range.endCol };
    if (compare(start, end) > 0) return "Range ends before it starts";
    edits.push({ start, end, expected: edit.expected, replacement: edit.replacement });
  }
  edits.sort((a, b) => compare(a.start, b.start) || compare(a.end, b.end));
  for (let i = 1; i < edits.length; i++) {
    const before = edits[i - 1];
    const after = edits[i];
    const sameSpot = compare(before.start, after.start) === 0 && compare(before.end, after.end) === 0;
    if (sameSpot || compare(after.start, before.end) < 0) return "Edits overlap";
  }
  return edits;
}

const compare = (a: Position, b: Position) => a.line - b.line || a.col - b.col;

function splice(text: string, edits: ParsedEdit[]): string | "conflict" {
  const lines = lineStarts(text);
  const spans: { from: number; to: number; replacement: string }[] = [];
  for (const edit of edits) {
    const from = offsetOf(text, lines, edit.start);
    const to = offsetOf(text, lines, edit.end);
    if (from === null || to === null) return "conflict";
    if (lf(text.slice(from, to)) !== lf(edit.expected)) return "conflict";
    spans.push({ from, to, replacement: edit.replacement });
  }
  const eol = dominantEol(text);
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const { from, to, replacement } = spans[i];
    out = out.slice(0, from) + withEol(replacement, eol) + out.slice(to);
  }
  return out;
}

const lf = (value: string) => value.replace(/\r\n/g, "\n");

function lineStarts(text: string) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function offsetOf(text: string, starts: number[], position: Position) {
  if (position.line >= starts.length) return null;
  const lineStart = starts[position.line];
  let lineEnd = position.line + 1 < starts.length ? starts[position.line + 1] - 1 : text.length;
  if (position.line + 1 < starts.length && text[lineEnd - 1] === "\r") lineEnd--;
  return lineStart + position.col <= lineEnd ? lineStart + position.col : null;
}

function dominantEol(text: string) {
  let crlf = 0;
  let total = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    total++;
    if (text[i - 1] === "\r") crlf++;
  }
  return crlf > total - crlf ? "\r\n" : "\n";
}

const withEol = (replacement: string, eol: string) => (eol === "\n" ? lf(replacement) : lf(replacement).replace(/\n/g, eol));

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function decodeUtf8(buffer: Buffer): { text: string; bom: boolean } | null {
  if (buffer.includes(0)) return null;
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) return null;
  const bom = buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? buffer.subarray(3) : buffer), bom };
  } catch {
    return null;
  }
}

async function writeAtomically(real: string, info: Stats, original: Buffer, output: Buffer) {
  const temp = join(dirname(real), `.${basename(real)}.lodestar-replace-${randomBytes(6).toString("hex")}~`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(output);
    try {
      await handle.chown(info.uid, info.gid);
    } catch {
    }
    await handle.chmod(info.mode & 0o7777);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const again = await readFile(real).catch(() => null);
    if (!again || !again.equals(original)) return false;
    await rename(temp, real);
    return true;
  } finally {
    await rm(temp, { force: true });
  }
}

function isMissing(caught: unknown) {
  const code = (caught as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const error = (path: string, message: string): ReplaceFileResult => ({ path, status: "error", applied: 0, message });

function failureOf(path: string, caught: unknown): ReplaceFileResult {
  if (isMissing(caught)) return { path, status: "notFound", applied: 0, message: "File not found" };
  return error(path, caught instanceof Error ? caught.message : String(caught));
}

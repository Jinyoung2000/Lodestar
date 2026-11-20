import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { REPLACE_MAX_EDITS_PER_FILE, REPLACE_MAX_FILES, type ReplaceEdit, type ReplaceFileRequest, type ReplaceFileResult } from "../shared/searchReplace";
import { resolveWritable } from "./files";
import { realDir } from "./paths";

// Search 뷰의 바꾸기(Replace, Replace All in File, Replace All)가 부르는 파일 쓰기. 치환 글은 화면이 이미 계산해서 edits 로 보낸다.
// 쓰기는 사람이 에디터에서 저장하는 것과 같은 길이다(files.save 처럼 resolveWritable 로 경로를 검사하고 세션 변경 장부는 건드리지 않는다).
// 장부(server/sessionTouch.ts)는 에이전트의 편집 도구 훅만 기록하므로 여기서 쓴 파일은 에이전트가 만진 파일로 들어가지 않는다.
// 파일마다 전부 쓰거나 하나도 쓰지 않는다. 파일 사이는 독립이라 어떤 파일의 conflict 가 다른 파일의 쓰기를 막지는 않는다.
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export type ReplaceResponse = { results: ReplaceFileResult[] };

// 호출이 겹치면 같은 파일을 두 번 읽고 쓰다 서로 덮을 수 있어서 한 번에 하나씩 처리한다.
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

// 요청 경로를 실제 파일 경로로 바꾼다. 작업 폴더 밖이면 outsideWorkspace, 없으면 notFound 결과를 돌려준다.
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

// 모양이 틀리거나 겹치면 오류 문구를, 아니면 시작 위치 순으로 정렬한 편집을 돌려준다.
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

// 모든 편집 위치의 지금 글이 expected 와 같을 때만 뒤에서부터 끼워 넣는다. 하나라도 다르면 "conflict".
// 줄은 \n 으로 나눈다(\r\n 의 \r 은 줄 끝 표시라 열 계산에서 뺀다). 홀로 있는 \r 은 줄바꿈이 아니다.
// expected 는 줄바꿈 표기(\r\n 과 \n)를 가리지 않고 비교한다. 에디터 모델은 \n 으로 합쳐 보기 때문이다.
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

// 줄 끝 표시(\n 이나 \r\n)는 열 수에 들어가지 않는다. 범위를 벗어나면 null.
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

// UTF-8 만 받는다. NUL 이 든 파일(이진, 앞뒤 NUL 이 많은 UTF-16 포함)과 UTF-16 BOM 과 깨진 바이트열은 null. UTF-8 BOM 은 떼어 두고 쓸 때 다시 붙인다.
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

// 같은 폴더에 임시 파일을 만들어 원래 권한과 소유자를 옮기고 rename 한다. 이름 끝의 ~ 는 변경 감시(workspaceWatch)가 잡음으로 거르는 표시다.
// rename 직전에 파일이 읽었을 때와 같은지 한 번 더 본다. 다르면 쓰지 않고 false.
// 하드 링크는 rename 으로 끊어지고 확장 속성(xattr)은 옮기지 않는다.
async function writeAtomically(real: string, info: Stats, original: Buffer, output: Buffer) {
  const temp = join(dirname(real), `.${basename(real)}.lodestar-replace-${randomBytes(6).toString("hex")}~`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(output);
    try {
      await handle.chown(info.uid, info.gid);
    } catch {
      // 소유자를 못 바꾸는 사용자면 그대로 둔다
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

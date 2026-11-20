// FILEATTACH: 입력창에 붙인 이미지가 아닌 파일. 두 가지 일을 한다.
// 1) 보내기: 화면이 준 파일 참조(path, name, bytes)를 확인해 말풍선 칩과 모델에 갈 첨부 파일 블록으로 바꾼다. 내용은 읽지 않는다.
// 2) 업로드 폴백: 화면이 실제 경로를 모르는 파일(브라우저로 붙은 창, 경로 없는 File, 옛 preload)을 POST /attachments 로 받아 ~/.agent-nav/attachments/<id>/<이름> 에 스트리밍으로 저장한다.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isUsablePath, MAX_FILE_BYTES, MAX_FILES, sanitizeFileName, withFileBlock, type FileDrop } from "../shared/files";
import type { FileRef, UserAttachment } from "../shared/protocol";
import { HOME } from "./store";

export const ATTACH_DIR = join(HOME, "attachments");
const ID_RE = /^[0-9a-f-]{36}$/;

export type ResolvedFiles = { files: FileDrop[]; chips: UserAttachment[]; model: (prompt: string) => string };

// 화면이 보낸 파일 참조를 확인한다. 경로는 절대 경로이고 지금도 일반 파일이어야 하며, 크기는 화면이 준 값이 아니라 지금 디스크의 값이다.
// 파일이 사라졌거나(옮김, 삭제, 임시 업로드 정리) 폴더면 던진다. 화면은 입력을 그대로 두고 이유를 알려, 사용자가 다시 붙일 수 있다.
export async function resolveFiles(refs: FileRef[] | undefined): Promise<ResolvedFiles> {
  if (!refs?.length) return { files: [], chips: [], model: (prompt) => prompt };
  if (!Array.isArray(refs) || refs.length > MAX_FILES) throw new Error(`You can attach up to ${MAX_FILES} files to a message`);
  const files: FileDrop[] = [];
  for (const ref of refs) {
    const name = sanitizeFileName(typeof ref?.name === "string" ? ref.name : "");
    if (!isUsablePath(ref?.path)) throw new Error(`${name}: not a usable file path`);
    const info = await stat(ref.path).catch(() => null);
    if (!info?.isFile()) throw new Error(`${name}: the file is gone or is not a regular file. Attach it again.`);
    if (info.size === 0) throw new Error(`${name}: the file is empty`);
    files.push({ path: ref.path, name, bytes: info.size, mediaType: typeof ref.mediaType === "string" ? ref.mediaType.replace(/[^\x21-\x7e]/g, "").slice(0, 100) : "" });
  }
  const chips = files.map((f) => ({ kind: "file" as const, label: f.name, path: f.path, bytes: f.bytes }));
  return { files, chips, model: (prompt) => withFileBlock(prompt, files) };
}

// 칩을 보내기 전에 지웠을 때 업로드해 둔 파일을 지운다. id 는 uuid 만 받는다.
export async function discardUpload(id: unknown): Promise<null> {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("invalid attachment id");
  await rm(join(ATTACH_DIR, id), { recursive: true, force: true });
  return null;
}

export type UploadGuard = {
  token: string;
  origins: ReadonlySet<string>;
  dir?: string;
  maxBytes?: number;
};

// POST /attachments?name=<파일 이름>. 본문은 파일 원본 바이트이고 Content-Length 가 필수다.
// 검사 순서: Origin(허용 목록에 있어야 하고 없으면 거절) -> 토큰(x-agent-nav-token, 상수 시간 비교) -> Content-Length(없으면 411, 상한 초과면 413) -> 이름 정리 -> 스트리밍 저장(받는 바이트가 상한이나 선언 길이를 넘으면 끊고 지움).
// Host 검사는 이 함수 앞의 서버 공통 코드가 이미 한다(DNS rebinding 방어).
export async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL, guard: UploadGuard): Promise<void> {
  const dir = guard.dir ?? ATTACH_DIR;
  const maxBytes = guard.maxBytes ?? MAX_FILE_BYTES;
  const fail = (status: number, error: string) => {
    // 읽지 않은 본문이 남아 있으면 응답을 다 보낸 뒤 연결을 닫는다(큰 업로드를 끝까지 받지 않는다).
    res.setHeader("connection", "close");
    reply(res, status, { error });
    res.on("finish", () => req.socket.destroySoon());
  };
  if (req.method !== "POST") return fail(405, "method not allowed");
  const origin = req.headers.origin ?? "";
  if (!origin || !guard.origins.has(origin)) return fail(403, "forbidden origin");
  if (!sameToken(req.headers["x-agent-nav-token"], guard.token)) return fail(403, "forbidden");
  const length = Number(req.headers["content-length"]);
  if (!Number.isFinite(length) || req.headers["content-length"] === undefined) return fail(411, "content-length required");
  if (length > maxBytes) return fail(413, `Files can be at most ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (length === 0) return fail(400, "the file is empty");

  const name = sanitizeFileName(url.searchParams.get("name") ?? "");
  const id = randomUUID();
  const folder = resolve(dir, id);
  const target = resolve(folder, name);
  // 이름 정리가 경로 조각을 이미 걷어 내지만, 저장 경로가 이 업로드의 폴더 밖이면 쓰지 않는다.
  if (!target.startsWith(folder + sep)) return fail(400, "invalid file name");

  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > length || received > maxBytes) done(new Error("body exceeds the declared length"));
      else done(null, chunk);
    },
  });
  try {
    await mkdir(folder, { recursive: true });
    await pipeline(req, counter, createWriteStream(target, { flags: "wx" }));
    // 연결이 중간에 끊기면 pipeline 이 던지지만, 선언한 길이보다 적게 받고 끝난 경우도 불완전한 파일이라 버린다.
    if (received !== length) throw new Error("incomplete upload");
  } catch (error) {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    if (!res.headersSent && !res.writableEnded) fail(400, error instanceof Error ? error.message : String(error));
    return;
  }
  reply(res, 200, { id, path: target, name, bytes: received });
}

function sameToken(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" }).end(text);
}

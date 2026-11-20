// INLINEMEDIA: 대화 속 이미지와 영상 경로를 미리보기로 읽어도 되는지 정하는 곳(정책)과 읽을 주소를 만드는 곳(서명).
// 바이트를 내보내는 HTTP 쪽은 server/mediaHttp.ts. 두 파일이 같은 sniffMedia 와 크기 상한을 쓴다.
//
// 읽기 허용 규칙(resolveMedia): 경로를 풀어 실제 경로(realpath)로 만든 뒤 아래를 모두 만족해야 한다.
//  1. 실제 경로의 확장자가 이미지(png, jpg, jpeg, gif, webp, svg)나 영상(mp4, mov, webm)이고, 일반 파일이며, 크기 상한 안이고, 앞 바이트가 그 형식이다(이름만 .png 인 글 파일은 거절).
//  2. 실제 경로가 "허용 범위" 안이다: 세션 작업 폴더와 워크스페이스 폴더(resolveReadable, 저장소 루트 포함), 데몬 홈(~/.agent-nav), 에이전트 scratchpad(/tmp/claude-<uid>/).
//     또는 범위 밖이어도 "이 세션 타임라인에 그 경로가 적혀 있는" 절대 경로(~/ 포함)이고 그 이름이 심볼릭 링크가 아니다(예: ~/Desktop/mock.png 를 에이전트가 알려 준 경우).
//  3. 상대 경로는 작업 폴더 기준으로만 풀고, 위 허용 범위 중 폴더들 안일 때만 읽는다(타임라인 근거로는 열리지 않는다).
// 심볼릭 링크는 실제 경로로 비교하므로 허용 범위 안에서 밖을 가리키는 링크는 2번에서 걸린다.
import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { sniffImageType } from "../shared/images";
import { findMediaPaths, isPlausibleMediaPath, mediaKindOf, type MediaKind } from "../shared/media";
import type { MediaInfo, TimelineItem } from "../shared/protocol";
import { realDir } from "./paths";

export const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_INLINE_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_PATHS_PER_CALL = 32;
const HEAD_BYTES = 4096;

export type MediaFile = { real: string; kind: MediaKind; mime: string; size: number; mtimeMs: number };

// 앞 바이트로 실제 형식을 알아낸다. 확장자와 어긋나면 null(.png 인데 JPEG 면 JPEG 로 읽히는 것까지는 괜찮지만 종류가 다르면 거절).
export function sniffMedia(head: Uint8Array, extension: string): { kind: MediaKind; mime: string } | null {
  const ext = extension.toLowerCase();
  if (mediaKindOf(`x.${ext}`) === "image") {
    if (ext === "svg") {
      const text = Buffer.from(head).toString("utf8").replace(/^﻿/, "");
      return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text) ? { kind: "image", mime: "image/svg+xml" } : null;
    }
    const mime = sniffImageType(head);
    return mime ? { kind: "image", mime } : null;
  }
  if (ext === "webm") return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 ? { kind: "video", mime: "video/webm" } : null;
  if (ext === "mp4" || ext === "mov") {
    if (Buffer.from(head.subarray(4, 8)).toString("latin1") !== "ftyp") return null;
    return { kind: "video", mime: ext === "mov" ? "video/quicktime" : "video/mp4" };
  }
  return null;
}

export const extensionOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? "";

export const sizeLimit = (kind: MediaKind) => (kind === "image" ? MAX_INLINE_IMAGE_BYTES : MAX_INLINE_VIDEO_BYTES);

// 실제 경로(realpath 를 푼 뒤의 것)에 있는 파일이 미리보기 대상인지 본다. 일반 파일, 0 바이트 아님, 크기 상한, 앞 바이트 형식.
export async function inspectMediaFile(real: string): Promise<MediaFile | null> {
  if (!isPlausibleMediaPath(real)) return null;
  const info = await lstat(real).catch(() => null);
  if (!info?.isFile() || info.size === 0) return null;
  const handle = await open(real, "r").catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    const sniffed = sniffMedia(head.subarray(0, bytesRead), extensionOf(real));
    if (!sniffed || info.size > sizeLimit(sniffed.kind)) return null;
    return { real, kind: sniffed.kind, mime: sniffed.mime, size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

export type MediaContext = {
  // 세션 작업 폴더. 상대 경로를 푸는 기준이기도 하다.
  cwd: string;
  // 실제 경로가 작업 폴더나 워크스페이스, 그 저장소 안인지(server/files.ts 의 resolveReadable 을 실제 경로에 적용한 것)
  inWorkspace: (real: string) => Promise<boolean>;
  // 데몬 홈(~/.agent-nav)
  daemonHome: string;
  userHome?: string;
  // 이 세션 타임라인에 적힌 이미지와 영상 경로(findMediaPaths 가 뽑은 글자 그대로). 허용 범위 밖의 절대 경로를 열 수 있는 근거다.
  mentioned: () => ReadonlySet<string>;
  // /tmp 가 가리키는 실제 폴더들. 시험이 바꿔 끼운다.
  scratchBases?: string[];
};

function scratchBases() {
  return [...new Set([realDir("/tmp"), realDir(tmpdir())])];
}

// Claude Code 가 세션마다 만드는 임시 폴더: <tmp>/claude-<uid>/<폴더>/<세션>/scratchpad. 같은 사용자의 다른 세션 폴더까지 포함한다(모두 사용자의 에이전트 산출물이다).
export function isAgentScratch(real: string, bases = scratchBases()) {
  return bases.some((base) => real.startsWith(`${base}/claude-`) && /^claude-\d+\//.test(real.slice(base.length + 1)));
}

const isUnder = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

// 경로 하나를 풀어 읽어도 되면 파일 정보를, 아니면 null(없음, 허용 범위 밖, 형식 아님, 크기 초과를 구분하지 않는다).
export async function resolveMedia(raw: string, ctx: MediaContext): Promise<MediaFile | null> {
  if (!isPlausibleMediaPath(raw)) return null;
  const relativePath = !raw.startsWith("/") && !raw.startsWith("~/");
  const absolute = raw.startsWith("~/") ? join(ctx.userHome ?? homedir(), raw.slice(2)) : relativePath ? resolve(ctx.cwd, raw) : raw;
  const real = await realpath(absolute).catch(() => null);
  if (!real) return null;
  const file = await inspectMediaFile(real);
  if (!file) return null;
  const inRange = (await ctx.inWorkspace(real)) || (!relativePath && (isUnder(realDir(ctx.daemonHome), real) || isAgentScratch(real, ctx.scratchBases)));
  if (inRange) return file;
  // 상대 경로는 작업 폴더 기준으로만 열린다. 허용 범위 밖의 절대 경로는 이 세션이 그 경로를 적었을 때만 열고,
  // 적힌 이름이 심볼릭 링크이면 거절한다(링크 이름을 적었다고 링크가 가리키는 다른 파일까지 보이면 안 된다. /tmp 처럼 폴더가 링크인 경우는 괜찮다).
  if (relativePath || !ctx.mentioned().has(raw)) return null;
  return (await lstat(absolute).then((info) => info.isSymbolicLink(), () => true)) ? null : file;
}

// 한 번에 여러 경로를 확인한다. 입력과 같은 길이와 순서로 답하고, 상한을 넘는 경로는 null 이다.
export async function resolveMediaBatch(raws: unknown, ctx: MediaContext, key: Buffer): Promise<(MediaInfo | null)[]> {
  if (!Array.isArray(raws)) throw new Error("paths must be an array");
  return Promise.all(
    raws.map(async (raw: unknown, index) => {
      if (typeof raw !== "string" || index >= MAX_PATHS_PER_CALL) return null;
      const file = await resolveMedia(raw, ctx);
      return file ? { raw, kind: file.kind, mime: file.mime, size: file.size, name: basename(file.real), url: mediaUrl(key, file) } : null;
    }),
  );
}

// 근거 집합: 타임라인의 사용자 메시지, 응답, 도구 입력과 출력, 서브에이전트 요약에서 findMediaPaths 로 뽑은 경로.
// 허용 범위 밖 경로를 열 때만 쓰고, 항목 수와 마지막 항목 길이가 같으면 다시 만들지 않는다.
const mentionCache = new Map<string, { signature: string; paths: ReadonlySet<string> }>();

function textsOf(item: TimelineItem): string[] {
  switch (item.kind) {
    case "user":
      return [item.text, item.shown ?? ""];
    case "assistant":
      return [item.text];
    case "tool":
      return [item.output ?? "", ...Object.values(item.input).filter((value): value is string => typeof value === "string"), item.task?.summary ?? ""];
    default:
      return [];
  }
}

export function mentionedMedia(agentId: string, items: readonly TimelineItem[]): ReadonlySet<string> {
  const last = items[items.length - 1];
  const signature = `${items.length}:${last?.id ?? ""}:${last ? textsOf(last).reduce((sum, text) => sum + text.length, 0) : 0}`;
  const hit = mentionCache.get(agentId);
  if (hit?.signature === signature) return hit.paths;
  const paths = new Set<string>();
  for (const item of items) for (const text of textsOf(item)) for (const path of findMediaPaths(text)) paths.add(path);
  if (mentionCache.size > 200) mentionCache.clear();
  mentionCache.set(agentId, { signature, paths });
  return paths;
}

export const forgetMentions = (agentId: string) => void mentionCache.delete(agentId);

// 서명: 데몬 토큰에서 뽑은 키로 (실제 경로, 수정 시각)에 HMAC 을 건다. 토큰 자체는 주소에 실리지 않고, 주소 하나는 파일 하나만 연다.
// 수정 시각이 주소에 들어가서 에이전트가 같은 경로에 파일을 다시 만들면 새 주소가 되어 캐시가 갱신된다.
export const mediaKey = (token: string) => createHmac("sha256", token).update("agent-nav media url v1").digest();

export function signMedia(key: Buffer, real: string, mtimeMs: number) {
  return createHmac("sha256", key).update(`${real}\0${Math.floor(mtimeMs)}`).digest("base64url");
}

export function verifyMedia(key: Buffer, real: string, mtime: string, signature: string) {
  if (!/^\d{1,16}$/.test(mtime)) return false;
  const expected = Buffer.from(signMedia(key, real, Number(mtime)));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function mediaUrl(key: Buffer, file: Pick<MediaFile, "real" | "mtimeMs">) {
  return `/media?p=${encodeURIComponent(file.real)}&m=${Math.floor(file.mtimeMs)}&s=${signMedia(key, file.real, file.mtimeMs)}`;
}

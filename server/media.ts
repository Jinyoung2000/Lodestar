import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { sniffImageType } from "../shared/images";
import { findMediaPaths, isPlausibleMediaPath, mediaKindOf, type MediaKind } from "../shared/media";
import type { MediaInfo, TimelineItem } from "../shared/protocol";
import { asideShotCopy } from "./asideImages";
import { realDir } from "./paths";

export const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_INLINE_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_PATHS_PER_CALL = 32;
const HEAD_BYTES = 4096;

export type MediaFile = { real: string; kind: MediaKind; mime: string; size: number; mtimeMs: number };

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
  cwd: string;
  inWorkspace: (real: string) => Promise<boolean>;
  daemonHome: string;
  userHome?: string;
  mentioned: () => ReadonlySet<string>;
  scratchBases?: string[];
};

function scratchBases() {
  return [...new Set([realDir("/tmp"), realDir(tmpdir())])];
}

export function isAgentScratch(real: string, bases = scratchBases()) {
  return bases.some((base) => real.startsWith(`${base}/claude-`) && /^claude-\d+\//.test(real.slice(base.length + 1)));
}

const isUnder = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

export async function resolveMedia(raw: string, ctx: MediaContext): Promise<MediaFile | null> {
  if (!isPlausibleMediaPath(raw)) return null;
  const relativePath = !raw.startsWith("/") && !raw.startsWith("~/");
  const absolute = raw.startsWith("~/") ? join(ctx.userHome ?? homedir(), raw.slice(2)) : relativePath ? resolve(ctx.cwd, raw) : raw;
  const found = await realpath(absolute).catch(() => null);
  const copy = found || relativePath ? null : await asideShotCopy(absolute, join(ctx.daemonHome, "tool-shots"));
  const real = found ?? (copy ? await realpath(copy).catch(() => null) : null);
  if (!real) return null;
  const file = await inspectMediaFile(real);
  if (!file) return null;
  const inRange = (await ctx.inWorkspace(real)) || (!relativePath && (isUnder(realDir(ctx.daemonHome), real) || isAgentScratch(real, ctx.scratchBases)));
  if (inRange) return file;
  if (relativePath || !ctx.mentioned().has(raw)) return null;
  return (await lstat(absolute).then((info) => info.isSymbolicLink(), () => true)) ? null : file;
}

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

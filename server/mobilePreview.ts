import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_IMAGE_BYTES, sniffImageType } from "../shared/images";
import { findMediaPaths } from "../shared/media";
import { MOBILE_MEDIA_PATH, type MobilePreview } from "../shared/mobile";
import type { TimelineItem } from "../shared/protocol";
import { HOME } from "./store";
import { imagePath } from "./images";
import { inspectMediaFile, isAgentScratch, mediaUrl } from "./media";

function mentionedFile(item: TimelineItem | undefined, target: string): string | null {
  if (item?.kind === "tool") {
    if (item.status === "done" && /(?:^|__)html_render$/.test(item.name)) return item.input.path === target && /\.html?$/i.test(target) ? target : null;
    return item.status === "done" && ["Write", "Edit", "MultiEdit"].includes(item.name) && (item.input.moved_to ?? item.input.file_path) === target ? target : null;
  }
  if (item?.kind !== "assistant") return null;
  const links = item.text.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g);
  if (Array.from(links).some((m) => (m[1] ?? m[2]) === target)) return decodeURIComponent(target);
  return findMediaPaths(item.text).includes(target) ? target : null;
}

function insideVisible(base: string | null, real: string): boolean {
  if (!base) return false;
  return relative(base, real).split(sep).every((part) => part && !part.startsWith("."));
}

async function insideData(real: string): Promise<boolean> {
  const data = await realpath(HOME).catch(() => HOME);
  return real === data || real.startsWith(data + sep);
}

async function insideHome(real: string): Promise<boolean> {
  const home = await realpath(homedir()).catch(() => null);
  if (!home || await insideData(real)) return false;
  return insideVisible(home, real);
}

async function mentionedImageOutsideData(absolute: string, real: string): Promise<boolean> {
  return isAbsolute(absolute) && real === absolute && /\.(png|jpe?g|gif|webp)$/i.test(real) && !await insideData(real);
}

export async function mobilePreview(root: string | null, item: TimelineItem | undefined, target: string, videoKey?: Buffer): Promise<MobilePreview> {
  if (item?.kind === "tool" && item.status === "done" && /(?:^|__)html_render$/.test(item.name) && target === "rendered-html" && typeof item.input.html === "string") {
    if (Buffer.byteLength(item.input.html) > MAX_IMAGE_BYTES) throw new Error("Previews support files up to 5 MB.");
    return { kind: "html", html: item.input.html };
  }
  let path: string | null = null;
  if (item?.kind === "user" && item.attachments?.some((a) => a.kind === "image" && a.id === target)) {
    path = imagePath(target);
  }
  const shotTarget = /^shot:(\d+)$/.exec(target);
  if (item?.kind === "tool" && shotTarget) {
    const shot = item.shots?.[Number(shotTarget[1])];
    if (shot && dirname(shot) === join(HOME, "tool-shots")) path = shot;
  }
  const raw = mentionedFile(item, target);
  if (raw) {
    const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
    if (root || isAbsolute(expanded)) {
      const base = root ? await realpath(root) : null;
      const absolute = base ? resolve(base, expanded) : expanded;
      const real = await realpath(absolute).catch(() => null);
      if (real && extname(real).toLowerCase() === extname(raw).toLowerCase() && (insideVisible(base, real) || isAgentScratch(real) || await insideHome(real) || await mentionedImageOutsideData(absolute, real))) path = real;
    }
  }
  if (path && videoKey && /\.(mp4|mov|webm)$/i.test(path)) {
    const video = await inspectMediaFile(path);
    if (!video || video.kind !== "video") throw new Error("This video cannot be played. Videos up to 512 MB in MP4, MOV or WebM work.");
    return { kind: "video", uri: mediaUrl(videoKey, video).replace(/^\/media\?/, `${MOBILE_MEDIA_PATH}?`) };
  }
  if (!path || !/\.(html?|png|jpe?g|gif|webp|svg|md|markdown|csv)$/i.test(path)) throw new Error("This file is unavailable in this session.");
  if (!(await stat(path)).isFile()) throw new Error("Choose a regular file.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("Previews support files up to 5 MB.");
    const ext = extname(path).toLowerCase();
    const textFormat = ext === ".md" || ext === ".markdown" ? "markdown" : ext === ".csv" ? "csv" : ext === ".svg" ? "svg" : null;
    if (textFormat && info.size > 256 * 1024) throw new Error("Document previews support files up to 256 KB.");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("The file changed. Open it again.");
      offset += bytesRead;
    }
    if (/\.html?$/i.test(path)) return { kind: "html", html: bytes.toString("utf8") };
    if (textFormat) return { kind: textFormat, text: bytes.toString("utf8") };
    const mime = sniffImageType(bytes);
    if (!mime) throw new Error("Unsupported image format.");
    return { kind: "image", uri: `data:${mime};base64,${bytes.toString("base64")}` };
  } finally {
    await file.close();
  }
}

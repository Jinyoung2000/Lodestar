import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { MAX_IMAGE_BYTES, sniffImageType } from "../shared/images";
import type { MobilePreview } from "../shared/mobile";
import type { TimelineItem } from "../shared/protocol";
import { HOME } from "./store";
import { imagePath } from "./images";

function hasWorkspaceFile(item: TimelineItem | undefined, target: string): boolean {
  if (item?.kind === "tool") {
    if (item.status === "done" && /(?:^|__)html_render$/.test(item.name)) return item.input.path === target && /\.html?$/i.test(target);
    return item.status === "done" && ["Write", "Edit", "MultiEdit"].includes(item.name) && (item.input.moved_to ?? item.input.file_path) === target;
  }
  if (item?.kind !== "assistant") return false;
  const links = item.text.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g);
  return Array.from(links).some((m) => (m[1] ?? m[2]) === target);
}

export async function mobilePreview(root: string | null, item: TimelineItem | undefined, target: string): Promise<MobilePreview> {
  if (item?.kind === "tool" && item.status === "done" && /(?:^|__)html_render$/.test(item.name) && target === "rendered-html" && typeof item.input.html === "string") {
    if (Buffer.byteLength(item.input.html) > MAX_IMAGE_BYTES) throw new Error("Previews support files up to 5 MB.");
    return { kind: "html", html: item.input.html };
  }
  let path: string | null = null;
  if (item?.kind === "user" && item.attachments?.some((a) => a.kind === "image" && a.id === target)) {
    path = imagePath(target);
  }
  if (item?.kind === "tool" && /^shot:\d+$/.test(target)) {
    const shot = item.shots?.[Number(target.slice(4))];
    if (shot && dirname(shot) === join(HOME, "tool-shots")) path = shot;
  }
  if (root && hasWorkspaceFile(item, target)) {
    const base = await realpath(root);
    const raw = item?.kind === "assistant" ? decodeURIComponent(target) : target;
    const real = await realpath(resolve(base, raw)).catch(() => null);
    if (real) {
      const parts = relative(base, real).split(sep);
      if (parts.every((part) => part && !part.startsWith(".")) && extname(real).toLowerCase() === extname(raw).toLowerCase()) path = real;
    }
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

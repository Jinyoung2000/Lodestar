import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function insideVisible(base: string | null, real: string): boolean {
  if (!base) return false;
  return relative(base, real).split(sep).every((part) => part && !part.startsWith("."));
}

async function insideHome(real: string): Promise<boolean> {
  const home = await realpath(homedir()).catch(() => null);
  const data = await realpath(HOME).catch(() => HOME);
  if (!home || real === data || real.startsWith(data + sep)) return false;
  return insideVisible(home, real);
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
  const shotTarget = /^shot:(\d+)$/.exec(target);
  if (item?.kind === "tool" && shotTarget) {
    const shot = item.shots?.[Number(shotTarget[1])];
    if (shot && dirname(shot) === join(HOME, "tool-shots")) path = shot;
  }
  if (hasWorkspaceFile(item, target)) {
    const raw = item?.kind === "assistant" ? decodeURIComponent(target) : target;
    const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
    if (root || isAbsolute(expanded)) {
      const base = root ? await realpath(root) : null;
      const real = await realpath(base ? resolve(base, expanded) : expanded).catch(() => null);
      if (real && extname(real).toLowerCase() === extname(raw).toLowerCase() && (insideVisible(base, real) || await insideHome(real))) path = real;
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

import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME } from "./store";

const MAX_BYTES = 8 * 1024 * 1024;
const MIMES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const EXT = "(png|jpe?g|webp|gif)";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function asideImageAllowed(path: string, home = homedir(), data = HOME): string | null {
  if (path.includes("..") || path.includes("\0") || path.length > 1024) return null;
  const patterns = [
    new RegExp(`^${esc(join(home, ".aside", "u"))}/\\d+/sessions/[\\w.-]+/tmp/repl-display-[\\w-]+\\.${EXT}$`),
    new RegExp(`^${esc(join(home, ".claude", "projects"))}/[^/]+/[^/]+/tool-results/mcp-aside-blob-[\\w-]+\\.${EXT}$`),
    new RegExp(`^${esc(join(data, "tool-shots"))}/[\\w-]+\\.${EXT}$`),
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(path);
    if (m) return MIMES[m[1].toLowerCase()] ?? null;
  }
  return null;
}

export async function readAsideImage(paths: unknown, home = homedir(), data = HOME): Promise<{ mime: string; data: string } | null> {
  if (!Array.isArray(paths)) return null;
  for (const path of paths.slice(0, 4)) {
    if (typeof path !== "string") continue;
    const mime = asideImageAllowed(path, home, data);
    if (!mime) continue;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) continue;
      return { mime, data: (await readFile(path)).toString("base64") };
    } catch {
    }
  }
  return null;
}

const SIGNATURES: { ext: string; test: (b: Buffer) => boolean }[] = [
  { ext: "png", test: (b) => b.subarray(1, 4).toString("latin1") === "PNG" },
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: "gif", test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
];

export async function saveAsideShots(content: unknown, dir = join(HOME, "tool-shots"), keep = 200): Promise<string[]> {
  const parts = Array.isArray(content) ? (content as { type?: string; source?: { type?: string; data?: unknown } }[]) : [];
  const saved: string[] = [];
  for (const part of parts) {
    if (part?.type !== "image" || part.source?.type !== "base64" || typeof part.source.data !== "string") continue;
    const bytes = Buffer.from(part.source.data, "base64");
    const kind = bytes.length > 12 && bytes.length <= MAX_BYTES ? SIGNATURES.find((s) => s.test(bytes)) : undefined;
    if (!kind) continue;
    try {
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${kind.ext}`);
      await writeFile(path, bytes);
      saved.push(path);
    } catch {
    }
  }
  if (saved.length) {
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /\.(png|jpg|webp|gif)$/.test(n)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) await unlink(join(dir, name)).catch(() => undefined);
  }
  return saved;
}

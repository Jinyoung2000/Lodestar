
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"] as const;
export const VIDEO_EXTENSIONS = ["mp4", "mov", "webm"] as const;
export type MediaKind = "image" | "video";

const EXT = "(?:png|jpe?g|gif|webp|svg|mp4|mov|webm)";
const HINT = new RegExp(`\\.${EXT}(?![\\p{L}\\p{N}_])`, "iu");
const ENDS_WITH_EXT = new RegExp(`\\.${EXT}$`, "i");

export const MAX_MEDIA_PER_MESSAGE = 8;
export const MAX_MEDIA_CANDIDATES = 16;
export const MAX_MEDIA_PATH_LENGTH = 1024;

export const mayContainMedia = (text: string) => HINT.test(text);

export function mediaKindOf(path: string): MediaKind | null {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
  if (!extension) return null;
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return "image";
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return "video";
  return null;
}

export function isPlausibleMediaPath(path: string): boolean {
  if (!path || path.length > MAX_MEDIA_PATH_LENGTH || path.includes("\0") || /\\|\n/.test(path)) return false;
  if (path.startsWith("//") || path.split("/").includes("..")) return false;
  return ENDS_WITH_EXT.test(path);
}

const HARD_WRAP = new RegExp(`(~?\\/[^\\s\`]*[\\p{L}\\p{N}_\\-/.])(?<!\\.${EXT})\\n[ \\t]*([^\\s\`/]+\\.${EXT})(?![\\p{L}\\p{N}_])`, "giu");
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
const MD_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g;
const BARE = new RegExp(`(?<![\\p{L}\\p{N}_/.~\\-])(~?\\/(?!\\/)[^\\s\`"'<>()\\[\\]{}|*?,;]+?\\.${EXT})(?![\\p{L}\\p{N}_/\\-]|\\.[\\p{L}\\p{N}])`, "giu");

export function findMediaPaths(text: string, options: { streaming?: boolean } = {}): string[] {
  if (!mayContainMedia(text)) return [];
  const streaming = options.streaming === true;
  const hits: { index: number; path: string }[] = [];
  const add = (index: number, path: string) => {
    if (isPlausibleMediaPath(path)) hits.push({ index, path });
  };
  const blank = (whole: string) => whole.replace(/[^\n]/g, " ");

  const base = text.replace(HARD_WRAP, (_whole, head: string, tail: string) => `${head}${tail}`);

  const lines = base.split("\n");
  let fence: string | null = null;
  let offset = 0;
  const kept = lines.map((line, number) => {
    const start = offset;
    offset += line.length + 1;
    const opening = FENCE.exec(line);
    if (fence === null && opening) {
      fence = opening[1];
      return blank(line);
    }
    if (fence === null) return line;
    if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && line.trim() === opening[1]) fence = null;
    else if (!(streaming && number === lines.length - 1)) {
      const only = line.trim();
      if (/^~?\//.test(only) && !/[`"'<>|*?]/.test(only)) add(start, only);
    }
    return blank(line);
  });
  let rest = kept.join("\n");

  rest = rest.replace(CODE_SPAN, (whole: string, _ticks: string, inner: string, index: number) => {
    const joined = inner.replace(/\s*\n\s*/g, "").trim();
    if (/^~?\//.test(joined) && !joined.includes("`")) {
      add(index, joined);
      return blank(whole);
    }
    return whole;
  });

  rest = rest.replace(MD_IMAGE, (whole: string, angle: string | undefined, plain: string | undefined, index: number) => {
    const target = localImageTarget(angle ?? plain ?? "");
    if (target) add(index, target);
    return blank(whole);
  });

  for (const match of rest.matchAll(BARE)) {
    if (streaming && match.index + match[0].length >= rest.length) continue;
    add(match.index, match[1]);
  }

  const found: string[] = [];
  for (const { path } of hits.sort((a, b) => a.index - b.index)) if (!found.includes(path)) found.push(path);
  return found;
}

export function localImageTarget(target: string): string | null {
  let value = target.trim();
  if (!value || /^(?:https?|data|blob|mailto|ftp):/i.test(value) || value.startsWith("//")) return null;
  value = value.replace(/^file:\/\//i, "").replace(/[?#].*$/, "");
  try {
    value = decodeURIComponent(value);
  } catch {
  }
  return isPlausibleMediaPath(value) ? value : null;
}

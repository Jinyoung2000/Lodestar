import type { TimelineItem } from "@shared/protocol";
import type { MobilePreview } from "@shared/mobile";
import { parseMarkdown, type Token } from "./markdown";

export type PreviewKind = MobilePreview["kind"];
export type Preview = { title: string; itemId: string; kind: PreviewKind; thumb?: string; path?: string; at?: string } & ({ content: MobilePreview } | { target: string });

export const formatLabel: Record<PreviewKind, string> = {
  html: "Interactive HTML", image: "Image", video: "Video", svg: "Vector graphic", markdown: "Markdown", csv: "Spreadsheet",
};

const cache = new WeakMap<TimelineItem, Preview[]>();

function fileKind(path: string): PreviewKind | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "htm" || ext === "html") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "svg" || ext === "csv") return ext;
  if (ext && ["png", "jpeg", "jpg", "webp", "gif"].includes(ext)) return "image";
  if (ext && ["mp4", "mov", "webm"].includes(ext)) return "video";
}

function fromText(kind: Exclude<PreviewKind, "image" | "video">, text: string): MobilePreview {
  return kind === "html" ? { kind, html: text } : { kind, text };
}

export function fencePreview(lang: string, body: string, itemId: string): Preview | undefined {
  const [language, ...name] = lang.trim().split(/\s+/);
  const kind = language.toLowerCase() === "lodestar-preview" ? "html" : fileKind(`.${language}`);
  if (!kind || kind === "image" || kind === "video") return;
  const heading = kind === "markdown" ? body.match(/^#\s+(.+)$/m)?.[1] : body.match(/<title(?:\s[^>]*)?>([^<]{1,160})<\/title>/i)?.[1];
  const title = name.join(" ").trim() || heading?.trim() || formatLabel[kind];
  return { kind, title, itemId, content: fromText(kind, body) };
}

const MEDIA_EXT = "(?:png|jpe?g|gif|webp|svg|mp4|mov|webm)";
const BARE_MEDIA_PATH = new RegExp(`(?<![\\p{L}\\p{N}_/.~\\-])(~?\\/(?!\\/)[^\\s\`"'<>()\\[\\]{}|*?,;]+?\\.${MEDIA_EXT})(?![\\p{L}\\p{N}_/\\-]|\\.[\\p{L}\\p{N}])`, "giu");

export function mediaPathPreview(text: string, itemId: string): Preview | undefined {
  const path = text.trim();
  if (!/^~?\/(?!\/)/.test(path) || path.length > 1024 || /[\n\\`]/.test(path) || path.split("/").includes("..")) return;
  const kind = fileKind(path);
  if (kind !== "image" && kind !== "video" && kind !== "svg") return;
  return { itemId, title: path.split("/").pop() || path, kind, target: path, path };
}

export function bareMediaPaths(text: string): string[] {
  return Array.from(text.matchAll(BARE_MEDIA_PATH), (match) => match[1]);
}

export function tokenPreview(token: Token, itemId: string): Preview | undefined {
  if (token.type === "code") return fencePreview(token.lang ?? "", token.text, itemId);
  if (token.type === "codespan") return mediaPathPreview(token.text, itemId);
  if (token.type !== "image" && token.type !== "link") return;
  const target = String(token.href);
  const title = token.text || target.split("/").pop() || "Image";
  if (token.type === "image" && /^https:\/\//i.test(target)) return { itemId, title, kind: "image", content: { kind: "image", uri: target } };
  if (/^([a-z]+:|\/\/)/i.test(target)) return;
  const kind = fileKind(target);
  if (kind) return { itemId, title, kind, target, path: target };
}

export function messagePreviews(item: TimelineItem): Preview[] {
  const cached = cache.get(item);
  if (cached) return cached;
  const files = previewsOf(item).map((file) => "at" in item && item.at ? { ...file, at: item.at } : file);
  cache.set(item, files);
  return files;
}

export function sessionPreviews(items: readonly TimelineItem[]): Preview[] {
  const paths = new Set<string>();
  const files: Preview[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    for (const file of messagePreviews(items[i])) {
      if (file.path && paths.has(file.path)) continue;
      if (file.path) paths.add(file.path);
      files.push(file);
    }
  }
  return files;
}

function previewsOf(item: TimelineItem): Preview[] {
  const itemId = item.id;
  const files: Preview[] = [];
  if (item.kind === "user") {
    for (const a of item.attachments ?? []) {
      if (a.kind === "image") files.push({ title: a.label, itemId, kind: "image", target: a.id, thumb: a.thumb });
      if (a.kind === "screenshot") files.push({ title: a.label, itemId, kind: "image", content: { kind: "image", uri: a.thumb }, thumb: a.thumb });
    }
    return files;
  }
  if (item.kind === "tool") {
    for (let i = 0; i < (item.shotCount ?? 0); i++) {
      files.push({ itemId, kind: "image", target: `shot:${i}`, title: item.page?.title || `Screenshot ${i + 1}` });
    }
    if (item.status === "done" && /(?:^|__)html_render$/.test(item.name)) {
      const title = typeof item.input.title === "string" ? item.input.title : "HTML preview";
      const html = item.input.html;
      if (typeof html === "string") {
        const clipped = /\n… \(\d+ more characters\)$/.test(html);
        files.push({ itemId, kind: "html", title, ...(clipped ? { target: "rendered-html" } : { content: { kind: "html", html } }) });
      } else if (typeof item.input.path === "string" && fileKind(item.input.path) === "html") {
        files.push({ itemId, kind: "html", title, target: item.input.path, path: item.input.path });
      }
    }
    const path = item.input.moved_to ?? item.input.file_path;
    if (item.status === "done" && ["Write", "Edit", "MultiEdit"].includes(item.name) && typeof path === "string") {
      const kind = fileKind(path);
      if (kind) {
        const title = path.split("/").pop() || path;
        const text = item.input.content;
        const inline = item.name === "Write" && kind !== "image" && kind !== "video" && typeof text === "string" && !/\n… \(\d+ more characters\)$/.test(text);
        files.push({ itemId, kind, title, path, ...(inline ? { content: fromText(kind, text) } : { target: path }) });
      }
    }
    return files;
  }
  if (item.kind !== "assistant" || item.streaming) return files;
  const add = (preview: Preview | undefined) => {
    if (preview && !(preview.path && files.some((file) => file.path === preview.path))) files.push(preview);
  };
  function visit(tokens: Token[]) {
    for (const t of tokens) {
      const preview = tokenPreview(t, itemId);
      if (preview) add(preview);
      else if (t.type === "list") {
        for (const child of t.items) visit(child.tokens);
      } else if ("tokens" in t && Array.isArray(t.tokens)) visit(t.tokens);
      else if (t.type === "text") for (const path of bareMediaPaths(t.text)) add(mediaPathPreview(path, itemId));
    }
  }
  visit(parseMarkdown(item.text));
  return files;
}

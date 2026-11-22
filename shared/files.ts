import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES } from "./images";

export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_FILES = 10;
const MAX_NAME_BYTES = 200;

export type FileProblem = "empty" | "size" | "count" | "folder";

export type FileDrop = { path: string; name: string; bytes: number; mediaType: string };

export type DropClass =
  | { kind: "image" }
  | { kind: "file"; oversizeImage: boolean }
  | { kind: "reject"; problem: FileProblem };

export function classifyDrop(type: string, bytes: number, fileCount: number): DropClass {
  if (bytes === 0) return { kind: "reject", problem: "empty" };
  if (type in IMAGE_EXTENSIONS && bytes <= MAX_IMAGE_BYTES) return { kind: "image" };
  if (bytes > MAX_FILE_BYTES) return { kind: "reject", problem: "size" };
  if (fileCount >= MAX_FILES) return { kind: "reject", problem: "count" };
  return { kind: "file", oversizeImage: type in IMAGE_EXTENSIONS };
}

export function fileProblemText(problem: FileProblem, name: string): string {
  switch (problem) {
    case "empty":
      return `${name}: the file is empty`;
    case "folder":
      return `${name}: folders can't be attached`;
    case "size":
      return `${name}: files can be at most ${MAX_FILE_BYTES / 1024 / 1024 / 1024} GB`;
    case "count":
      return `You can attach up to ${MAX_FILES} files to a message`;
  }
}

export const oversizeImageNotice = (name: string) => `${name}: over ${MAX_IMAGE_BYTES / 1024 / 1024} MB, so it was attached as a file path instead of an image`;

export function sanitizeFileName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
  return fitBytes(cleaned);
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function fitBytes(name: string): string {
  if (byteLength(name) <= MAX_NAME_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  let stem = name.slice(0, name.length - ext.length);
  while (stem.length > 1 && byteLength(stem) + byteLength(ext) > MAX_NAME_BYTES) stem = stem.slice(0, -1);
  if (stem.length > 1 && /[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1);
  return stem + ext;
}

export function isUsablePath(path: unknown): path is string {
  // eslint-disable-next-line no-control-regex
  return typeof path === "string" && path.startsWith("/") && path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(path) && !path.split("/").includes("..");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const FILE_BLOCK_HEADER = "Attached files (open them with your tools; their contents are not included):";

export function fileBlock(files: FileDrop[]): string {
  if (!files.length) return "";
  const lines = files.map((f) => {
    const meta = [f.mediaType, formatBytes(f.bytes)].filter(Boolean).join(", ");
    return `- ${f.path} (${meta})`;
  });
  return [FILE_BLOCK_HEADER, ...lines].join("\n");
}

export function withFileBlock(prompt: string, files: FileDrop[]): string {
  const block = fileBlock(files);
  return block ? (prompt ? `${prompt}\n\n${block}` : block) : prompt;
}

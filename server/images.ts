import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkImage, IMAGE_EXTENSIONS, imageProblemText, MAX_IMAGE_BYTES, sniffImageType } from "../shared/images";
import { HOME } from "./store";

const IMAGES_DIR = join(HOME, "images");
const ID_RE = /^[0-9a-f-]{36}$/;

export type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } };

export function saveImage(params: { mediaType: string; data: string; name: string }): { id: string } {
  const name = params.name.slice(0, 120) || "image";
  if (params.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw new Error(imageProblemText("size", name));
  return saveImageBytes(Buffer.from(params.data, "base64"), params.mediaType, name);
}

export function saveImageBytes(bytes: Buffer, mediaType: string, rawName: string): { id: string } {
  const name = rawName.slice(0, 120) || "image";
  const problem = checkImage(mediaType, bytes.length, 0);
  if (problem) throw new Error(imageProblemText(problem, name));
  const real = sniffImageType(bytes);
  if (!real) throw new Error(imageProblemText("format", name));
  const id = randomUUID();
  mkdirSync(IMAGES_DIR, { recursive: true });
  writeFileSync(join(IMAGES_DIR, `${id}.${IMAGE_EXTENSIONS[real]}`), bytes);
  return { id };
}

export function imagePath(id: string): string | null {
  if (!ID_RE.test(id) || !existsSync(IMAGES_DIR)) return null;
  const file = readdirSync(IMAGES_DIR).find((f) => f.startsWith(`${id}.`));
  return file ? join(IMAGES_DIR, file) : null;
}

export function imageBlock(id: string): ImageBlock | null {
  const path = imagePath(id);
  if (!path) return null;
  const bytes = readFileSync(path);
  const type = sniffImageType(bytes);
  if (!type) return null;
  return { type: "image", source: { type: "base64", media_type: type as ImageBlock["source"]["media_type"], data: bytes.toString("base64") } };
}

export function imageBlocks(attachments: { kind: string; id?: string }[] | undefined): ImageBlock[] {
  return (attachments ?? []).flatMap((a) => {
    const block = a.kind === "image" && a.id ? imageBlock(a.id) : null;
    return block ? [block] : [];
  });
}

export function removeImages(ids: string[]) {
  for (const id of ids) {
    const path = imagePath(id);
    if (path) rmSync(path, { force: true });
  }
}

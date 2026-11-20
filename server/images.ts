// fixB: 입력창 이미지를 ~/.agent-nav/images/<id>.<확장자> 에 저장하고, 모델에 보낼 image 블록으로 읽는다.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkImage, IMAGE_EXTENSIONS, imageProblemText, MAX_IMAGE_BYTES, sniffImageType } from "../shared/images";
import { HOME } from "./store";

const IMAGES_DIR = join(HOME, "images");
const ID_RE = /^[0-9a-f-]{36}$/;

export type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } };

// base64 를 풀어 실제 형식과 크기를 확인한 뒤 저장한다. 형식은 앞머리 바이트로 정하고 브라우저가 알려 준 mediaType 은 거절 판단에만 쓴다.
export function saveImage(params: { mediaType: string; data: string; name: string }): { id: string } {
  const name = params.name.slice(0, 120) || "image";
  if (params.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw new Error(imageProblemText("size", name));
  return saveImageBytes(Buffer.from(params.data, "base64"), params.mediaType, name);
}

// MOBILE: 이미 바이트인 이미지(모바일의 HTTP 업로드)를 같은 검사와 같은 저장 경로로 저장한다.
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

// CODEX: Codex 는 이미지를 파일 경로(localImage)로 받는다
export function imagePath(id: string): string | null {
  if (!ID_RE.test(id) || !existsSync(IMAGES_DIR)) return null;
  const file = readdirSync(IMAGES_DIR).find((f) => f.startsWith(`${id}.`));
  return file ? join(IMAGES_DIR, file) : null;
}

// 저장된 이미지를 모델에 보낼 블록으로. 파일이 사라졌으면 건너뛴다.
export function imageBlock(id: string): ImageBlock | null {
  const path = imagePath(id);
  if (!path) return null;
  const bytes = readFileSync(path);
  const type = sniffImageType(bytes);
  if (!type) return null;
  return { type: "image", source: { type: "base64", media_type: type as ImageBlock["source"]["media_type"], data: bytes.toString("base64") } };
}

// 사용자 메시지에 붙은 첨부 중 이미지 칩의 id 로 블록 목록을 만든다.
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

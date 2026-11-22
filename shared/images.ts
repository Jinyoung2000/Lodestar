
export const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 5;

export type ImageProblem = "format" | "size" | "empty" | "count";

export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}

export function checkImage(type: string, bytes: number, already: number): ImageProblem | null {
  if (already >= MAX_IMAGES) return "count";
  if (!(type in IMAGE_EXTENSIONS)) return "format";
  if (bytes === 0) return "empty";
  if (bytes > MAX_IMAGE_BYTES) return "size";
  return null;
}

export function imageProblemText(problem: ImageProblem, name: string): string {
  switch (problem) {
    case "format":
      return `${name}: only PNG, JPEG, GIF and WebP images can be attached`;
    case "size":
      return `${name}: images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`;
    case "empty":
      return `${name}: the image is empty`;
    case "count":
      return `You can attach up to ${MAX_IMAGES} images to a message`;
  }
}

export function clipboardImageFiles<T extends { type: string }>(data: { files: ArrayLike<T>; types: ArrayLike<string> } | null): T[] {
  if (!data || Array.from(data.types).includes("text/plain")) return [];
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

export const dragHasFiles = (data: { types: ArrayLike<string> } | null) => !!data && Array.from(data.types).includes("Files");

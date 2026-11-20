// fixB: 입력창 이미지의 형식과 크기 규칙. 화면(붙여넣기, 끌어다 놓기, 첨부)과 서버(images.upload)가 같은 규칙을 쓴다.

// 모델(Anthropic API)이 받는 형식과 장당 크기 상한(5MB)이다. 메시지 하나에 붙일 수 있는 장수는 앱이 정한 값이다.
export const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 5;

export type ImageProblem = "format" | "size" | "empty" | "count";

// 파일 앞머리 바이트로 실제 형식을 알아낸다. 모델에 틀린 media_type 을 보내면 API 가 요청을 거절해 턴이 실패하므로, 이름이나 브라우저가 알려 준 type 대신 이쪽을 믿는다.
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}

// 붙이기 전에 보는 검사. type 은 브라우저가 알려 준 값이라 형식은 대략만 거른다(정확한 판정은 서버의 sniffImageType).
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

// 붙인 클립보드에서 이미지 파일. 글도 같이 있으면(스프레드시트를 복사하면 표 이미지가 따라온다) 글 붙여넣기가 우선이라 이미지는 가져오지 않는다.
export function clipboardImageFiles<T extends { type: string }>(data: { files: ArrayLike<T>; types: ArrayLike<string> } | null): T[] {
  if (!data || Array.from(data.types).includes("text/plain")) return [];
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

// 끌어 온 것에 파일이 들어 있는가(끌기 중에는 내용은 못 보고 종류만 보인다)
export const dragHasFiles = (data: { types: ArrayLike<string> } | null) => !!data && Array.from(data.types).includes("Files");

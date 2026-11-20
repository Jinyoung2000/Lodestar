// 입력창 파일 첨부(이미지가 아닌 것, 또는 이미지로는 못 보내는 것)의 규칙. 화면(끌어다 놓기, 선택창)과 데몬(업로드 경로, 보내기)이 같이 쓰는 순수 함수다. 시험: test/fileattach.test.ts
// 모델(Anthropic API)은 영상이나 임의 파일을 받지 못한다. 그래서 파일은 내용을 싣지 않고 절대 경로만 메시지에 실어, 에이전트가 Read, Bash(ffmpeg 등)로 직접 열게 한다.
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES } from "./images";

// 파일 하나의 크기 상한. 경로만 싣는 파일이라 모델 한도와는 무관하고, 업로드 폴백(데몬 디스크에 복사)이 쓰는 값이다.
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
// 메시지 하나에 붙일 수 있는 파일 수
export const MAX_FILES = 10;
// 파일 이름 상한(바이트). macOS 의 파일 이름 상한이 255 바이트라 그 안에서 확장자를 지키며 줄인다.
const MAX_NAME_BYTES = 200;

export type FileProblem = "empty" | "size" | "count" | "folder";

// 화면과 서버가 같이 쓰는 파일 한 개의 참조. path 는 데몬이 보내는 시점에 다시 확인하는 절대 경로다.
export type FileDrop = { path: string; name: string; bytes: number; mediaType: string };

export type DropClass =
  | { kind: "image" }
  // oversizeImage: 형식은 이미지인데 5MB 를 넘어 모델에 image 블록으로는 못 보내는 경우(경로로 붙이고 알린다)
  | { kind: "file"; oversizeImage: boolean }
  | { kind: "reject"; problem: FileProblem };

// 끌어 놓은 파일이 이미지 칩이 될지 파일 칩이 될지 가른다. 이미지는 지금 동작 그대로 이미지 칩이고(장수 상한은 이미지 쪽 검사가 본다), 5MB 를 넘는 이미지는 파일 칩으로 돌린다.
// type 은 브라우저가 이름의 확장자로 알려 준 값이라 대략만 믿는다. 이미지 칩이 된 뒤의 정확한 판정은 서버의 sniffImageType 이 한다.
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

// 이미지로는 못 보내 파일로 붙였다는 안내(5MB 초과)
export const oversizeImageNotice = (name: string) => `${name}: over ${MAX_IMAGE_BYTES / 1024 / 1024} MB, so it was attached as a file path instead of an image`;

// 이름에서 경로 조각과 제어 문자를 걷어 파일 이름 하나로 만든다. 클라이언트가 준 이름은 믿지 않고 저장 경로를 만들 때 반드시 이 함수를 거친다.
// "../x", "a/b", "a\\b" 는 마지막 조각만 남고, 빈 이름과 "." / ".." 는 "file" 이 된다. 긴 이름은 확장자를 남기고 줄인다.
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
  // 이모지(서로게이트 쌍)의 반쪽만 남으면 디스크 이름이 U+FFFD 로 바뀌어 보낸 이름과 달라진다. 남은 반쪽은 버린다.
  if (stem.length > 1 && /[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1);
  return stem + ext;
}

// 프롬프트 줄바꿈 형식을 깨지 않고 모델이 그대로 열 수 있는 절대 경로인가
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

// 글 뒤에 파일 블록을 붙인 모델용 메시지. 글이 비었으면 블록만 간다.
export function withFileBlock(prompt: string, files: FileDrop[]): string {
  const block = fileBlock(files);
  return block ? (prompt ? `${prompt}\n\n${block}` : block) : prompt;
}

import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME } from "./store";

// 타임라인의 Aside 호출 행이 보이는 이미지를 읽는다. 결과 글에는 파일 경로만 남아 있어서(shared/asideTool.ts), 그 경로들 중 아래 위치의 이미지 파일만 읽는다.
//  - Aside 가 세션 폴더에 둔 화면 캡처: ~/.aside/u/<n>/sessions/<세션>/tmp/repl-display-*.<확장자>
//  - Claude Code 가 도구 결과에서 떼어 둔 이미지: ~/.claude/projects/<폴더>/<세션>/tool-results/mcp-aside-blob-*.<확장자>
//  - 데몬이 저장한 도구 스크린샷: <데몬 홈>/tool-shots/<이름>.<확장자>
// 정규식 밖의 경로, 심볼릭 링크, 8MB 를 넘는 파일은 읽지 않는다.
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

// 후보 경로를 앞에서부터 보고 처음 읽히는 이미지를 돌려준다. 읽을 수 있는 것이 없으면 null.
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
      // 파일이 없으면 다음 후보
    }
  }
  return null;
}

// 도구 결과에 실려 온 이미지 조각(MCP image content)을 데몬 폴더의 tool-shots 에 저장하고 경로를 돌려준다. 결과 글은 이미지를 경로로만 말해서, 원본 경로가 지워져도 썸네일이 남게 복사해 둔다.
// 형식은 앞 바이트로 확인한다(PNG, JPEG, WebP, GIF). 오래된 것부터 지워 keep 개만 남긴다.
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
      // 저장하지 못해도 도구 결과는 그대로 둔다
    }
  }
  if (saved.length) {
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /\.(png|jpg|webp|gif)$/.test(n)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) await unlink(join(dir, name)).catch(() => undefined);
  }
  return saved;
}

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./store";
import { T } from "./strings";

// Browser 탭에서 첨부한 페이지 스크린샷. 입력창 첨부는 글이라서 PNG 를 데몬 폴더에 저장하고 경로를 글로 넣는다(에이전트가 Read 로 본다).
const MAX_BYTES = 8 * 1024 * 1024;
const KEEP = 40;

export async function saveBrowserShot(base64: string, dir = join(HOME, "browser-shots"), keep = KEEP) {
  const png = Buffer.from(base64, "base64");
  if (png.length === 0 || png.length > MAX_BYTES || png.subarray(1, 4).toString("latin1") !== "PNG") throw new Error(T.errBadScreenshot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
  await writeFile(path, png);
  await prune(dir, keep);
  return { path };
}

// 오래된 것부터 지워 keep 개만 남긴다. 파일 이름이 시각 순이다.
async function prune(dir: string, keep: number) {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".png")).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) await unlink(join(dir, name)).catch(() => undefined);
}

// 타임라인 썸네일용으로 데몬이 저장한 스크린샷을 읽는다. 저장 폴더 안의 .png 만 읽는다.
export async function readBrowserShot(path: string, dirs = [join(HOME, "browser-shots"), join(HOME, "tool-shots")]): Promise<string | null> {
  const inside = dirs.some((dir) => path.startsWith(`${dir}/`) && !path.includes(".."));
  if (!inside || !path.endsWith(".png")) return null;
  try {
    return (await readFile(path)).toString("base64");
  } catch {
    return null;
  }
}

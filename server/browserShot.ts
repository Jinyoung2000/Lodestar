import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./store";
import { T } from "./strings";

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

async function prune(dir: string, keep: number) {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".png")).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) await unlink(join(dir, name)).catch(() => undefined);
}

export async function readBrowserShot(path: string, dirs = [join(HOME, "browser-shots"), join(HOME, "tool-shots")]): Promise<string | null> {
  const inside = dirs.some((dir) => path.startsWith(`${dir}/`) && !path.includes(".."));
  if (!inside || !path.endsWith(".png")) return null;
  try {
    return (await readFile(path)).toString("base64");
  } catch {
    return null;
  }
}

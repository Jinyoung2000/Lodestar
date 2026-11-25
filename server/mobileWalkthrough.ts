import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MobileWalkthrough } from "../shared/mobile";
import type { TimelineItem } from "../shared/protocol";
import { parseWalkthrough, walkthroughSlide, walkthroughSources } from "../shared/walkthrough";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const normalized = (source: string) => source.split("\n").map((line) => line.trim()).join("\n").trim();

export async function mobileWalkthrough(root: string, item: TimelineItem | undefined, source: string): Promise<MobileWalkthrough> {
  const wanted = normalized(source);
  const match = item?.kind === "assistant" ? walkthroughSources(item.text).find((s) => normalized(s) === wanted) : undefined;
  if (match === undefined) throw new Error("This walkthrough is unavailable in this session.");
  const base = await realpath(root);
  const reads = new Map<string, Promise<string | null>>();
  const fileText = (path: string) => {
    let read = reads.get(path);
    if (!read) reads.set(path, (read = readVisibleFile(base, path)));
    return read;
  };
  const steps = parseWalkthrough(match);
  return { slides: await Promise.all(steps.map(async (step) => walkthroughSlide(await fileText(step.path), step))) };
}

async function readVisibleFile(base: string, path: string): Promise<string | null> {
  const real = await realpath(resolve(base, path)).catch(() => null);
  if (!real) return null;
  const inside = relative(base, real);
  if (!inside || isAbsolute(inside) || inside.split(sep).some((part) => !part || part.startsWith("."))) return null;
  const info = await stat(real).catch(() => null);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return null;
  return readFile(real, "utf8").catch(() => null);
}

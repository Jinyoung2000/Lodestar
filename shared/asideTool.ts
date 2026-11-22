export const ASIDE_TOOL = "mcp__aside__repl";
export const isAsideTool = (name: string) => name === ASIDE_TOOL;

const SAVED = /^Displayed image saved to: (\/\S+?\.(?:png|jpe?g|webp|gif))(?: \[[^\]]*\])?\s*$/gim;
const SOURCE = /^\[Image: source: (\/\S+?\.(?:png|jpe?g|webp|gif))\]\s*$/gim;

export function asideImageRefs(output: string | null): string[][] {
  if (!output) return [];
  const found: { index: number; path: string; source: boolean }[] = [];
  for (const m of output.matchAll(SAVED)) found.push({ index: m.index ?? 0, path: m[1], source: false });
  for (const m of output.matchAll(SOURCE)) found.push({ index: m.index ?? 0, path: m[1], source: true });
  found.sort((a, b) => a.index - b.index);
  const refs: string[][] = [];
  for (const hit of found) {
    const last = refs[refs.length - 1];
    if (hit.source && last && last.length === 1) last.push(hit.path);
    else refs.push([hit.path]);
  }
  return refs;
}

export function withoutImageNotes(output: string): string {
  return output
    .split("\n")
    .filter((line) => !/^Displayed image saved to: /i.test(line) && !/^\[Image: (?:source|original)\b/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

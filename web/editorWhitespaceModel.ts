export type WhitespaceMode = "none" | "boundary" | "selection" | "trailing" | "all";

export type LineSelection = { from: number; to: number };

export function whitespaceOffsets(text: string, mode: WhitespaceMode, selections: readonly LineSelection[] | null): number[] {
  if (mode === "none") return [];
  if (mode === "selection" && (!selections || selections.length === 0)) return [];
  const length = text.length;
  let firstNonSpace = indexOfFirstNonSpace(text);
  let lastNonSpace: number;
  let allSpace = false;
  if (firstNonSpace === -1) {
    allSpace = true;
    firstNonSpace = length;
    lastNonSpace = length;
  } else {
    lastNonSpace = indexOfLastNonSpace(text);
  }
  const offsets: number[] = [];
  let selectionIndex = 0;
  let current = selections?.[0];
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    while (current && current.to <= i) current = selections?.[++selectionIndex];
    if (code !== 9 && code !== 32) continue;
    if (mode === "trailing" && !allSpace && i <= lastNonSpace) continue;
    if (mode === "boundary" && i >= firstNonSpace && i <= lastNonSpace && code === 32) {
      const before = i - 1 >= 0 ? text.charCodeAt(i - 1) : 0;
      const after = i + 1 < length ? text.charCodeAt(i + 1) : 0;
      if (before !== 32 && after !== 32) continue;
    }
    if (mode === "selection" && !(current && current.from <= i && i < current.to)) continue;
    offsets.push(i);
  }
  return offsets;
}

function indexOfFirstNonSpace(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9) return i;
  }
  return -1;
}

function indexOfLastNonSpace(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9) return i;
  }
  return -1;
}

export type WhitespaceRun = { from: number; to: number; tab: boolean };

export function whitespaceRuns(text: string, offsets: readonly number[]): WhitespaceRun[] {
  const runs: WhitespaceRun[] = [];
  for (const offset of offsets) {
    const tab = text.charCodeAt(offset) === 9;
    const last = runs[runs.length - 1];
    if (last && last.to === offset && last.tab === tab && !tab) last.to = offset + 1;
    else runs.push({ from: offset, to: offset + 1, tab });
  }
  return runs;
}

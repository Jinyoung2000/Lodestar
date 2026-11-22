
export type ConflictBlock = {
  start: number;
  base: number;
  mid: number;
  end: number;
  currentLabel: string;
  incomingLabel: string;
  current: string[];
  incoming: string[];
};

export type ConflictChoice = "current" | "incoming" | "both";

const START = /^<{7}(?: (.*?))?\r?$/;
const BASE = /^\|{7}(?: .*?)?\r?$/;
const MID = /^={7}\r?$/;
const END = /^>{7}(?: (.*?))?\r?$/;

export function parseConflicts(lines: readonly string[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let start = -1;
  let base = -1;
  let mid = -1;
  let currentLabel = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opened = START.exec(line);
    if (opened) {
      start = i;
      base = -1;
      mid = -1;
      currentLabel = opened[1] ?? "";
      continue;
    }
    if (start < 0) continue;
    if (mid < 0 && base < 0 && BASE.test(line)) base = i;
    else if (mid < 0 && MID.test(line)) mid = i;
    else if (mid >= 0) {
      const closed = END.exec(line);
      if (!closed) continue;
      blocks.push({
        start,
        base,
        mid,
        end: i,
        currentLabel,
        incomingLabel: closed[1] ?? "",
        current: lines.slice(start + 1, base >= 0 ? base : mid),
        incoming: lines.slice(mid + 1, i),
      });
      start = -1;
      base = -1;
      mid = -1;
    }
  }
  return blocks;
}

export function replacementFor(block: ConflictBlock, choice: ConflictChoice): string[] {
  if (choice === "current") return block.current;
  if (choice === "incoming") return block.incoming;
  return [...block.current, ...block.incoming];
}

export function resolveConflict(text: string, index: number, choice: ConflictChoice): string {
  const lines = text.split("\n");
  const block = parseConflicts(lines)[index];
  if (!block) return text;
  lines.splice(block.start, block.end - block.start + 1, ...replacementFor(block, choice));
  return lines.join("\n");
}

export function resolveAllConflicts(text: string, choice: ConflictChoice): string {
  const lines = text.split("\n");
  const blocks = parseConflicts(lines);
  for (const block of [...blocks].reverse()) lines.splice(block.start, block.end - block.start + 1, ...replacementFor(block, choice));
  return lines.join("\n");
}

export const hasConflictMarkers = (text: string) => text.includes("<<<<<<<") && parseConflicts(text.split("\n")).length > 0;

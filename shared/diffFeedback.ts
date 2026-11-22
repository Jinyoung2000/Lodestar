import type { Text } from "@codemirror/state";
import type { DiffFeedback, UserAttachment } from "./protocol";


export type LineChange = { origStart: number; origEnd: number; modStart: number; modEnd: number };
export type FeedbackRange = { startLine: number; startColumn: number; endLine: number; endColumn: number };

const CONTEXT = 3;

export function groupChanges(changes: LineChange[]): LineChange[][] {
  const groups: LineChange[][] = [];
  let current: LineChange[] = [];
  for (const change of changes) {
    if (current.length === 0) {
      current.push(change);
      continue;
    }
    const reach = current[current.length - 1].origEnd - 1 + CONTEXT;
    if (change.origStart - CONTEXT <= reach + 1) current.push(change);
    else {
      groups.push(current);
      current = [change];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function selectionCoversChange(range: FeedbackRange, start: number, end: number) {
  const empty = range.startLine === range.endLine && range.startColumn === range.endColumn;
  if (empty) return end > start && start <= range.startLine && range.startLine < end;
  return range.startLine <= start && end <= range.endLine + 1;
}

export function buildHunk(group: LineChange[], orig: string[], mod: string[], origEndsWithNewline: boolean, modEndsWithNewline: boolean): string {
  const first = group[0];
  const last = group[group.length - 1];
  const origFrom = Math.max(1, first.origStart - CONTEXT);
  const origTo = Math.min(orig.length, last.origEnd - 1 + CONTEXT);
  const modFrom = Math.max(1, first.modStart - CONTEXT);
  const lines: string[] = [];
  let origNoNewline = -1;
  let modNoNewline = -1;
  let o = origFrom;
  let origCount = 0;
  let modCount = 0;
  for (const change of group) {
    for (; o < change.origStart; ) {
      const at = lines.length;
      lines.push(` ${orig[o - 1]}`);
      if (o === orig.length) origNoNewline = at;
      if (modFrom + modCount === mod.length) modNoNewline = at;
      o++;
      origCount++;
      modCount++;
    }
    for (let n = change.origStart; n < change.origEnd; n++) {
      const at = lines.length;
      lines.push(`-${orig[n - 1]}`);
      if (n === orig.length) origNoNewline = at;
      o++;
      origCount++;
    }
    for (let n = change.modStart; n < change.modEnd; n++) {
      const at = lines.length;
      lines.push(`+${mod[n - 1]}`);
      if (n === mod.length) modNoNewline = at;
      modCount++;
    }
  }
  for (; o <= origTo; ) {
    const at = lines.length;
    lines.push(` ${orig[o - 1]}`);
    if (o === orig.length) origNoNewline = at;
    if (modFrom + modCount === mod.length) modNoNewline = at;
    o++;
    origCount++;
    modCount++;
  }
  const out = [`@@ -${origFrom},${origCount} +${modFrom},${modCount} @@`, ...lines];
  if (!origEndsWithNewline && origNoNewline >= 0) out.splice(origNoNewline + 2, 0, "\\ No newline at end of file");
  else if (!modEndsWithNewline && modNoNewline >= 0) out.splice(modNoNewline + 2, 0, "\\ No newline at end of file");
  return out.join("\n");
}

export function hunksForRange(range: FeedbackRange, changes: LineChange[], original: string, current: string): string | undefined {
  const groups = groupChanges(changes).filter((group) => {
    const covers = (c: LineChange) => selectionCoversChange(range, c.modStart, c.modEnd);
    const empty = range.startLine === range.endLine && range.startColumn === range.endColumn;
    return empty ? group.some(covers) : group.every(covers);
  });
  if (groups.length === 0) return undefined;
  const origLines = splitForHunk(original);
  const modLines = splitForHunk(current);
  const origEnds = original.length > 0 && original.endsWith("\n");
  const modEnds = current.length > 0 && current.endsWith("\n");
  return groups.map((group) => buildHunk(group, origLines, modLines, origEnds, modEnds)).join("\n");
}

function splitForHunk(text: string) {
  const lines = text.split("\n");
  if (text.length > 0 && text.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function lineRangeLabel(item: Pick<DiffFeedback, "startLine" | "endLine">) {
  return item.startLine === item.endLine ? `${item.startLine}` : `${item.startLine}-${item.endLine}`;
}

function fence(code: string, info = "") {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${info}\n${code}\n${ticks}`;
}

export const FEEDBACK_HEADER = "The following comments were made on the code changes:";
export const FEEDBACK_INSTRUCTION = "Act on the user's feedback on this session's changes below. Understand the intent behind each piece of feedback, make the requested changes to address it, and verify your changes are consistent with the rest of the codebase.";

export function formatFeedbackPrompt(userText: string, items: DiffFeedback[]): string {
  const blocks = items.map((item) => {
    let block = `[${item.rel}:${lineRangeLabel(item)}]`;
    if (item.codeSelection) block += `\nSelection:\n${fence(item.codeSelection)}`;
    if (item.diffHunks) block += `\nDiff Hunks:\n${fence(item.diffHunks, "diff")}`;
    block += `\nComment (user): ${item.text}`;
    return block;
  });
  const head = userText.trim() || FEEDBACK_INSTRUCTION;
  return `${head}\n\n${[FEEDBACK_HEADER, ...blocks].join("\n\n")}`;
}

export function feedbackChip(item: DiffFeedback): UserAttachment {
  const name = item.rel.slice(item.rel.lastIndexOf("/") + 1);
  return { kind: "diffFeedback", label: `${name}:${lineRangeLabel(item)}`, path: item.path, line: item.startLine, endLine: item.endLine, id: item.id, text: item.text };
}

export function chipText(items: DiffFeedback[]) {
  if (items.length === 1) return items[0].text.length <= 25 ? items[0].text : `${items[0].text.slice(0, 25)}…`;
  return `${items.length} comments`;
}

type Chunkish = { fromA: number; toA: number; fromB: number; toB: number };

export function chunksToLineChanges(chunks: readonly Chunkish[], a: Text, b: Text): LineChange[] {
  return chunks.map((c) => {
    const origStart = a.lineAt(c.fromA).number;
    const modStart = b.lineAt(c.fromB).number;
    return { origStart, origEnd: c.toA > c.fromA ? a.lineAt(c.toA - 1).number + 1 : origStart, modStart, modEnd: c.toB > c.fromB ? b.lineAt(c.toB - 1).number + 1 : modStart };
  });
}


export function groupForPills(items: DiffFeedback[]): DiffFeedback[][] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.startLine - b.startLine || a.createdAt.localeCompare(b.createdAt));
  const groups: DiffFeedback[][] = [];
  let group = [sorted[0]];
  let height = estimateHeight(sorted[0]);
  for (const item of sorted.slice(1)) {
    if (item.startLine - group[0].startLine <= 5 + height) {
      group.push(item);
      height += estimateHeight(item);
    } else {
      groups.push(group);
      group = [item];
      height = estimateHeight(item);
    }
  }
  groups.push(group);
  return groups;
}

const estimateHeight = (item: DiffFeedback) => Math.ceil(Math.max(1, item.text.length) / 50) + 1;

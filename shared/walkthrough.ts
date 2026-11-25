export const WALKTHROUGH_LANGUAGE = "walkthrough";

export type WalkthroughStep = { path: string; start: number; end: number; note: string; removed: string[]; added: string[] };
export type WalkthroughRowKind = "context" | "focus" | "removed" | "added";
export type WalkthroughRow = { kind: WalkthroughRowKind; line: number | null; text: string };
export type WalkthroughSlide = { step: WalkthroughStep; line: number | null; missing: "file" | "line" | null; rows: WalkthroughRow[] };
export type WalkthroughSegment = { kind: "markdown"; text: string } | { kind: "walkthrough"; source: string };

const CONTEXT_LINES = 3;
const MAX_FOCUS_LINES = 40;
const MAX_STEPS = 40;
const HEADER = /^\s*(?:\d+[.)]\s+)?`?([^\s`|]+?):(\d+)(?:-(\d+))?`?\s*(?:[|]\s*(.*))?$/;
const DIFF_LINE = /^([-+])(?: (.*)|)$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*walkthrough[ \t]*\n([\s\S]*?)\n\1\2[ \t]*$/gm;

export function parseWalkthrough(source: string): WalkthroughStep[] {
  const steps: WalkthroughStep[] = [];
  let current: WalkthroughStep | null = null;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const header = HEADER.exec(line);
    if (header && !DIFF_LINE.test(line)) {
      if (steps.length >= MAX_STEPS) break;
      const start = Math.max(1, Number(header[2]));
      const end = Math.max(start, Number(header[3] ?? header[2]));
      current = { path: header[1], start, end, note: (header[4] ?? "").trim(), removed: [], added: [] };
      steps.push(current);
      continue;
    }
    if (!current) continue;
    const diff = DIFF_LINE.exec(line);
    if (diff) {
      (diff[1] === "-" ? current.removed : current.added).push(diff[2] ?? "");
      continue;
    }
    const text = line.trim();
    if (text && !current.removed.length && !current.added.length) current.note = current.note ? `${current.note} ${text}` : text;
  }
  return steps;
}

export function walkthroughSegments(text: string): WalkthroughSegment[] {
  if (!text.includes(WALKTHROUGH_LANGUAGE)) return [{ kind: "markdown", text }];
  const segments: WalkthroughSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    if (!parseWalkthrough(match[3]).length) continue;
    const before = text.slice(last, match.index);
    if (before.trim()) segments.push({ kind: "markdown", text: before });
    segments.push({ kind: "walkthrough", source: match[3] });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (rest.trim() || !segments.length) segments.push({ kind: "markdown", text: rest });
  return segments;
}

export const walkthroughSources = (text: string) => walkthroughSegments(text).flatMap((s) => (s.kind === "walkthrough" ? [s.source] : []));

const same = (a: string, b: string) => a.trim() === b.trim();

function findRemoved(lines: string[], removed: string[], near: number): number | null {
  const first = removed.findIndex((l) => l.trim());
  if (first === -1) return null;
  let best: number | null = null;
  for (let i = 0; i + removed.length <= lines.length; i += 1) {
    if (!same(lines[i + first] ?? "", removed[first])) continue;
    if (!removed.every((r, k) => !r.trim() || same(lines[i + k] ?? "", r))) continue;
    const start = i + 1;
    if (best === null || Math.abs(start - near) < Math.abs(best - near)) best = start;
  }
  return best;
}

export function locateStep(lines: string[], step: WalkthroughStep): { start: number; end: number; matched: boolean } | null {
  if (step.removed.length) {
    const found = findRemoved(lines, step.removed, step.start);
    if (found !== null) return { start: found, end: found + step.removed.length - 1, matched: true };
  }
  if (step.start > lines.length) return null;
  return { start: step.start, end: Math.min(step.end, lines.length, step.start + MAX_FOCUS_LINES - 1), matched: !step.removed.length };
}

export function walkthroughSlide(fileText: string | null, step: WalkthroughStep): WalkthroughSlide {
  const removedRows = step.removed.map((text) => ({ kind: "removed" as const, line: null, text }));
  const addedRows = step.added.map((text) => ({ kind: "added" as const, line: null, text }));
  if (fileText === null) return { step, line: null, missing: "file", rows: [...removedRows, ...addedRows] };
  const lines = fileText.split(/\r?\n/);
  const at = locateStep(lines, step);
  if (!at) return { step, line: null, missing: "line", rows: [...removedRows, ...addedRows] };
  const rows: WalkthroughRow[] = [];
  const push = (kind: WalkthroughRowKind, from: number, to: number) => {
    for (let n = from; n <= to; n += 1) rows.push({ kind, line: n, text: lines[n - 1] ?? "" });
  };
  push("context", Math.max(1, at.start - CONTEXT_LINES), at.start - 1);
  if (at.matched) push(step.removed.length ? "removed" : "focus", at.start, at.end);
  else rows.push(...removedRows);
  rows.push(...addedRows);
  push("context", at.matched ? at.end + 1 : at.start, Math.min(lines.length, (at.matched ? at.end : at.start - 1) + CONTEXT_LINES));
  return { step, line: at.start, missing: null, rows };
}

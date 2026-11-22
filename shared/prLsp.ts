import type { PrFile, PrLocalTarget } from "./prTypes";
import { findRow, parsePatch, type DiffRow } from "./prDiff";

export type PrLocalCandidate = {
  workspaceId: string;
  dir: string;
  topLevel: boolean;
  headSha: string | null;
  branch: string | null;
  hasCommit: boolean;
};

export type PrLocalInput = {
  headRef: string;
  headSha: string;
  checkoutDir: string | null;
};

export function chooseLocalTarget(input: PrLocalInput, candidates: PrLocalCandidate[]): PrLocalTarget {
  if (candidates.length === 0) return { kind: "no-workspace" };
  const sha = input.headSha.toLowerCase();
  const exactOf = (c: PrLocalCandidate) => c.headSha !== null && c.headSha.toLowerCase() === sha;
  const checkedOut = candidates
    .filter((c) => exactOf(c) || (c.branch !== null && c.branch === input.headRef))
    .map((c) => ({ c, score: (c.dir === input.checkoutDir ? 4 : 0) + (exactOf(c) ? 2 : 0) + (c.topLevel ? 0 : 1) }))
    .sort((a, b) => b.score - a.score)[0];
  if (checkedOut) return { kind: "checked-out", workspaceId: checkedOut.c.workspaceId, dir: checkedOut.c.dir, branch: checkedOut.c.branch, exact: exactOf(checkedOut.c) };
  const top = (list: PrLocalCandidate[]) => list.find((c) => c.topLevel) ?? list[0];
  const withCommit = candidates.filter((c) => c.hasCommit);
  if (withCommit.length) {
    const pick = top(withCommit);
    return { kind: "commit", workspaceId: pick.workspaceId, dir: pick.dir };
  }
  const pick = top(candidates);
  return { kind: "fetch-needed", workspaceId: pick.workspaceId, dir: pick.dir };
}

export function relPathIn(dir: string, absolute: string): string | null {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  return absolute.startsWith(base) ? absolute.slice(base.length) : null;
}

export function sameCodeLine(docLine: string, patchLine: string): boolean {
  return docLine.replace(/\r$/, "") === patchLine.replace(/\r$/, "");
}

const WORD = /[\p{L}\p{N}_$]/u;

export function wordRangeAt(text: string, offset: number): { from: number; to: number } | null {
  const chars = Array.from(text);
  const starts: number[] = [];
  let at = 0;
  for (const ch of chars) {
    starts.push(at);
    at += ch.length;
  }
  starts.push(at);
  const idx = starts.findIndex((s) => s >= offset);
  const i = idx === -1 ? chars.length : idx;
  const isWord = (k: number) => k >= 0 && k < chars.length && WORD.test(chars[k]);
  const k = isWord(i) && starts[i] === offset ? i : isWord(i - 1) ? i - 1 : isWord(i) ? i : -1;
  if (k === -1) return null;
  let a = k;
  let b = k;
  while (isWord(a - 1)) a--;
  while (isWord(b + 1)) b++;
  return { from: starts[a], to: starts[b + 1] };
}

export type DefinitionTarget =
  | { kind: "pr"; path: string; row: number; line: number }
  | { kind: "local" };

const rowsCache = new Map<string, DiffRow[]>();
function rowsOf(patch: string): DiffRow[] {
  let rows = rowsCache.get(patch);
  if (!rows) {
    rows = parsePatch(patch);
    if (rowsCache.size > 200) rowsCache.clear();
    rowsCache.set(patch, rows);
  }
  return rows;
}

export function resolveDefinitionTarget(files: PrFile[], rel: string | null, line0: number): DefinitionTarget {
  if (rel === null) return { kind: "local" };
  const file = files.find((f) => f.path === rel);
  if (!file || file.status === "removed" || !file.patch) return { kind: "local" };
  const row = findRow(rowsOf(file.patch), "RIGHT", line0 + 1);
  return row === -1 ? { kind: "local" } : { kind: "pr", path: file.path, row, line: line0 + 1 };
}

export const isSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-fA-F]{7,40}$/.test(value);

export function isRepoRelativePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("-") && !path.includes("\0") && !path.split("/").some((part) => part === ".." || part === "");
}

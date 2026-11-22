import type { GitProblem } from "./gitProblems";

export type ScmCode = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "!";

export type ScmEntry = {
  rel: string;
  path: string;
  code: ScmCode;
  from?: string;
  conflict?: string;
};

export type ScmLastCommit = {
  hash: string;
  subject: string;
  parents: number;
  pushed: boolean;
};

export type ScmStatus = {
  repoRoot: string | null;
  hasHead: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  staged: ScmEntry[];
  changes: ScmEntry[];
  conflicts: ScmEntry[];
  merging: boolean;
  lastCommit: ScmLastCommit | null;
  operation?: ScmOperation | null;
  operationText?: string;
  mergeMessage?: string;
};

export type ScmOperation = "merge" | "rebase";

export type ScmCommitOptions = {
  message: string;
  amend?: boolean;
  stageAll?: boolean;
  confirmPushedAmend?: boolean;
  noVerify?: boolean;
  then?: "push" | "sync";
};

export type ScmCommitResult =
  | { status: "committed"; summary: string; pushError: string | null }
  | { status: "needsStageAll" }
  | { status: "nothingToCommit" }
  | { status: "amendPushed" }
  | { status: "conflicts" }
  | { status: "failed"; output: string; hook: boolean };

export type ScmDiscardResult = { restored: number; trashed: number };

export type ScmCommit = {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  refs: string[];
  parents: number;
};

export type ScmCommitFile = { rel: string; code: ScmCode; from?: string; additions: number; deletions: number };

export type ScmWorktree = {
  path: string;
  branch: string | null;
  head: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  main: boolean;
};

export type ScmRepoWorktrees = { name: string; root: string; worktrees: ScmWorktree[] };

const CONFLICT_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function parseStatus(raw: string, root: string): Pick<ScmStatus, "staged" | "changes" | "conflicts"> {
  const staged: ScmEntry[] = [];
  const changes: ScmEntry[] = [];
  const conflicts: ScmEntry[] = [];
  const parts = raw.split("\0");
  const make = (rel: string, code: ScmCode, from?: string, conflict?: string): ScmEntry => ({ rel, path: `${root}/${rel}`, code, ...(from ? { from } : {}), ...(conflict ? { conflict } : {}) });
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (item.length < 4 || item[2] !== " ") continue;
    const x = item[0];
    const y = item[1];
    const rel = item.slice(3);
    const from = x === "R" || x === "C" || y === "R" || y === "C" ? parts[++i] : undefined;
    const pair = `${x}${y}`;
    if (pair === "!!") continue;
    if (pair === "??") {
      changes.push(make(rel, "U"));
      continue;
    }
    if (CONFLICT_PAIRS.has(pair)) {
      conflicts.push(make(rel, "!", undefined, pair));
      continue;
    }
    if (x !== " ") staged.push(make(rel, toCode(x), x === "R" || x === "C" ? from : undefined));
    if (y !== " ") changes.push(make(rel, toCode(y), y === "R" || y === "C" ? from : undefined));
  }
  const byRel = (a: ScmEntry, b: ScmEntry) => a.rel.localeCompare(b.rel);
  return { staged: staged.sort(byRel), changes: changes.sort(byRel), conflicts: conflicts.sort(byRel) };
}

function toCode(letter: string): ScmCode {
  return letter === "M" || letter === "A" || letter === "D" || letter === "R" || letter === "C" || letter === "T" ? letter : "M";
}

export type ScmTreeNode = { name: string; path: string; entry: ScmEntry | null; children: ScmTreeNode[] };

export function buildScmTree(entries: readonly ScmEntry[]): ScmTreeNode[] {
  const root: ScmTreeNode = { name: "", path: "", entry: null, children: [] };
  for (const entry of entries) {
    const parts = entry.rel.split("/");
    let node = root;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.find((c) => c.path === path);
      if (!child) {
        child = { name, path, entry: index === parts.length - 1 ? entry : null, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const squash = (node: ScmTreeNode): ScmTreeNode => {
    const children = node.children.map(squash);
    if (!node.entry && children.length === 1 && !children[0].entry && node.path) return { ...children[0], name: `${node.name}/${children[0].name}` };
    return { ...node, children };
  };
  const sort = (nodes: ScmTreeNode[]): ScmTreeNode[] => nodes.sort((a, b) => Number(!!a.entry) - Number(!!b.entry) || a.name.localeCompare(b.name)).map((n) => ({ ...n, children: sort(n.children) }));
  return sort(root.children.map(squash));
}

export function scmEntriesUnder(node: ScmTreeNode): ScmEntry[] {
  return node.entry ? [node.entry] : node.children.flatMap(scmEntriesUnder);
}

export const scmBasename = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
export const scmDirname = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

export function cleanCommitMessage(raw: string): string {
  const lines = raw
    .replace(/```[a-z]*\n?/gi, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^co-authored-by:/i.test(l) && !/^generated with/i.test(l));
  const first = (lines[0] ?? "").replace(/^["'`]+|["'`]+$/g, "").trim();
  return first.length > 100 ? `${first.slice(0, 97).trimEnd()}...` : first;
}

export type ScmTarget = { agentId?: string; workspaceId?: string };

export type ScmPullMode = "ff" | "merge" | "rebase";

export type ScmSyncResult = { ok: true; output: string } | { ok: false; output: string; problem: GitProblem; conflicts?: number };

export type ScmOperationResult = { ok: true; summary: string } | { ok: false; output: string; problem: GitProblem };

export type ScmDiffSection = "staged" | "changes";
export type ScmFileDiffSection = ScmDiffSection | "uncommitted";

export type ScmHunkInfo = { index: number; oldStart: number; oldLines: number; newStart: number; newLines: number; hash: string };

export type ScmFileDiff = {
  rel: string;
  original: string | null;
  modified: string | null;
  binary: boolean;
  tooLarge: boolean;
  hunks: ScmHunkInfo[];
};

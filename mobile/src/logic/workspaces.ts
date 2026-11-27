import type { Agent, BranchesResult, SessionSort, Workspace } from "@shared/protocol";
import { stateOf, type SessionState } from "./agents";

export type Location = {
  workspace: Workspace;
  kind: "main" | "worktree";
  label: string;
  sessions: Agent[];
  done: Agent[];
};

export type Project = {
  workspace: Workspace;
  main: Location;
  worktrees: Location[];
  state: SessionState;
  active: number;
  done: number;
  lastActivity: string;
};

export function shortPath(dir: string): string {
  return dir.replace(/^\/private(?=\/(tmp|var)\/)/, "").replace(/^\/Users\/[^/]+/, "~");
}

const STATE_RANK: SessionState[] = ["waiting", "error", "running", "unread", "idle"];

export function aggregateState(agents: readonly Agent[]): SessionState {
  let best = STATE_RANK.length - 1;
  for (const agent of agents) {
    if (agent.done) continue;
    best = Math.min(best, STATE_RANK.indexOf(stateOf(agent)));
  }
  return STATE_RANK[best];
}

export const DEFAULT_SESSION_SORT: SessionSort = "updated";

const byTimeDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

export function compareAgents(sort: SessionSort): (a: Agent, b: Agent) => number {
  return (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (sort === "created" ? byTimeDesc(a.createdAt, b.createdAt) : byTimeDesc(a.updatedAt, b.updatedAt));
}

export function branchLabel(child: Workspace, agents: readonly Agent[]): string {
  const known = agents.find((a) => a.workspaceId === child.id && a.worktree)?.worktree?.branch;
  if (known) return known;
  const named = /\(([^()]+)\)\s*$/.exec(child.name)?.[1];
  return named ?? (child.dir.split("/").filter(Boolean).pop() ?? child.name);
}

function locationOf(workspace: Workspace, kind: Location["kind"], label: string, agents: readonly Agent[], sessionSort: SessionSort): Location {
  const mine = agents.filter((a) => a.workspaceId === workspace.id);
  const compare = compareAgents(sessionSort);
  return { workspace, kind, label, sessions: mine.filter((a) => !a.done).sort(compare), done: mine.filter((a) => a.done).sort(compare) };
}

export function buildProject(workspace: Workspace, workspaces: readonly Workspace[], agents: readonly Agent[], sessionSort: SessionSort = DEFAULT_SESSION_SORT): Project {
  const main = locationOf(workspace, "main", "Main folder", agents, sessionSort);
  const worktrees = workspaces
    .filter((w) => w.parentId === workspace.id && !w.feedback)
    .map((w) => locationOf(w, "worktree", branchLabel(w, agents), agents, sessionSort))
    .sort((a, b) => a.label.localeCompare(b.label));
  const all = [main, ...worktrees];
  const everyone = all.flatMap((l) => [...l.sessions, ...l.done]);
  return {
    workspace,
    main,
    worktrees,
    state: aggregateState(everyone),
    active: all.reduce((n, l) => n + l.sessions.length, 0),
    done: all.reduce((n, l) => n + l.done.length, 0),
    lastActivity: everyone.reduce((best, a) => (a.updatedAt > best ? a.updatedAt : best), ""),
  };
}

export function topWorkspace(workspaces: readonly Workspace[], id: string): Workspace | null {
  const found = workspaces.find((w) => w.id === id);
  if (!found || found.feedback) return null;
  return found.parentId ? (workspaces.find((w) => w.id === found.parentId) ?? null) : found;
}

export function canStartWorktree(info: Pick<BranchesResult, "repoRoot" | "branches"> | null): boolean {
  return !!info?.repoRoot && info.branches.length > 0;
}

export function worktreeDisabledReason(info: Pick<BranchesResult, "repoRoot" | "branches"> | null): string | null {
  if (!info) return null;
  if (!info.repoRoot) return "Not a git repository";
  return info.branches.length === 0 ? "This repository has no commits yet" : null;
}

export function defaultBaseBranch(info: Pick<BranchesResult, "defaultBase" | "branches">): string {
  return info.defaultBase || info.branches[0] || "";
}

export function worktreePreview(repoRoot: string, branch: string): string {
  const name = repoRoot.split("/").filter(Boolean).pop() ?? "repo";
  return `${name}.worktrees/${branch.trim() || "<branch>"}`;
}

export function baseChoices(info: Pick<BranchesResult, "locals" | "remotes" | "branches">): string[] {
  const list = info.locals.length || info.remotes.length ? [...info.locals, ...info.remotes] : info.branches;
  return [...new Set(list)];
}

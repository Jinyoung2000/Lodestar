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

export type ProjectSort = "activity" | "name" | "manual";
export const PROJECT_SORTS: readonly ProjectSort[] = ["activity", "name", "manual"];
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

export function buildProjects(workspaces: readonly Workspace[], agents: readonly Agent[], query = "", sort: ProjectSort = "activity", manualOrder: readonly string[] = []): Project[] {
  const needle = query.trim().toLowerCase();
  const projects = workspaces
    .filter((w) => !w.parentId && !w.feedback)
    .filter((w) => needle === "" || w.name.toLowerCase().includes(needle) || shortPath(w.dir).toLowerCase().includes(needle))
    .map((w) => buildProject(w, workspaces, agents));
  return sortProjects(projects, sort, manualOrder);
}

const byActivity = (a: Project, b: Project) => byTimeDesc(a.lastActivity, b.lastActivity) || a.workspace.name.localeCompare(b.workspace.name);
const byName = (a: Project, b: Project) => a.workspace.name.localeCompare(b.workspace.name) || a.workspace.dir.localeCompare(b.workspace.dir);

export function sortProjects(projects: readonly Project[], sort: ProjectSort, manualOrder: readonly string[] = []): Project[] {
  if (sort === "name") return [...projects].sort(byName);
  if (sort === "activity") return [...projects].sort(byActivity);
  const byId = new Map(projects.map((p) => [p.workspace.id, p]));
  const placed = [...new Set(manualOrder)].flatMap((id) => byId.get(id) ?? []);
  const known = new Set(placed.map((p) => p.workspace.id));
  return [...placed, ...projects.filter((p) => !known.has(p.workspace.id)).sort(byActivity)];
}

export const orderOf = (projects: readonly Project[]): string[] => projects.map((p) => p.workspace.id);

export function moveInOrder(order: readonly string[], id: string, direction: "up" | "down" | "top" | "bottom"): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const to = direction === "up" ? from - 1 : direction === "down" ? from + 1 : direction === "top" ? 0 : order.length - 1;
  if (to < 0 || to >= order.length || to === from) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
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

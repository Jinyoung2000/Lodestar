import type { Agent, BranchesResult, SessionSort, Workspace } from "@shared/protocol";
import { stateOf, type SessionState } from "./agents";

// 워크스페이스 화면의 순수 계산. Paseo 의 project(최상위 폴더) 아래 workspace(폴더 자체나 worktree)가 Lodestar 에서는
// 최상위 워크스페이스(parentId 없음)와 그 아래 worktree 워크스페이스(parentId 가 최상위의 id)다. 세션(agent)은 그 안에서 돈다.

export type Location = {
  workspace: Workspace;
  kind: "main" | "worktree";
  // 화면에 쓰는 이름: 폴더 자체는 "Main folder", worktree 는 브랜치 이름
  label: string;
  // 완료(done)가 아닌 세션. 고정이 먼저, 그 안에서는 고른 세션 정렬(기본 최근 수정순)
  sessions: Agent[];
  done: Agent[];
};

export type Project = {
  workspace: Workspace;
  main: Location;
  worktrees: Location[];
  // 이 프로젝트 모든 위치의 진행 중 세션의 대표 상태(답 대기, 오류, 실행 중, 안 읽음 순으로 눈에 띄는 것)
  state: SessionState;
  // 완료가 아닌 세션 수와 완료한 세션 수
  active: number;
  done: number;
  lastActivity: string;
};

// 집 폴더 접두를 ~ 로 줄이고, macOS 의 /private/tmp 같은 이름은 /tmp 로 보인다.
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

// 프로젝트 목록 정렬: activity 는 가장 최근에 움직인 세션 순(기본), name 은 이름 순, manual 은 사용자가 정한 순서.
export type ProjectSort = "activity" | "name" | "manual";
export const PROJECT_SORTS: readonly ProjectSort[] = ["activity", "name", "manual"];
// 프로젝트 안 세션 정렬은 데스크톱 데몬의 SessionSort("created" | "updated")와 같은 어휘를 쓴다. 고른 값이 없을 때의 전역 기본값:
// 데몬의 defaults.sessionSort 는 모바일에 열린 RPC 가 아니라서(shared/mobile.ts 의 허용 목록에 defaults.get 이 없다) 받지 않고 updated 로 둔다.
export const DEFAULT_SESSION_SORT: SessionSort = "updated";

const byTimeDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

// 고정한 세션이 먼저이고, 그 안에서는 sort 의 시각이 늦은 것부터(created 는 만든 시각, updated 는 마지막 수정 시각).
export function compareAgents(sort: SessionSort): (a: Agent, b: Agent) => number {
  return (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (sort === "created" ? byTimeDesc(a.createdAt, b.createdAt) : byTimeDesc(a.updatedAt, b.updatedAt));
}

// worktree 워크스페이스의 브랜치 이름: 그 안에서 시작한 세션의 worktree 정보가 가장 정확하고, 없으면 워크스페이스 이름 "프로젝트 (브랜치)" 의 괄호 안, 그것도 없으면 폴더 이름.
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

// sessionSort 는 이 프로젝트 안의 세션 순서(위치별 세션과 Done). Project.lastActivity 는 정렬과 상관없이 updatedAt 기준이다.
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

// 최상위 워크스페이스(피드백 개선 용은 뺀다). 기본(activity)은 최근에 움직인 순이고 세션이 없는 폴더는 이름 순으로 맨 뒤.
// sort 가 name 이면 이름 순, manual 이면 manualOrder(워크스페이스 id 순서)를 따른다.
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
  // manual: 저장된 순서대로. 저장된 순서에 없는 프로젝트(새로 추가된 것)는 맨 아래에 최근 활동 순으로 붙는다. 저장된 순서에만 있는 id(사라진 프로젝트)는 건너뛴다.
  const byId = new Map(projects.map((p) => [p.workspace.id, p]));
  const placed = [...new Set(manualOrder)].flatMap((id) => byId.get(id) ?? []);
  const known = new Set(placed.map((p) => p.workspace.id));
  return [...placed, ...projects.filter((p) => !known.has(p.workspace.id)).sort(byActivity)];
}

// 정렬된 프로젝트 목록을 저장할 순서(id 목록)로. manual 로 바꾸는 순간 저장해 두면 화면에 보이던 순서가 그대로 시작점이 된다.
export const orderOf = (projects: readonly Project[]): string[] => projects.map((p) => p.workspace.id);

// 순서에서 id 하나를 한 칸 위나 아래로, 또는 맨 위나 맨 아래로. 이미 끝이거나 순서에 없는 id 면 그대로 돌려준다.
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

// 주소가 worktree 워크스페이스여도 그 프로젝트(최상위)를 돌려준다. 없으면 null.
export function topWorkspace(workspaces: readonly Workspace[], id: string): Workspace | null {
  const found = workspaces.find((w) => w.id === id);
  if (!found || found.feedback) return null;
  return found.parentId ? (workspaces.find((w) => w.id === found.parentId) ?? null) : found;
}

// 새 세션 화면: 브랜치 정보에서 worktree 시작이 되는지와 기준 브랜치 기본값(데스크톱 NewSession 과 같다)
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

// 새 worktree 가 만들어질 곳(레포 옆 <repo>.worktrees/<branch>)을 미리 보인다.
export function worktreePreview(repoRoot: string, branch: string): string {
  const name = repoRoot.split("/").filter(Boolean).pop() ?? "repo";
  return `${name}.worktrees/${branch.trim() || "<branch>"}`;
}

// 기준 브랜치로 고를 수 있는 목록: 로컬 브랜치가 앞, 원격이 뒤. 서버가 로컬과 원격을 따로 주지 않던 옛 응답이면 섞인 목록을 쓴다.
export function baseChoices(info: Pick<BranchesResult, "locals" | "remotes" | "branches">): string[] {
  const list = info.locals.length || info.remotes.length ? [...info.locals, ...info.remotes] : info.branches;
  return [...new Set(list)];
}

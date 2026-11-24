import type { Agent, ChangedFile, Workspace } from "../shared/protocol";
import { isGeneratedPath } from "../shared/generatedFiles";
import { applySessionOrder, CHATS_SCOPE, DONE_SCOPE, FOLDERS_SCOPE, kidsScope, PINNED_SCOPE, type SessionOrders } from "../shared/sessionOrder";
import { S } from "./strings";

export type Ordering = "created" | "updated";
export type Grouping = "time" | "workspace";
export type ShowRange = "recent" | "all";

export type FolderOrder = "recent" | "name" | "manual";
export type SessionView = { ordering: Ordering | null; grouping: Grouping; show: ShowRange; showDone: boolean; folderOrder: FolderOrder };

export const DEFAULT_VIEW: SessionView = { ordering: null, grouping: "workspace", show: "recent", showDone: false, folderOrder: "recent" };

export const RECENT_LIMIT = 5;

export type SessionRow = { agent: Agent; depth: number; hasChildren: boolean; scope: string | null };

export type ScopeList = { ids: string[]; shown: number };

export type GroupKind = "pinned" | "chats" | "workspace" | "time" | "done";

export type SessionGroup = {
  id: string;
  kind: GroupKind;
  name: string;
  workspaceId: string | null;
  count: number;
  rows: SessionRow[];
  foldable: boolean;
  folded: boolean;
  hidden: number;
  scope: string | null;
  resetScopes: string[];
  scopes: Record<string, ScopeList>;
};

export type GroupInput = {
  agents: Agent[];
  workspaces: Workspace[];
  topWorkspaceId: (workspaceId: string | null) => string | null;
  view: SessionView;
  defaultOrdering: Ordering;
  now: number;
  collapsedParents: ReadonlySet<string>;
  expandedGroups: ReadonlySet<string>;
  orders?: SessionOrders;
};

export const FALLBACK_ORDERING: Ordering = "created";

export function isDefaultView(view: SessionView, defaultOrdering: Ordering) {
  return (view.ordering === null || view.ordering === defaultOrdering) && view.grouping === DEFAULT_VIEW.grouping && view.show === DEFAULT_VIEW.show && view.showDone === DEFAULT_VIEW.showDone && view.folderOrder === DEFAULT_VIEW.folderOrder;
}

export function buildGroups(input: GroupInput): SessionGroup[] {
  const { view, now } = input;
  const ordering = view.ordering ?? input.defaultOrdering;
  const timeOf = (a: Agent) => (ordering === "created" ? a.createdAt : a.updatedAt);
  const sessions = input.agents.filter((a) => !a.feedbackId && !a.assistant);
  const active = sessions.filter((a) => !a.done);
  const finished = sessions.filter((a) => a.done);

  const groups: SessionGroup[] = [];
  const pinnedIds = pinnedFamily(active);
  const pinnedTree = buildTree(active.filter((a) => pinnedIds.has(a.id)), ordering);
  if (pinnedTree.roots.length) groups.push(makeGroup({ id: "pinned", kind: "pinned", name: S.groupPinned, workspaceId: null, scope: PINNED_SCOPE }, pinnedTree.roots, pinnedTree, input));
  const tree = buildTree(active.filter((a) => !pinnedIds.has(a.id)), ordering);
  if (view.grouping === "workspace") {
    const chats = tree.roots.filter((r) => !input.topWorkspaceId(r.workspaceId));
    groups.push(makeGroup({ id: "chats", kind: "chats", name: S.groupChats, workspaceId: null, scope: CHATS_SCOPE }, chats, tree, input));
    for (const workspace of orderFolders(input.workspaces, active, input.topWorkspaceId, view.folderOrder, input.orders?.[FOLDERS_SCOPE])) {
      const roots = tree.roots.filter((r) => input.topWorkspaceId(r.workspaceId) === workspace.id);
      groups.push(makeGroup({ id: `ws:${workspace.id}`, kind: "workspace", name: workspace.name, workspaceId: workspace.id, scope: workspace.id }, roots, tree, input));
    }
  } else {
    const buckets = new Map<string, Agent[]>();
    for (const root of tree.roots) {
      const key = timeBucket(timeOf(root), now);
      buckets.set(key, [...(buckets.get(key) ?? []), root]);
    }
    for (const key of TIME_BUCKETS) {
      const roots = buckets.get(key);
      if (roots?.length) groups.push(makeGroup({ id: `time:${key}`, kind: "time", name: TIME_NAMES[key](), workspaceId: null, scope: null }, roots, tree, input));
    }
  }
  if (view.showDone && finished.length) {
    const doneTree = buildTree(finished, ordering);
    groups.push(makeGroup({ id: "done", kind: "done", name: S.groupDone, workspaceId: null, scope: DONE_SCOPE }, doneTree.roots, doneTree, input));
  }
  return groups;
}

export function orderFolders(workspaces: Workspace[], sessions: Agent[], topWorkspaceId: (workspaceId: string | null) => string | null, folderOrder: FolderOrder, saved?: readonly string[]): Workspace[] {
  const byName = [...workspaces].sort((a, b) => a.name.localeCompare(b.name));
  if (folderOrder === "name") return byName;
  const latest = new Map<string, string>();
  for (const session of sessions) {
    const id = topWorkspaceId(session.workspaceId);
    if (id && session.updatedAt > (latest.get(id) ?? "")) latest.set(id, session.updatedAt);
  }
  const recent = byName.sort((a, b) => (latest.get(b.id) ?? "").localeCompare(latest.get(a.id) ?? ""));
  return folderOrder === "manual" ? applySessionOrder(recent, saved) : recent;
}

export type SidebarInput = GroupInput & {
  collapsedGroups: ReadonlySet<string>;
};

export type SidebarLayout = {
  groups: SessionGroup[];
  scopes: Record<string, ScopeList>;
  order: string[];
};

export function sidebarLayout(input: SidebarInput): SidebarLayout {
  const groups = buildGroups(input);
  const order = groups.filter((g) => !input.collapsedGroups.has(g.id)).flatMap((g) => g.rows.map((r) => r.agent.id));
  const scopes = Object.assign({}, ...groups.map((g) => g.scopes)) as Record<string, ScopeList>;
  const folderIds = groups.flatMap((g) => (g.kind === "workspace" && g.workspaceId ? [g.workspaceId] : []));
  if (folderIds.length) scopes[FOLDERS_SCOPE] = { ids: folderIds, shown: folderIds.length };
  return { groups, scopes, order };
}

export const parentId = (agent: Agent) => agent.handoffFrom ?? null;

function pinnedFamily(list: Agent[]) {
  const byId = new Map(list.map((a) => [a.id, a]));
  const inFamily = (agent: Agent, seen: Set<string>): boolean => {
    if (agent.pinned) return true;
    const parent = parentId(agent) ? byId.get(parentId(agent)!) : undefined;
    if (!parent || seen.has(parent.id)) return false;
    return inFamily(parent, new Set([...seen, agent.id]));
  };
  return new Set(list.filter((a) => inFamily(a, new Set())).map((a) => a.id));
}

type Tree = { roots: Agent[]; children: Map<string, Agent[]> };

function buildTree(list: Agent[], ordering: Ordering): Tree {
  const ids = new Set(list.map((a) => a.id));
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of list) {
    const parent = parentId(agent);
    if (parent && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), agent]);
    else roots.push(agent);
  }
  const timeOf = (a: Agent) => (ordering === "created" ? a.createdAt : a.updatedAt);
  roots.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || timeOf(b).localeCompare(timeOf(a)));
  for (const list of children.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { roots, children };
}

function makeGroup(head: Pick<SessionGroup, "id" | "kind" | "name" | "workspaceId" | "scope">, defaultRoots: Agent[], tree: Tree, input: GroupInput): SessionGroup {
  const roots = head.scope ? applySessionOrder(defaultRoots, input.orders?.[head.scope]) : defaultRoots;
  const foldable = input.view.show === "recent" && roots.length > RECENT_LIMIT;
  const folded = foldable && !input.expandedGroups.has(head.id);
  const shown = folded ? roots.slice(0, RECENT_LIMIT) : roots;
  const rows: SessionRow[] = [];
  const scopes: Record<string, ScopeList> = {};
  if (head.scope) scopes[head.scope] = { ids: roots.map((r) => r.id), shown: shown.length };
  const kidsOf = (agent: Agent) => applySessionOrder(tree.children.get(agent.id) ?? [], input.orders?.[kidsScope(agent.id)]);
  const walk = (agent: Agent, depth: number, scope: string | null) => {
    const kids = kidsOf(agent);
    rows.push({ agent, depth, hasChildren: kids.length > 0, scope });
    if (kids.length) scopes[kidsScope(agent.id)] = { ids: kids.map((k) => k.id), shown: kids.length };
    if (input.collapsedParents.has(agent.id)) return;
    for (const kid of kids) walk(kid, depth + 1, kidsScope(agent.id));
  };
  for (const root of shown) walk(root, 0, head.scope);
  const resetScopes = [...(head.scope ? [head.scope] : []), ...parentsIn(roots, tree).map(kidsScope)];
  return { ...head, count: roots.reduce((sum, r) => sum + 1 + descendants(r, tree), 0), rows, foldable, folded, hidden: folded ? roots.length - RECENT_LIMIT : 0, resetScopes, scopes };
}

function parentsIn(roots: Agent[], tree: Tree): string[] {
  const found: string[] = [];
  const visit = (agent: Agent) => {
    const kids = tree.children.get(agent.id);
    if (!kids?.length) return;
    found.push(agent.id);
    kids.forEach(visit);
  };
  roots.forEach(visit);
  return found;
}

function descendants(agent: Agent, tree: Tree): number {
  return (tree.children.get(agent.id) ?? []).reduce((sum, kid) => sum + 1 + descendants(kid, tree), 0);
}

const TIME_BUCKETS = ["today", "yesterday", "week", "older"] as const;
const TIME_NAMES: Record<(typeof TIME_BUCKETS)[number], () => string> = {
  today: () => S.timeToday,
  yesterday: () => S.timeYesterday,
  week: () => S.timeLast7Days,
  older: () => S.timeOlder,
};

export function timeBucket(iso: string, now: number): (typeof TIME_BUCKETS)[number] {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "older";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  if (time >= start.getTime()) return "today";
  if (time >= start.getTime() - day) return "yesterday";
  if (time >= start.getTime() - 7 * day) return "week";
  return "older";
}

export function relativeTime(iso: string, now: number): string {
  return relativeWith(iso, now, S.timeCompact);
}

export function relativeTimeLong(iso: string, now: number): string {
  return relativeWith(iso, now, (count, unit) => S.timeRelative(count, S.timeUnitLong[unit]));
}

const UNIT_STEPS = [
  { unit: "sec", below: 60, size: 1 },
  { unit: "min", below: 3600, size: 60 },
  { unit: "hr", below: 86_400, size: 3600 },
  { unit: "day", below: 604_800, size: 86_400 },
  { unit: "wk", below: 2_592_000, size: 604_800 },
  { unit: "mo", below: 31_536_000, size: 2_592_000 },
  { unit: "yr", below: Infinity, size: 31_536_000 },
] as const;

function relativeWith(iso: string, now: number, format: (count: number, unit: (typeof UNIT_STEPS)[number]["unit"]) => string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 30) return S.timeNow;
  const step = UNIT_STEPS.find((candidate) => seconds < candidate.below) ?? UNIT_STEPS[UNIT_STEPS.length - 1];
  return format(Math.round(seconds / step.size), step.unit);
}

export function sumChanges(files: ChangedFile[] | undefined) {
  const shown = files?.filter((f) => !isGeneratedPath(f.path));
  return { add: shown?.reduce((n, f) => n + f.additions, 0) ?? 0, del: shown?.reduce((n, f) => n + f.deletions, 0) ?? 0 };
}

import type { Agent, ChangedFile, Workspace } from "../shared/protocol";
import { isGeneratedPath } from "../shared/generatedFiles";
import { applySessionOrder, CHATS_SCOPE, DONE_SCOPE, FOLDERS_SCOPE, kidsScope, PINNED_SCOPE, type SessionOrders } from "../shared/sessionOrder";
import { S } from "./strings";

// B1: 사이드바 세션 목록의 묶음, 정렬, 접기 계산. 화면과 store 에 의존하지 않아서 test/sidebar.test.ts 가 그대로 부른다.

export type Ordering = "created" | "updated";
export type Grouping = "time" | "workspace";
export type ShowRange = "recent" | "all";

export type FolderOrder = "recent" | "name" | "manual";
export type SessionView = { ordering: Ordering | null; grouping: Grouping; show: ShowRange; showDone: boolean; folderOrder: FolderOrder };

export const DEFAULT_VIEW: SessionView = { ordering: null, grouping: "workspace", show: "recent", showDone: false, folderOrder: "recent" };

// Show=Recent 일 때 한 묶음이 처음 보이는 세션 수(갈래 자식은 세지 않는다).
export const RECENT_LIMIT = 5;

// scope 는 이 행이 순서를 바꿀 수 있는 목록(shared/sessionOrder.ts)이다. 최상위 행은 묶음의 scope, 갈래 행은 부모의 kidsScope 이고, 시간별 묶음의 최상위 행은 null(순서를 못 바꾼다).
export type SessionRow = { agent: Agent; depth: number; hasChildren: boolean; scope: string | null };

// 순서를 바꿀 수 있는 목록 하나. ids 는 접힌 것까지 포함한 전체 순서이고, shown 은 그중 화면에 보이는 앞쪽 개수(Show more 로 접힌 최상위는 보이지 않는다).
export type ScopeList = { ids: string[]; shown: number };

export type GroupKind = "pinned" | "chats" | "workspace" | "time" | "done";

export type SessionGroup = {
  id: string;
  kind: GroupKind;
  name: string;
  // kind 가 workspace 일 때만 있다
  workspaceId: string | null;
  // 묶음 안 세션 수(갈래 자식 포함). 화면에는 안 보이고 접근성 이름에만 쓴다.
  count: number;
  rows: SessionRow[];
  // 상위 세션이 RECENT_LIMIT 을 넘어 Show more 와 Show less 가 붙는 묶음
  foldable: boolean;
  folded: boolean;
  // 접혀서 안 보이는 최상위 세션 수(`+N more` 의 N)
  hidden: number;
  // 이 묶음의 최상위 세션 순서 scope. 시간별 묶음은 null.
  scope: string | null;
  // 순서 되돌리기가 지울 scope 전부: 묶음 scope 와, 묶음 안 부모 세션마다의 갈래 scope
  resetScopes: string[];
  // 이 묶음에서 순서를 바꿀 수 있는 목록(scope 별). 끌기와 키보드가 새 순서를 만들 때 쓴다.
  scopes: Record<string, ScopeList>;
};

export type GroupInput = {
  agents: Agent[];
  // 사이드바에 보이는 최상위 워크스페이스
  workspaces: Workspace[];
  topWorkspaceId: (workspaceId: string | null) => string | null;
  view: SessionView;
  defaultOrdering: Ordering;
  now: number;
  // 자식 행을 접어 둔 부모 세션 id
  collapsedParents: ReadonlySet<string>;
  // Show more 로 펼친 묶음 id
  expandedGroups: ReadonlySet<string>;
  // 손으로 정한 순서(scope 별 id 목록). 없으면 기본 정렬 그대로다.
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
  // 피드백 개선 세션은 Improvements 화면이 맡는다.
  const sessions = input.agents.filter((a) => !a.feedbackId);
  const active = sessions.filter((a) => !a.done);
  const finished = sessions.filter((a) => a.done);

  const groups: SessionGroup[] = [];
  // 고정한 세션은 어느 묶음에 속하든 맨 위 Pinned 묶음으로 올라간다. 고정한 세션의 갈래도 부모를 따라간다.
  const pinnedIds = pinnedFamily(active);
  const pinnedTree = buildTree(active.filter((a) => pinnedIds.has(a.id)), ordering);
  if (pinnedTree.roots.length) groups.push(makeGroup({ id: "pinned", kind: "pinned", name: S.groupPinned, workspaceId: null, scope: PINNED_SCOPE }, pinnedTree.roots, pinnedTree, input));
  const tree = buildTree(active.filter((a) => !pinnedIds.has(a.id)), ordering);
  if (view.grouping === "workspace") {
    // Chats 는 비어 있어도 머리가 보인다(안에는 No chats)
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

// 폴더 묶음 순서. recent 는 그 폴더 세션 중 가장 최근 updatedAt 이 큰 폴더가 위이고, 세션이 없는 폴더는 맨 아래다. 같으면 이름순.
// manual 은 recent 순서 위에 saved(FOLDERS_SCOPE 의 워크스페이스 id 목록)를 입힌다. saved 에 없는 폴더는 recent 순서 그대로 맨 위, saved 에만 있는 id 는 빠진다.
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
  // 접어 둔 묶음 id. 접힌 묶음의 행은 화면에 없으므로 이동 순서에서도 뺀다.
  collapsedGroups: ReadonlySet<string>;
};

export type SidebarLayout = {
  groups: SessionGroup[];
  // 순서를 바꿀 수 있는 목록 전부(묶음마다의 scopes 를 합친 것)
  scopes: Record<string, ScopeList>;
  // 사이드바에 보이는 세션 id 를 위에서 아래로. 사이드바 렌더와 이전, 다음 세션 이동이 같은 값을 쓴다.
  order: string[];
};

export function sidebarLayout(input: SidebarInput): SidebarLayout {
  const groups = buildGroups(input);
  const order = groups.filter((g) => !input.collapsedGroups.has(g.id)).flatMap((g) => g.rows.map((r) => r.agent.id));
  const scopes = Object.assign({}, ...groups.map((g) => g.scopes)) as Record<string, ScopeList>;
  // 폴더 묶음 자체의 순서 목록: 지금 보이는 최상위 폴더 순서 전부(접힌 폴더도 포함, Show more 는 없다)
  const folderIds = groups.flatMap((g) => (g.kind === "workspace" && g.workspaceId ? [g.workspaceId] : []));
  if (folderIds.length) scopes[FOLDERS_SCOPE] = { ids: folderIds, shown: folderIds.length };
  return { groups, scopes, order };
}

// 사이드바에서 부모 아래에 붙는 관계: 갈래(Forked)가 먼저, 없으면 핸드오프로 시작한 세션이 원 세션 아래에 붙는다.
export const parentId = (agent: Agent) => agent.forkedFrom ?? agent.handoffFrom ?? null;

// 고정한 세션과, 부모 쪽으로 거슬러 올라가다 고정한 세션을 만나는 갈래들
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

// 갈래 세션은 원 세션 아래에 붙는다. 원 세션이 같은 목록에 없으면(삭제됨, 다른 묶음) 자기가 최상위다.
// 최상위는 고정한 세션이 앞이고, 그 안에서 정렬 기준 시각이 최근인 순서. 자식은 만든 순서.
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
  // 손으로 정한 순서가 있으면 기본 정렬 위에 입힌다(새 세션은 맨 위). 접힌 최상위(Show more)도 이 순서의 뒤쪽이다.
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

// 묶음 안에서 자식이 있는 세션 id (접힌 부모도 포함)
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

// 기준 시각을 오늘 0시(로컬)에서 며칠 전인지로 나눈다. Last 7 days 는 어제 이전부터 7일 전 0시까지.
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
  return relativeWith(iso, now, S.timeUnitShort);
}

// B6: 세션 검색 둘째 줄의 시간. 사이드바와 같은 기준에 단위를 길게 쓴다: 2 minutes ago.
export function relativeTimeLong(iso: string, now: number): string {
  return relativeWith(iso, now, S.timeUnitLong);
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

function relativeWith(iso: string, now: number, words: typeof S.timeUnitShort): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 30) return S.timeNow;
  const step = UNIT_STEPS.find((candidate) => seconds < candidate.below) ?? UNIT_STEPS[UNIT_STEPS.length - 1];
  return S.timeRelative(Math.round(seconds / step.size), words[step.unit]);
}

// 생성 파일(shared/generatedFiles.ts)은 Changes 패널 목록에서 빠지므로 세션 행의 줄 수에서도 뺀다.
export function sumChanges(files: ChangedFile[] | undefined) {
  const shown = files?.filter((f) => !isGeneratedPath(f.path));
  return { add: shown?.reduce((n, f) => n + f.additions, 0) ?? 0, del: shown?.reduce((n, f) => n + f.deletions, 0) ?? 0 };
}

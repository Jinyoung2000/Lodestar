import type { Agent, SessionSort, Workspace } from "@shared/protocol";

export type SessionState = "waiting" | "error" | "running" | "unread" | "idle";

export function stateOf(agent: Agent): SessionState {
  if (agent.status === "waiting") return "waiting";
  if (agent.status === "error") return "error";
  if (agent.status === "running") return "running";
  if (agent.unread) return "unread";
  return "idle";
}

export type Section = { key: string; title: string; agents: Agent[]; kind: "pinned" | "workspace" | "chats" | "time" | "done" };
export type GroupView = { grouping: "workspace" | "time"; ordering: SessionSort };

const TIME_BUCKETS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "Last 7 days"], ["older", "Older"]] as const;
type TimeBucket = (typeof TIME_BUCKETS)[number][0];
const DAY_MS = 24 * 60 * 60 * 1000;

export function timeBucket(iso: string, now: number): TimeBucket {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "older";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return "today";
  if (time >= start.getTime() - DAY_MS) return "yesterday";
  if (time >= start.getTime() - 7 * DAY_MS) return "week";
  return "older";
}

const stampOf = (ordering: SessionSort) => (agent: Agent) => (ordering === "created" ? agent.createdAt : agent.updatedAt);

export function groupAgents(agents: readonly Agent[], workspaces: readonly Workspace[], query = "", view: GroupView = { grouping: "workspace", ordering: "updated" }, now = Date.now()): Section[] {
  const stamp = stampOf(view.ordering);
  const newestFirst = (a: Agent, b: Agent) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0);
  const needle = query.trim().toLowerCase();
  const space = new Map(workspaces.map((w) => [w.id, w]));
  const top = (id: string | null) => {
    if (id === null) return { key: "chats", title: "Chats" };
    const w = space.get(id);
    const parent = w?.parentId ? space.get(w.parentId) : null;
    const base = parent ?? w;
    return base ? { key: base.id, title: base.name } : { key: id, title: "Unknown folder" };
  };
  const matches = (agent: Agent) => needle === "" || agent.title.toLowerCase().includes(needle) || top(agent.workspaceId).title.toLowerCase().includes(needle);

  const pinned: Agent[] = [];
  const done: Agent[] = [];
  const groups = new Map<string, Section>();
  for (const agent of [...agents].sort(newestFirst)) {
    if (!matches(agent)) continue;
    if (agent.pinned) pinned.push(agent);
    else if (agent.done) done.push(agent);
    else if (view.grouping === "time") {
      const key = timeBucket(stamp(agent), now);
      const group = groups.get(key) ?? { key, title: key, agents: [], kind: "time" as const };
      group.agents.push(agent);
      groups.set(key, group);
    } else {
      const { key, title } = top(agent.workspaceId);
      const group = groups.get(key) ?? { key, title, agents: [], kind: key === "chats" ? "chats" as const : "workspace" as const };
      group.agents.push(agent);
      groups.set(key, group);
    }
  }
  const sections: Section[] = [];
  if (pinned.length) sections.push({ key: "pinned", title: "Pinned", agents: pinned, kind: "pinned" });
  if (view.grouping === "time") {
    for (const [key, title] of TIME_BUCKETS) {
      const group = groups.get(key);
      if (group) sections.push({ ...group, key: `time:${key}`, title });
    }
  } else sections.push(...groups.values());
  if (done.length) sections.push({ key: "done", title: "Done", agents: done, kind: "done" });
  return sections;
}

export function workspaceName(agent: Agent, workspaces: readonly Workspace[]): string {
  if (agent.workspaceId === null) return "Chat";
  const w = workspaces.find((x) => x.id === agent.workspaceId);
  const parent = w?.parentId ? workspaces.find((x) => x.id === w.parentId) : null;
  const name = (parent ?? w)?.name ?? "Unknown folder";
  if (agent.worktree && parent) return `${name} (${agent.worktree.branch})`;
  return parent && w ? w.name : name;
}

export function pickableWorkspaces(workspaces: readonly Workspace[], agents: readonly Agent[]): Workspace[] {
  const lastUse = new Map<string, string>();
  for (const agent of agents) if (agent.workspaceId) lastUse.set(agent.workspaceId, lastUse.get(agent.workspaceId) && lastUse.get(agent.workspaceId)! > agent.updatedAt ? lastUse.get(agent.workspaceId)! : agent.updatedAt);
  return workspaces.filter((w) => !w.parentId && !w.feedback).sort((a, b) => (lastUse.get(b.id) ?? "").localeCompare(lastUse.get(a.id) ?? "") || a.name.localeCompare(b.name));
}

export function waitingCount(agents: readonly Agent[]): number {
  return agents.filter((a) => a.status === "waiting").length;
}

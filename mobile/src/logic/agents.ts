import type { Agent, Workspace } from "@shared/protocol";

// 세션 목록: 워크스페이스별 묶음, 상태 점, 검색.

export type SessionState = "waiting" | "error" | "running" | "unread" | "idle";

// 목록 행의 상태 점. 답을 기다리는 것(승인, 질문)이 가장 눈에 띄어야 한다.
export function stateOf(agent: Agent): SessionState {
  if (agent.status === "waiting") return "waiting";
  if (agent.status === "error") return "error";
  if (agent.status === "running") return "running";
  if (agent.unread) return "unread";
  return "idle";
}

export type Section = { key: string; title: string; agents: Agent[] };

const byUpdated = (a: Agent, b: Agent) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

// 상위 프로젝트 이름으로 묶는다(worktree 워크스페이스는 부모 프로젝트 아래). 폴더 없는 세션은 Chats.
// 묶음 순서는 그 묶음에서 가장 최근에 움직인 세션 순이고, 고정(pinned)은 맨 위 묶음이다. done 은 맨 아래 한 묶음.
export function groupAgents(agents: readonly Agent[], workspaces: readonly Workspace[], query = ""): Section[] {
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
  for (const agent of [...agents].sort(byUpdated)) {
    if (!matches(agent)) continue;
    if (agent.pinned) pinned.push(agent);
    else if (agent.done) done.push(agent);
    else {
      const { key, title } = top(agent.workspaceId);
      const group = groups.get(key) ?? { key, title, agents: [] };
      group.agents.push(agent);
      groups.set(key, group);
    }
  }
  const sections: Section[] = [];
  if (pinned.length) sections.push({ key: "pinned", title: "Pinned", agents: pinned });
  sections.push(...groups.values());
  if (done.length) sections.push({ key: "done", title: "Done", agents: done });
  return sections;
}

export function workspaceName(agent: Agent, workspaces: readonly Workspace[]): string {
  if (agent.workspaceId === null) return "Chat";
  const w = workspaces.find((x) => x.id === agent.workspaceId);
  const parent = w?.parentId ? workspaces.find((x) => x.id === w.parentId) : null;
  const name = (parent ?? w)?.name ?? "Unknown folder";
  if (agent.worktree && parent) return `${name} (${agent.worktree.branch})`;
  // worktree 워크스페이스에서 시작한 세션(agent.worktree 가 없다)은 워크스페이스 이름 "프로젝트 (브랜치)" 가 그대로 위치 표시다
  return parent && w ? w.name : name;
}

// 새 세션을 만들 때 고를 수 있는 폴더: 최상위 프로젝트만(worktree 와 피드백 용은 뺀다), 최근에 쓴 순서
export function pickableWorkspaces(workspaces: readonly Workspace[], agents: readonly Agent[]): Workspace[] {
  const lastUse = new Map<string, string>();
  for (const agent of agents) if (agent.workspaceId) lastUse.set(agent.workspaceId, lastUse.get(agent.workspaceId) && lastUse.get(agent.workspaceId)! > agent.updatedAt ? lastUse.get(agent.workspaceId)! : agent.updatedAt);
  return workspaces.filter((w) => !w.parentId && !w.feedback).sort((a, b) => (lastUse.get(b.id) ?? "").localeCompare(lastUse.get(a.id) ?? "") || a.name.localeCompare(b.name));
}

// 승인이나 질문을 기다리는 세션 수(앱 아이콘 배지, 목록 머리 요약)
export function waitingCount(agents: readonly Agent[]): number {
  return agents.filter((a) => a.status === "waiting").length;
}

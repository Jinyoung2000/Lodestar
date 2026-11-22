import type { Agent, Workspace } from "../shared/protocol";
import { withoutImprovementSessions } from "./improvementRows";
import { S } from "./strings";

export type SessionOption = { agent: Agent; folder: string; worktree: boolean; section: "recent" | "other" };

export type SessionSearchInput = {
  agents: Agent[];
  workspaces: Workspace[];
  recentIds: string[];
  query: string;
};

export const SESSION_SEARCH_LIMIT = 200;

export function sessionOptions({ agents: all, workspaces, recentIds, query }: SessionSearchInput): SessionOption[] {
  const agents = withoutImprovementSessions(all);
  const q = query.trim().toLowerCase();
  const byId = new Map(agents.map((a) => [a.id, a]));
  const recent = recentIds.map((id) => byId.get(id)).filter((a): a is Agent => !!a);
  const recentSet = new Set(recent.map((a) => a.id));
  const others = agents.filter((a) => !recentSet.has(a.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const options: SessionOption[] = [
    ...recent.map((agent) => ({ agent, section: "recent" as const })),
    ...others.map((agent) => ({ agent, section: "other" as const })),
  ].map(({ agent, section }) => ({ agent, section, folder: folderName(agent, workspaces), worktree: !!agent.worktree }));
  return options.filter((o) => !q || `${o.agent.title} ${o.folder}`.toLowerCase().includes(q)).slice(0, SESSION_SEARCH_LIMIT);
}

export function folderName(agent: Agent, workspaces: Workspace[]): string {
  if (agent.workspaceId === null) return S.groupChats;
  const own = workspaces.find((w) => w.id === agent.workspaceId);
  const top = own?.parentId ? workspaces.find((w) => w.id === own.parentId) : own;
  if (top) return top.name;
  return agent.cwd.split("/").filter(Boolean).pop() ?? "";
}

export function startsSection(options: SessionOption[], index: number): boolean {
  return index === 0 || options[index - 1].section !== options[index].section;
}

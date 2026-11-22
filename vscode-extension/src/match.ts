import type { Agent, Workspace } from "../../shared/protocol";

export type RealPath = (path: string) => string;

export function workspaceForFolder(folder: string, workspaces: Workspace[], real: RealPath): Workspace | null {
  const same = workspaces.filter((w) => !w.feedback && real(w.dir) === folder);
  return same.find((w) => w.parentId === null) ?? same[0] ?? null;
}

export function matchSessions(folders: string[], workspaces: Workspace[], agents: Agent[], real: RealPath): Agent[] {
  const open = new Set(folders);
  const direct = workspaces.filter((w) => !w.feedback && open.has(real(w.dir)));
  const ids = new Set(direct.map((w) => w.id));
  for (const w of workspaces) if (w.parentId && ids.has(w.parentId)) ids.add(w.id);
  return agents.filter((a) => {
    if (a.workspaceId === null || a.feedbackId) return false;
    if (ids.has(a.workspaceId)) return true;
    if (open.has(real(a.cwd))) return true;
    return !!a.worktree && open.has(real(a.worktree.root));
  });
}

export type SessionStatus = "running" | "waiting" | "error" | "unread" | "read";

export function statusOf(agent: Agent): SessionStatus {
  if (agent.status === "running") return "running";
  if (agent.status === "waiting") return "waiting";
  if (agent.status === "error") return "error";
  return agent.unread ? "unread" : "read";
}

const STATUS_TEXT: Record<SessionStatus, string> = { running: "Working...", waiting: "Input needed", error: "Error", unread: "", read: "" };

export function describeSession(agent: Agent, now: number): string {
  const text = STATUS_TEXT[statusOf(agent)];
  const time = relativeTime(now - Date.parse(agent.updatedAt));
  return text ? `${text} ${time}` : time;
}

export function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

export function sortSessions(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function attentionCount(agents: Agent[]): number {
  return agents.filter((a) => !a.done && (a.status === "waiting" || (a.status === "idle" && a.unread))).length;
}

export function selectedLines(text: (line: number) => string, start: { line: number; character: number }, end: { line: number; character: number }): { startLine: number; endLine: number; text: string } {
  const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  const lines: string[] = [];
  for (let line = start.line; line <= lastLine; line++) lines.push(text(line));
  return { startLine: start.line + 1, endLine: lastLine + 1, text: lines.join("\n") };
}

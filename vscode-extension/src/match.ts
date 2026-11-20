import type { Agent, Workspace } from "../../shared/protocol";

// 이 파일은 vscode 모듈을 쓰지 않는다. 루트의 test/vsext.test.ts 가 그대로 불러 시험한다.

export type RealPath = (path: string) => string;

// 폴더와 같은 경로의 워크스페이스. VS Code 가 worktree 폴더를 열었으면 그 worktree 워크스페이스, 프로젝트 폴더를 열었으면 프로젝트 워크스페이스다.
export function workspaceForFolder(folder: string, workspaces: Workspace[], real: RealPath): Workspace | null {
  const same = workspaces.filter((w) => !w.feedback && real(w.dir) === folder);
  return same.find((w) => w.parentId === null) ?? same[0] ?? null;
}

// 열린 폴더들에 속한 세션. 프로젝트 워크스페이스는 자기 worktree 워크스페이스(parentId)의 세션도 포함한다. 폴더 없는 세션(Chats)은 제외한다.
// 경로는 모두 realpath 로 비교한다(/tmp 와 /private/tmp). 상위나 하위 폴더는 같은 폴더로 치지 않는다.
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

// 트리 행 오른쪽 글: 진행 중, 승인 대기, 오류는 상태 문구와 시간, 안 읽음과 읽음은 시간만(안 읽음은 파란 점이 말해 준다).
export function describeSession(agent: Agent, now: number): string {
  const text = STATUS_TEXT[statusOf(agent)];
  const time = relativeTime(now - Date.parse(agent.updatedAt));
  return text ? `${text} ${time}` : time;
}

// Lodestar 사이드바의 상대 시간과 같은 단위(now, 분, 시간, 일, 주).
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

// 고정한 세션이 위, 그 안에서는 최근에 움직인 순서.
export function sortSessions(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

// 안 읽음과 승인 대기를 합친 수. Activity Bar 아이콘의 배지다.
export function attentionCount(agents: Agent[]): number {
  return agents.filter((a) => !a.done && (a.status === "waiting" || (a.status === "idle" && a.unread))).length;
}

// 에디터 선택이 걸친 줄 전체. 끝이 다음 줄 맨 앞이면 그 줄은 뺀다(Lodestar 에디터의 첨부와 같은 규칙).
export function selectedLines(text: (line: number) => string, start: { line: number; character: number }, end: { line: number; character: number }): { startLine: number; endLine: number; text: string } {
  const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  const lines: string[] = [];
  for (let line = start.line; line <= lastLine; line++) lines.push(text(line));
  return { startLine: start.line + 1, endLine: lastLine + 1, text: lines.join("\n") };
}

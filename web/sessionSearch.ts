import type { Agent, Workspace } from "../shared/protocol";
import { withoutImprovementSessions } from "./improvementRows";
import { S } from "./strings";

// B6: 세션 검색(⌃⌥R)의 목록 계산. 화면과 store 에 의존하지 않아서 test/overlays.test.ts 가 그대로 부른다.
export type SessionOption = { agent: Agent; folder: string; worktree: boolean; section: "recent" | "other" };

export type SessionSearchInput = {
  agents: Agent[];
  // 알고 있는 모든 워크스페이스(worktree 포함). worktree 세션은 원래 프로젝트 이름으로 보인다.
  workspaces: Workspace[];
  // 최근에 연 세션 id, 최근 것이 앞
  recentIds: string[];
  query: string;
};

export const SESSION_SEARCH_LIMIT = 200;

// recently opened(연 순서의 역순) 다음에 other sessions(updatedAt 이 최근인 순). 제목이나 폴더 이름에 질의가 들어 있는 세션만 남긴다.
// 피드백 개선 세션은 Improvements 화면이 맡아서 여기 나오지 않는다.
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

// 워크스페이스를 모르는 세션(지워진 폴더, 다른 프로젝트)은 세션이 돌던 폴더의 이름을 쓴다.
export function folderName(agent: Agent, workspaces: Workspace[]): string {
  if (agent.workspaceId === null) return S.groupChats;
  const own = workspaces.find((w) => w.id === agent.workspaceId);
  const top = own?.parentId ? workspaces.find((w) => w.id === own.parentId) : own;
  if (top) return top.name;
  return agent.cwd.split("/").filter(Boolean).pop() ?? "";
}

// 구역 머리말(recently opened, other sessions)은 구역의 첫 행 오른쪽에 붙는다.
export function startsSection(options: SessionOption[], index: number): boolean {
  return index === 0 || options[index - 1].section !== options[index].section;
}

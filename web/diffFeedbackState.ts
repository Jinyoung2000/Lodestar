import { useSyncExternalStore } from "react";
import type { Agent, DiffFeedback, ServerEvent } from "../shared/protocol";
import { rpc } from "./rpc";
import { absolutePath } from "./lsp";
import { activeAgent, flash, getState, openDiff, openFile } from "./store";

// DIFFFB: 세션마다 쌓은 diff 피드백을 화면이 들고 있는 작은 저장소. 원본은 데몬(`~/.agent-nav/diff-feedback/`)이고 여기는 읽어 온 복사본이다.
// store.ts 의 State 와 따로 둔다(changesState.ts 와 같은 방식).
type Reveal = { agentId: string; path: string; line: number; nonce: number; at: number };

type FeedbackState = {
  items: Record<string, DiffFeedback[]>;
  shown: Record<string, string[]>;
  reveal: Reveal | null;
};

let state: FeedbackState = { items: {}, shown: {}, reveal: null };
const listeners = new Set<() => void>();
const EMPTY: DiffFeedback[] = [];
let revealNonce = 0;
const loading = new Set<string>();

function set(patch: (s: FeedbackState) => Partial<FeedbackState>) {
  state = { ...state, ...patch(state) };
  listeners.forEach((l) => l());
}

export const subscribeDiffFeedback = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const getDiffFeedback = (agentId: string) => state.items[agentId] ?? EMPTY;
export const useFeedbackReveal = () => useSyncExternalStore(subscribeDiffFeedback, () => state.reveal);

export function useDiffFeedback(agentId: string | null | undefined): DiffFeedback[] {
  return useSyncExternalStore(subscribeDiffFeedback, () => (agentId ? (state.items[agentId] ?? EMPTY) : EMPTY));
}

export const pendingOf = (items: DiffFeedback[]) => items.filter((f) => f.state === "accepted");

// 에디터에 그릴 피드백: 쌓인 것과 다시 보이기로 한 보낸 것
export function visibleFeedback(agentId: string, path: string) {
  const shown = state.shown[agentId] ?? [];
  return getDiffFeedback(agentId).filter((f) => f.path === path && (f.state === "accepted" || shown.includes(f.id)));
}

export function hideSubmitted(agentId: string, id: string) {
  set((s) => ({ shown: { ...s.shown, [agentId]: (s.shown[agentId] ?? []).filter((x) => x !== id) } }));
}

export function ensureDiffFeedback(agentId: string) {
  if (state.items[agentId] || loading.has(agentId)) return;
  loading.add(agentId);
  void rpc
    .call("diffFeedback.list", { agentId })
    .then((items) => set((s) => ({ items: { ...s.items, [agentId]: s.items[agentId] ?? items } })))
    .catch(() => undefined)
    .finally(() => loading.delete(agentId));
}

export function applyDiffFeedbackEvent(event: Extract<ServerEvent, { type: "diffFeedback" }>) {
  set((s) => ({ items: { ...s.items, [event.agentId]: event.items } }));
}

const fail = (error: Error) => flash(error.message);

export type NewDiffFeedback = Omit<DiffFeedback, "id" | "state" | "createdAt">;

export async function addDiffFeedback(agentId: string, item: NewDiffFeedback) {
  try {
    return await rpc.call("diffFeedback.add", { agentId, item });
  } catch (error) {
    fail(error as Error);
    return null;
  }
}

export const updateDiffFeedback = (agentId: string, id: string, text: string) => void rpc.call("diffFeedback.update", { agentId, id, text }).catch(fail);
export const removeDiffFeedback = (agentId: string, id: string) => void rpc.call("diffFeedback.remove", { agentId, id }).catch(fail);
export const clearDiffFeedback = (agentId: string) => void rpc.call("diffFeedback.clear", { agentId }).catch(fail);

// 쌓인 것 전부를 한 메시지로 보낸다. text 는 입력창에 쓴 글(없으면 빈 문자열). 응답 중이면 서버가 큐에 넣는다.
export function sendDiffFeedback(agentId: string, text: string, steer = false) {
  return rpc.call("diffFeedback.send", { agentId, text, steer });
}

// 작업 폴더 기준 상대 경로. 세션 폴더, worktree, 워크스페이스 폴더 순으로 맞는 것을 쓴다.
export function relativeToAgent(agent: Agent | undefined, absolute: string) {
  const workspace = agent?.workspaceId ? getState().workspaces.find((w) => w.id === agent.workspaceId) : undefined;
  for (const root of [agent?.cwd, agent?.worktree?.root, workspace?.dir]) {
    if (root && absolute.startsWith(`${root}/`)) return absolute.slice(root.length + 1);
  }
  return absolute;
}

// 칩이나 목록에서 피드백 위치로 간다. 바뀐 파일이면 diff 탭, 아니면 파일 탭을 열고 그 줄을 보인다. 보낸 피드백이면 에디터에 다시 보인다.
export function revealDiffFeedback(agentId: string, target: { path: string; line: number; id?: string }) {
  const agent = getState().agents.find((a) => a.id === agentId);
  if (!agent?.workspaceId) return;
  if (target.id) {
    const id = target.id;
    if (getDiffFeedback(agentId).some((f) => f.id === id && f.state === "submitted")) set((s) => ({ shown: { ...s.shown, [agentId]: [...new Set([...(s.shown[agentId] ?? []), id])] } }));
  }
  const changed = getState().gitChanges[agentId]?.files.some((f) => f.path === target.path);
  set(() => ({ reveal: { agentId, path: target.path, line: target.line, nonce: ++revealNonce, at: Date.now() } }));
  if (changed) openDiff(agentId, agent.workspaceId, target.path);
  else {
    const workspace = getState().workspaces.find((w) => target.path.startsWith(`${w.dir}/`));
    if (workspace) openFile({ workspaceId: workspace.id, path: target.path.slice(workspace.dir.length + 1), line: target.line });
  }
}

// 에디터 탭의 파일에 피드백을 보낼 세션: 지금 보고 있는 세션이고 그 파일이 세션 폴더(또는 worktree, 워크스페이스 폴더) 안일 때만이다. 없으면 null.
export function feedbackAgentFor(workspaceId: string, path: string): string | null {
  const agent = activeAgent();
  if (!agent?.workspaceId) return null;
  const workspace = getState().workspaces.find((w) => w.id === agent.workspaceId);
  const absolute = absolutePath(workspaceId, path);
  return [agent.cwd, agent.worktree?.root, workspace?.dir].some((root) => root && absolute.startsWith(`${root}/`)) ? agent.id : null;
}

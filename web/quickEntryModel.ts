import type { Agent, EffortLevel, PermissionMode, ResolvedDefaults, Settings, Workspace } from "../shared/protocol";
import { S } from "./strings";

// 전역 빠른 입력창(web/QuickEntry.tsx)의 순수 로직: 대상 선택, 키 분기, 전송 계획. React 와 store 에 의존하지 않아 test/quickentry.test.ts 가 단독으로 돌린다.

// 어디로 보낼지. new: 이 워크스페이스의 새 세션, chat: 폴더 없는 빠른 채팅(새 세션 화면의 Chat), session: 이미 있는 세션에 이어 보내기
export type QuickTarget = { kind: "new"; workspaceId: string } | { kind: "chat" } | { kind: "session"; agentId: string };

export const RECENT_SESSION_LIMIT = 5;
export const RECENT_WORKSPACE_LIMIT = 6;

const isTop = (w: Workspace) => !w.parentId && !w.feedback;

// 최근에 쓴 순서의 최상위 워크스페이스. 최근은 그 폴더(와 worktree)의 세션 중 가장 늦은 updatedAt 이고, 세션이 하나도 없는 폴더는 뒤로 간다.
export function workspacesByRecency(workspaces: readonly Workspace[], agents: readonly Agent[]): Workspace[] {
  const parentOf = new Map(workspaces.map((w) => [w.id, w.parentId ?? w.id]));
  const latest = new Map<string, string>();
  for (const agent of agents) {
    if (!agent.workspaceId || agent.feedbackId) continue;
    const top = parentOf.get(agent.workspaceId);
    if (!top) continue;
    const seen = latest.get(top);
    if (!seen || agent.updatedAt > seen) latest.set(top, agent.updatedAt);
  }
  return workspaces
    .filter(isTop)
    .map((workspace, index) => ({ workspace, index, at: latest.get(workspace.id) ?? "" }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? 1 : -1))
    .map((entry) => entry.workspace);
}

// 이어 보낼 수 있는 최근 세션. 보관(done)한 세션과 피드백 개선 세션은 뺀다.
export function recentSessions(agents: readonly Agent[], limit = RECENT_SESSION_LIMIT): Agent[] {
  return agents
    .filter((a) => !a.done && !a.feedbackId)
    .slice()
    .sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit);
}

// 기본 대상: 폴더 없는 빠른 채팅(사용자 10-20 "quick chat은 chat 모드(no folder)가 기본"). 폴더의 새 세션이나 이어 보내기는 목록에서 고른다.
// 고른 대상은 쓰던 글이 남아 있는 동안만 유지되고, 빈 입력창으로 다시 열면 이 기본으로 돌아온다(web/QuickEntry.tsx).
export function defaultTarget(_workspaces: readonly Workspace[], _agents: readonly Agent[]): QuickTarget {
  return { kind: "chat" };
}

// 저장해 둔 대상이 아직 유효한가(폴더나 세션이 지워졌을 수 있다). 아니면 기본 대상.
export function validTarget(target: QuickTarget | null, workspaces: readonly Workspace[], agents: readonly Agent[]): QuickTarget {
  if (target?.kind === "chat") return target;
  if (target?.kind === "new" && workspaces.some((w) => w.id === target.workspaceId && isTop(w))) return target;
  if (target?.kind === "session" && agents.some((a) => a.id === target.agentId)) return target;
  return defaultTarget(workspaces, agents);
}

// 대상 목록의 한 줄. section: 새 세션을 만들 폴더들(new), 폴더 없는 빠른 채팅(chat), 이어 보낼 세션들(session)
export type TargetRow = { key: string; section: "new" | "chat" | "session"; target: QuickTarget; label: string; hint: string };

const tildePath = (path: string) => path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

// 목록에 보일 줄들. 폴더는 최근 쓴 순서로 RECENT_WORKSPACE_LIMIT 개까지이고, 지금 고른 폴더가 그 밖이면 맨 앞에 끼운다.
export function targetRows(workspaces: readonly Workspace[], agents: readonly Agent[], current: QuickTarget): TargetRow[] {
  const ordered = workspacesByRecency(workspaces, agents);
  const shown = ordered.slice(0, RECENT_WORKSPACE_LIMIT);
  const picked = current.kind === "new" ? ordered.find((w) => w.id === current.workspaceId) : undefined;
  if (picked && !shown.includes(picked)) shown.unshift(picked);
  const nameOf = new Map(workspaces.map((w) => [w.id, w.name]));
  return [
    ...shown.map((w): TargetRow => ({ key: `new:${w.id}`, section: "new", target: { kind: "new", workspaceId: w.id }, label: w.name, hint: tildePath(w.dir) })),
    { key: "chat", section: "chat", target: { kind: "chat" }, label: S.quickEntryChat, hint: S.quickEntryChatHint },
    ...recentSessions(agents).map((a): TargetRow => ({ key: `session:${a.id}`, section: "session", target: { kind: "session", agentId: a.id }, label: a.title, hint: a.workspaceId ? (nameOf.get(a.workspaceId) ?? "") : S.quickEntryChat })),
  ];
}

export const sameTarget = (a: QuickTarget, b: QuickTarget) => (a.kind === "new" && b.kind === "new" ? a.workspaceId === b.workspaceId : a.kind === "session" && b.kind === "session" ? a.agentId === b.agentId : a.kind === b.kind);

// 대상 알약에 적을 짧은 이름
export function targetLabel(target: QuickTarget, workspaces: readonly Workspace[], agents: readonly Agent[]): string {
  if (target.kind === "chat") return S.quickEntryChat;
  if (target.kind === "new") return S.quickEntryTargetNew(workspaces.find((w) => w.id === target.workspaceId)?.name ?? "folder");
  return S.quickEntryTargetReply(agents.find((a) => a.id === target.agentId)?.title ?? "session");
}

// 입력칸 키. send-open: Enter(보내고 패널이 대화로 커진다), send-stay: ⌘Enter(보내고 패널을 숨긴다), newline: Shift+Enter(줄바꿈은 입력칸이 한다),
// close: Esc, menu: ⌥↓(대상 목록 열기), none: 그 밖의 키와 한글 조합 중인 Enter.
export type QuickKeyAction = "send-open" | "send-stay" | "newline" | "close" | "menu" | "none";

export type QuickKeyEvent = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; isComposing: boolean; keyCode?: number };

export function quickKeyAction(e: QuickKeyEvent): QuickKeyAction {
  if (e.isComposing || e.keyCode === 229) return "none";
  if (e.key === "Escape") return "close";
  if (e.key === "ArrowDown" && e.altKey && !e.metaKey && !e.ctrlKey) return "menu";
  if (e.key !== "Enter") return "none";
  if (e.metaKey || e.ctrlKey) return "send-stay";
  if (e.shiftKey || e.altKey) return "newline";
  return "send-open";
}

export type QuickDefaults = { permissionMode: PermissionMode; model: string | null; effort: EffortLevel | null };

// 새 세션의 모델, effort, 권한. 새 세션 화면(web/defaults.ts effectiveDefaults)과 같은 순서로, 데몬이 해석한 값 > settings 에서 고른 값 > 내장값이다.
// "마지막으로 고른 값"은 메인 창의 입력창 칩이 쓰는 기억이라 빠른 입력창은 따르지 않고 기본값을 쓴다.
export function quickDefaults(settings: Pick<Settings, "defaultModel" | "defaultEffort" | "defaultPermissionMode"> | null, resolved: ResolvedDefaults | null): QuickDefaults {
  return {
    model: resolved?.model.value ?? settings?.defaultModel ?? null,
    effort: resolved?.effort.value ?? settings?.defaultEffort ?? null,
    permissionMode: resolved?.permissionMode.value ?? settings?.defaultPermissionMode ?? "default",
  };
}

// images 는 업로드한 뒤에 붙는다(전송 직전에 images.upload 로 올리고 참조를 받는다). 글도 이미지도 없으면 보낼 게 없다(null).
export type QuickSendPlan =
  | { method: "agents.create"; params: { workspaceId: string | null; prompt: string; permissionMode: PermissionMode; model: string | null; effort: EffortLevel | null; worktree: null } }
  | { method: "agents.send"; params: { agentId: string; prompt: string } };

export function planQuickSend(input: { target: QuickTarget; text: string; imageCount: number; defaults: QuickDefaults }): QuickSendPlan | null {
  const prompt = input.text.trim();
  if (!prompt && input.imageCount === 0) return null;
  const { target, defaults } = input;
  if (target.kind === "session") return { method: "agents.send", params: { agentId: target.agentId, prompt } };
  return { method: "agents.create", params: { workspaceId: target.kind === "new" ? target.workspaceId : null, prompt, permissionMode: defaults.permissionMode, model: defaults.model, effort: defaults.effort, worktree: null } };
}

// 보내기 단추를 누를 수 있나
export function canQuickSend(state: { connected: boolean; busy: boolean; text: string; imageCount: number }): boolean {
  return state.connected && !state.busy && (state.text.trim() !== "" || state.imageCount > 0);
}

// 저장해 둔 초안(localStorage). 깨졌으면 빈 초안.
export type QuickDraft = { text: string; target: QuickTarget | null };

export function parseDraft(raw: string | null): QuickDraft {
  try {
    const value = JSON.parse(raw ?? "null") as { text?: unknown; target?: unknown } | null;
    const text = typeof value?.text === "string" ? value.text : "";
    const t = value?.target as { kind?: unknown; workspaceId?: unknown; agentId?: unknown } | null | undefined;
    const target: QuickTarget | null = t?.kind === "chat" ? { kind: "chat" } : t?.kind === "new" && typeof t.workspaceId === "string" ? { kind: "new", workspaceId: t.workspaceId } : t?.kind === "session" && typeof t.agentId === "string" ? { kind: "session", agentId: t.agentId } : null;
    return { text, target };
  } catch {
    return { text: "", target: null };
  }
}

import { CLAUDE_EFFORT_LEVELS, type Agent, type EffortLevel, type ModelInfo, type PermissionMode, type ResolvedDefaults, type Settings, type Workspace } from "../shared/protocol";
import { aliasModelName, modelNameFromId, versionedDisplayName } from "../shared/modelName";
import { S } from "./strings";

export type QuickTarget = { kind: "new"; workspaceId: string } | { kind: "chat" } | { kind: "session"; agentId: string };

export const RECENT_SESSION_LIMIT = 5;
export const RECENT_WORKSPACE_LIMIT = 6;

const isTop = (w: Workspace) => !w.parentId && !w.feedback;

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

export function recentSessions(agents: readonly Agent[], limit = RECENT_SESSION_LIMIT): Agent[] {
  return agents
    .filter((a) => !a.done && !a.feedbackId)
    .slice()
    .sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit);
}

export function defaultTarget(_workspaces: readonly Workspace[], _agents: readonly Agent[]): QuickTarget {
  return { kind: "chat" };
}

export function validTarget(target: QuickTarget | null, workspaces: readonly Workspace[], agents: readonly Agent[]): QuickTarget {
  if (target?.kind === "chat") return target;
  if (target?.kind === "new" && workspaces.some((w) => w.id === target.workspaceId && isTop(w))) return target;
  if (target?.kind === "session" && agents.some((a) => a.id === target.agentId)) return target;
  return defaultTarget(workspaces, agents);
}

export type TargetRow = { key: string; section: "new" | "chat" | "session"; target: QuickTarget; label: string; hint: string };

const tildePath = (path: string) => path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

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

export function targetLabel(target: QuickTarget, workspaces: readonly Workspace[], agents: readonly Agent[]): string {
  if (target.kind === "chat") return S.quickEntryChat;
  if (target.kind === "new") return S.quickEntryTargetNew(workspaces.find((w) => w.id === target.workspaceId)?.name ?? "folder");
  return S.quickEntryTargetReply(agents.find((a) => a.id === target.agentId)?.title ?? "session");
}

export type QuickKeyAction = "send-open" | "send-stay" | "newline" | "close" | "menu" | "model-menu" | "none";

export type QuickKeyEvent = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; isComposing: boolean; keyCode?: number };

export function quickKeyAction(e: QuickKeyEvent): QuickKeyAction {
  if (e.isComposing || e.keyCode === 229) return "none";
  if (e.key === "Escape") return "close";
  if (e.key === "ArrowDown" && e.altKey && !e.metaKey && !e.ctrlKey) return "menu";
  if (e.key === "ArrowUp" && e.altKey && !e.metaKey && !e.ctrlKey) return "model-menu";
  if (e.key !== "Enter") return "none";
  if (e.metaKey || e.ctrlKey) return "send-stay";
  if (e.shiftKey || e.altKey) return "newline";
  return "send-open";
}

export type QuickDefaults = { permissionMode: PermissionMode; model: string | null; effort: EffortLevel | null };

export function quickDefaults(settings: Pick<Settings, "defaultModel" | "defaultEffort" | "defaultPermissionMode"> | null, resolved: ResolvedDefaults | null): QuickDefaults {
  return {
    model: resolved?.model.value ?? settings?.defaultModel ?? null,
    effort: resolved?.effort.value ?? settings?.defaultEffort ?? null,
    permissionMode: resolved?.permissionMode.value ?? settings?.defaultPermissionMode ?? "default",
  };
}

type QuickModel = Pick<ModelInfo, "value" | "resolvedModel" | "displayName">;

export type ModelRow = { key: string; value: string | null; label: string; hint: string; isDefault: boolean };

export function quickModelName(id: string | null, models: readonly QuickModel[]): string {
  const fallback = models.find((m) => m.value === "default");
  const target = id && id !== "default" ? id.replace(/\[[^\]]*\]$/, "") : (fallback?.resolvedModel ?? null);
  if (!target) return fallback?.displayName ?? S.default;
  const known = models.find((m) => m.value !== "default" && (m.value === target || m.resolvedModel === target));
  return known ? versionedDisplayName(known.displayName, known.resolvedModel ?? (target.startsWith("claude-") ? target : null)) : (modelNameFromId(target) ?? aliasModelName(target, models.map((m) => m.resolvedModel)) ?? target);
}

export function quickEffort(id: string | null, effort: EffortLevel | null, models: readonly Pick<ModelInfo, "value" | "resolvedModel" | "supportedEffortLevels">[]): EffortLevel | null {
  const base = id && id !== "default" ? id.replace(/\[[^\]]*\]$/, "") : null;
  const info = (base ? models.find((m) => m.value === base || m.resolvedModel === base) : undefined) ?? models.find((m) => m.value === "default");
  const levels: readonly EffortLevel[] = info?.supportedEffortLevels.length ? info.supportedEffortLevels : CLAUDE_EFFORT_LEVELS;
  if (effort && levels.includes(effort)) return effort;
  return levels.includes("high") ? "high" : (levels[levels.length - 1] ?? null);
}

export function modelRows(models: readonly QuickModel[], defaultModel: string | null): ModelRow[] {
  const fallback = models.find((m) => m.value === "default");
  const defaultId = defaultModel && defaultModel !== "default" ? defaultModel.replace(/\[[^\]]*\]$/, "") : (fallback?.resolvedModel ?? null);
  const isDefault = (m: QuickModel) => defaultId !== null && (m.value === defaultId || m.resolvedModel === defaultId);
  const rows = models.filter((m) => m.value !== "default").map((m): ModelRow => ({ key: `model:${m.value}`, value: m.value, label: quickModelName(m.value, models), hint: m.resolvedModel ?? m.value, isDefault: isDefault(m) }));
  if (rows.some((row) => row.isDefault)) return rows;
  return [{ key: "default", value: null, label: quickModelName(defaultModel, models), hint: defaultId ?? "", isDefault: true }, ...rows];
}

export function chosenModelRow(rows: readonly ModelRow[], chosen: string | null): ModelRow | undefined {
  return chosen === null ? rows.find((row) => row.isDefault) : rows.find((row) => row.value === chosen);
}

export function validModel(chosen: string | null, models: readonly QuickModel[]): string | null {
  if (chosen === null || models.length === 0) return chosen;
  return models.some((m) => m.value === chosen && m.value !== "default") ? chosen : null;
}

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

export function canQuickSend(state: { connected: boolean; busy: boolean; text: string; imageCount: number }): boolean {
  return state.connected && !state.busy && (state.text.trim() !== "" || state.imageCount > 0);
}

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

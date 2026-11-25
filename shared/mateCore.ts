import type { AssistantAction, AssistantCheckIn, CheckInReason } from "./assistant";
import type { FollowUpItem, FollowUpsState } from "./followups";
import type { Agent, TimelineItem } from "./protocol";

const DAY_MS = 86_400_000;
export const ACTIVE_DAYS = 7;
const QUESTION_TOOL = "AskUserQuestion";
const PLAN_TOOL = "ExitPlanMode";

export const SNOOZE_CHOICES = ["2h", "tomorrow", "nextWeek"] as const;
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number];
export const isSnoozeChoice = (value: unknown): value is SnoozeChoice => typeof value === "string" && (SNOOZE_CHOICES as readonly string[]).includes(value);

export const isSnoozed = (item: Pick<FollowUpItem, "snoozedUntil">, now: number) => item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > now;

type TrackedRef = Pick<Agent, "done" | "feedbackId" | "automationId" | "assistant">;
export const isTracked = (agent: TrackedRef) => !agent.done && !agent.feedbackId && !agent.automationId && !agent.assistant;

export type ProgressPhase = "working" | "error" | "paused";
export type DecisionRow = { item: FollowUpItem; agent: Agent; snoozed: boolean };
export type ProgressRow = { agent: Agent; phase: ProgressPhase; text: string };
export type FinishedRow = { agent: Agent; text: string };
export type FollowUpSections = { decisions: DecisionRow[]; progress: ProgressRow[]; finished: FinishedRow[] };

const atOf = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : 0;
};

export const lastActiveAt = (agent: Pick<Agent, "updatedAt" | "reopenedAt">) => Math.max(atOf(agent.updatedAt), atOf(agent.reopenedAt));

export function followUpSections(agents: readonly Agent[], state: Pick<FollowUpsState, "items" | "notes">, now: number): FollowUpSections {
  const tracked = new Map(agents.filter(isTracked).map((a) => [a.id, a]));
  const decisions: DecisionRow[] = [];
  const decided = new Set<string>();
  for (const item of state.items) {
    const agent = tracked.get(item.agentId);
    if (!agent) continue;
    decided.add(agent.id);
    decisions.push({ item, agent, snoozed: isSnoozed(item, now) });
  }
  decisions.sort((a, b) => Number(a.snoozed) - Number(b.snoozed) || (a.snoozed ? atOf(a.item.snoozedUntil) - atOf(b.item.snoozedUntil) : atOf(a.item.since) - atOf(b.item.since)));

  const noteOf = new Map(state.notes.map((n) => [n.agentId, n]));
  const progress: ProgressRow[] = [];
  const finished: FinishedRow[] = [];
  const quietBefore = now - ACTIVE_DAYS * DAY_MS;
  for (const agent of tracked.values()) {
    if (decided.has(agent.id)) continue;
    const note = noteOf.get(agent.id);
    if (agent.status === "running" || agent.status === "waiting") progress.push({ agent, phase: "working", text: "" });
    else if (agent.status === "error") progress.push({ agent, phase: "error", text: "" });
    else if (note?.phase === "finished") finished.push({ agent, text: note.text });
    else if (lastActiveAt(agent) >= quietBefore) progress.push({ agent, phase: "paused", text: note?.text ?? "" });
  }
  const recent = (a: Agent, b: Agent) => lastActiveAt(b) - lastActiveAt(a);
  const rank = (row: ProgressRow) => (row.phase === "working" ? 0 : row.phase === "error" ? 1 : 2);
  progress.sort((a, b) => rank(a) - rank(b) || recent(a.agent, b.agent));
  finished.sort((a, b) => recent(a.agent, b.agent));
  return { decisions, progress, finished };
}

export function openDecisionCount(agents: readonly Agent[], items: readonly FollowUpItem[], now: number): number {
  if (items.length === 0) return 0;
  const tracked = new Set(agents.filter(isTracked).map((a) => a.id));
  return items.filter((item) => tracked.has(item.agentId) && !isSnoozed(item, now)).length;
}

export const ASSISTANT_SERVER = "lodestar_work";

export const ASSISTANT_TOOLS = {
  listWork: "list_work",
  readSession: "read_session",
  sendToSession: "send_to_session",
  startSession: "start_session",
  markDone: "mark_done",
  setReminder: "set_reminder",
  listReminders: "list_reminders",
  cancelReminder: "cancel_reminder",
  snoozeDecision: "snooze_decision",
  dismissDecision: "dismiss_decision",
  answerQuestion: "answer_question",
  respondToApproval: "respond_to_approval",
  stopSession: "stop_session",
  renameSession: "rename_session",
  pinSession: "pin_session",
  undoAction: "undo_action",
} as const;

const PREFIX = `mcp__${ASSISTANT_SERVER}__`;
export const assistantToolName = (tool: string) => `${PREFIX}${tool}`;
export const isAssistantTool = (full: string) => full.startsWith(PREFIX);

export const SILENT_REPLY = "NOTHING";
export const isSilentReply = (text: string) => text.replace(/[\s.`*"'!]/g, "").toUpperCase() === SILENT_REPLY;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function clockText(date: Date): string {
  const hour = date.getHours() % 12 || 12;
  return `${hour}:${String(date.getMinutes()).padStart(2, "0")} ${date.getHours() < 12 ? "AM" : "PM"}`;
}

export const dayText = (date: Date) => `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`;

export type AssistantApproval = { title: string; message: string; code?: string; disclaimer?: string };

export function assistantApproval(toolName: string, input: Record<string, unknown>): AssistantApproval | null {
  if (!isAssistantTool(toolName)) return null;
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const session = text("session_title") || text("session");
  switch (toolName.slice(PREFIX.length)) {
    case ASSISTANT_TOOLS.sendToSession:
      return { title: `Send to ${session}?`, message: text("text") };
    case ASSISTANT_TOOLS.answerQuestion:
      return { title: `Answer ${session}?`, message: [text("pending"), text("answer")].filter(Boolean).join("\n") };
    case ASSISTANT_TOOLS.respondToApproval:
      return { title: `${input.decision === "deny" ? "Deny" : "Allow"} the tool call in ${session}?`, message: text("pending") };
    case ASSISTANT_TOOLS.stopSession:
      return { title: `Stop ${session}?`, message: "" };
    default:
      return null;
  }
}

type PermissionEntry = Extract<TimelineItem, { kind: "permission" }>;

export type MateEntry =
  | { kind: "checkIn"; id: string; at: string | null; reason: CheckInReason | null }
  | { kind: "mate"; id: string; text: string; streaming: boolean }
  | { kind: "user"; id: string; text: string }
  | { kind: "decisions"; id: string; items: FollowUpItem[] }
  | { kind: "approval"; id: string; item: PermissionEntry; approval: AssistantApproval | null }
  | { kind: "question"; id: string; item: PermissionEntry }
  | { kind: "action"; id: string; action: AssistantAction }
  | { kind: "working"; id: string }
  | { kind: "error"; id: string; text: string };

export type MateFeedSource = { items: readonly TimelineItem[]; checkIns: readonly AssistantCheckIn[]; followUps: readonly FollowUpItem[]; status: Agent["status"]; now: number; actions?: readonly AssistantAction[] };

export function mateFeed(source: MateFeedSource): MateEntry[] {
  const { items, checkIns, followUps, status, now } = source;
  const byAnchor = new Map(checkIns.flatMap((c) => (c.anchorId ? [[c.anchorId, c] as const] : [])));
  const itemIds = new Set(items.map((item) => item.id));
  const actionsAfter = new Map<string, AssistantAction[]>();
  const loose: AssistantAction[] = [];
  for (const action of [...(source.actions ?? [])].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!action.afterId) loose.push(action);
    else if (itemIds.has(action.afterId)) actionsAfter.set(action.afterId, [...(actionsAfter.get(action.afterId) ?? []), action]);
  }
  const actionEntries = (list: readonly AssistantAction[]): MateEntry[] => list.map((action) => ({ kind: "action", id: `action:${action.id}`, action }));
  const open = new Map(followUps.filter((item) => !isSnoozed(item, now)).map((item) => [item.id, item]));
  const shown = new Set<string>();
  const entries: MateEntry[] = [];
  let pendingCards: { id: string; ids: string[] } | null = null;
  const flushCards = () => {
    if (!pendingCards) return;
    const cards = pendingCards.ids.flatMap((id) => (open.has(id) && !shown.has(id) ? [open.get(id)!] : []));
    for (const card of cards) shown.add(card.id);
    if (cards.length) entries.push({ kind: "decisions", id: `${pendingCards.id}:cards`, items: cards });
    pendingCards = null;
  };
  for (const item of items) {
    if (item.kind === "user") {
      flushCards();
      if (item.source === "system") {
        const record = byAnchor.get(item.id);
        entries.push({ kind: "checkIn", id: item.id, at: item.at ?? record?.at ?? null, reason: record?.reason ?? null });
        if (record?.itemIds.length) pendingCards = { id: item.id, ids: record.itemIds };
      } else if (item.text.trim()) entries.push({ kind: "user", id: item.id, text: item.shown ?? item.text });
    } else if (item.kind === "assistant" && item.text.trim() && (item.streaming || !isSilentReply(item.text))) {
      const last = entries[entries.length - 1];
      if (last?.kind === "mate" && last.streaming) entries[entries.length - 1] = { kind: "mate", id: item.id, text: item.text, streaming: item.streaming };
      else entries.push({ kind: "mate", id: item.id, text: item.text, streaming: item.streaming });
    } else if (item.kind === "result") flushCards();
    else if (item.kind === "permission" && item.status === "pending") {
      if (item.toolName === QUESTION_TOOL || item.toolName === PLAN_TOOL) entries.push({ kind: "question", id: item.id, item });
      else entries.push({ kind: "approval", id: item.id, item, approval: assistantApproval(item.toolName, item.input) });
    } else if (item.kind === "error") entries.push({ kind: "error", id: item.id, text: item.text });
    const done = actionsAfter.get(item.id);
    if (done) entries.push(...actionEntries(done));
  }
  flushCards();
  entries.push(...actionEntries(loose));
  const untold = [...open.values()].filter((item) => !shown.has(item.id));
  if (untold.length) entries.push({ kind: "decisions", id: "open:cards", items: untold });
  const last = entries[entries.length - 1];
  if (status === "running" && !(last?.kind === "mate" && last.streaming)) entries.push({ kind: "working", id: "working" });
  return entries;
}

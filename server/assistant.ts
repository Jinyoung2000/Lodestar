import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  ASSISTANT_DEFAULT_MODEL,
  ASSISTANT_LIMITS,
  ASSISTANT_NAME,
  ASSISTANT_NOTES_FILE,
  ASSISTANT_NOTES_TEMPLATE,
  ASSISTANT_PROMPT,
  ASSISTANT_SERVER,
  ASSISTANT_TOOLS,
  CHECK_IN_GAP_DEFAULT,
  assistantToolAsks,
  assistantToolName,
  assistantToolNeedsUserTurn,
  buildCheckIn,
  checkInItemIds,
  checkInReason,
  clockText,
  dayText,
  isAssistantTool,
  isSilentReply,
  pushPreview,
  workDigest,
  type AssistantAction,
  type AssistantActionKind,
  type AssistantCheckIn,
  type AssistantReminder,
  type AssistantState,
  type CheckInEvent,
  type CheckInReason,
} from "../shared/assistant";
import { FOLLOW_UP_LIMITS, isSnoozed, isTracked, parseMorning, scanSession, type FollowUpItem, type FollowUpsState, type SnoozeChoice } from "../shared/followups";
import { isInteractiveTool } from "../shared/interactive";
import type { Agent, ServerEvent, TimelineItem } from "../shared/protocol";
import type { AssistantAsk, CreateParams } from "./agents";
import { assistantToolServer, callAssistantTool, isAssistantToolDef, type AssistantToolHost, type CallToolResult } from "./assistantTools";
import { mateMcpLaunch, type McpLaunch } from "./mateMcp";
import { HOME, type Store } from "./store";
import { T } from "./strings";

export const ASSISTANT_DIR = join(HOME, "assistant");
export const ASSISTANT_FILE = join(HOME, "assistant.json");
const FILE_VERSION = 1;
const TICK_MS = 60_000;
const FIRST_TICK_MS = 12_000;
const SETTLE_MS = 500;
const NOTES_LIMIT = 64_000;
const FOREIGN_INSTRUCTION_FILES = ["AGENTS.md", "GEMINI.md"];

type AssistantStoreView = Pick<Store, "settings" | "agents" | "workspaces" | "timeline" | "addAgent" | "patchAgent" | "removeItem">;
type AssistantRunner = {
  send: (agentId: string, prompt: string, options?: { system?: boolean }) => Promise<{ queued: boolean }>;
  create: (params: CreateParams) => Promise<Agent>;
  setDone: (agentId: string, done: boolean) => void;
  answerQuestion: (agentId: string, itemId: string, answers: Record<string, string>) => void;
  respondPermission: (agentId: string, itemId: string, decision: "allow" | "deny") => void;
  interrupt: (agentId: string) => Promise<unknown>;
  rename: (agentId: string, title: string) => void;
  setPinned: (agentId: string, pinned: boolean) => void;
  askTool: (agentId: string, toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;
};
type AssistantFollowUps = { state: () => FollowUpsState; refresh: () => void; snooze: (id: string, choice: unknown) => FollowUpsState; dismiss: (id: string) => FollowUpsState };

export type AssistantDeps = {
  store: AssistantStoreView;
  runner: AssistantRunner;
  followUps: AssistantFollowUps;
  emit: (event: ServerEvent) => void;
  autoBlocked?: () => boolean;
  push?: (message: { title: string; body: string; agentId?: string }) => Promise<unknown> | void;
  now?: () => Date;
  dir?: string;
  file?: string;
};

type Wake = { startedAt: number; before: number; reason: CheckInReason; itemIds: string[]; running: boolean };
type Saved = { version: number; reminders: AssistantReminder[]; told: string[]; lastNudgeId: string | null; checkIns: AssistantCheckIn[]; morningDate: string | null; ledger: { day: string; wakes: number }; actions: AssistantAction[] };
type NewAction = Pick<AssistantAction, "kind" | "targets"> & Partial<Pick<AssistantAction, "workspace" | "after">>;
const ACTION_KINDS = new Set<AssistantActionKind>(["markDone", "start", "rename", "pin"]);
const isBusy = (agent: Agent) => agent.status === "running" || agent.status === "waiting";
const quoted = (agents: readonly { title: string }[]) => agents.map((a) => `"${a.title}"`).join(", ");

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const tail = (text: string, max: number) => (text.length <= max ? text : `…${text.slice(text.length - max + 1)}`);

function currentFollowUpEvents(events: readonly CheckInEvent[], state: FollowUpsState, now: number): CheckInEvent[] {
  const active = new Set(state.enabled ? state.items.filter((item) => !isSnoozed(item, now)).map((item) => item.id) : []);
  return events.flatMap((event): CheckInEvent[] => {
    if (event.kind === "decision") return active.has(event.itemId) ? [event] : [];
    if (event.kind === "reminder") {
      const itemIds = event.itemIds.filter((id) => active.has(id));
      return itemIds.length ? [{ ...event, itemIds }] : [];
    }
    return [event];
  });
}

export class AssistantService {
  private reminders: AssistantReminder[] = [];
  private actions: AssistantAction[] = [];
  private told = new Set<string>();
  private lastNudgeId: string | null = null;
  private checkIns: AssistantCheckIn[] = [];
  private morningDate: string | null = null;
  private ledger = { day: "", wakes: 0 };
  private queue: CheckInEvent[] = [];
  private wake: Wake | null = null;
  private lastWakeAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private started = false;

  constructor(private deps: AssistantDeps) {
    this.load();
  }

  private get dir() {
    return this.deps.dir ?? ASSISTANT_DIR;
  }

  private get file() {
    return this.deps.file ?? ASSISTANT_FILE;
  }

  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private get enabled() {
    return this.deps.store.settings.assistantEnabled === true;
  }

  private agent(): Agent | null {
    return this.deps.store.agents.find((a) => a.assistant) ?? null;
  }

  state(): AssistantState {
    const agent = this.agent();
    return { enabled: this.enabled, agentId: agent?.id ?? null, notesPath: agent ? join(agent.cwd, ASSISTANT_NOTES_FILE) : null, busy: this.wake !== null, lastCheckIn: this.checkIns[0] ?? null, checkIns: this.checkIns, reminders: this.reminders, actions: this.actions };
  }

  private get standing() {
    return this.enabled && !this.deps.autoBlocked?.();
  }

  start() {
    if (this.standing) this.ensureAgent();
    this.onFollowUps(this.deps.followUps.state());
    this.started = true;
    const first = setTimeout(() => this.tick(), FIRST_TICK_MS);
    const every = setInterval(() => this.tick(), TICK_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  ensureAgent(): Agent {
    mkdirSync(this.dir, { recursive: true });
    const notes = join(this.dir, ASSISTANT_NOTES_FILE);
    if (!existsSync(notes)) writeFileSync(notes, ASSISTANT_NOTES_TEMPLATE);
    const existing = this.agent();
    if (existing) return existing;
    const now = this.now().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      workspaceId: null,
      cwd: this.dir,
      worktree: null,
      forkedFrom: null,
      resumeFrom: null,
      startCommit: null,
      feedbackId: null,
      title: ASSISTANT_NAME,
      sessionId: null,
      status: "idle",
      permissionMode: "default",
      model: ASSISTANT_DEFAULT_MODEL,
      effort: null,
      activeModel: null,
      activeEffort: null,
      backgroundTasks: 0,
      createdAt: now,
      updatedAt: now,
      assistant: true,
    };
    this.deps.store.addAgent(agent);
    this.deps.emit({ type: "agent", agent });
    this.publish();
    return agent;
  }

  options(agent: Agent, ask: AssistantAsk): Partial<Options> {
    const root = resolve(agent.cwd);
    const host = this.host();
    return {
      settingSources: ["user", "project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: ASSISTANT_PROMPT },
      mcpServers: { [ASSISTANT_SERVER]: assistantToolServer(host) },
      canUseTool: async (toolName, input, { signal, toolUseID }) => {
        const allow = { behavior: "allow" as const, updatedInput: input };
        if (this.wake && isInteractiveTool(toolName)) return { behavior: "deny", message: T.errAssistantCheckInAct };
        if (isAssistantTool(toolName)) {
          const refusal = this.refusal(toolName, input);
          if (refusal) return { behavior: "deny" as const, message: refusal };
          return assistantToolAsks(toolName) && this.agent()?.permissionMode !== "bypassPermissions" ? ask(toolName, this.titled(host, input), signal, toolUseID) : allow;
        }
        const path = typeof input.file_path === "string" ? resolve(root, input.file_path) : null;
        if ((toolName === "Edit" || toolName === "Write") && path && (path === root || path.startsWith(root + sep))) return allow;
        if (this.agent()?.permissionMode === "bypassPermissions") return allow;
        return ask(toolName, input, signal, toolUseID);
      },
    };
  }

  private titled(host: AssistantToolHost, input: Record<string, unknown>) {
    const target = typeof input.session === "string" ? this.deps.store.agents.find((a) => a.id === input.session) : undefined;
    if (!target) return input;
    const pending = host.pendingOf(target.id);
    return { ...input, session_title: target.title, ...(pending ? { pending } : {}) };
  }

  async callTool(agentId: string, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const agent = this.agent();
    const refuse = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });
    if (!agent || agent.id !== agentId) return refuse(T.errAssistantToolCaller);
    if (!isAssistantToolDef(name)) return refuse(`Unknown tool: ${name}`);
    const full = assistantToolName(name);
    const refusal = this.refusal(full, input);
    if (refusal) return refuse(refusal);
    const host = this.host();
    if (assistantToolAsks(full) && agent.permissionMode !== "bypassPermissions" && !(await this.deps.runner.askTool(agent.id, full, this.titled(host, input), signal))) return refuse(T.permissionDeniedByUser);
    return callAssistantTool(host, name, input);
  }

  foreignSetup(agent: Agent): McpLaunch | null {
    if (!agent.assistant) return null;
    mkdirSync(this.dir, { recursive: true });
    const notesPath = join(this.dir, ASSISTANT_NOTES_FILE);
    const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8").slice(0, NOTES_LIMIT).trim() : "";
    const text = [T.assistantForeignHeader(ASSISTANT_NOTES_FILE), "", ASSISTANT_PROMPT, "", `# ${ASSISTANT_NOTES_FILE}`, "", notes, ""].join("\n");
    for (const file of FOREIGN_INSTRUCTION_FILES) writeFileSync(join(this.dir, file), text);
    return mateMcpLaunch(agent.id);
  }

  private refusal(toolName: string, input: Record<string, unknown>): string | null {
    if (assistantToolNeedsUserTurn(toolName) && this.wake) return T.errAssistantCheckInAct;
    const wants = toolName === assistantToolName(ASSISTANT_TOOLS.answerQuestion) ? "question" : toolName === assistantToolName(ASSISTANT_TOOLS.respondToApproval) ? "approval" : null;
    if (!wants) return null;
    const agent = typeof input.session === "string" ? this.deps.store.agents.find((a) => a.id === input.session && !a.assistant && !a.feedbackId) : undefined;
    if (!agent) return null;
    const pending = scanSession(agent, this.deps.store.timeline(agent.id)).pending;
    return pending?.kind === wants ? null : T.errAssistantNothingPending(agent.title, wants === "question" ? "question" : "tool call");
  }

  silentTurn(agentId: string): boolean {
    if (!this.wake) return false;
    const reply = this.deps.store.timeline(agentId).findLast((item) => item.kind === "assistant" && !item.streaming && item.text.trim() !== "");
    return reply?.kind === "assistant" && isSilentReply(reply.text);
  }

  observe(event: ServerEvent) {
    if (event.type === "followUps") this.onFollowUps(event.state);
    else if (event.type === "agent" && event.agent.assistant) this.onOwnStatus(event.agent);
    else if (event.type === "settings" && this.standing && !this.agent()) this.ensureAgent();
  }

  private onFollowUps(state: FollowUpsState) {
    if (!this.enabled) return;
    const now = this.now().getTime();
    const live = new Set(state.items.map((item) => item.id));
    if (this.queue.length) this.queue = currentFollowUpEvents(this.queue, state, now);
    let changed = false;
    for (const item of state.items) {
      if (this.told.has(item.id)) continue;
      this.told.add(item.id);
      changed = true;
      if (!state.enabled || isSnoozed(item, now)) continue;
      if (item.kind === "ask") this.queue.push({ kind: "decision", itemId: item.id });
      else this.pushWaiting(item);
    }
    for (const id of [...this.told]) {
      if (live.has(id)) continue;
      this.told.delete(id);
      changed = true;
    }
    const nudge = state.nudge;
    if (nudge && nudge.id !== this.lastNudgeId) {
      this.lastNudgeId = nudge.id;
      changed = true;
      if (state.enabled && now - Date.parse(nudge.at) < ASSISTANT_LIMITS.nudgeFreshMs) {
        const requested = new Set(nudge.requestedItemIds);
        if (requested.size) this.queue.push({ kind: "reminder", itemIds: [...requested], requested: true });
        const routine = nudge.itemIds.filter((id) => !requested.has(id));
        if (routine.length) this.queue.push({ kind: "reminder", itemIds: routine });
      }
    }
    if (changed) this.save();
  }

  private pushWaiting(item: FollowUpItem) {
    if (!this.started) return;
    const agent = this.deps.store.agents.find((a) => a.id === item.agentId);
    if (!agent) return;
    const fallback = item.kind === "plan" ? "A plan is ready for your review." : item.kind === "question" ? "It asked you a question." : "It needs your approval.";
    void this.deps.push?.({ title: agent.title, body: item.text ? pushPreview(item.text) : fallback, agentId: agent.id });
  }

  private onOwnStatus(agent: Agent) {
    const wake = this.wake;
    if (!wake) return;
    if (agent.status === "running") wake.running = true;
    else if (agent.status === "error") this.endWake(false);
    else if (agent.status === "idle" && wake.running) setTimeout(() => this.settleWake(wake), SETTLE_MS).unref();
  }

  private settleWake(wake: Wake) {
    if (this.wake !== wake) return;
    const agent = this.agent();
    if (!agent) return this.endWake(false);
    const items = this.deps.store.timeline(agent.id);
    const added = items.slice(wake.before);
    const end = added.findIndex((item) => item.kind === "result");
    const turn = end === -1 ? added : added.slice(0, end + 1);
    const reply = turn.findLast((item): item is Extract<TimelineItem, { kind: "assistant" }> => item.kind === "assistant" && !item.streaming && item.text.trim() !== "");
    const spoke = !!reply && !isSilentReply(reply.text);
    if (!spoke && reply) {
      for (const item of turn) {
        this.deps.store.removeItem(agent.id, item.id);
        this.deps.emit({ type: "timelineRemove", agentId: agent.id, itemId: item.id });
      }
      if (agent.unread) this.deps.emit({ type: "agent", agent: this.deps.store.patchAgent(agent.id, { unread: false }) });
    }
    console.log(`[assistant] check-in ${wake.reason} ${spoke ? "spoke" : "silent"}`);
    const first = turn[0];
    this.endWake(spoke, spoke && first?.kind === "user" && first.source === "system" ? first.id : null);
    if (spoke && reply) void this.deps.push?.({ title: agent.title, body: pushPreview(reply.text), agentId: agent.id });
  }

  private endWake(spoke: boolean, anchorId: string | null = null) {
    const wake = this.wake;
    if (!wake) return;
    this.wake = null;
    this.checkIns = [{ at: this.now().toISOString(), spoke, reason: wake.reason, itemIds: spoke ? wake.itemIds : [], anchorId }, ...this.checkIns].slice(0, ASSISTANT_LIMITS.checkIns);
    this.save();
    this.publish();
  }

  tick() {
    if (!this.enabled) return;
    if (this.standing && !this.agent()) this.ensureAgent();
    const now = this.now();
    if (this.wake && now.getTime() - this.wake.startedAt > ASSISTANT_LIMITS.staleWakeMs) this.wake = null;
    const queued = new Set(this.queue.flatMap((e) => (e.kind === "ownReminder" ? [e.reminder.id] : [])));
    for (const reminder of this.reminders) if (Date.parse(reminder.at) <= now.getTime() && !queued.has(reminder.id)) this.queue.push({ kind: "ownReminder", reminder });
    this.queueMorning(now);
    void this.flush();
  }

  private quiet(now: Date) {
    const morning = parseMorning(this.deps.store.settings.morningReviewTime);
    const minutes = now.getHours() * 60 + now.getMinutes();
    return now.getHours() >= FOLLOW_UP_LIMITS.quietFromHour || minutes < morning.hour * 60 + morning.minute;
  }

  private queueMorning(now: Date) {
    if (this.deps.store.settings.assistantMorningBrief === false) return;
    const today = dayKey(now);
    if (this.morningDate === today || now.getHours() >= FOLLOW_UP_LIMITS.quietFromHour) return;
    const morning = parseMorning(this.deps.store.settings.morningReviewTime);
    if (now.getHours() * 60 + now.getMinutes() < morning.hour * 60 + morning.minute) return;
    this.morningDate = today;
    this.save();
    const { agents, followUps } = this.source();
    const deferred = new Set(followUps.items.filter((item) => isSnoozed(item, now.getTime())).map((item) => item.agentId));
    const fresh = new Set(checkInItemIds(this.queue));
    const waiting = followUps.items.some((item) => !deferred.has(item.agentId) && (item.kind !== "ask" || fresh.has(item.id)));
    const tracked = waiting || agents.some((a) => isTracked(a) && a.status !== "idle" && !deferred.has(a.id)) || followUps.notes.length > 0;
    if (tracked) this.queue.push({ kind: "morning" });
  }

  cancelReminder(id: string): AssistantState {
    if (!this.reminders.some((r) => r.id === id)) throw new Error(T.errAssistantReminderUnknown(id));
    this.reminders = this.reminders.filter((r) => r.id !== id);
    this.save();
    this.publish();
    return this.state();
  }

  readNotes(): { text: string } {
    const path = this.state().notesPath;
    return { text: path && existsSync(path) ? readFileSync(path, "utf8").slice(0, NOTES_LIMIT) : "" };
  }

  writeNotes(text: unknown): { text: string } {
    if (typeof text !== "string" || text.length > NOTES_LIMIT) throw new Error(T.errAssistantNotes);
    const agent = this.ensureAgent();
    writeFileSync(join(agent.cwd, ASSISTANT_NOTES_FILE), text);
    return { text };
  }

  async checkIn(): Promise<AssistantState> {
    if (!this.enabled) throw new Error(T.errAssistantOff);
    const agent = this.ensureAgent();
    if (this.wake || isBusy(agent)) throw new Error(T.errAssistantBusy);
    this.deps.followUps.refresh();
    this.queue.push({ kind: "manual" });
    await this.flush();
    return this.state();
  }

  private source() {
    const state = this.deps.followUps.state();
    return { agents: this.deps.store.agents, workspaces: this.deps.store.workspaces, followUps: state.enabled ? state : { items: [], notes: [] }, now: this.now().getTime() };
  }

  private async flush() {
    if (this.wake || this.queue.length === 0) return;
    if (!this.enabled) {
      this.queue = [];
      return;
    }
    const manual = this.queue.some((e) => e.kind === "manual");
    if (!manual && this.deps.autoBlocked?.()) {
      this.queue = [];
      return;
    }
    const agent = this.agent();
    if (!agent || isBusy(agent) || agent.queue?.length) return;
    const now = this.now();
    const overview = manual || this.queue.some((event) => event.kind === "morning");
    const gap = this.deps.store.settings.assistantCheckInGap ?? CHECK_IN_GAP_DEFAULT;
    const routineDue = overview || (gap > 0 && !this.quiet(now) && now.getTime() - this.lastWakeAt >= gap * 60_000);
    const routine = (event: CheckInEvent) => event.kind === "decision" || (event.kind === "reminder" && !event.requested);
    const pending = this.queue;
    this.queue = routineDue || gap === 0 ? [] : pending.filter(routine);
    const ready = routineDue ? pending : pending.filter((event) => !routine(event));
    if (!ready.length) return;
    const today = dayKey(now);
    if (this.ledger.day !== today) this.ledger = { day: today, wakes: 0 };
    if (!manual && this.ledger.wakes >= ASSISTANT_LIMITS.wakesPerDay) {
      this.queue = [];
      return;
    }
    this.deps.followUps.refresh();
    const events = currentFollowUpEvents(ready, this.deps.followUps.state(), now.getTime())
      .filter((event) => event.kind !== "ownReminder" || this.reminders.some((r) => r.id === event.reminder.id));
    if (events.length === 0) return;
    const wake: Wake = { startedAt: now.getTime(), before: this.deps.store.timeline(agent.id).length, reason: checkInReason(events), itemIds: checkInItemIds(events), running: false };
    this.wake = wake;
    this.lastWakeAt = now.getTime();
    this.ledger.wakes++;
    this.publish();
    try {
      await this.deps.runner.send(agent.id, buildCheckIn(events, this.source()), { system: true });
      const told = new Set(events.flatMap((e) => (e.kind === "ownReminder" ? [e.reminder.id] : [])));
      if (told.size) {
        this.reminders = this.reminders.filter((r) => !told.has(r.id));
        this.save();
        this.publish();
      }
    } catch (error) {
      console.error("[assistant] check-in could not start", error);
      if (this.wake === wake) this.wake = null;
      this.publish();
    }
  }

  private target(session: string): Agent {
    const wanted = session.trim();
    const agents = this.deps.store.agents.filter((a) => !a.assistant && !a.feedbackId);
    const byId = agents.find((a) => a.id === wanted);
    if (byId) return byId;
    const titled = agents.filter((a) => a.title.trim().toLowerCase() === wanted.toLowerCase());
    const open = titled.filter((a) => !a.done);
    const agent = titled.length === 1 ? titled[0] : open.length === 1 ? open[0] : null;
    if (agent) return agent;
    throw new Error(titled.length > 1 ? T.errAssistantSessionAmbiguous(wanted) : T.errAssistantSession(wanted));
  }

  private host(): AssistantToolHost {
    const { store, runner, followUps } = this.deps;
    const itemOf = (agent: Agent) => {
      const item = followUps.state().items.find((i) => i.agentId === agent.id);
      if (!item) throw new Error(T.errAssistantNoDecision(agent.title));
      return item;
    };
    return {
      work: () => {
        followUps.refresh();
        const names = store.workspaces.filter((w) => !w.feedback && !w.archived).map((w) => w.name);
        return `${workDigest(this.source())}\n\nWorkspaces: ${names.join(", ") || "none"}`;
      },
      readSession: (session, messages) => {
        const agent = this.target(session);
        const items = store.timeline(agent.id);
        const spoken = items.filter((i) => (i.kind === "user" && i.source !== "system" && i.text.trim() !== "") || (i.kind === "assistant" && !i.streaming && i.text.trim() !== "")).slice(-messages);
        const lines = spoken.map((i) => (i.kind === "user" ? `User: ${clip(i.shown ?? i.text, ASSISTANT_LIMITS.readChars)}` : i.kind === "assistant" ? `Session: ${tail(i.text, ASSISTANT_LIMITS.readChars)}` : ""));
        const pending = scanSession(agent, items).pending;
        const waiting = pending ? [`Waiting on the user (${pending.kind}): ${pending.text}${pending.options.length ? ` | choices: ${pending.options.join(" / ")}` : ""}`] : [];
        return [`"${agent.title}" (session ${agent.id}, status ${agent.status}${agent.done ? ", done" : ""})`, "", ...lines, ...waiting].join("\n");
      },
      send: async (session, text) => {
        const agent = this.target(session);
        const result = await runner.send(agent.id, text);
        return result.queued ? `Queued for "${agent.title}". It is sent when the running turn ends.` : `Sent to "${agent.title}".`;
      },
      start: async (workspace, prompt) => {
        const wanted = workspace.trim().toLowerCase();
        const matches = store.workspaces.filter((w) => !w.feedback && !w.archived && (w.id === workspace || w.name.trim().toLowerCase() === wanted));
        if (matches.length !== 1) throw new Error(T.errAssistantWorkspace(workspace));
        const agent = await runner.create({ workspaceId: matches[0].id, prompt, permissionMode: store.settings.defaultPermissionMode ?? "default", model: null, effort: null, worktree: null });
        const action = this.record({ kind: "start", targets: [{ agentId: agent.id, title: agent.title, before: {} }], workspace: matches[0].name });
        return `Started "${agent.title}" (session ${agent.id}) in ${matches[0].name}. ${this.undoHint(action)}`;
      },
      markDone: (sessions) => this.markDone(sessions),
      undo: (id) => this.undo(id).then((result) => result.text),
      setReminder: (text, when) => {
        const now = this.now();
        const at = when.inMinutes !== undefined ? new Date(now.getTime() + when.inMinutes * 60_000) : parseLocal(when.at);
        if (!at || at.getTime() <= now.getTime()) throw new Error(T.errAssistantReminderTime);
        if (this.reminders.length >= ASSISTANT_LIMITS.reminders) throw new Error(T.errAssistantReminderLimit);
        const reminder: AssistantReminder = { id: randomUUID().slice(0, 8), text: clip(text.trim(), ASSISTANT_LIMITS.reminderText), at: at.toISOString(), createdAt: now.toISOString() };
        this.reminders = [...this.reminders, reminder].sort((a, b) => a.at.localeCompare(b.at));
        this.save();
        this.publish();
        return `Reminder ${reminder.id} set for ${dayText(at)}, ${clockText(at)}.`;
      },
      listReminders: () => (this.reminders.length ? this.reminders.map((r) => `- ${r.id}: ${dayText(new Date(r.at))}, ${clockText(new Date(r.at))}: ${r.text}`).join("\n") : "No reminders are set."),
      cancelReminder: (id) => {
        if (!this.reminders.some((r) => r.id === id)) throw new Error(T.errAssistantReminderUnknown(id));
        this.reminders = this.reminders.filter((r) => r.id !== id);
        this.save();
        this.publish();
        return `Reminder ${id} cancelled.`;
      },
      snooze: (session, choice: SnoozeChoice) => {
        const agent = this.target(session);
        const state = followUps.snooze(itemOf(agent).id, choice);
        const until = state.items.find((i) => i.agentId === agent.id)?.snoozedUntil;
        return `Snoozed the decision of "${agent.title}"${until ? ` until ${dayText(new Date(until))}, ${clockText(new Date(until))}` : ""}.`;
      },
      dismiss: (session) => {
        const agent = this.target(session);
        followUps.dismiss(itemOf(agent).id);
        return `Dropped the decision of "${agent.title}" from the list.`;
      },
      answerQuestion: (session, answer) => {
        const agent = this.target(session);
        const pending = scanSession(agent, store.timeline(agent.id)).pending;
        if (pending?.kind !== "question") throw new Error(T.errAssistantNothingPending(agent.title, "question"));
        runner.answerQuestion(agent.id, pending.itemId, { [pending.question ?? pending.text]: answer });
        return `Answered "${agent.title}": ${answer}`;
      },
      respondToApproval: (session, decision) => {
        const agent = this.target(session);
        const pending = scanSession(agent, store.timeline(agent.id)).pending;
        if (pending?.kind !== "approval") throw new Error(T.errAssistantNothingPending(agent.title, "tool call"));
        runner.respondPermission(agent.id, pending.itemId, decision);
        return `${decision === "allow" ? "Allowed" : "Denied"} the tool call in "${agent.title}": ${pending.text}`;
      },
      stop: async (session) => {
        const agent = this.target(session);
        if (agent.status !== "running" && agent.status !== "waiting") throw new Error(T.errAssistantNotRunning(agent.title));
        await runner.interrupt(agent.id);
        return `Stopped "${agent.title}".`;
      },
      rename: (session, title) => {
        const agent = this.target(session);
        const before = agent.title;
        runner.rename(agent.id, title);
        const after = store.agents.find((a) => a.id === agent.id)?.title ?? title.trim();
        const action = this.record({ kind: "rename", targets: [{ agentId: agent.id, title: after, before: { title: before } }], after: { title: after } });
        return `Renamed "${before}" to "${after}". ${this.undoHint(action)}`;
      },
      pin: (session, pinned) => {
        const agent = this.target(session);
        const before = agent.pinned === true;
        runner.setPinned(agent.id, pinned);
        const action = this.record({ kind: "pin", targets: [{ agentId: agent.id, title: agent.title, before: { pinned: before } }], after: { pinned } });
        return `${pinned ? "Pinned" : "Unpinned"} "${agent.title}". ${this.undoHint(action)}`;
      },
      pendingOf: (session) => {
        const agent = store.agents.find((a) => a.id === session);
        const pending = agent ? scanSession(agent, store.timeline(agent.id)).pending : null;
        return pending ? pending.text : null;
      },
    };
  }

  private markDone(sessions: readonly string[]): string {
    const agents = [...new Map(sessions.map((session) => this.target(session)).map((agent) => [agent.id, agent])).values()];
    const busy = agents.filter(isBusy);
    const already = agents.filter((agent) => agent.done && !isBusy(agent));
    const marking = agents.filter((agent) => !agent.done && !isBusy(agent));
    const skipped = [...(busy.length ? [`Still working or waiting on the user, so not marked: ${quoted(busy)}.`] : []), ...(already.length ? [`Already done: ${quoted(already)}.`] : [])];
    if (marking.length === 0) throw new Error(T.errAssistantNothingToMark(skipped.join(" ")));
    for (const agent of marking) this.deps.runner.setDone(agent.id, true);
    const action = this.record({ kind: "markDone", targets: marking.map((agent) => ({ agentId: agent.id, title: agent.title, before: {} })) });
    return [`Marked done: ${quoted(marking)}. ${this.undoHint(action)}`, ...skipped].join("\n");
  }

  private undoHint(action: AssistantAction) {
    return `Action ${action.id}; ${ASSISTANT_TOOLS.undoAction} reverses it.`;
  }

  private record(entry: NewAction): AssistantAction {
    const mate = this.agent();
    const afterId = mate ? (this.deps.store.timeline(mate.id).at(-1)?.id ?? null) : null;
    const action: AssistantAction = { id: randomUUID().slice(0, 8), at: this.now().toISOString(), afterId, workspace: null, after: {}, undoneAt: null, ...entry };
    this.actions = [action, ...this.actions].slice(0, ASSISTANT_LIMITS.actions);
    this.save();
    this.publish();
    return action;
  }

  async undo(id?: unknown): Promise<{ text: string }> {
    const wanted = typeof id === "string" && id.trim() ? id.trim() : null;
    const action = wanted ? this.actions.find((a) => a.id === wanted) : this.actions.find((a) => !a.undoneAt);
    if (!action) throw new Error(wanted ? T.errAssistantActionUnknown(wanted) : T.errAssistantNoAction);
    if (action.undoneAt) throw new Error(T.errAssistantActionUndone(action.id));
    const { store, runner, emit } = this.deps;
    const reversed: string[] = [];
    const kept: string[] = [];
    for (const target of action.targets) {
      const agent = store.agents.find((a) => a.id === target.agentId);
      const name = `"${agent?.title ?? target.title}"`;
      if (!agent) {
        kept.push(`${name} no longer exists`);
        continue;
      }
      if (action.kind === "markDone") {
        if (!agent.done) kept.push(`${name} is open again already`);
        else {
          emit({ type: "agent", agent: store.patchAgent(agent.id, { done: false }) });
          reversed.push(`reopened ${name}`);
        }
      } else if (action.kind === "start") {
        if (agent.done && !isBusy(agent)) kept.push(`${name} is done already`);
        else {
          if (isBusy(agent)) await runner.interrupt(agent.id);
          runner.setDone(agent.id, true);
          reversed.push(`stopped ${name} and marked it done; changes it made to files stay`);
        }
      } else if (action.kind === "rename") {
        if (agent.title !== action.after.title || target.before.title === undefined) kept.push(`${name} was renamed again since`);
        else {
          runner.rename(agent.id, target.before.title);
          reversed.push(`renamed ${name} back to "${target.before.title}"`);
        }
      } else if (action.kind === "pin") {
        if ((agent.pinned === true) !== action.after.pinned) kept.push(`${name} was ${agent.pinned ? "pinned" : "unpinned"} again since`);
        else {
          runner.setPinned(agent.id, target.before.pinned === true);
          reversed.push(`${target.before.pinned ? "pinned" : "unpinned"} ${name} again`);
        }
      }
    }
    this.actions = this.actions.map((a) => (a.id === action.id ? { ...a, undoneAt: this.now().toISOString() } : a));
    this.save();
    this.publish();
    const sentence = (parts: string[]) => parts.join("; ").replace(/^./, (c) => c.toUpperCase());
    const text = [reversed.length ? `Undid action ${action.id}: ${sentence(reversed)}.` : `Nothing to undo in action ${action.id}.`, ...(kept.length ? [`Left as is: ${kept.join("; ")}.`] : [])].join(" ");
    return { text };
  }

  private publish() {
    this.deps.emit({ type: "assistant", state: this.state() });
  }

  private save() {
    const saved: Saved = { version: FILE_VERSION, reminders: this.reminders, told: [...this.told], lastNudgeId: this.lastNudgeId, checkIns: this.checkIns, morningDate: this.morningDate, ledger: this.ledger, actions: this.actions };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved, null, 2));
    renameSync(tmp, this.file);
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Saved> | null;
      if (!raw || typeof raw !== "object" || raw.version !== FILE_VERSION) return;
      const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
      this.reminders = (Array.isArray(raw.reminders) ? raw.reminders : []).filter((r): r is AssistantReminder => !!r && typeof r.id === "string" && typeof r.text === "string" && iso(r.at) && iso(r.createdAt));
      this.told = new Set((Array.isArray(raw.told) ? raw.told : []).filter((id): id is string => typeof id === "string"));
      this.lastNudgeId = typeof raw.lastNudgeId === "string" ? raw.lastNudgeId : null;
      const reasons = new Set(["morning", "decision", "reminder", "manual"]);
      this.checkIns = (Array.isArray(raw.checkIns) ? raw.checkIns : [])
        .filter((c): c is AssistantCheckIn => !!c && iso(c.at) && typeof c.spoke === "boolean" && reasons.has(c.reason))
        .map((c) => ({ at: c.at, spoke: c.spoke, reason: c.reason, itemIds: (Array.isArray(c.itemIds) ? c.itemIds : []).filter((id): id is string => typeof id === "string"), anchorId: typeof c.anchorId === "string" ? c.anchorId : null }))
        .slice(0, ASSISTANT_LIMITS.checkIns);
      this.morningDate = typeof raw.morningDate === "string" ? raw.morningDate : null;
      if (raw.ledger && typeof raw.ledger.day === "string" && Number.isInteger(raw.ledger.wakes)) this.ledger = { day: raw.ledger.day, wakes: raw.ledger.wakes };
      this.actions = (Array.isArray(raw.actions) ? raw.actions : [])
        .filter((a): a is AssistantAction => !!a && typeof a.id === "string" && ACTION_KINDS.has(a.kind) && iso(a.at) && Array.isArray(a.targets) && a.targets.every((t) => !!t && typeof t.agentId === "string" && typeof t.title === "string"))
        .map((a) => ({ id: a.id, kind: a.kind, at: a.at, afterId: typeof a.afterId === "string" ? a.afterId : null, targets: a.targets.map((t) => ({ agentId: t.agentId, title: t.title, before: t.before && typeof t.before === "object" ? t.before : {} })), workspace: typeof a.workspace === "string" ? a.workspace : null, after: a.after && typeof a.after === "object" ? a.after : {}, undoneAt: iso(a.undoneAt) ? a.undoneAt : null }))
        .slice(0, ASSISTANT_LIMITS.actions);
    } catch (error) {
      console.error("[assistant] could not read the saved state", error);
    }
  }
}

function parseLocal(text: string | undefined): Date | null {
  const match = typeof text === "string" ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text.trim()) : null;
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

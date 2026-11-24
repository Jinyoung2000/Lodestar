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
  buildCheckIn,
  checkInItemIds,
  checkInReason,
  clockText,
  dayText,
  isAssistantTool,
  isSilentReply,
  pushPreview,
  workDigest,
  type AssistantCheckIn,
  type AssistantReminder,
  type AssistantState,
  type CheckInEvent,
  type CheckInReason,
} from "../shared/assistant";
import { FOLLOW_UP_LIMITS, isTracked, parseMorning, scanSession, type FollowUpItem, type FollowUpsState, type SnoozeChoice } from "../shared/followups";
import type { Agent, ServerEvent, TimelineItem } from "../shared/protocol";
import type { AssistantAsk, CreateParams } from "./agents";
import { assistantToolServer, type AssistantToolHost } from "./assistantTools";
import { HOME, type Store } from "./store";
import { T } from "./strings";

export const ASSISTANT_DIR = join(HOME, "assistant");
export const ASSISTANT_FILE = join(HOME, "assistant.json");
const FILE_VERSION = 1;
const TICK_MS = 60_000;
const FIRST_TICK_MS = 12_000;
const SETTLE_MS = 500;
const NOTES_LIMIT = 64_000;

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
type Saved = { version: number; reminders: AssistantReminder[]; told: string[]; lastNudgeId: string | null; checkIns: AssistantCheckIn[]; morningDate: string | null; ledger: { day: string; wakes: number } };

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const tail = (text: string, max: number) => (text.length <= max ? text : `…${text.slice(text.length - max + 1)}`);

export class AssistantService {
  private reminders: AssistantReminder[] = [];
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
    return { enabled: this.enabled, agentId: agent?.id ?? null, notesPath: agent ? join(agent.cwd, ASSISTANT_NOTES_FILE) : null, busy: this.wake !== null, lastCheckIn: this.checkIns[0] ?? null, checkIns: this.checkIns, reminders: this.reminders };
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
    const titled = (input: Record<string, unknown>) => {
      const target = typeof input.session === "string" ? this.deps.store.agents.find((a) => a.id === input.session) : undefined;
      if (!target) return input;
      const pending = host.pendingOf(target.id);
      return { ...input, session_title: target.title, ...(pending ? { pending } : {}) };
    };
    return {
      settingSources: ["user", "project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: ASSISTANT_PROMPT },
      mcpServers: { [ASSISTANT_SERVER]: assistantToolServer(host) },
      canUseTool: async (toolName, input, { signal, toolUseID }) => {
        const allow = { behavior: "allow" as const, updatedInput: input };
        if (isAssistantTool(toolName)) {
          const refusal = this.refusal(toolName, input);
          if (refusal) return { behavior: "deny" as const, message: refusal };
          return assistantToolAsks(toolName) && this.agent()?.permissionMode !== "bypassPermissions" ? ask(toolName, titled(input), signal, toolUseID) : allow;
        }
        const path = typeof input.file_path === "string" ? resolve(root, input.file_path) : null;
        if ((toolName === "Edit" || toolName === "Write") && path && (path === root || path.startsWith(root + sep))) return allow;
        if (this.agent()?.permissionMode === "bypassPermissions") return allow;
        return ask(toolName, input, signal, toolUseID);
      },
    };
  }

  private refusal(toolName: string, input: Record<string, unknown>): string | null {
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
    const live = new Set(state.items.map((item) => item.id));
    let changed = false;
    for (const item of state.items) {
      if (this.told.has(item.id)) continue;
      this.told.add(item.id);
      changed = true;
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
      if (this.now().getTime() - Date.parse(nudge.at) < ASSISTANT_LIMITS.nudgeFreshMs) this.queue.push({ kind: "reminder", itemIds: nudge.itemIds });
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
    const due = this.reminders.filter((r) => Date.parse(r.at) <= now.getTime());
    if (due.length) {
      this.reminders = this.reminders.filter((r) => !due.includes(r));
      for (const reminder of due) this.queue.push({ kind: "ownReminder", reminder });
      this.save();
      this.publish();
    }
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
    const tracked = this.deps.store.agents.some((a) => isTracked(a) && a.status !== "idle") || this.deps.followUps.state().items.length > 0 || this.deps.followUps.state().notes.length > 0;
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
    if (this.wake || agent.status !== "idle") throw new Error(T.errAssistantBusy);
    this.deps.followUps.refresh();
    this.queue.push({ kind: "manual" });
    await this.flush();
    return this.state();
  }

  private source() {
    return { agents: this.deps.store.agents, workspaces: this.deps.store.workspaces, followUps: this.deps.followUps.state(), now: this.now().getTime() };
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
    if (!agent || agent.status !== "idle" || agent.queue?.length) return;
    const now = this.now();
    const urgent = this.queue.some((e) => e.kind === "manual" || e.kind === "morning" || e.kind === "ownReminder");
    if (!urgent) {
      const gapMinutes = this.deps.store.settings.assistantCheckInGap ?? CHECK_IN_GAP_DEFAULT;
      if (gapMinutes === 0) {
        this.queue = [];
        return;
      }
      if (this.quiet(now) || now.getTime() - this.lastWakeAt < gapMinutes * 60_000) return;
    }
    const today = dayKey(now);
    if (this.ledger.day !== today) this.ledger = { day: today, wakes: 0 };
    if (!manual && this.ledger.wakes >= ASSISTANT_LIMITS.wakesPerDay) {
      this.queue = [];
      return;
    }
    const live = new Set(this.deps.followUps.state().items.map((item) => item.id));
    const seen = new Set<string>();
    const events = this.queue.flatMap((event): CheckInEvent[] => {
      if (event.kind === "decision") {
        if (!live.has(event.itemId) || seen.has(event.itemId)) return [];
        seen.add(event.itemId);
        return [event];
      }
      if (event.kind === "reminder") {
        const itemIds = event.itemIds.filter((id) => live.has(id));
        return itemIds.length ? [{ kind: "reminder", itemIds }] : [];
      }
      return [event];
    });
    this.queue = [];
    if (events.length === 0) return;
    const wake: Wake = { startedAt: now.getTime(), before: this.deps.store.timeline(agent.id).length, reason: checkInReason(events), itemIds: checkInItemIds(events), running: false };
    this.wake = wake;
    this.lastWakeAt = now.getTime();
    this.ledger.wakes++;
    this.publish();
    try {
      await this.deps.runner.send(agent.id, buildCheckIn(events, this.source()), { system: true });
    } catch (error) {
      console.error("[assistant] check-in could not start", error);
      if (this.wake === wake) this.wake = null;
      this.publish();
    }
  }

  private target(session: string): Agent {
    const wanted = session.trim();
    const agents = this.deps.store.agents.filter((a) => !a.assistant && !a.feedbackId);
    const agent = agents.find((a) => a.id === wanted) ?? agents.find((a) => a.title.trim().toLowerCase() === wanted.toLowerCase());
    if (!agent) throw new Error(T.errAssistantSession(wanted));
    return agent;
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
        return `Started "${agent.title}" (session ${agent.id}) in ${matches[0].name}.`;
      },
      markDone: (session) => {
        const agent = this.target(session);
        runner.setDone(agent.id, true);
        return `Marked "${agent.title}" done.`;
      },
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
        runner.rename(agent.id, title);
        return `Renamed "${agent.title}" to "${title.trim()}".`;
      },
      pin: (session, pinned) => {
        const agent = this.target(session);
        runner.setPinned(agent.id, pinned);
        return `${pinned ? "Pinned" : "Unpinned"} "${agent.title}".`;
      },
      pendingOf: (session) => {
        const agent = store.agents.find((a) => a.id === session);
        const pending = agent ? scanSession(agent, store.timeline(agent.id)).pending : null;
        return pending ? pending.text : null;
      },
    };
  }

  private publish() {
    this.deps.emit({ type: "assistant", state: this.state() });
  }

  private save() {
    const saved: Saved = { version: FILE_VERSION, reminders: this.reminders, told: [...this.told], lastNudgeId: this.lastNudgeId, checkIns: this.checkIns, morningDate: this.morningDate, ledger: this.ledger };
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

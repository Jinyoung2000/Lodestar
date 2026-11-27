import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  buildAnalysisInput,
  FOLLOW_UP_DEFAULT_MODEL,
  FOLLOW_UP_LIMITS,
  FOLLOW_UP_SCHEMA,
  FOLLOW_UP_SYSTEM_PROMPT,
  isSnoozeChoice,
  isSnoozed,
  isTracked,
  lastActiveAt,
  nextReminder,
  parseAnalysis,
  parseMorning,
  scanSession,
  snoozeUntil,
  type AnalysisSession,
  type FollowUpItem,
  type FollowUpKind,
  type FollowUpNudge,
  type FollowUpsState,
  type SessionScan,
  type WorkNote,
} from "../shared/followups";
import type { Agent, ServerEvent } from "../shared/protocol";
import { claudeBin, claudeEnv, isAuthError } from "./claude";
import { spawnInGroup } from "./processGroups";
import { HOME, type Store } from "./store";
import { T } from "./strings";

export const FOLLOW_UPS_FILE = join(HOME, "followups.json");
const FILE_VERSION = 1;
const ANALYSIS_VERSION = 2;
const TICK_MS = 60_000;
const FIRST_TICK_MS = 8_000;
const QUICK_MS = 1_500;
const TIMEOUT_MS = 120_000;
const MAX_TURNS = 4;
const DAY_MS = 86_400_000;

export type FollowUpModelRequest = { prompt: string; model: string; signal: AbortSignal };
export type FollowUpModelRun = (request: FollowUpModelRequest) => Promise<unknown>;

type FollowUpStoreView = Pick<Store, "settings" | "agents" | "workspaces" | "timeline">;

export type FollowUpDeps = {
  store: FollowUpStoreView;
  emit: (event: ServerEvent) => void;
  autoBlocked?: () => boolean;
  model?: FollowUpModelRun;
  now?: () => Date;
  file?: string;
};

type Ledger = { day: string; calls: number };
type Saved = { version: number; analysisVersion: number; items: FollowUpItem[]; notes: WorkNote[]; analyzed: Record<string, string>; dismissed: Record<string, string>; checkedAt: string | null; ledger: Ledger };

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export class FollowUpsService {
  private items: FollowUpItem[] = [];
  private notes: WorkNote[] = [];
  private analyzed = new Map<string, string>();
  private dismissed = new Map<string, string>();
  private scans = new Map<string, SessionScan>();
  private dirty = new Set<string>();
  private primed = false;
  private checking = false;
  private replying = new Set<string>();
  private checkedAt: string | null = null;
  private error: string | null = null;
  private nudge: FollowUpNudge | null = null;
  private ledger: Ledger = { day: "", calls: 0 };
  private timers: NodeJS.Timeout[] = [];
  private quick: NodeJS.Timeout | null = null;

  constructor(private deps: FollowUpDeps) {
    this.load();
  }

  private get file() {
    return this.deps.file ?? FOLLOW_UPS_FILE;
  }

  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private get enabled() {
    return this.deps.store.settings.assistantEnabled === true && this.deps.store.settings.followUpsEnabled !== false;
  }

  private get morning() {
    return parseMorning(this.deps.store.settings.morningReviewTime);
  }

  state(): FollowUpsState {
    return { enabled: this.enabled, checking: this.checking, checkedAt: this.checkedAt, error: this.error, items: this.items, notes: this.notes, nudge: this.nudge };
  }

  holds(agentId: string): boolean {
    return this.enabled && this.items.some((item) => item.agentId === agentId && item.remindAt !== null);
  }

  start() {
    const first = setTimeout(() => this.tick(), FIRST_TICK_MS);
    const every = setInterval(() => this.tick(), TICK_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.quick) clearTimeout(this.quick);
    this.quick = null;
  }

  observe(event: ServerEvent) {
    if (event.type === "agent") this.touch(event.agent.id);
    else if (event.type === "agentRemoved") this.touch(event.agentId);
    else if (event.type === "timelineUpsert" && (event.item.kind === "permission" || event.item.kind === "user" || event.item.kind === "result")) this.touch(event.agentId);
  }

  private touch(agentId: string) {
    this.dirty.add(agentId);
    if (this.quick || !this.enabled) return;
    this.quick = setTimeout(() => {
      this.quick = null;
      this.refresh();
    }, QUICK_MS);
    this.quick.unref();
  }

  tick() {
    if (!this.enabled) return;
    this.refresh();
    this.remind();
    if (!this.checking && !this.deps.autoBlocked?.()) void this.analyze(false);
  }

  refresh() {
    if (!this.enabled) return;
    const agents = new Map(this.deps.store.agents.map((a) => [a.id, a]));
    if (!this.primed) {
      this.primed = true;
      const since = this.now().getTime() - FOLLOW_UP_LIMITS.scanDays * DAY_MS;
      for (const agent of agents.values()) if (isTracked(agent) && (agent.status !== "idle" || lastActiveAt(agent) >= since)) this.dirty.add(agent.id);
      for (const item of this.items) this.dirty.add(item.agentId);
      for (const note of this.notes) this.dirty.add(note.agentId);
    }
    if (this.dirty.size === 0) return;
    const before = JSON.stringify([this.items, this.notes]);
    const now = this.now();
    for (const agentId of this.dirty) {
      const agent = agents.get(agentId);
      if (!agent || !isTracked(agent)) {
        this.forget(agentId, !agent);
        continue;
      }
      const scan = scanSession(agent, this.deps.store.timeline(agentId));
      this.scans.set(agentId, scan);
      this.settle(agent, scan, now);
    }
    this.dirty.clear();
    if (JSON.stringify([this.items, this.notes]) !== before) this.changed();
  }

  private forget(agentId: string, gone: boolean) {
    this.items = this.items.filter((i) => i.agentId !== agentId);
    this.notes = this.notes.filter((n) => n.agentId !== agentId);
    this.scans.delete(agentId);
    if (gone) {
      this.analyzed.delete(agentId);
      this.dismissed.delete(agentId);
    }
  }

  private settle(agent: Agent, scan: SessionScan, now: Date) {
    const pending = scan.pending;
    const keep = (item: FollowUpItem) => {
      if (item.agentId !== agent.id) return true;
      if (item.kind === "ask") return !pending && scan.anchorId === item.anchorId;
      return pending?.itemId === item.anchorId;
    };
    this.items = this.items.filter(keep);
    this.notes = this.notes.filter((note) => note.agentId !== agent.id || (!pending && scan.anchorId === note.anchorId));
    if (!pending || this.dismissed.get(agent.id) === pending.itemId) return;
    const id = `${agent.id}:${pending.itemId}`;
    if (this.items.some((i) => i.id === id)) return;
    this.items = [...this.items, this.newItem(agent.id, pending.kind, pending.itemId, pending.text, pending.options, now, now)];
  }

  private newItem(agentId: string, kind: FollowUpKind, anchorId: string, text: string, options: string[], since: Date, now: Date): FollowUpItem {
    const from = since.getTime() > now.getTime() ? since : now;
    return { id: `${agentId}:${anchorId}`, agentId, kind, text, options, anchorId, since: since.toISOString(), reminded: 0, remindAt: nextReminder(from, 0, this.morning)?.toISOString() ?? null, snoozedUntil: null };
  }

  remind() {
    const now = this.now();
    const at = now.getTime();
    let advanced = false;
    const due: string[] = [];
    const requestedItemIds: string[] = [];
    this.items = this.items.map((item) => {
      if (isSnoozed(item, at) || !item.remindAt || Date.parse(item.remindAt) > at) return item;
      if (item.snoozedUntil) requestedItemIds.push(item.id);
      else if (this.deps.store.settings.followUpsReminders === false) return item;
      advanced = true;
      if (item.kind !== "ask" || item.snoozedUntil) due.push(item.id);
      const reminded = item.reminded + 1;
      return { ...item, reminded, snoozedUntil: null, remindAt: nextReminder(now, reminded, this.morning)?.toISOString() ?? null };
    });
    if (!advanced) return;
    if (due.length) {
      this.nudge = { id: randomUUID(), at: now.toISOString(), itemIds: due, requestedItemIds };
      console.log(`[followups] reminded ${due.length}`);
    }
    this.changed();
  }

  snooze(id: string, choice: unknown): FollowUpsState {
    if (!isSnoozeChoice(choice)) throw new Error(T.errFollowUpSnooze);
    const item = this.item(id);
    const until = snoozeUntil(choice, this.now(), this.morning).toISOString();
    this.items = this.items.map((i) => (i.id === item.id ? { ...i, snoozedUntil: until, remindAt: until } : i));
    this.changed();
    return this.state();
  }

  wake(id: string): FollowUpsState {
    const item = this.item(id);
    const now = this.now();
    this.items = this.items.map((i) => (i.id === item.id ? { ...i, snoozedUntil: null, remindAt: nextReminder(now, i.reminded, this.morning)?.toISOString() ?? null } : i));
    this.changed();
    return this.state();
  }

  dismiss(id: string): FollowUpsState {
    const item = this.item(id);
    this.dismissed.set(item.agentId, item.anchorId);
    this.items = this.items.filter((i) => i.id !== item.id);
    this.changed();
    return this.state();
  }

  async reply(id: string, text: string, send: (agentId: string, text: string) => Promise<unknown>): Promise<FollowUpsState> {
    if (!this.enabled) throw new Error(T.errFollowUpsOff);
    const item = this.item(id);
    const agent = this.deps.store.agents.find((candidate) => candidate.id === item.agentId);
    if (item.kind !== "ask" || !agent || !isTracked(agent) || agent.queue?.length || scanSession(agent, this.deps.store.timeline(agent.id)).anchorId !== item.anchorId) throw new Error(T.errFollowUpStale);
    if (typeof text !== "string" || !text.trim()) throw new Error(T.errFollowUpReplyEmpty);
    if (this.replying.has(id)) throw new Error(T.errFollowUpReplyBusy);
    this.replying.add(id);
    try {
      await send(agent.id, text.trim());
      this.items = this.items.filter((open) => open.id !== id);
      this.changed();
      return this.state();
    } finally {
      this.replying.delete(id);
    }
  }

  keepOpen(agentId: string): FollowUpsState {
    const note = this.notes.find((n) => n.agentId === agentId);
    if (!note) throw new Error(T.errFollowUpUnknown);
    this.notes = this.notes.map((n) => (n.agentId === agentId ? { ...n, phase: "paused" as const, text: "" } : n));
    this.changed();
    return this.state();
  }

  async check(): Promise<FollowUpsState> {
    if (!this.enabled) throw new Error(T.errFollowUpsOff);
    if (this.checking) throw new Error(T.errFollowUpsChecking);
    this.refresh();
    await this.analyze(true);
    return this.state();
  }

  private item(id: string): FollowUpItem {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(T.errFollowUpUnknown);
    return item;
  }

  private queue(manual: boolean, now: Date): AnalysisSession[] {
    const at = now.getTime();
    const activeSince = at - FOLLOW_UP_LIMITS.activeDays * DAY_MS;
    const workspaces = new Map(this.deps.store.workspaces.map((w) => [w.id, w.name]));
    const out: AnalysisSession[] = [];
    const recentFirst = [...this.deps.store.agents].sort((a, b) => lastActiveAt(b) - lastActiveAt(a));
    for (const agent of recentFirst) {
      const scan = this.scans.get(agent.id);
      if (!scan?.anchorId || !isTracked(agent) || agent.status !== "idle") continue;
      if (this.analyzed.get(agent.id) === scan.anchorId || this.dismissed.get(agent.id) === scan.anchorId) continue;
      if (lastActiveAt(agent) < activeSince) continue;
      const endedAt = scan.anchorAt ? Date.parse(scan.anchorAt) : NaN;
      if (!manual && Number.isFinite(endedAt) && at - endedAt < FOLLOW_UP_LIMITS.settleMs) continue;
      out.push({ agent, workspace: workspaces.get(agent.workspaceId ?? "") ?? "", scan });
    }
    return out;
  }

  private async analyze(manual: boolean) {
    const started = this.now();
    const queue = this.queue(manual, started);
    if (queue.length === 0) {
      if (manual) {
        this.checkedAt = started.toISOString();
        this.error = null;
        this.changed();
      }
      return;
    }
    const today = dayKey(started);
    if (this.ledger.day !== today) this.ledger = { day: today, calls: 0 };
    const batches = manual ? FOLLOW_UP_LIMITS.batchesPerCheck : Math.min(FOLLOW_UP_LIMITS.batchesPerTick, FOLLOW_UP_LIMITS.callsPerDay - this.ledger.calls);
    if (batches <= 0) return;
    this.checking = true;
    this.error = null;
    this.publish();
    let found = 0;
    let read = 0;
    try {
      for (let i = 0; i < batches && i * FOLLOW_UP_LIMITS.batch < queue.length; i++) {
        const batch = queue.slice(i * FOLLOW_UP_LIMITS.batch, (i + 1) * FOLLOW_UP_LIMITS.batch);
        const input = buildAnalysisInput(batch);
        this.ledger.calls++;
        const raw = await this.runModel(input.prompt);
        const results = parseAnalysis(raw, input);
        if (results.length === 0) throw new Error(T.errFollowUpsEmpty);
        read += results.length;
        const now = this.now();
        this.refresh();
        for (const result of results) {
          const scan = this.scans.get(result.agentId);
          const agent = this.deps.store.agents.find((a) => a.id === result.agentId);
          if (!agent || !isTracked(agent) || agent.status !== "idle" || scan?.anchorId !== result.anchorId) continue;
          this.analyzed.set(agent.id, result.anchorId);
          const existing = this.items.find((item) => item.agentId === agent.id && item.anchorId === result.anchorId);
          if (this.dismissed.get(agent.id) === result.anchorId || existing?.snoozedUntil) continue;
          this.items = this.items.filter((item) => item.agentId !== agent.id);
          this.notes = this.notes.filter((note) => note.agentId !== agent.id);
          if (result.state === "decision") {
            const since = scan.anchorAt && Number.isFinite(Date.parse(scan.anchorAt)) ? new Date(scan.anchorAt) : now;
            const decision = existing ? { ...existing, text: result.text, options: result.options } : this.newItem(agent.id, "ask", result.anchorId, result.text, result.options, since, now);
            this.items = [...this.items, decision];
            found++;
          } else this.notes = [...this.notes, { agentId: agent.id, phase: result.state, text: result.text, anchorId: result.anchorId, at: now.toISOString() }];
        }
        this.save();
        this.publish();
      }
      console.log(`[followups] ${manual ? "manual" : "auto"} check sessions=${read} decisions=${found} calls_today=${this.ledger.calls}`);
    } catch (error) {
      const text = String(error instanceof Error ? error.message : error).slice(0, 400);
      this.error = isAuthError(text) ? T.reloginHint(text) : text;
      console.error(`[followups] check failed: ${text}`);
    } finally {
      this.checking = false;
      this.checkedAt = this.now().toISOString();
      this.changed();
    }
  }

  private async runModel(prompt: string): Promise<unknown> {
    const configured = this.deps.store.settings.followUpsModel;
    const model = typeof configured === "string" && configured ? configured : FOLLOW_UP_DEFAULT_MODEL;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      return await (this.deps.model ?? runFollowUpModel)({ prompt, model, signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) throw new Error(T.errFollowUpsTimeout);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private changed() {
    this.save();
    this.publish();
  }

  private publish() {
    this.deps.emit({ type: "followUps", state: this.state() });
  }

  private save() {
    const saved: Saved = { version: FILE_VERSION, analysisVersion: ANALYSIS_VERSION, items: this.items, notes: this.notes, analyzed: Object.fromEntries(this.analyzed), dismissed: Object.fromEntries(this.dismissed), checkedAt: this.checkedAt, ledger: this.ledger };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved, null, 2));
    renameSync(tmp, this.file);
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Saved> | null;
      if (!raw || typeof raw !== "object" || raw.version !== FILE_VERSION) return;
      this.items = (Array.isArray(raw.items) ? raw.items : []).flatMap((item) => sanitizeItem(item) ?? []);
      this.notes = (Array.isArray(raw.notes) ? raw.notes : []).flatMap((note) => sanitizeNote(note) ?? []);
      this.analyzed = stringMap(raw.analyzed);
      if (raw.analysisVersion !== ANALYSIS_VERSION) {
        for (const item of this.items) if (item.kind === "ask" && !item.snoozedUntil) this.analyzed.delete(item.agentId);
      }
      this.dismissed = stringMap(raw.dismissed);
      this.checkedAt = typeof raw.checkedAt === "string" ? raw.checkedAt : null;
      if (raw.ledger && typeof raw.ledger.day === "string" && Number.isInteger(raw.ledger.calls)) this.ledger = { day: raw.ledger.day, calls: raw.ledger.calls };
    } catch (error) {
      console.error("[followups] could not read the saved list", error);
    }
  }
}

function stringMap(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) if (typeof value === "string") out.set(key, value);
  return out;
}

const isoOrNull = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);

function sanitizeItem(raw: unknown): FollowUpItem | null {
  const i = raw as Partial<FollowUpItem> | null;
  if (!i || typeof i !== "object" || typeof i.id !== "string" || typeof i.agentId !== "string" || typeof i.anchorId !== "string") return null;
  const kind = i.kind === "approval" || i.kind === "question" || i.kind === "plan" || i.kind === "ask" ? i.kind : null;
  const since = isoOrNull(i.since);
  if (!kind || !since) return null;
  return {
    id: i.id,
    agentId: i.agentId,
    kind,
    text: typeof i.text === "string" ? i.text.slice(0, FOLLOW_UP_LIMITS.text) : "",
    options: (Array.isArray(i.options) ? i.options : []).filter((o): o is string => typeof o === "string").slice(0, FOLLOW_UP_LIMITS.options),
    anchorId: i.anchorId,
    since,
    reminded: Number.isInteger(i.reminded) && (i.reminded as number) >= 0 ? (i.reminded as number) : 0,
    remindAt: isoOrNull(i.remindAt),
    snoozedUntil: isoOrNull(i.snoozedUntil),
  };
}

function sanitizeNote(raw: unknown): WorkNote | null {
  const n = raw as Partial<WorkNote> | null;
  if (!n || typeof n !== "object" || typeof n.agentId !== "string" || typeof n.anchorId !== "string") return null;
  const at = isoOrNull(n.at);
  if ((n.phase !== "paused" && n.phase !== "finished") || !at) return null;
  return { agentId: n.agentId, phase: n.phase, text: typeof n.text === "string" ? n.text.slice(0, FOLLOW_UP_LIMITS.text) : "", anchorId: n.anchorId, at };
}

export async function runFollowUpModel(request: FollowUpModelRequest): Promise<unknown> {
  const abort = new AbortController();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const q = query({
    prompt: request.prompt,
    options: {
      cwd: HOME,
      env: claudeEnv(),
      model: request.model,
      maxTurns: MAX_TURNS,
      thinking: { type: "disabled" },
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      systemPrompt: FOLLOW_UP_SYSTEM_PROMPT,
      outputFormat: { type: "json_schema", schema: FOLLOW_UP_SCHEMA as unknown as Record<string, unknown> },
      persistSession: false,
      includePartialMessages: false,
      pathToClaudeCodeExecutable: claudeBin(),
      spawnClaudeCodeProcess: spawnInGroup,
      abortController: abort,
    },
  });
  let structured: unknown = null;
  let failure: string | null = null;
  try {
    for await (const message of q) {
      if (message.type !== "result") continue;
      if (message.subtype === "success" && !message.is_error) structured = message.structured_output ?? parseJson(message.result);
      else failure = message.subtype === "success" ? message.result : message.subtype;
    }
  } catch (error) {
    if (failure === null) throw error;
  } finally {
    q.close();
  }
  if (failure) {
    console.error(`[followups] model result: ${failure}`);
    throw new Error(/^error_[a-z_]+$/.test(failure) ? T.errFollowUpsModel : failure);
  }
  if (structured === null) throw new Error(T.errFollowUpsEmpty);
  return structured;
}

function parseJson(text: string): unknown {
  const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTOMATION_DEFAULT_CONCURRENCY,
  AUTOMATION_LIMITS,
  dueTrigger,
  isActiveRun,
  isEffort,
  isHarness,
  isPermissionMode,
  nextRunAfter,
  normalizeSchedule,
  normalizeTarget,
  runBranchName,
  scheduleProblem,
  targetProblem,
  trimRuns,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationsState,
  type AutomationTrigger,
} from "../shared/automations";
import type { Agent, ServerEvent, TimelineItem, UserAttachment } from "../shared/protocol";
import type { CreateParams } from "./agents";
import { HOME, type Store } from "./store";
import { T } from "./strings";

const TICK_MS = 60_000;
const FIRST_TICK_MS = 5_000;
const FILE_VERSION = 1;

type AutomationStoreView = Pick<Store, "settings" | "agents" | "agent" | "workspace" | "timeline" | "patchAgent">;
type BranchInfo = { repoRoot: string | null; current: string | null; defaultBase: string | null; branches: string[] };

export type AutomationDeps = {
  store: AutomationStoreView;
  create: (params: CreateParams) => Promise<Agent>;
  send: (agentId: string, prompt: string, options: { display: string; attachments: UserAttachment[] }) => Promise<{ queued: boolean }>;
  branches: (dir: string) => Promise<BranchInfo>;
  emit: (event: ServerEvent) => void;
  autoBlocked?: () => boolean;
  now?: () => Date;
  file?: string;
};

export const AUTOMATIONS_FILE = join(HOME, "automations.json");

export class AutomationService {
  private automations: Automation[] = [];
  private runs: AutomationRun[] = [];
  private started = new Set<string>();
  private marks = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private deps: AutomationDeps) {
    this.load();
  }

  private get file() {
    return this.deps.file ?? AUTOMATIONS_FILE;
  }

  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  state(): AutomationsState {
    const counts = new Map<string, number>();
    const runs = trimRuns(this.runs).filter((run) => {
      const seen = counts.get(run.automationId) ?? 0;
      counts.set(run.automationId, seen + 1);
      return seen < AUTOMATION_LIMITS.runsListed;
    });
    return { automations: this.automations, runs };
  }

  runsOf(automationId: string): AutomationRun[] {
    this.get(automationId);
    return trimRuns(this.runs.filter((run) => run.automationId === automationId));
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
  }

  create(raw: AutomationInput): Automation {
    const input = this.validate(raw, null);
    const now = this.now();
    const at = now.toISOString();
    const automation: Automation = { ...input, id: randomUUID(), createdAt: at, updatedAt: at, nextRunAt: null };
    automation.nextRunAt = this.firstRunAt(automation, now);
    this.automations = [...this.automations, automation];
    this.changed();
    return automation;
  }

  update(id: string, patch: Partial<AutomationInput>): Automation {
    const current = this.get(id);
    if (!patch || typeof patch !== "object") throw new Error(T.errAutomationField("patch"));
    const input = this.validate({ ...pickInput(current), ...patch }, current);
    const now = this.now();
    const timing = JSON.stringify(input.schedule) !== JSON.stringify(current.schedule) || input.enabled !== current.enabled;
    const next: Automation = { ...current, ...input, updatedAt: now.toISOString() };
    if (timing) next.nextRunAt = this.firstRunAt(next, now);
    this.replace(next);
    return next;
  }

  setEnabled(id: string, enabled: boolean): Automation {
    if (typeof enabled !== "boolean") throw new Error(T.errAutomationField("enabled"));
    return this.update(id, { enabled });
  }

  delete(id: string) {
    this.get(id);
    this.automations = this.automations.filter((a) => a.id !== id);
    this.runs = this.runs.filter((run) => run.automationId !== id);
    this.changed();
  }

  async runNow(id: string): Promise<AutomationRun> {
    const automation = this.get(id);
    if (this.activeRunOf(id)) throw new Error(T.errAutomationRunning);
    return this.launch(automation, "manual", null);
  }

  tick() {
    const now = this.now();
    this.settleStuck(now);
    if (this.deps.autoBlocked?.()) return;
    const due = this.automations
      .filter((a) => a.enabled && dueTrigger(a.nextRunAt, now))
      .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
    for (const automation of due) {
      const trigger = dueTrigger(automation.nextRunAt, now);
      if (!trigger) continue;
      const scheduledFor = automation.nextRunAt;
      if (this.activeRunOf(automation.id)) {
        this.advance(automation, now);
        this.record(automation.id, trigger, scheduledFor, "skipped", null, T.automationSkippedRunning);
        continue;
      }
      const busy = this.busyTarget(automation);
      if (busy) {
        this.advance(automation, now);
        this.record(automation.id, trigger, scheduledFor, "skipped", busy.id, T.automationSkippedBusy);
        continue;
      }
      if (this.runningCount() >= this.concurrency()) continue;
      this.advance(automation, now);
      void this.launch(this.get(automation.id), trigger, scheduledFor);
    }
  }

  observe(event: ServerEvent) {
    if (event.type === "agentRemoved") {
      const run = this.activeRunOn(event.agentId);
      if (run) this.finish(run, "failed", T.automationSessionRemoved);
      return;
    }
    if (event.type !== "agent") return;
    const run = this.activeRunOn(event.agent.id);
    if (run) this.follow(run, event.agent);
  }

  private follow(run: AutomationRun, agent: Agent) {
    if (agent.status === "running") {
      this.started.add(run.id);
      if (run.status === "needsInput") this.setStatus(run, "running");
      return;
    }
    if (agent.status === "waiting") {
      this.started.add(run.id);
      if (run.status !== "needsInput") this.setStatus(run, "needsInput");
      return;
    }
    if (agent.status === "error") {
      if (!this.started.has(run.id) && this.deps.store.timeline(agent.id).length <= (this.marks.get(run.id) ?? 0)) return;
      this.finish(run, "failed", lastErrorText(this.deps.store.timeline(agent.id)) ?? T.automationTurnFailed);
      return;
    }
    if (!this.started.has(run.id)) return;
    const failure = turnFailure(this.deps.store.timeline(agent.id));
    if (failure) this.finish(run, "failed", failure);
    else this.finish(run, "succeeded", null);
  }

  private async launch(automation: Automation, trigger: AutomationTrigger, scheduledFor: string | null): Promise<AutomationRun> {
    const run = this.record(automation.id, trigger, scheduledFor, "running", null, null);
    try {
      if (automation.target.kind === "session") {
        const { agentId } = automation.target;
        const agent = this.deps.store.agents.find((a) => a.id === agentId);
        if (!agent) throw new Error(T.automationSessionGone);
        this.bind(run, agent.id);
        await this.deps.send(agent.id, automation.prompt, { display: "", attachments: [automationChip(automation)] });
      } else {
        const agent = await this.deps.create(await this.createParams(automation));
        const marked = this.deps.store.patchAgent(agent.id, { automationId: automation.id });
        this.deps.emit({ type: "agent", agent: marked });
        this.bind(run, agent.id);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error(`[automations] ${automation.id.slice(0, 8)} ${trigger} failed to start: ${text}`);
      this.finish(run, "failed", text.slice(0, 400));
      return run;
    }
    console.log(`[automations] ${automation.id.slice(0, 8)} ${trigger} started in ${run.agentId?.slice(0, 8)}`);
    const agent = this.deps.store.agents.find((a) => a.id === run.agentId);
    if (agent && isActiveRun(run) && agent.status !== "idle") this.follow(run, agent);
    return run;
  }

  private bind(run: AutomationRun, agentId: string) {
    run.agentId = agentId;
    this.marks.set(run.id, this.deps.store.timeline(agentId).length);
    this.changed();
  }

  private async createParams(automation: Automation): Promise<CreateParams> {
    if (automation.target.kind !== "newSession") throw new Error(T.errAutomationField("target"));
    const { store } = this.deps;
    const workspace = store.workspace(automation.target.workspaceId);
    if (workspace.feedback || workspace.archived) throw new Error(T.errAutomationWorkspace);
    const base = { prompt: automation.prompt, automationChip: automationChip(automation), permissionMode: automation.permissionMode, model: automation.model, effort: automation.effort, harness: automation.harness };
    if (!automation.target.worktree) return { ...base, workspaceId: workspace.id, worktree: null };
    const top = workspace.parentId ? store.workspace(workspace.parentId) : workspace;
    const info = await this.deps.branches(top.dir);
    if (!info.repoRoot) throw new Error(T.errAutomationWorkspace);
    const baseBranch = automation.target.worktree.base || info.defaultBase || info.current || "";
    if (!info.branches.includes(baseBranch)) throw new Error(T.errAutomationBase(baseBranch));
    const branch = runBranchName(automation.title, this.now(), randomBytes(2).toString("hex"));
    return { ...base, workspaceId: top.id, worktree: { branch, base: baseBranch } };
  }

  private busyTarget(automation: Automation): Agent | null {
    if (automation.target.kind !== "session") return null;
    const { agentId } = automation.target;
    const agent = this.deps.store.agents.find((a) => a.id === agentId);
    return agent && (agent.status === "running" || agent.status === "waiting") ? agent : null;
  }

  private settleStuck(now: Date) {
    for (const run of this.runs) {
      if (run.status !== "running" || this.started.has(run.id)) continue;
      if (now.getTime() - Date.parse(run.startedAt) < AUTOMATION_LIMITS.startTimeoutMs) continue;
      const agent = run.agentId ? this.deps.store.agents.find((a) => a.id === run.agentId) : undefined;
      if (agent && agent.status !== "idle") {
        this.follow(run, agent);
        continue;
      }
      if (!run.agentId && now.getTime() - Date.parse(run.startedAt) < AUTOMATION_LIMITS.startTimeoutMs * 5) continue;
      this.finish(run, "failed", agent || !run.agentId ? T.automationNoStart : T.automationSessionGone);
    }
  }

  private advance(automation: Automation, now: Date) {
    const next: Automation =
      automation.schedule.kind === "once"
        ? { ...automation, enabled: false, nextRunAt: null }
        : { ...automation, nextRunAt: nextRunAfter(automation.schedule, now, automation.nextRunAt)?.toISOString() ?? null };
    this.replace(next);
  }

  private firstRunAt(automation: Pick<Automation, "enabled" | "schedule">, now: Date): string | null {
    if (!automation.enabled) return null;
    const next = nextRunAfter(automation.schedule, now);
    if (!next && automation.schedule.kind === "once") throw new Error(T.errAutomationPast);
    return next?.toISOString() ?? null;
  }

  private record(automationId: string, trigger: AutomationTrigger, scheduledFor: string | null, status: AutomationRunStatus, agentId: string | null, error: string | null): AutomationRun {
    const at = this.now().toISOString();
    const run: AutomationRun = { id: randomUUID(), automationId, trigger, scheduledFor, startedAt: at, endedAt: isActiveRun({ status }) ? null : at, status, agentId, error };
    this.runs = trimRuns([run, ...this.runs]);
    if (status === "skipped") console.log(`[automations] ${automationId.slice(0, 8)} ${trigger} skipped: ${error}`);
    this.changed();
    return run;
  }

  private setStatus(run: AutomationRun, status: AutomationRunStatus) {
    run.status = status;
    this.changed();
  }

  private finish(run: AutomationRun, status: AutomationRunStatus, error: string | null) {
    if (!isActiveRun(run)) return;
    run.status = status;
    run.error = error;
    run.endedAt = this.now().toISOString();
    this.started.delete(run.id);
    this.marks.delete(run.id);
    console.log(`[automations] ${run.automationId.slice(0, 8)} run ${status}${error ? `: ${error}` : ""}`);
    this.changed();
  }

  private activeRunOf(automationId: string) {
    return this.runs.find((run) => run.automationId === automationId && isActiveRun(run));
  }

  private activeRunOn(agentId: string) {
    return this.runs.find((run) => run.agentId === agentId && isActiveRun(run));
  }

  private runningCount() {
    return this.runs.filter((run) => run.status === "running").length;
  }

  private concurrency() {
    const value = this.deps.store.settings.automationConcurrency;
    return Number.isInteger(value) && value >= AUTOMATION_LIMITS.concurrencyMin ? value : AUTOMATION_DEFAULT_CONCURRENCY;
  }

  private get(id: string): Automation {
    const automation = this.automations.find((a) => a.id === id);
    if (!automation) throw new Error(T.errAutomationUnknown(String(id)));
    return automation;
  }

  private replace(next: Automation) {
    this.automations = this.automations.map((a) => (a.id === next.id ? next : a));
    this.changed();
  }

  private validate(raw: AutomationInput, current: Automation | null): AutomationInput {
    if (!raw || typeof raw !== "object") throw new Error(T.errAutomationField("automation"));
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) throw new Error(T.errAutomationTitle);
    if (title.length > AUTOMATION_LIMITS.title) throw new Error(T.errAutomationTitleLong(AUTOMATION_LIMITS.title));
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    if (!prompt) throw new Error(T.errAutomationPrompt);
    if (prompt.length > AUTOMATION_LIMITS.prompt) throw new Error(T.errAutomationPromptLong(AUTOMATION_LIMITS.prompt));
    if (typeof raw.enabled !== "boolean") throw new Error(T.errAutomationField("enabled"));
    const problem = scheduleProblem(raw.schedule);
    if (problem === "interval") throw new Error(T.errAutomationInterval(AUTOMATION_LIMITS.intervalMin, AUTOMATION_LIMITS.intervalMax));
    if (problem === "time") throw new Error(T.errAutomationTime);
    if (problem === "weekdays") throw new Error(T.errAutomationWeekdays);
    if (problem === "date") throw new Error(T.errAutomationDate);
    if (problem) throw new Error(T.errAutomationField("schedule"));
    if (targetProblem(raw.target)) throw new Error(T.errAutomationField("target"));
    const target = normalizeTarget(raw.target);
    if (JSON.stringify(target) !== JSON.stringify(current?.target)) this.checkTarget(target);
    if (!isHarness(raw.harness)) throw new Error(T.errAutomationField("harness"));
    if (raw.model !== null && !(typeof raw.model === "string" && raw.model.trim() && raw.model.length <= 200)) throw new Error(T.errAutomationField("model"));
    if (raw.effort !== null && !isEffort(raw.effort)) throw new Error(T.errAutomationField("effort"));
    if (!isPermissionMode(raw.permissionMode)) throw new Error(T.errAutomationField("permissionMode"));
    return { title, prompt, enabled: raw.enabled, schedule: normalizeSchedule(raw.schedule), target, harness: raw.harness, model: raw.model?.trim() ?? null, effort: raw.effort, permissionMode: raw.permissionMode };
  }

  private checkTarget(target: Automation["target"]) {
    if (target.kind === "session") {
      if (this.deps.store.agent(target.agentId).feedbackId) throw new Error(T.errAutomationSession);
      return;
    }
    const workspace = this.deps.store.workspace(target.workspaceId);
    if (workspace.feedback || workspace.archived) throw new Error(T.errAutomationWorkspace);
  }

  private changed() {
    this.save();
    this.deps.emit({ type: "automations", state: this.state() });
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, automations: this.automations, runs: this.runs }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      rmSync(tmp, { force: true });
      console.error("[automations] save failed", error);
    }
  }

  private load() {
    if (!existsSync(this.file)) return;
    let raw: { automations?: unknown; runs?: unknown };
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (!raw || typeof raw !== "object") throw new Error("not an object");
    } catch {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, aside);
      } catch {
      }
      console.error(`[automations] ${T.automationCorrupt(aside)}`);
      return;
    }
    this.automations = (Array.isArray(raw.automations) ? raw.automations : []).map(sanitizeAutomation).filter((a): a is Automation => a !== null);
    const known = new Set(this.automations.map((a) => a.id));
    const at = this.now().toISOString();
    let interrupted = 0;
    this.runs = trimRuns(
      (Array.isArray(raw.runs) ? raw.runs : [])
        .map(sanitizeRun)
        .filter((run): run is AutomationRun => run !== null && known.has(run.automationId))
        .map((run) => {
          if (!isActiveRun(run)) return run;
          interrupted++;
          return { ...run, status: "failed" as const, endedAt: at, error: T.automationInterrupted };
        }),
    );
    if (interrupted) this.save();
  }
}

function pickInput(automation: Automation): AutomationInput {
  const { title, prompt, enabled, schedule, target, harness, model, effort, permissionMode } = automation;
  return { title, prompt, enabled, schedule, target, harness, model, effort, permissionMode };
}

export function sanitizeAutomation(raw: unknown): Automation | null {
  const a = raw as Partial<Automation> | null;
  if (!a || typeof a !== "object" || typeof a.id !== "string" || !a.id) return null;
  if (typeof a.title !== "string" || typeof a.prompt !== "string" || typeof a.enabled !== "boolean") return null;
  if (scheduleProblem(a.schedule) || targetProblem(a.target) || !isPermissionMode(a.permissionMode)) return null;
  const date = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
  const created = date(a.createdAt) ?? new Date(0).toISOString();
  return {
    id: a.id,
    title: a.title,
    prompt: a.prompt,
    enabled: a.enabled,
    schedule: normalizeSchedule(a.schedule!),
    target: normalizeTarget(a.target!),
    harness: isHarness(a.harness) ? a.harness : "claude",
    model: typeof a.model === "string" && a.model ? a.model : null,
    effort: isEffort(a.effort) ? a.effort : null,
    permissionMode: a.permissionMode!,
    createdAt: created,
    updatedAt: date(a.updatedAt) ?? created,
    nextRunAt: a.enabled ? date(a.nextRunAt) : null,
  };
}

const RUN_STATUSES: readonly AutomationRunStatus[] = ["running", "succeeded", "failed", "skipped", "needsInput"];
const TRIGGERS: readonly AutomationTrigger[] = ["scheduled", "catchup", "manual"];

export function sanitizeRun(raw: unknown): AutomationRun | null {
  const r = raw as Partial<AutomationRun> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.automationId !== "string" || typeof r.startedAt !== "string") return null;
  if (!RUN_STATUSES.includes(r.status as AutomationRunStatus) || !TRIGGERS.includes(r.trigger as AutomationTrigger)) return null;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: r.id,
    automationId: r.automationId,
    trigger: r.trigger as AutomationTrigger,
    scheduledFor: text(r.scheduledFor),
    startedAt: r.startedAt,
    endedAt: text(r.endedAt),
    status: r.status as AutomationRunStatus,
    agentId: text(r.agentId),
    error: text(r.error),
  };
}

function lastTurnItems(items: TimelineItem[]): TimelineItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "user" && item.source !== "system") return items.slice(i + 1);
  }
  return items;
}

export function lastErrorText(items: TimelineItem[]): string | null {
  const turn = lastTurnItems(items);
  for (let i = turn.length - 1; i >= 0; i--) {
    const item = turn[i];
    if (item.kind === "error") return item.text.slice(0, 400);
  }
  return null;
}

export function turnFailure(items: TimelineItem[]): string | null {
  const turn = lastTurnItems(items);
  for (let i = turn.length - 1; i >= 0; i--) {
    const item = turn[i];
    if (item.kind === "result") return item.isError ? (lastErrorText(items) ?? T.automationTurnFailed) : null;
  }
  return null;
}

function automationChip(automation: Automation): Extract<UserAttachment, { kind: "automation" }> {
  return { kind: "automation", label: automation.title, id: automation.id };
}

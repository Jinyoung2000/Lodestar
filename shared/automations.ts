import { EFFORT_LEVELS, HARNESS_VALUES, PERMISSION_MODE_VALUES, type EffortLevel, type Harness, type PermissionMode } from "./protocol";

export type AutomationSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string; weekdays: number[] }
  | { kind: "once"; at: string };

export type AutomationTarget =
  | { kind: "newSession"; workspaceId: string; worktree: { base: string } | null }
  | { kind: "session"; agentId: string };

export type Automation = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  target: AutomationTarget;
  harness: Harness;
  model: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
};

export type AutomationInput = Pick<Automation, "title" | "prompt" | "enabled" | "schedule" | "target" | "harness" | "model" | "effort" | "permissionMode">;

export type AutomationTrigger = "scheduled" | "catchup" | "manual";
export type AutomationRunStatus = "running" | "succeeded" | "failed" | "skipped" | "needsInput";

export type AutomationRun = {
  id: string;
  automationId: string;
  trigger: AutomationTrigger;
  scheduledFor: string | null;
  startedAt: string;
  endedAt: string | null;
  status: AutomationRunStatus;
  agentId: string | null;
  error: string | null;
};

export type AutomationsState = { automations: Automation[]; runs: AutomationRun[] };

export type AutomationsRpcMethods = {
  "automations.list": { params: Record<string, never>; result: AutomationsState };
  "automations.create": { params: AutomationInput; result: Automation };
  "automations.update": { params: { id: string; patch: Partial<AutomationInput> }; result: Automation };
  "automations.delete": { params: { id: string }; result: null };
  "automations.setEnabled": { params: { id: string; enabled: boolean }; result: Automation };
  "automations.runNow": { params: { id: string }; result: AutomationRun };
  "automations.runs": { params: { automationId: string }; result: AutomationRun[] };
};

export const AUTOMATION_LIMITS = {
  title: 120,
  prompt: 20_000,
  intervalMin: 5,
  intervalMax: 1440,
  runsKept: 50,
  runsListed: 10,
  scheduledGraceMs: 5 * 60_000,
  startTimeoutMs: 2 * 60_000,
  concurrencyMin: 1,
  concurrencyMax: 10,
};

export const AUTOMATION_DEFAULT_CONCURRENCY = 2;
export const WEEKDAYS_DEFAULT = [1, 2, 3, 4, 5];
export const ACTIVE_RUN_STATUSES: readonly AutomationRunStatus[] = ["running", "needsInput"];

export const isActiveRun = (run: Pick<AutomationRun, "status">) => ACTIVE_RUN_STATUSES.includes(run.status);

export function parseClock(text: unknown): { hour: number; minute: number } | null {
  const match = typeof text === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim()) : null;
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

export type ScheduleProblem = "interval" | "time" | "weekdays" | "date" | "kind";

export function scheduleProblem(raw: unknown): ScheduleProblem | null {
  const schedule = raw as Partial<AutomationSchedule> | null;
  if (!schedule || typeof schedule !== "object") return "kind";
  if (schedule.kind === "interval") {
    const minutes = (schedule as { minutes?: unknown }).minutes;
    return Number.isInteger(minutes) && (minutes as number) >= AUTOMATION_LIMITS.intervalMin && (minutes as number) <= AUTOMATION_LIMITS.intervalMax ? null : "interval";
  }
  if (schedule.kind === "daily") {
    const daily = schedule as { time?: unknown; weekdays?: unknown };
    if (!parseClock(daily.time)) return "time";
    const days = daily.weekdays;
    return Array.isArray(days) && days.length > 0 && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? null : "weekdays";
  }
  if (schedule.kind === "once") {
    const at = (schedule as { at?: unknown }).at;
    return typeof at === "string" && Number.isFinite(Date.parse(at)) ? null : "date";
  }
  return "kind";
}

export function normalizeSchedule(schedule: AutomationSchedule): AutomationSchedule {
  if (schedule.kind === "interval") return { kind: "interval", minutes: schedule.minutes };
  if (schedule.kind === "daily") {
    const clock = parseClock(schedule.time)!;
    return { kind: "daily", time: `${two(clock.hour)}:${two(clock.minute)}`, weekdays: [...new Set(schedule.weekdays)].sort((a, b) => a - b) };
  }
  return { kind: "once", at: new Date(Date.parse(schedule.at)).toISOString() };
}

export function targetProblem(raw: unknown): boolean {
  const target = raw as Partial<AutomationTarget> | null;
  if (!target || typeof target !== "object") return true;
  if (target.kind === "session") return typeof (target as { agentId?: unknown }).agentId !== "string" || !(target as { agentId: string }).agentId;
  if (target.kind !== "newSession") return true;
  const fresh = target as { workspaceId?: unknown; worktree?: unknown };
  if (typeof fresh.workspaceId !== "string" || !fresh.workspaceId) return true;
  if (fresh.worktree === null || fresh.worktree === undefined) return false;
  const base = (fresh.worktree as { base?: unknown }).base;
  return typeof fresh.worktree !== "object" || typeof base !== "string";
}

export function normalizeTarget(target: AutomationTarget): AutomationTarget {
  if (target.kind === "session") return { kind: "session", agentId: target.agentId };
  return { kind: "newSession", workspaceId: target.workspaceId, worktree: target.worktree ? { base: target.worktree.base.trim() } : null };
}

export const isPermissionMode = (value: unknown): value is PermissionMode => typeof value === "string" && (PERMISSION_MODE_VALUES as readonly string[]).includes(value);
export const isHarness = (value: unknown): value is Harness => typeof value === "string" && (HARNESS_VALUES as readonly string[]).includes(value);
export const isEffort = (value: unknown): value is EffortLevel => typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);

const two = (n: number) => String(n).padStart(2, "0");
const MINUTE_MS = 60_000;

export function nextRunAfter(schedule: AutomationSchedule, from: Date, anchor: string | null = null): Date | null {
  if (schedule.kind === "interval") {
    const step = schedule.minutes * MINUTE_MS;
    const anchorAt = anchor ? Date.parse(anchor) : NaN;
    if (!Number.isFinite(anchorAt)) return new Date(from.getTime() + step);
    const slots = Math.max(1, Math.floor((from.getTime() - anchorAt) / step) + 1);
    return new Date(anchorAt + slots * step);
  }
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    return at > from.getTime() ? new Date(at) : null;
  }
  const clock = parseClock(schedule.time);
  if (!clock || schedule.weekdays.length === 0) return null;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, clock.hour, clock.minute, 0, 0);
    if (day.getTime() > from.getTime() && schedule.weekdays.includes(day.getDay())) return day;
  }
  return null;
}

export function dueTrigger(nextRunAt: string | null, now: Date): "scheduled" | "catchup" | null {
  if (!nextRunAt) return null;
  const at = Date.parse(nextRunAt);
  if (!Number.isFinite(at) || at > now.getTime()) return null;
  return now.getTime() - at <= AUTOMATION_LIMITS.scheduledGraceMs ? "scheduled" : "catchup";
}

export function trimRuns(runs: AutomationRun[], keep = AUTOMATION_LIMITS.runsKept): AutomationRun[] {
  const counts = new Map<string, number>();
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sorted.filter((run) => {
    const seen = counts.get(run.automationId) ?? 0;
    counts.set(run.automationId, seen + 1);
    return seen < keep;
  });
}

export function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "run";
}

export function runBranchName(title: string, at: Date, suffix: string): string {
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
  return `automation/${branchSlug(title)}-${stamp}-${suffix}`;
}

export type AutomationPhase = "running" | "needsInput" | "failed" | "paused" | "scheduled" | "idle";

export function automationPhase(automation: Pick<Automation, "enabled" | "nextRunAt">, latest: Pick<AutomationRun, "status"> | undefined): AutomationPhase {
  if (latest?.status === "running") return "running";
  if (latest?.status === "needsInput") return "needsInput";
  if (!automation.enabled) return "paused";
  if (latest?.status === "failed") return "failed";
  return automation.nextRunAt ? "scheduled" : "idle";
}

export function latestRunOf(runs: AutomationRun[], automationId: string): AutomationRun | undefined {
  let latest: AutomationRun | undefined;
  for (const run of runs) if (run.automationId === automationId && (!latest || run.startedAt > latest.startedAt)) latest = run;
  return latest;
}

import { AUTOMATION_LIMITS, WEEKDAYS_DEFAULT, automationPhase, latestRunOf, parseClock, type Automation, type AutomationInput, type AutomationPhase, type AutomationRun, type AutomationSchedule } from "../shared/automations";
import type { Agent, EffortLevel, PermissionMode, Workspace } from "../shared/protocol";
import { S } from "./strings";

const A = S.automation;
const two = (n: number) => String(n).padStart(2, "0");
const clock = (date: Date) => `${two(date.getHours())}:${two(date.getMinutes())}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const monthDay = (date: Date) => `${MONTHS[date.getMonth()]} ${date.getDate()}`;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const dayOffset = (date: Date, now: Date) => Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);

export function scheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.kind === "interval") return A.everyMinutes(schedule.minutes);
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    return A.onceOn(`${monthDay(at)}, ${clock(at)}`);
  }
  const days = [...schedule.weekdays].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  const key = days.join(",");
  const which = key === "1,2,3,4,5" ? A.weekdays : days.length === 7 ? A.everyDay : key === "6,0" ? A.weekends : days.map((d) => DAY_NAMES[d]).join(", ");
  return A.atTime(which, schedule.time);
}

export function shortWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  const offset = dayOffset(at, now);
  if (offset === 0) return clock(at);
  if (offset === -1) return A.yesterdayAt(clock(at));
  return monthDay(at);
}

export function runTimeLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  const offset = dayOffset(at, now);
  if (offset === 0) return A.todayComma(clock(at));
  if (offset === -1) return A.yesterdayComma(clock(at));
  return `${DAY_NAMES[at.getDay()]}, ${monthDay(at)}, ${clock(at)}`;
}

export function nextRunLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  const minutes = Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return A.nextIn(minutes);
  const offset = dayOffset(at, now);
  if (offset === 0) return A.nextToday(clock(at));
  if (offset === 1) return A.nextTomorrow(clock(at));
  if (offset < 7) return A.nextOn(DAY_NAMES[at.getDay()], clock(at));
  return A.nextOn(monthDay(at), clock(at));
}

export type AutomationRow = { automation: Automation; latest: AutomationRun | undefined; phase: AutomationPhase };

const PHASE_RANK: Record<AutomationPhase, number> = { needsInput: 0, failed: 1, running: 2, scheduled: 3, idle: 4, paused: 5 };

export function automationRows(automations: Automation[], runs: AutomationRun[]): AutomationRow[] {
  return automations
    .map((automation) => {
      const latest = latestRunOf(runs, automation.id);
      return { automation, latest, phase: automationPhase(automation, latest) };
    })
    .sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || (a.automation.nextRunAt ?? "").localeCompare(b.automation.nextRunAt ?? "") || a.automation.title.localeCompare(b.automation.title));
}

export function phaseWord(row: AutomationRow, now: Date): string {
  if (row.phase === "scheduled") return row.automation.nextRunAt ? nextRunLabel(row.automation.nextRunAt, now) : A.phase.idle;
  return A.phase[row.phase];
}

export function lastRunLine(row: AutomationRow, now: Date): string | null {
  const run = row.latest;
  if (!run) return null;
  if (run.status === "running") return A.startedAt(shortWhen(run.startedAt, now));
  if (run.status === "needsInput") return A.since(shortWhen(run.startedAt, now));
  const when = shortWhen(run.endedAt ?? run.startedAt, now);
  if (row.phase === "failed") return dayOffset(new Date(run.endedAt ?? run.startedAt), now) === 0 ? A.todayAt(clock(new Date(run.endedAt ?? run.startedAt))) : when;
  return `${A.result[run.status]} ${when}`;
}

export const automationsAwaitingInput = (automations: Automation[], runs: AutomationRun[]) => automations.filter((a) => latestRunOf(runs, a.id)?.status === "needsInput").length;

export function sessionSummary(automation: Automation, workspaces: Workspace[], agents: Agent[]): string {
  const target = automation.target;
  if (target.kind === "session") return A.existingSessionSummary(agents.find((a) => a.id === target.agentId)?.title ?? A.missingSession);
  const name = workspaces.find((w) => w.id === target.workspaceId)?.name ?? A.missingFolder;
  if (!target.worktree) return A.newSessionIn(name);
  return A.newSessionWorktree(name, target.worktree.base || A.defaultBranch);
}

export type AutomationDraft = {
  title: string;
  prompt: string;
  enabled: boolean;
  kind: AutomationSchedule["kind"];
  minutes: string;
  time: string;
  weekdays: number[];
  onceAt: string;
  targetKind: "newSession" | "session";
  workspaceId: string;
  worktree: boolean;
  base: string;
  agentId: string;
  model: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
};

const localInput = (date: Date) => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${clock(date)}`;

export const ONCE_FORMAT = "YYYY-MM-DD HH:MM";

function parseLocal(text: string): Date | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getMonth() === month - 1 && date.getDate() === day && hour < 24 && minute < 60 ? date : null;
}

export function draftOf(automation: Automation | null, defaults: { workspaceId: string; permissionMode: PermissionMode; now: Date }): AutomationDraft {
  const tomorrow = new Date(defaults.now.getFullYear(), defaults.now.getMonth(), defaults.now.getDate() + 1, 9, 0);
  const blank: AutomationDraft = {
    title: "",
    prompt: "",
    enabled: true,
    kind: "daily",
    minutes: "30",
    time: "09:00",
    weekdays: WEEKDAYS_DEFAULT,
    onceAt: localInput(tomorrow),
    targetKind: "newSession",
    workspaceId: defaults.workspaceId,
    worktree: false,
    base: "",
    agentId: "",
    model: null,
    effort: null,
    permissionMode: defaults.permissionMode,
  };
  if (!automation) return blank;
  const { schedule, target } = automation;
  return {
    ...blank,
    title: automation.title,
    prompt: automation.prompt,
    enabled: automation.enabled,
    kind: schedule.kind,
    minutes: schedule.kind === "interval" ? String(schedule.minutes) : blank.minutes,
    time: schedule.kind === "daily" ? schedule.time : blank.time,
    weekdays: schedule.kind === "daily" ? schedule.weekdays : blank.weekdays,
    onceAt: schedule.kind === "once" ? localInput(new Date(schedule.at)) : blank.onceAt,
    targetKind: target.kind,
    workspaceId: target.kind === "newSession" ? target.workspaceId : blank.workspaceId,
    worktree: target.kind === "newSession" && !!target.worktree,
    base: target.kind === "newSession" ? (target.worktree?.base ?? "") : "",
    agentId: target.kind === "session" ? target.agentId : "",
    model: automation.model,
    effort: automation.effort,
    permissionMode: automation.permissionMode,
  };
}

export function inputOf(draft: AutomationDraft): { input: AutomationInput } | { problem: string } {
  if (!draft.title.trim()) return { problem: A.needTitle };
  if (!draft.prompt.trim()) return { problem: A.needPrompt };
  const schedule = scheduleOf(draft);
  if (typeof schedule === "string") return { problem: schedule };
  if (draft.targetKind === "newSession" && !draft.workspaceId) return { problem: A.needFolder };
  if (draft.targetKind === "session" && !draft.agentId) return { problem: A.needSession };
  const target: AutomationInput["target"] = draft.targetKind === "session" ? { kind: "session", agentId: draft.agentId } : { kind: "newSession", workspaceId: draft.workspaceId, worktree: draft.worktree ? { base: draft.base } : null };
  return { input: { title: draft.title.trim(), prompt: draft.prompt.trim(), enabled: draft.enabled, schedule, target, harness: "claude", model: draft.model, effort: draft.effort, permissionMode: draft.permissionMode } };
}

function scheduleOf(draft: AutomationDraft): AutomationSchedule | string {
  if (draft.kind === "interval") {
    const minutes = Number(draft.minutes);
    if (!Number.isInteger(minutes) || minutes < AUTOMATION_LIMITS.intervalMin || minutes > AUTOMATION_LIMITS.intervalMax) return A.needInterval(AUTOMATION_LIMITS.intervalMin, AUTOMATION_LIMITS.intervalMax);
    return { kind: "interval", minutes };
  }
  if (draft.kind === "daily") {
    if (!parseClock(draft.time)) return A.needTime;
    if (draft.weekdays.length === 0) return A.needDays;
    return { kind: "daily", time: draft.time.trim(), weekdays: draft.weekdays };
  }
  const at = parseLocal(draft.onceAt);
  if (!at) return A.needDate;
  return { kind: "once", at: at.toISOString() };
}

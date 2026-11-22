import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentStatus, SubagentTask, TimelineItem } from "../shared/protocol";
import { ASYNC_LAUNCH_PATTERN, cleanSubagentOutput, type ToolItem } from "../shared/subagents";

export { isAgentTool, mainFlow, runningBackground, subagentChildIds, type ToolItem } from "../shared/subagents";

const STEP_OUTPUT_MAX = 500;
const STEP_INPUT_MAX = 400;

export function slimInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === "string" && value.length > STEP_INPUT_MAX ? `${value.slice(0, STEP_INPUT_MAX)}...` : value]));
}

export const slimOutput = (text: string) => (text.length > STEP_OUTPUT_MAX ? `${text.slice(0, STEP_OUTPUT_MAX)}...` : text);

export function firstLine(text: string | null | undefined): string | null {
  const line = (text ?? "").split("\n").find((l) => l.trim());
  return line ? line.trim().slice(0, 300) : null;
}

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

export function newTask(input: Record<string, unknown>, now: string): SubagentTask {
  return { taskId: null, status: "running", backgrounded: input.run_in_background === true, subagentType: str(input.subagent_type), description: str(input.description) ?? str(input.name) ?? firstLine(str(input.prompt)) ?? "Agent", activity: null, tokens: 0, toolUses: 0, durationMs: 0, lastTool: null, summary: null, startedAt: now };
}

type Started = Extract<SDKMessage, { type: "system"; subtype: "task_started" }>;
type Progress = Extract<SDKMessage, { type: "system"; subtype: "task_progress" }>;
type Updated = Extract<SDKMessage, { type: "system"; subtype: "task_updated" }>;
type Notification = Extract<SDKMessage, { type: "system"; subtype: "task_notification" }>;

const withTask = (item: ToolItem, task: SubagentTask): ToolItem => ({ ...item, task });
const finished = (status: SubagentStatus) => status !== "running";

export const isAgentTask = (message: { task_type?: string; subagent_type?: string }) => message.task_type === undefined ? message.subagent_type !== undefined : message.task_type === "local_agent";

export function startTask(item: ToolItem, message: Started, now: string): ToolItem {
  const base = item.task ?? newTask(item.input, now);
  return withTask(item, { ...base, taskId: message.task_id, backgrounded: message.is_backgrounded ?? base.backgrounded, subagentType: message.subagent_type ?? base.subagentType, description: str(message.description) ?? base.description });
}

export function progressTask(item: ToolItem, message: Progress): ToolItem {
  const base = item.task;
  if (!base || finished(base.status)) return item;
  return withTask(item, { ...base, taskId: base.taskId ?? message.task_id, activity: str(message.summary) ?? str(message.description) ?? base.activity, tokens: message.usage.total_tokens, toolUses: message.usage.tool_uses, durationMs: message.usage.duration_ms, lastTool: message.last_tool_name ?? base.lastTool });
}

const UPDATE_STATUS: Record<string, SubagentStatus | undefined> = { running: "running", completed: "completed", failed: "failed", killed: "stopped" };

export function updateTask(item: ToolItem, message: Updated, now: string): ToolItem {
  const base = item.task;
  if (!base) return item;
  const patch = message.patch;
  const status = patch.status ? (UPDATE_STATUS[patch.status] ?? base.status) : base.status;
  const next = finished(base.status) && status === "running" ? base.status : status;
  return withTask(item, { ...base, status: next, backgrounded: patch.is_backgrounded ?? base.backgrounded, description: str(patch.description) ?? base.description, ...(finished(next) && !base.endedAt ? { endedAt: now } : {}) });
}

export function finishTask(item: ToolItem, message: Notification, now: string): ToolItem {
  const base = item.task ?? newTask(item.input, now);
  const status: SubagentStatus = message.status;
  return withTask(item, {
    ...base,
    taskId: base.taskId ?? message.task_id,
    status,
    activity: null,
    summary: firstLine(message.summary) ?? base.summary,
    tokens: message.usage?.total_tokens ?? base.tokens,
    toolUses: message.usage?.tool_uses ?? base.toolUses,
    durationMs: message.usage?.duration_ms ?? base.durationMs,
    endedAt: base.endedAt ?? now,
  });
}

export function resultTask(item: ToolItem, text: string, isError: boolean, now: string): ToolItem {
  const base = item.task ?? newTask(item.input, now);
  if (ASYNC_LAUNCH_PATTERN.test(text)) return withTask(item, { ...base, backgrounded: true });
  if (finished(base.status)) return item.task ? item : withTask(item, base);
  return withTask(item, { ...base, status: isError ? "failed" : "completed", activity: null, summary: base.summary ?? firstLine(cleanSubagentOutput(text).text), endedAt: now, durationMs: base.durationMs || Math.max(0, Date.parse(now) - Date.parse(base.startedAt)) });
}

export function stopTask(item: ToolItem, now: string): ToolItem {
  const base = item.task;
  if (!base || finished(base.status)) return item;
  return withTask(item, { ...base, status: "stopped", activity: null, endedAt: now });
}

export function reconcileTasks(items: TimelineItem[], liveTaskIds: ReadonlySet<string>, now: string): ToolItem[] {
  const changed: ToolItem[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || item.task?.status !== "running" || !item.task.backgrounded || !item.task.taskId || liveTaskIds.has(item.task.taskId)) continue;
    changed.push(stopTask(item, now));
  }
  return changed;
}

export function settleStale(items: TimelineItem[]): TimelineItem[] {
  const now = new Date().toISOString();
  return items.map((item) => {
    if (item.kind !== "tool") return item;
    if (item.parentToolUseId && item.status === "running") return { ...item, status: "error" as const, cancelled: true };
    return item.task?.status === "running" ? stopTask(item, now) : item;
  });
}

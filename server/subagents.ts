import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentStatus, SubagentTask, TimelineItem } from "../shared/protocol";
import { ASYNC_LAUNCH_PATTERN, cleanSubagentOutput, type ToolItem } from "../shared/subagents";

export { isAgentTool, mainFlow, runningBackground, subagentChildIds, type ToolItem } from "../shared/subagents";

// SUB: 서브에이전트(Agent, Task 도구) 현황을 도구 호출 항목의 `task` 필드로 모으는 순수한 조각들. test/subagents.test.ts 가 SDK 이벤트 순서로 시험한다.
// 호출 하나가 서브에이전트 하나라서 항목 id(= tool_use_id)가 곧 서브에이전트 id 다. SDK 는 호출이 끝나기 전에 task_started 로 id 를 알리고, 끝난 뒤에는 task_notification 으로 결과를 알린다.

const STEP_OUTPUT_MAX = 500;
const STEP_INPUT_MAX = 400;

// 서브에이전트가 부른 도구는 화면에 한 줄 요약으로만 보이므로 긴 입력(파일 전체 등)은 줄여 저장한다. 서브에이전트 하나가 도구를 수백 번 부를 수 있다.
export function slimInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === "string" && value.length > STEP_INPUT_MAX ? `${value.slice(0, STEP_INPUT_MAX)}...` : value]));
}

export const slimOutput = (text: string) => (text.length > STEP_OUTPUT_MAX ? `${text.slice(0, STEP_OUTPUT_MAX)}...` : text);

export function firstLine(text: string | null | undefined): string | null {
  const line = (text ?? "").split("\n").find((l) => l.trim());
  return line ? line.trim().slice(0, 300) : null;
}

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

// Agent 호출이 막 들어왔을 때(task_started 가 오기 전)의 현황. 입력만으로 알 수 있는 것만 담는다.
export function newTask(input: Record<string, unknown>, now: string): SubagentTask {
  return { taskId: null, status: "running", backgrounded: input.run_in_background === true, subagentType: str(input.subagent_type), description: str(input.description) ?? str(input.name) ?? firstLine(str(input.prompt)) ?? "Agent", activity: null, tokens: 0, toolUses: 0, durationMs: 0, lastTool: null, summary: null, startedAt: now };
}

type Started = Extract<SDKMessage, { type: "system"; subtype: "task_started" }>;
type Progress = Extract<SDKMessage, { type: "system"; subtype: "task_progress" }>;
type Updated = Extract<SDKMessage, { type: "system"; subtype: "task_updated" }>;
type Notification = Extract<SDKMessage, { type: "system"; subtype: "task_notification" }>;

const withTask = (item: ToolItem, task: SubagentTask): ToolItem => ({ ...item, task });
const finished = (status: SubagentStatus) => status !== "running";

// 서브에이전트가 아닌 작업(백그라운드 Bash, Monitor 등)의 task_* 는 다루지 않는다.
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
  // 끝난 서브에이전트를 늦게 온 running 갱신으로 되살리지 않는다
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

// Agent 호출의 tool_result. 백그라운드로 띄웠다는 안내면 아직 도는 중이고, 아니면(앞에서 기다린 서브에이전트) 그 결과가 곧 끝이다.

export function resultTask(item: ToolItem, text: string, isError: boolean, now: string): ToolItem {
  const base = item.task ?? newTask(item.input, now);
  if (ASYNC_LAUNCH_PATTERN.test(text)) return withTask(item, { ...base, backgrounded: true });
  // 이미 task_notification 이 끝을 알렸으면 그 값을 지킨다
  if (finished(base.status)) return item.task ? item : withTask(item, base);
  return withTask(item, { ...base, status: isError ? "failed" : "completed", activity: null, summary: base.summary ?? firstLine(cleanSubagentOutput(text).text), endedAt: now, durationMs: base.durationMs || Math.max(0, Date.parse(now) - Date.parse(base.startedAt)) });
}

export function stopTask(item: ToolItem, now: string): ToolItem {
  const base = item.task;
  if (!base || finished(base.status)) return item;
  return withTask(item, { ...base, status: "stopped", activity: null, endedAt: now });
}

// background_tasks_changed 는 살아 있는 백그라운드 작업 전체다(교체 의미). task_notification 을 놓쳤어도 여기서 빠진 것은 끝난 것이다.
// 앞에서 기다리는 서브에이전트는 이 목록에 없을 수 있어 backgrounded 인 것만 본다. 아직 taskId 를 모르는 것(task_started 가 오기 전)은 건드리지 않는다.
export function reconcileTasks(items: TimelineItem[], liveTaskIds: ReadonlySet<string>, now: string): ToolItem[] {
  const changed: ToolItem[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || item.task?.status !== "running" || !item.task.backgrounded || !item.task.taskId || liveTaskIds.has(item.task.taskId)) continue;
    changed.push(stopTask(item, now));
  }
  return changed;
}

// 디스크에서 읽은 타임라인의 도는 서브에이전트와 그 도구 호출은 이전 데몬이 남긴 것이다(프로세스는 이미 없다). 도는 것으로 남지 않게 멈춘 것으로 바꾼다.
export function settleStale(items: TimelineItem[]): TimelineItem[] {
  const now = new Date().toISOString();
  return items.map((item) => {
    if (item.kind !== "tool") return item;
    if (item.parentToolUseId && item.status === "running") return { ...item, status: "error" as const, cancelled: true };
    return item.task?.status === "running" ? stopTask(item, now) : item;
  });
}

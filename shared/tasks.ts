import type { TimelineItem } from "./protocol";
import { sharedPrefix } from "./sharedPrefix";

export type TaskStatus = "pending" | "in_progress" | "completed";
export type TaskEntry = { id: string; subject: string; activeForm: string | null; status: TaskStatus };
export type TaskState = { list: TaskEntry[]; done: number; total: number; current: TaskEntry | null; names: Map<string, string> };

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

export const TASK_TOOLS = ["TodoWrite", "TaskCreate", "TaskUpdate"] as const;
export const isTaskTool = (name: string) => (TASK_TOOLS as readonly string[]).includes(name);

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const asStatus = (value: unknown): TaskStatus | "deleted" | null => (value === "pending" || value === "in_progress" || value === "completed" || value === "deleted" ? value : null);

const counts = (item: ToolItem) => item.status !== "error" && !item.cancelled;

export function taskState(items: readonly TimelineItem[] | undefined): TaskState {
  return foldTasks([], new Map(), items ?? [], 0);
}

export function taskStateFrom(items: readonly TimelineItem[] | undefined, prev: { input: readonly TimelineItem[] | undefined; output: TaskState } | null): TaskState {
  if (!items || !prev?.input) return taskState(items);
  const from = sharedPrefix(prev.input, items);
  for (let i = from; i < prev.input.length; i++) {
    const item = prev.input[i];
    if (item.kind === "tool" && isTaskTool(item.name)) return taskState(items);
  }
  return foldTasks(prev.output.list, new Map(prev.output.names), items, from);
}

function foldTasks(start: TaskEntry[], names: Map<string, string>, items: readonly TimelineItem[], from: number): TaskState {
  let list = start;
  const remember = (entry: TaskEntry) => names.set(entry.id, entry.subject);
  for (let at = from; at < items.length; at++) {
    const item = items[at];
    if (item.kind !== "tool" || item.parentToolUseId || !counts(item)) continue;
    if (item.name === "TodoWrite" && Array.isArray(item.input.todos)) {
      list = (item.input.todos as Record<string, unknown>[]).flatMap((todo, index) => {
        const subject = str(todo.content) ?? str(todo.subject);
        const status = asStatus(todo.status);
        if (!subject || !status || status === "deleted") return [];
        return [{ id: String(index + 1), subject, activeForm: str(todo.activeForm), status }];
      });
      list.forEach(remember);
    } else if (item.name === "TaskCreate") {
      const subject = str(item.input.subject) ?? str(item.input.description);
      if (!subject) continue;
      const id = /Task #(\d+)/.exec(item.output ?? "")?.[1] ?? `call:${item.id}`;
      const entry: TaskEntry = { id, subject, activeForm: str(item.input.activeForm), status: "pending" };
      list = [...list.filter((t) => t.id !== id), entry];
      remember(entry);
    } else if (item.name === "TaskUpdate") {
      const id = str(item.input.taskId) ?? (typeof item.input.taskId === "number" ? String(item.input.taskId) : null);
      if (!id) continue;
      const status = asStatus(item.input.status);
      if (status === "deleted") {
        list = list.filter((t) => t.id !== id);
        continue;
      }
      const known = list.find((t) => t.id === id);
      const subject = str(item.input.subject) ?? known?.subject ?? names.get(id) ?? `Task #${id}`;
      const next: TaskEntry = { id, subject, activeForm: str(item.input.activeForm) ?? known?.activeForm ?? null, status: status ?? known?.status ?? "pending" };
      list = known ? list.map((t) => (t.id === id ? next : t)) : [...list, next];
      remember(next);
    }
  }
  const done = list.filter((t) => t.status === "completed").length;
  return { list, done, total: list.length, current: list.find((t) => t.status === "in_progress") ?? null, names };
}

export type TaskStep = { verb: "added" | "started" | "completed" | "reset" | "removed" | "updated" | "list"; subject: string | null; status: TaskStatus | "deleted"; progress: string | null };

export function taskStep(item: ToolItem, state: TaskState): TaskStep {
  if (item.name === "TodoWrite") {
    const written = Array.isArray(item.input.todos) ? (item.input.todos as Record<string, unknown>[]) : [];
    const done = written.filter((t) => t.status === "completed").length;
    return { verb: "list", subject: null, status: "pending", progress: `${done}/${written.length}` };
  }
  if (item.name === "TaskCreate") return { verb: "added", subject: str(item.input.subject) ?? str(item.input.description), status: "pending", progress: null };
  const id = str(item.input.taskId) ?? (typeof item.input.taskId === "number" ? String(item.input.taskId) : "");
  const status = asStatus(item.input.status);
  const subject = str(item.input.subject) ?? state.names.get(id) ?? (id ? `#${id}` : null);
  const verb = status === "in_progress" ? "started" : status === "completed" ? "completed" : status === "pending" ? "reset" : status === "deleted" ? "removed" : "updated";
  return { verb, subject, status: status ?? "pending", progress: null };
}

export function taskRunView(timeline: readonly TimelineItem[] | undefined, run: readonly ToolItem[]): { verb: "added" | "updated"; done: number; total: number } {
  const last = run[run.length - 1];
  const at = (timeline ?? []).findIndex((i) => i.id === last?.id);
  const state = taskState(at === -1 ? timeline : (timeline ?? []).slice(0, at + 1));
  return { verb: run.every((i) => i.name === "TaskCreate") ? "added" : "updated", done: state.done, total: state.total };
}

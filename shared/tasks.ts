import type { TimelineItem } from "./protocol";
import { sharedPrefix } from "./sharedPrefix";

// 모델의 할 일 도구(TodoWrite, TaskCreate, TaskUpdate)를 타임라인에서 접어 최신 할 일 목록으로 만든다. React 와 서버 없이 시험한다(test/tasks.test.ts).
export type TaskStatus = "pending" | "in_progress" | "completed";
export type TaskEntry = { id: string; subject: string; activeForm: string | null; status: TaskStatus };
export type TaskState = { list: TaskEntry[]; done: number; total: number; current: TaskEntry | null; names: Map<string, string> };

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

export const TASK_TOOLS = ["TodoWrite", "TaskCreate", "TaskUpdate"] as const;
export const isTaskTool = (name: string) => (TASK_TOOLS as readonly string[]).includes(name);

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const asStatus = (value: unknown): TaskStatus | "deleted" | null => (value === "pending" || value === "in_progress" || value === "completed" || value === "deleted" ? value : null);

// 도구 호출이 끝나지 못한 것(실패, 중단)은 목록을 바꾸지 않는다. 아직 도는 호출은 바뀔 것으로 보고 반영한다(결과가 오기 전에도 목록이 보이게).
const counts = (item: ToolItem) => item.status !== "error" && !item.cancelled;

export function taskState(items: readonly TimelineItem[] | undefined): TaskState {
  return foldTasks([], new Map(), items ?? [], 0);
}

// 지난 배열과 지난 결과로 이어서 센다. 바뀐 첫 항목 뒤의 지난 항목에 할 일 호출이 없으면, 그 앞까지 접은 상태가 지난 결과와 같으므로 바뀐 곳부터만 접는다.
// 긴 대화에 응답이 흐를 때 이벤트마다 대화 전체를 다시 접던 비용이 바뀐 끝부분 몫으로 준다(PERF2). 그렇지 않으면(할 일 호출이 바뀜) 처음부터 접는다.
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
      // 번호는 도구 결과("Task #1 created successfully: ...")에 있다. 결과가 오기 전에는 호출 id 로 임시 번호를 둔다.
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

// 대화 속 한 줄: 도구 호출 하나를 사람이 읽는 동작으로 풀어 쓴다. 제목은 최신 목록에서 찾고(TaskUpdate 는 번호만 갖고 있다) 없으면 null.
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

// 연속된 할 일 호출 묶음을 한 줄로 접을 때의 요약: 묶음의 마지막 호출이 끝난 시점의 진행 수. 만들기만 있었으면 "added", 하나라도 바꿨으면 "updated".
export function taskRunView(timeline: readonly TimelineItem[] | undefined, run: readonly ToolItem[]): { verb: "added" | "updated"; done: number; total: number } {
  const last = run[run.length - 1];
  const at = (timeline ?? []).findIndex((i) => i.id === last?.id);
  const state = taskState(at === -1 ? timeline : (timeline ?? []).slice(0, at + 1));
  return { verb: run.every((i) => i.name === "TaskCreate") ? "added" : "updated", done: state.done, total: state.total };
}

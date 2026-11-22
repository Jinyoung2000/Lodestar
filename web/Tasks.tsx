import { useContext, useRef, useState } from "react";
import type { TimelineItem } from "../shared/protocol";
import { taskRunView, taskState, taskStateFrom, taskStep, type TaskEntry, type TaskState, type TaskStatus, type TaskStep } from "../shared/tasks";
import { sourcePart } from "../shared/toBoard";
import { AddToBoardButton } from "./AddToBoardButton";
import { TimelineContext } from "./Checkpoint";
import { ChevronRightCompact, Codicon, DotSpinner } from "./icons";
import { Popup } from "./Popup";
import { S } from "./strings";
import { sameFields, useStoreDerived } from "./useStoreDerived";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

export function TasksChip({ agentId }: { agentId: string }) {
  const state = useStoreDerived((s) => s.timelines[agentId], (items, prev) => taskStateOf(items, prev?.input), sameTaskState);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!state.total) return null;
  return (
    <>
      <button ref={ref} type="button" className="chip agents-chip tasks-chip" aria-haspopup="listbox" aria-expanded={open} aria-label={S.tasksListAria} title={state.current ? (state.current.activeForm ?? state.current.subject) : S.tasksProgress(state.done, state.total)} onClick={() => setOpen((v) => !v)}>
        {state.current ? <DotSpinner size={14} /> : <Codicon name={state.done === state.total ? "pass" : "tasklist"} size={14} />}
        <span className="chip-main">{S.tasksChip(state.done, state.total)}</span>
      </button>
      {open && (
        <Popup anchor={ref.current} placement="above" label={S.tasksListTitle} className="popup-agents popup-tasks" onClose={() => setOpen(false)}>
          <div className="popup-list" role="list">
            {state.list.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </Popup>
      )}
    </>
  );
}

const taskStates = new WeakMap<readonly TimelineItem[], TaskState>();
function taskStateOf(items: TimelineItem[] | undefined, prevItems?: TimelineItem[] | undefined): TaskState {
  if (!items) return taskState(items);
  let state = taskStates.get(items);
  if (state) return state;
  const base = prevItems ? taskStates.get(prevItems) : undefined;
  state = prevItems && base ? taskStateFrom(items, { input: prevItems, output: base }) : taskState(items);
  taskStates.set(items, state);
  return state;
}

function sameTaskState(a: TaskState, b: TaskState) {
  const sameTask = (x: TaskEntry | null, y: TaskEntry | null) => x === y || (!!x && !!y && sameFields(x, y));
  return a.done === b.done && a.total === b.total && sameTask(a.current, b.current) && a.list.length === b.list.length && a.list.every((task, i) => sameTask(task, b.list[i]));
}

function TaskRow({ task }: { task: TaskEntry }) {
  const label = `${task.subject}, ${S.taskStatus[task.status]}`;
  return (
    <div className="popup-row agent-row task-row" role="listitem" aria-label={label} title={label} data-status={task.status}>
      <span className="agent-row-icon">
        <TaskIcon status={task.status} />
      </span>
      <span className="popup-row-title task-row-title">{task.subject}</span>
    </div>
  );
}

function TaskIcon({ status }: { status: TaskStatus }) {
  if (status === "in_progress") return <DotSpinner size={14} />;
  return <Codicon name={status === "completed" ? "pass" : "circle-large-outline"} size={14} />;
}

export function TaskStepRow({ item }: { item: ToolItem }) {
  const { agentId } = useContext(TimelineContext);
  const step = useStoreDerived<TimelineItem[] | undefined, TaskStep>((s) => s.timelines[agentId], (items, prev) => taskStep(item, taskStateOf(items, prev?.input)), sameFields, [item]);
  const written = item.name === "TodoWrite" && Array.isArray(item.input.todos) ? (item.input.todos as Record<string, unknown>[]) : [];
  const failed = item.status === "error" && !item.cancelled;
  const dataStatus = failed || item.cancelled ? "error" : step.verb === "started" ? "running" : "done";
  const glyph = step.verb === "completed" ? "pass" : step.verb === "started" ? "circle-filled" : step.verb === "removed" ? "trash" : step.verb === "updated" || step.verb === "list" ? "tasklist" : "circle-large-outline";

  if (item.name === "TodoWrite") {
    return (
      <details className="step step-task" data-item-id={item.id} data-tool={item.name} data-status={dataStatus}>
        <summary>
          <span className="step-icon">
            <Codicon name={glyph} size={14} />
          </span>
          <span className="step-verb">{S.taskVerbs.list}</span>
          {step.progress && <span className="step-detail muted">{S.tasksCount(Number(step.progress.split("/")[0]), written.length)}</span>}
          <span className="step-chevron">
            <ChevronRightCompact size={12} />
          </span>
        </summary>
        <div className="step-tasks">
          {written.map((todo, index) => (
            <div key={index} className="step-task-line" data-status={String(todo.status)}>
              <TaskIcon status={todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending"} />
              <span className="step-task-subject">{String(todo.content ?? "")}</span>
              {!!String(todo.content ?? "").trim() && <AddToBoardButton agentId={agentId} itemId={item.id} text={String(todo.content)} part={sourcePart(String(todo.content))} kind="task" className="step-task-board" size={12} />}
            </div>
          ))}
        </div>
      </details>
    );
  }
  return (
    <div className="step step-task" data-item-id={item.id} data-tool={item.name} data-status={dataStatus}>
      <div className="step-line" data-status={dataStatus}>
        <span className="step-icon">
          <Codicon name={failed || item.cancelled ? "error" : glyph} size={14} />
        </span>
        <span className="step-verb">{S.taskVerbs[step.verb]}</span>
        {step.subject && <span className="step-detail muted">{step.subject}</span>}
        {failed && <span className="minus xs">{S.stepFailed}</span>}
        {!!step.subject && <AddToBoardButton agentId={agentId} itemId={item.id} text={step.subject} part={sourcePart(step.subject)} kind="task" className="step-task-board" size={12} />}
      </div>
    </div>
  );
}

export function TaskRunRow({ items: run }: { items: ToolItem[] }) {
  const { agentId } = useContext(TimelineContext);
  const view = useStoreDerived((s) => s.timelines[agentId], (timeline) => taskRunView(timeline, run), sameFields, [run]);
  const running = run.some((item) => item.status === "running");
  return (
    <details className="step step-task" data-tool="TaskRun" data-status={running ? "running" : "done"}>
      <summary>
        <span className="step-icon">
          <Codicon name={view.total > 0 && view.done === view.total ? "pass" : "tasklist"} size={14} />
        </span>
        <span className="step-verb">{view.verb === "added" ? S.taskVerbs.addedMany : S.taskVerbs.list}</span>
        {view.total > 0 && <span className="step-detail muted">{S.tasksCount(view.done, view.total)}</span>}
        <span className="step-chevron">
          <ChevronRightCompact size={12} />
        </span>
      </summary>
      <div className="step-tasks">
        {run.map((item) => (
          <TaskStepRow key={item.id} item={item} />
        ))}
      </div>
    </details>
  );
}

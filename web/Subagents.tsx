import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatTokens } from "../shared/contextUsage";
import type { SubagentTask, TimelineItem } from "../shared/protocol";
import { ASYNC_LAUNCH_PATTERN, cleanSubagentOutput, runningBackgroundFrom, subagentSteps, type ToolItem } from "../shared/subagents";
import { TimelineContext } from "./Checkpoint";
import { ChevronRightCompact, Codicon, DotSpinner } from "./icons";
import { Popup } from "./Popup";
import { useStore } from "./store";
import { S } from "./strings";
import type { PermissionItem, StepEntry } from "./timelineModel";
import { revealAllSteps } from "./timelineReveal";
import { sameArray, useStoreDerived } from "./useStoreDerived";

type AgentRenderers = { renderStep: (step: ToolItem) => ReactNode; renderText: (text: string) => ReactNode; renderActivity: (step: ToolItem) => ReactNode };

export function AgentGroup({ entries, ...renderers }: { entries: StepEntry[] } & AgentRenderers) {
  const tasks = entries.flatMap(({ item }) => (item.kind === "tool" && item.task ? [item.task] : []));
  const count = (status: SubagentTask["status"]) => tasks.filter((t) => t.status === status).length;
  return (
    <div className="agent-group">
      {entries.length > 1 && (
        <div className="agent-group-head">
          <Codicon name="robot" size={14} />
          <span>{S.agentsCount(entries.length, count("completed"), count("failed"), count("stopped"))}</span>
        </div>
      )}
      {entries.map(({ item, permission }) => (item.kind === "tool" ? <AgentStepRow key={item.id} item={item} permission={permission} {...renderers} /> : null))}
    </div>
  );
}

export function AgentStepRow({ item, permission, renderStep, renderText, renderActivity }: { item: ToolItem; permission: PermissionItem | null } & AgentRenderers) {
  const { agentId, revealAll } = useContext(TimelineContext);
  const steps = useStoreDerived((s) => s.timelines[agentId], (items) => subagentSteps(items, item.id), sameArray, [item.id]);
  const task = item.task!;
  const waiting = permission?.status === "pending";
  const denied = permission?.status === "denied";
  const running = task.status === "running" && !waiting && !denied;
  const elapsed = useElapsed(task, running);
  const tools = Math.max(task.toolUses, steps.length);
  const result = useMemo(() => (item.output && !ASYNC_LAUNCH_PATTERN.test(item.output) ? cleanSubagentOutput(item.output) : null), [item.output]);
  const summary = summaryOf(task);
  const body = summary && result?.text.split("\n")[0].trim().slice(0, 300) === summary ? result.text.split("\n").slice(1).join("\n").trim() : (result?.text ?? "");
  const [built, setBuilt] = useState(false);
  const showBody = built || revealAll;
  const state = denied ? "denied" : waiting ? "waiting" : task.status;
  const lastStep = steps.length ? steps[steps.length - 1] : null;
  const firstResultLine = (summary ?? result?.text.split("\n").find((line) => line.trim()) ?? "").replace(/\*\*|`/g, "");
  const preview =
    state === "denied" ? S.stepSkipped
    : state === "waiting" ? S.stepWaiting
    : state === "running" ? (lastStep ? renderActivity(lastStep) : (task.activity ?? S.subagentNoSteps))
    : state === "failed" ? (firstResultLine ? S.subagentFailedWith(firstResultLine) : S.subagentFailed)
    : state === "stopped" ? S.subagentStopped
    : firstResultLine || S.subagentRan;
  return (
    <details className="agent-run" onToggle={(e) => e.currentTarget.open && setBuilt(true)} data-tool={item.name} data-subagent={item.id} data-status={state}>
      <summary onClickCapture={() => setBuilt(true)}>
        <span className="agent-run-icon">{running || waiting ? <DotSpinner size={14} state={waiting ? "waiting" : "running"} /> : <Codicon name={STATUS_ICON[state] ?? "check"} size={14} />}</span>
        <span className="agent-run-main">
          <span className="agent-run-title">
            <span className="agent-run-name">{task.description}</span>
            {task.subagentType && <span className="agent-run-type">{task.subagentType}</span>}
            {task.backgrounded && running && <span className="agent-tag">{S.subagentBackground}</span>}
          </span>
          <span className="agent-run-preview">{preview}</span>
        </span>
        {!waiting && !denied && elapsed && <span className="agent-run-time">{elapsed}</span>}
        <span className="agent-run-chevron">
          <ChevronRightCompact size={12} />
        </span>
      </summary>
      {showBody && (
        <div className="agent-body">
          {steps.length === 0 && running && <div className="agent-empty faint xs">{task.activity ?? S.subagentNoSteps}</div>}
          {steps.map((step) => renderStep(step))}
          {summary && <div className="agent-summary">{renderText(summary)}</div>}
          {!!body && renderText(body)}
          {(tools > 0 || task.tokens > 0) && <div className="agent-stats">{S.subagentUsage(tools, formatTokens(task.tokens))}</div>}
        </div>
      )}
    </details>
  );
}

const STATUS_ICON: Record<string, string> = { completed: "check", failed: "error", stopped: "circle-slash", denied: "circle-slash" };

function summaryOf(task: SubagentTask) {
  return (task.summary ? cleanSubagentOutput(task.summary).text : "") || null;
}

function useElapsed(task: SubagentTask, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const ms = running ? Math.max(0, now - Date.parse(task.startedAt)) : task.durationMs;
  return ms > 0 ? formatDuration(ms) : "";
}

export function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function SubagentsChip({ agentId, paneId }: { agentId: string; paneId: string }) {
  const running = useStoreDerived((s) => s.timelines[agentId], runningBackgroundFrom, sameArray);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!running.length) return null;
  return (
    <>
      <button ref={ref} type="button" className="chip agents-chip" aria-haspopup="listbox" aria-expanded={open} aria-label={S.agentsListAria} onClick={() => setOpen((v) => !v)}>
        <DotSpinner size={14} />
        <span className="chip-main">{S.agentsRunning(running.length)}</span>
      </button>
      {open && <SubagentsList anchor={ref.current} agentId={agentId} paneId={paneId} onClose={() => setOpen(false)} />}
    </>
  );
}

function SubagentsList({ anchor, agentId, paneId, onClose }: { anchor: HTMLElement | null; agentId: string; paneId: string; onClose: () => void }) {
  const items = useStore((s) => s.timelines[agentId]) ?? NO_ITEMS;
  const rows = useMemo(() => {
    const all = items.filter((i): i is ToolItem => i.kind === "tool" && !!i.task && !i.parentToolUseId);
    const order = (t: ToolItem) => (t.task!.status === "running" ? 0 : 1);
    return all
      .map((t, index) => ({ t, index }))
      .sort((a, b) => order(a.t) - order(b.t) || b.index - a.index)
      .slice(0, 20)
      .map(({ t }) => t);
  }, [items]);
  return (
    <Popup anchor={anchor} placement="above" label={S.agentsListTitle} className="popup-agents" onClose={onClose}>
      <div className="popup-list" role="listbox">
        {rows.map((row) => (
          <AgentListRow
            key={row.id}
            item={row}
            onPick={() => {
              onClose();
              scrollToSubagent(paneId, row.id);
            }}
          />
        ))}
      </div>
    </Popup>
  );
}

function AgentListRow({ item, onPick }: { item: ToolItem; onPick: () => void }) {
  const task = item.task!;
  const running = task.status === "running";
  const elapsed = useElapsed(task, running);
  return (
    <div className="popup-row agent-row" role="option" aria-selected={false} title={S.agentsShowStep} onClick={onPick}>
      <span className="agent-row-icon">{running ? <DotSpinner size={14} /> : <Codicon name={task.status === "completed" ? "check" : "error"} size={14} />}</span>
      <span className="agent-row-text">
        <span className="popup-row-title">{task.description}</span>
        <span className="popup-row-detail agent-row-detail">{task.status === "running" ? (task.activity ?? S.subagentStats(task.toolUses, formatTokens(task.tokens), elapsed)) : (summaryOf(task)?.replace(/\*\*|`/g, "") ?? S.subagentStats(task.toolUses, formatTokens(task.tokens), elapsed))}</span>
      </span>
    </div>
  );
}

export function scrollToSubagent(paneId: string, toolId: string) {
  const find = () => {
    const pane = document.getElementById(`composer-${paneId}`)?.closest(".pane") ?? document;
    return pane.querySelector<HTMLDetailsElement>(`[data-subagent="${CSS.escape(toolId)}"]`);
  };
  const show = (row: HTMLDetailsElement) => {
    for (let el = row.parentElement; el; el = el.parentElement) if (el instanceof HTMLDetailsElement) el.open = true;
    row.open = true;
    row.scrollIntoView({ block: "center", behavior: "instant" });
    row.dataset.flash = "";
    window.setTimeout(() => delete row.dataset.flash, 1200);
  };
  if (!revealAllSteps(paneId)) {
    const row = find();
    if (row) show(row);
    return;
  }
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const row = find();
      if (row) show(row);
    }),
  );
}

const NO_ITEMS: TimelineItem[] = [];

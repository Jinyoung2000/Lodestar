import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatTokens } from "../shared/contextUsage";
import type { SubagentTask, TimelineItem } from "../shared/protocol";
import { ASYNC_LAUNCH_PATTERN, cleanSubagentOutput, runningBackgroundFrom, subagentSteps, type ToolItem } from "../shared/subagents";
import { TimelineContext } from "./Checkpoint";
import { ChevronRightCompact, Codicon, DotSpinner } from "./icons";
import { Popup } from "./Popup";
import { useStore } from "./store";
import { S } from "./strings";
import type { PermissionItem } from "./timelineModel";
import { revealAllSteps } from "./timelineReveal";
import { sameArray, useStoreDerived } from "./useStoreDerived";

// SUB: Agent(Task) 도구 호출 한 줄. 접힌 줄에는 이름, 상태, 도구 수와 토큰과 시간이 보이고, 펼치면 그 서브에이전트가 부른 도구가 실시간으로 쌓이는 단계 목록과 끝난 뒤 결과의 첫 줄이 보인다.
// renderStep 은 단계 한 줄을 그리는 Timeline 의 StepRow, renderText 는 결과 본문을 대화 본문과 같은 마크다운 경로로 그리는 Timeline 의 Markdown 이다(서로를 가져오지 않으려고 넘겨 받는다).
export function AgentStepRow({ item, permission, renderStep, renderText }: { item: ToolItem; permission: PermissionItem | null; renderStep: (step: ToolItem) => ReactNode; renderText: (text: string) => ReactNode }) {
  const { agentId, revealAll } = useContext(TimelineContext);
  const steps = useStoreDerived((s) => s.timelines[agentId], (items) => subagentSteps(items, item.id), sameArray, [item.id]);
  const task = item.task!;
  const waiting = permission?.status === "pending";
  const denied = permission?.status === "denied";
  const running = task.status === "running" && !waiting && !denied;
  const elapsed = useElapsed(task, running);
  const verb = denied ? S.stepSkipped : waiting ? S.verbsBase.Agent : task.status === "running" ? S.subagentRunning : task.status === "completed" ? S.subagentRan : task.status === "failed" ? S.subagentFailed : S.subagentStopped;
  const tools = Math.max(task.toolUses, steps.length);
  // 하네스가 붙인 안내 틀과 usage 태그는 걷고 결과 본문만 보인다. 요약 줄과 같은 글이면 한 번만 보인다.
  const result = useMemo(() => (item.output && !ASYNC_LAUNCH_PATTERN.test(item.output) ? cleanSubagentOutput(item.output) : null), [item.output]);
  const summary = summaryOf(task);
  // 요약은 결과의 첫 줄이라, 본문에서는 그 줄을 빼고 나머지만 보인다.
  const body = summary && result?.text.split("\n")[0].trim().slice(0, 300) === summary ? result.text.split("\n").slice(1).join("\n").trim() : (result?.text ?? "");
  const showOutput = !!body;
  // 접힌 줄은 열기 전에는 안쪽(서브에이전트가 부른 도구 수십~수백 줄)을 만들지 않는다. 한 번 만든 뒤에는 다시 접어도 남긴다. 어떤 길로 열려도(클릭, 찾기, 이동) 만든다.
  const [built, setBuilt] = useState(false);
  const showBody = built || revealAll;
  return (
    <details className="step step-agent" onToggle={(e) => e.currentTarget.open && setBuilt(true)} data-tool={item.name} data-subagent={item.id} data-status={denied ? "denied" : waiting ? "running" : task.status === "running" ? "running" : task.status === "completed" ? "done" : "error"}>
      <summary onClickCapture={() => setBuilt(true)}>
        <span className="step-icon">{running ? <DotSpinner size={14} /> : <Codicon name={task.status === "failed" || task.status === "stopped" || denied ? "error" : "robot"} size={14} />}</span>
        <span className="step-verb">{verb}</span>
        {!denied && <span className="step-detail agent-name">{task.description}</span>}
        {!denied && task.backgrounded && task.status === "running" && <span className="agent-tag">{S.subagentBackground}</span>}
        {waiting && <span className="faint xs">{S.stepWaiting}</span>}
        {!denied && !waiting && (tools > 0 || elapsed) && <span className="agent-stats faint xs">{S.subagentStats(tools, formatTokens(task.tokens), elapsed)}</span>}
        <span className="step-chevron">
          <ChevronRightCompact size={12} />
        </span>
      </summary>
      {showBody && (
        <div className="agent-body">
          {task.subagentType && (
            <div className="agent-meta faint xs">
              {task.subagentType}
              {running && task.activity ? `, ${task.activity}` : ""}
            </div>
          )}
          {steps.length === 0 && task.status === "running" && <div className="agent-empty faint xs">{S.subagentNoSteps}</div>}
          {steps.map((step) => renderStep(step))}
          {summary && <div className="agent-summary">{renderText(summary)}</div>}
          {showOutput && renderText(body)}
        </div>
      )}
    </details>
  );
}

// 옛 기록의 요약은 안내 틀의 첫 줄일 수 있어 걷어 낸다. 남는 것이 없으면 null.
function summaryOf(task: SubagentTask) {
  return (task.summary ? cleanSubagentOutput(task.summary).text : "") || null;
}

// 도는 동안은 1초마다 경과 시간을 다시 센다. 끝난 서브에이전트는 SDK 가 알려 준 시간을 쓴다.
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

// 입력창 위 칩 줄의 `N agents running`. 백그라운드로 도는 서브에이전트가 있을 때만 보이고, 누르면 이 세션의 서브에이전트 목록이 뜬다.
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
  // 도는 것이 먼저, 그다음은 최근 순. 한 세션에 여러 개가 쌓여도 목록이 길어지지 않게 20개까지.
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

// 목록의 행을 누르면 대화에서 그 서브에이전트의 줄로 간다: 접힌 단계 묶음을 열고, 줄을 펼치고, 가운데로 스크롤한 뒤 잠깐 강조한다.
// scrollIntoView 는 smooth 면 스크롤 컨테이너에서 조용히 취소되는 일이 있어 instant 로 한다.
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
  // 줄과 안쪽 줄이 모두 만들어진 뒤에 스크롤해야 접히지 않은 높이로 가운데에 맞는다. 접힌 단계 묶음이나 접힌 서브에이전트 줄은 안쪽이 아직 없으므로 칸의 묶음을 모두 만들게 하고 두 프레임 뒤에 찾는다.
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

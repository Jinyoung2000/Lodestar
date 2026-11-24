import { useMemo, type ReactNode } from "react";
import { followUpSections, lastActiveAt, type FinishedRow, type ProgressPhase, type ProgressRow } from "../shared/followups";
import type { Agent } from "../shared/protocol";
import { FollowUpDecision } from "./FollowUpDecision";
import { checkFollowUps, keepSessionOpen, markSessionsDone, openFollowUpSession } from "./followUpActions";
import { agoText, cardKeyOf, workspaceNameOf } from "./followUpsModel";
import { Codicon, DotSpinner } from "./icons";
import { useNow } from "./PrBits";
import { useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import "./automations.css";
import "./followups.css";

const F = S.followUp;
const NOTHING = { items: [], notes: [] };
const activeText = (agent: Agent, now: number) => F.active(agoText(new Date(lastActiveAt(agent)).toISOString(), now));

export function FollowUpsView() {
  const state = useStore((s) => s.followUps);
  const agents = useStore((s) => s.agents);
  const workspaces = useStore((s) => s.workspaces);
  const board = useStore((s) => s.board);
  const now = useNow();
  const sections = useMemo(() => followUpSections(agents, state ?? NOTHING, now), [agents, state, now]);
  const workspace = (agent: Agent) => workspaceNameOf(workspaces, agent.workspaceId);
  const nothing = sections.decisions.length === 0 && sections.progress.length === 0 && sections.finished.length === 0;
  const checking = state?.checking === true;
  const snoozed = sections.decisions.filter((row) => row.snoozed).length;

  return (
    <section className="followups" aria-label={S.followUps}>
      <div className="pane-header followups-header">
        <h1 className="followups-heading">{S.followUps}</h1>
        <span className="spacer" />
        <span className="followups-checked">{state?.checkedAt ? F.checked(agoText(state.checkedAt, now)) : F.neverChecked}</span>
        <Button variant="secondary" disabled={!state || checking} onClick={checkFollowUps}>
          <Codicon name="refresh" size={14} spin={checking} />
          {checking ? F.checking : F.checkNow}
        </Button>
      </div>
      <div className="followups-body">
        {state?.error && (
          <p className="followups-error" role="alert">
            {state.error}
          </p>
        )}
        {nothing && <p className="followups-empty">{F.empty}</p>}
        {sections.decisions.length > 0 && (
          <Group title={F.sections.decisions} count={sections.decisions.length - snoozed} note={snoozed > 0 ? F.snoozedCount(snoozed) : null}>
            {sections.decisions.map((row) => (
              <FollowUpDecision key={row.item.id} row={row} workspace={workspace(row.agent)} now={now} />
            ))}
          </Group>
        )}
        {sections.progress.length > 0 && (
          <Group title={F.sections.progress} count={sections.progress.length}>
            {sections.progress.map((row) => (
              <ProgressItem key={row.agent.id} row={row} workspace={workspace(row.agent)} cardKey={cardKeyOf(board, row.agent.id)} now={now} />
            ))}
          </Group>
        )}
        {sections.finished.length > 0 && (
          <Group title={F.sections.finished} count={sections.finished.length}>
            {sections.finished.map((row) => (
              <FinishedItem key={row.agent.id} row={row} workspace={workspace(row.agent)} />
            ))}
          </Group>
        )}
      </div>
    </section>
  );
}

type GroupProps = { title: string; count: number; note?: string | null; children: ReactNode };

function Group({ title, count, note, children }: GroupProps) {
  return (
    <section className="followups-group">
      <div className="followups-group-head">
        <span className="followup-glyph" />
        <h2 className="followups-group-title">
          <span>{title}</span>
          <span className="followups-count">{count}</span>
          {note && <span className="session-separator" aria-hidden="true" />}
          {note && <span className="followups-count">{note}</span>}
        </h2>
      </div>
      <ul className="followups-list">{children}</ul>
    </section>
  );
}

const PHASE_ICON: Record<Exclude<ProgressPhase, "working">, string> = { paused: "debug-pause", error: "error" };

type ProgressItemProps = { row: ProgressRow; workspace: string; cardKey: string | null; now: number };

function ProgressItem({ row, workspace, cardKey, now }: ProgressItemProps) {
  const { agent, phase, text } = row;
  return (
    <li className="followup-row" data-kind="progress" data-phase={phase}>
      <span className="followup-glyph">{phase === "working" ? <DotSpinner state="running" /> : <Codicon name={PHASE_ICON[phase]} />}</span>
      <button type="button" className="followup-main" title={workspace || undefined} onClick={() => openFollowUpSession(agent.id)}>
        <span className="followup-title">{agent.title}</span>
        {text && <span className="followup-note">{text}</span>}
      </button>
      <div className="followup-state">
        <span className="followup-phase">{F.phases[phase]}</span>
        {phase !== "working" && <span className="session-separator" aria-hidden="true" />}
        {phase !== "working" && <span>{activeText(agent, now)}</span>}
        {cardKey && <span className="session-separator" aria-hidden="true" />}
        {cardKey && <span>{cardKey}</span>}
      </div>
    </li>
  );
}

type FinishedItemProps = { row: FinishedRow; workspace: string };

function FinishedItem({ row, workspace }: FinishedItemProps) {
  const { agent, text } = row;
  return (
    <li className="followup-row" data-kind="finished">
      <span className="followup-glyph">
        <Codicon name="check" />
      </span>
      <button type="button" className="followup-main" title={workspace || undefined} onClick={() => openFollowUpSession(agent.id)}>
        <span className="followup-title">{agent.title}</span>
        {text && <span className="followup-note">{text}</span>}
      </button>
      <div className="followup-actions">
        <Button className="followup-swap" aria-label={F.keepOpenAria(agent.title)} title={F.keepOpen} onClick={() => keepSessionOpen(agent.id)}>
          <Codicon name="close" size={14} className="followup-swap-icon" />
          <span className="followup-swap-label">{F.keepOpen}</span>
        </Button>
        <Button variant="secondary" aria-label={F.markDoneAria(agent.title)} onClick={() => markSessionsDone([agent.id])}>
          {F.markDone}
        </Button>
      </div>
    </li>
  );
}

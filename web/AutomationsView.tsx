import { useMemo } from "react";
import { isActiveRun } from "../shared/automations";
import { AutomationDetail } from "./AutomationDetail";
import { openRunSession, runAutomationNow, setAutomationEnabled } from "./automationActions";
import { automationRows, lastRunLine, phaseWord, scheduleLabel, type AutomationRow } from "./automationModel";
import { AutomationGlyph } from "./AutomationGlyph";
import { Codicon } from "./icons";
import { useNow } from "./PrBits";
import { openAutomation, openAutomationEditor, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import "./automations.css";

const A = S.automation;

export function AutomationsView() {
  const state = useStore((s) => s.automations);
  const selectedId = useStore((s) => s.selectedAutomationId);
  const now = new Date(useNow());
  const rows = useMemo(() => automationRows(state?.automations ?? [], state?.runs ?? []), [state]);
  const selected = rows.find((row) => row.automation.id === selectedId) ?? null;

  if (rows.length === 0) {
    return (
      <section className="automations" aria-label={S.automations}>
        <div className="pane-header automations-header">
          <h1 className="automations-heading">{S.automations}</h1>
        </div>
        <div className="automations-empty">
          <span className="automations-empty-text">{A.empty}</span>
          <Button variant="primary" onClick={() => openAutomationEditor({ mode: "create" })}>
            <Codicon name="add" size={14} />
            {A.newTitle}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <div className="split-view">
      <section className="automations" aria-label={S.automations}>
        <div className="pane-header automations-header">
          <h1 className="automations-heading">{S.automations}</h1>
          <span className="spacer" />
          <Button variant="secondary" onClick={() => openAutomationEditor({ mode: "create" })}>
            <Codicon name="add" size={14} />
            {A.newTitle}
          </Button>
        </div>
        <ul className="automations-list" aria-label={A.listAria}>
          {rows.map((row) => (
            <AutomationListRow key={row.automation.id} row={row} selected={row.automation.id === selectedId} now={now} />
          ))}
        </ul>
      </section>
      {selected && <AutomationDetail row={selected} runs={state?.runs ?? []} now={now} />}
    </div>
  );
}

type AutomationListRowProps = { row: AutomationRow; selected: boolean; now: Date };

function AutomationListRow({ row, selected, now }: AutomationListRowProps) {
  const { automation, latest, phase } = row;
  const busy = !!latest && isActiveRun(latest);
  const meta = lastRunLine(row, now);
  const sessionId = latest?.agentId ?? null;
  const hasSession = useStore((s) => !!sessionId && s.agents.some((a) => a.id === sessionId));
  return (
    <li className="automation-row" data-phase={phase} aria-current={selected || undefined}>
      <span className="automation-glyph">
        <AutomationGlyph phase={phase} />
      </span>
      <button type="button" className="automation-main" onClick={() => openAutomation(selected ? null : automation.id)}>
        <span className="automation-title">{automation.title}</span>
        <span className="automation-schedule">{scheduleLabel(automation.schedule)}</span>
      </button>
      <div className="automation-state">
        <span className="automation-phase" data-phase={phase}>
          {phaseWord(row, now)}
        </span>
        {meta && (
          <span className="automation-meta">
            <span>{meta}</span>
            {hasSession && (
              <>
                <span className="session-separator" aria-hidden="true" />
                <button type="button" className="automation-link" onClick={() => openRunSession(sessionId)}>
                  {A.openSession}
                </button>
              </>
            )}
          </span>
        )}
        {phase === "failed" && latest?.error && (
          <span className="automation-error" title={latest.error}>
            {latest.error}
          </span>
        )}
      </div>
      <div className="automation-actions">
        <Button aria-label={A.runNowAria(automation.title)} disabled={busy} onClick={() => runAutomationNow(automation.id)}>
          <Codicon name="play" size={14} />
          {A.runNow}
        </Button>
        <Switch checked={automation.enabled} aria-label={A.enableAria(automation.title)} onCheckedChange={(enabled) => setAutomationEnabled(automation.id, enabled)} />
      </div>
    </li>
  );
}

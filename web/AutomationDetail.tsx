import type { AutomationRun } from "../shared/automations";
import { deleteAutomation, openRunSession } from "./automationActions";
import { runTimeLabel, scheduleLabel, sessionSummary, type AutomationRow } from "./automationModel";
import { AutomationGlyph } from "./AutomationGlyph";
import { Codicon } from "./icons";
import { openAutomation, openAutomationEditor, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

const A = S.automation;

type AutomationDetailProps = { row: AutomationRow; runs: AutomationRun[]; now: Date };

export function AutomationDetail({ row, runs, now }: AutomationDetailProps) {
  const { automation } = row;
  const workspaces = useStore((s) => s.workspaces);
  const agents = useStore((s) => s.agents);
  const models = useStore((s) => s.meta?.models ?? []);
  const history = runs.filter((run) => run.automationId === automation.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const modelName = automation.model ? (models.find((m) => m.value === automation.model)?.displayName ?? automation.model) : A.defaultModel;
  const model = automation.effort ? A.modelEffort(modelName, S.effortNames[automation.effort]) : modelName;
  const fixedSession = automation.target.kind === "session";
  return (
    <section className="automation-detail" aria-label={automation.title}>
      <div className="pane-header automation-detail-header">
        <h2 className="automation-detail-title">{automation.title}</h2>
        <Button onClick={() => openAutomationEditor({ mode: "edit", id: automation.id })}>
          <Codicon name="edit" size={14} />
          {A.edit}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" aria-label={A.more}>
              <Codicon name="ellipsis" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem danger onSelect={() => void deleteAutomation(automation)}>
              {A.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" aria-label={A.close} onClick={() => openAutomation(null)}>
          <Codicon name="close" size={14} />
        </Button>
      </div>
      <div className="automation-detail-body">
        <div className="automation-summary">
          <p className="automation-prompt">{automation.prompt}</p>
          <dl className="automation-facts">
            <dt>{A.schedule}</dt>
            <dd>{scheduleLabel(automation.schedule)}</dd>
            <dt>{A.session}</dt>
            <dd>{sessionSummary(automation, workspaces, agents)}</dd>
            {!fixedSession && (
              <>
                <dt>{A.model}</dt>
                <dd>{model}</dd>
                <dt>{A.permission}</dt>
                <dd>{S.permissionModes[automation.permissionMode]}</dd>
              </>
            )}
          </dl>
        </div>
        <div className="automation-history">
          <h3 className="automation-history-title">{A.runHistory}</h3>
          {history.length === 0 && <div className="automation-history-empty">{A.noRuns}</div>}
          <ul className="automation-runs">
            {history.map((run) => (
              <RunRow key={run.id} run={run} now={now} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function RunRow({ run, now }: { run: AutomationRun; now: Date }) {
  const hasSession = useStore((s) => !!run.agentId && s.agents.some((a) => a.id === run.agentId));
  const quiet = run.status === "skipped";
  return (
    <li className="automation-run" data-status={run.status}>
      <span className="automation-run-glyph">
        <AutomationGlyph status={run.status} />
      </span>
      <span className="automation-run-time">{runTimeLabel(run.startedAt, now)}</span>
      <span className="automation-run-trigger">{A.trigger[run.trigger]}</span>
      <span className="automation-run-result" data-quiet={quiet || undefined}>
        {A.result[run.status]}
      </span>
      {hasSession ? (
        <Button size="icon" aria-label={A.openSession} onClick={() => openRunSession(run.agentId)}>
          <Codicon name="arrow-right" />
        </Button>
      ) : (
        <span />
      )}
      {run.error && (run.status === "failed" || run.status === "skipped") && <span className="automation-run-error">{run.error}</span>}
    </li>
  );
}

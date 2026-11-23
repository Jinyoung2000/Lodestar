import type { AutomationPhase, AutomationRunStatus } from "../shared/automations";
import { Codicon, DotSpinner } from "./icons";

type AutomationGlyphProps = { phase?: AutomationPhase; status?: AutomationRunStatus };

const ICONS: Partial<Record<AutomationPhase | AutomationRunStatus, string>> = {
  failed: "error",
  paused: "debug-pause",
  scheduled: "watch",
  idle: "watch",
  succeeded: "check",
  skipped: "circle-slash",
};

export function AutomationGlyph({ phase, status }: AutomationGlyphProps) {
  const kind = status ?? phase ?? "idle";
  if (kind === "running") return <DotSpinner state="running" />;
  if (kind === "needsInput") return <DotSpinner state="waiting" />;
  return (
    <span className="automation-icon" data-kind={kind}>
      <Codicon name={ICONS[kind] ?? "watch"} />
    </span>
  );
}

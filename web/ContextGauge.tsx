import type { Agent, ContextUsage } from "../shared/protocol";
import { contextLevel, contextPercent, contextRatio, formatTokens } from "../shared/contextUsage";
import { rpc } from "./rpc";
import { flash } from "./store";
import { S } from "./strings";

export function ContextGauge({ agent, busy }: { agent: Agent; busy: boolean }) {
  const usage = agent.contextUsage;
  if (!usage) return null;
  const percent = contextPercent(usage);
  const level = contextLevel(usage);
  return (
    <span className="context-gauge-wrap">
      <button type="button" className="chip context-gauge" data-chip data-level={level} aria-label={S.contextAria(percent)}>
        <GaugeRing usage={usage} />
        <span className="context-gauge-percent">{percent}%</span>
      </button>
      <div className="context-card" role="tooltip" data-level={level}>
        <div className="context-card-head">{S.contextTitle}</div>
        <div className="context-card-row">
          <span>{S.contextTokens(formatTokens(usage.used), formatTokens(usage.limit))}</span>
          <span className="context-card-percent">{percent}%</span>
        </div>
        <div className="context-card-bar">
          <span className="context-card-fill" style={{ width: `${Math.min(100, contextRatio(usage) * 100)}%` }} />
        </div>
        {level !== "ok" && <div className="context-card-note">{S.contextDecline}</div>}
        <div className="context-card-note faint">{S.contextAutoCompact}</div>
        {usage.source === "estimate" && <div className="context-card-note faint">{S.contextEstimate}</div>}
        <button type="button" className="context-card-action" disabled={busy} title={busy ? S.contextCompactBusy : undefined} onClick={() => void compact(agent.id)}>
          {S.contextCompact}
        </button>
      </div>
    </span>
  );
}

// 압축은 슬래시 명령이라 보통 메시지로 보낸다. 응답 중이면 버튼이 막혀 있다.
function compact(agentId: string) {
  return rpc.call("agents.send", { agentId, prompt: "/compact" }).catch((error: Error) => flash(error.message));
}

const RADIUS = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function GaugeRing({ usage }: { usage: ContextUsage }) {
  const filled = Math.max(0, Math.min(1, contextRatio(usage)));
  return (
    <svg className="context-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle className="context-ring-bg" cx="18" cy="18" r={RADIUS} />
      <circle className="context-ring-arc" cx="18" cy="18" r={RADIUS} strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - filled)} />
    </svg>
  );
}

import { useEffect, useState } from "react";
import type { Agent } from "../shared/protocol";
import { Codicon } from "./icons";
import { rpc } from "./rpc";
import { S } from "./strings";

export function ImportedMark() {
  return (
    <span className="session-source" title={S.importedTooltip} role="img" aria-label={S.importedIconAria} data-imported-mark>
      <Codicon name="code-oss" size={12} />
    </span>
  );
}

export function ImportedNotice({ agent }: { agent: Agent }) {
  const active = useVscodeActivity(agent.id, !!agent.imported);
  if (!active) return null;
  return (
    <div className="import-notice" role="status" data-testid="import-notice">
      <Codicon name="code-oss" size={12} />
      <span>{S.importActivityNotice}</span>
    </div>
  );
}

// 몇 초마다 데몬에 묻는다. 창이 가려져 있으면 묻지 않는다.
function useVscodeActivity(agentId: string, enabled: boolean) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setActive(false);
      return;
    }
    let cancelled = false;
    const poll = () => {
      if (document.hidden) return;
      void rpc
        .call("import.activity", { agentId })
        .then((value) => !cancelled && setActive(value.active))
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentId, enabled]);
  return active;
}

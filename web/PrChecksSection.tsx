import "./pr.css";
import { useEffect, useState } from "react";
import type { Agent } from "../shared/protocol";
import type { PrDetail } from "../shared/prTypes";
import { CheckIcon, PrStateIcon } from "./PrBits";
import { formatDuration, sortChecks, summarizeChecks } from "./prChecks";
import { openPrBeside, prRefOfUrl } from "./prStore";
import { P } from "./prStrings";
import { rpc } from "./rpc";
import { useStore } from "./store";

const REFRESH_MS = 60_000;

export function PrChecksSection({ agent }: { agent: Agent }) {
  const prs = useStore((s) => s.prs[agent.id]);
  const branch = useStore((s) => s.gitInfo[agent.id]?.branch ?? null);
  const pr = prs?.prs.find((p) => p.state === "OPEN") ?? prs?.prs[0] ?? null;
  const ref = pr ? prRefOfUrl(pr.url) : null;
  const key = ref ? `${ref.repo}#${ref.number}` : null;
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!ref) return;
    let cancelled = false;
    const load = () =>
      rpc.call("pr.get", ref).then(
        (next) => !cancelled && setDetail(next),
        (e: Error) => !cancelled && setError(e.message),
      );
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (prs?.available === false) return <div className="pr-checks-note" title={prs.reason ?? ""}>{prs.reason}</div>;
  if (!pr || !ref) return <div className="pr-checks-note">{branch ? P.noPrForBranch(branch) : P.noPullRequest}</div>;

  const checks = detail ? sortChecks(detail.checkList) : [];
  return (
    <div className="pr-checks">
      <button type="button" className="pr-checks-pr" title={P.openPrTip(pr.number)} onClick={() => openPrBeside(ref.repo, ref.number, { agentId: agent.id })}>
        <PrStateIcon pr={{ state: pr.state === "MERGED" ? "MERGED" : pr.state === "CLOSED" ? "CLOSED" : "OPEN", isDraft: detail?.isDraft ?? false }} />
        <span className="pr-checks-title">{pr.title}</span>
        <span className="pr-faint">#{pr.number}</span>
      </button>
      {branch && <div className="pr-checks-branch">{P.prForBranch(branch)}</div>}
      {!detail && !error && <div className="pr-checks-note">{P.loading}</div>}
      {error && <div className="pr-checks-note" title={error}>{error}</div>}
      {detail && checks.length === 0 && <div className="pr-checks-note">{P.noChecks}</div>}
      {detail && checks.length > 0 && <div className="pr-checks-summary">{summarizeChecks(checks)}</div>}
      {checks.map((check) => (
        <button key={check.name} type="button" className="pr-check-line" disabled={!check.url} title={check.url ? P.openCheckTip(check.name) : check.name} onClick={() => check.url && window.open(check.url, "_blank", "noreferrer")}>
          <CheckIcon kind={check.state} />
          <span className="pr-check-line-name">{check.name}</span>
          <span className="pr-faint">{check.state === "pending" ? check.detail : formatDuration(check.durationMs)}</span>
        </button>
      ))}
    </div>
  );
}

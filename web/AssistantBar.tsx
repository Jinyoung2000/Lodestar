import { useMemo } from "react";
import { openDecisionCount } from "../shared/followups";
import type { Agent } from "../shared/protocol";
import { agoText } from "./followUpsModel";
import { Codicon } from "./icons";
import { useNow } from "./PrBits";
import { rpc } from "./rpc";
import { flash, openFollowUps, setState, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

const A = S.assistant;
const fail = (error: unknown) => flash(A.failed(error instanceof Error ? error.message : String(error)));

export function AssistantStatus() {
  const state = useStore((s) => s.assistant);
  const now = useNow();
  if (!state) return null;
  const last = state.lastCheckIn;
  const text = state.busy ? A.checkingIn : last ? (last.spoke ? A.checkedIn(agoText(last.at, now)) : A.checkedInQuiet(agoText(last.at, now))) : null;
  return text ? <span className="muted small assistant-status">{text}</span> : null;
}

type AssistantActionsProps = { agent: Agent };

export function AssistantActions({ agent }: AssistantActionsProps) {
  const busy = useStore((s) => s.assistant?.busy === true);
  const items = useStore((s) => s.followUps?.items);
  const agents = useStore((s) => s.agents);
  const waiting = useMemo(() => (items ? openDecisionCount(agents, items, Date.now()) : 0), [agents, items]);
  const checkIn = () => {
    void rpc
      .call("assistant.checkIn", {})
      .then((assistant) => setState({ assistant }))
      .catch(fail);
  };
  return (
    <>
      <button type="button" className="chip" title={A.trackingTitle} onClick={openFollowUps}>
        <Codicon name="checklist" size={14} />
        <span className="chip-main assistant-label">{A.tracking}</span>
        {waiting > 0 && <span>{waiting}</span>}
      </button>
      <button type="button" className="chip" title={A.notesTitle} onClick={() => void rpc.call("assistant.openNotes", {}).catch(fail)}>
        <Codicon name="note" size={14} />
        <span className="chip-main assistant-label">{A.notes}</span>
      </button>
      <Button variant="secondary" className="assistant-checkin" aria-label={A.checkInNow} title={A.checkInNow} disabled={busy || agent.status !== "idle"} onClick={checkIn}>
        <Codicon name="refresh" size={14} spin={busy} />
        <span className="assistant-label">{A.checkInNow}</span>
      </Button>
    </>
  );
}

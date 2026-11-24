import { useMemo, useState, type KeyboardEvent } from "react";
import { mateFeed, type AssistantState } from "../shared/assistant";
import type { Agent } from "../shared/protocol";
import { agoText } from "./followUpsModel";
import { Codicon } from "./icons";
import { checkInMate, openMateSession, sendToMate, stopMate } from "./mateActions";
import { MateFeed } from "./MateFeed";
import { MatePanel } from "./MatePanel";
import { useNow } from "./PrBits";
import { useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import "./mate.css";

const A = S.assistant;
const NO_ITEMS: never[] = [];

export function MateView() {
  const state = useStore((s) => s.assistant);
  const agent = useStore((s) => s.agents.find((a) => a.id === s.assistant?.agentId) ?? null);
  if (!state || !agent) {
    return (
      <section className="mate" aria-label={A.name}>
        <p className="mate-empty">{A.unavailable}</p>
      </section>
    );
  }
  return (
    <div className="mate">
      <MateChat agent={agent} state={state} />
      <MatePanel state={state} />
    </div>
  );
}

type MateChatProps = { agent: Agent; state: AssistantState };

function MateChat({ agent, state }: MateChatProps) {
  const items = useStore((s) => s.timelines[agent.id]) ?? NO_ITEMS;
  const open = useStore((s) => s.followUps?.items) ?? NO_ITEMS;
  const now = useNow();
  const entries = useMemo(() => mateFeed({ items, checkIns: state.checkIns, followUps: open, status: agent.status, now }), [items, state.checkIns, open, agent.status, now]);
  const busy = agent.status === "running" || agent.status === "waiting";
  const last = state.lastCheckIn;
  const status = state.busy ? A.checkingIn : agent.status === "running" ? A.working : agent.status === "waiting" ? S.status.waiting : last ? (last.spoke ? A.checkedIn(agoText(last.at, now)) : A.checkedInQuiet(agoText(last.at, now))) : A.idle;
  return (
    <section className="mate-chat" aria-label={A.name}>
      <header className="mate-head">
        <span />
        <div className="mate-identity">
          <span className="mate-avatar" data-busy={busy || undefined}>
            <Codicon name="compass" size={20} />
          </span>
          <h1 className="mate-name">{agent.title}</h1>
          <span className="mate-status">{status}</span>
        </div>
        <div className="mate-head-actions">
          <Button size="icon" aria-label={A.checkInNow} disabled={state.busy || agent.status !== "idle"} onClick={checkInMate}>
            <Codicon name="refresh" spin={state.busy} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" aria-label={A.more}>
                <Codicon name="ellipsis" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={openMateSession}>{A.openAsSession}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <MateFeed agentId={agent.id} entries={entries} />
      <MateComposer agentId={agent.id} running={agent.status === "running"} />
    </section>
  );
}

type MateComposerProps = { agentId: string; running: boolean };

function MateComposer({ agentId, running }: MateComposerProps) {
  const [draft, setDraft] = useState("");
  const send = () => {
    const text = draft;
    if (!text.trim()) return;
    setDraft("");
    void sendToMate(text).then((sent) => {
      if (!sent) setDraft((current) => current || text);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };
  return (
    <form
      className="mate-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea className="mate-input" rows={1} value={draft} placeholder={A.placeholder} aria-label={A.placeholder} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
      {running && !draft.trim() ? (
        <Button size="icon" aria-label={A.stop} onClick={() => stopMate(agentId)}>
          <Codicon name="debug-stop" />
        </Button>
      ) : (
        <Button type="submit" variant="primary" size="icon" aria-label={A.send} disabled={!draft.trim()}>
          <Codicon name="arrow-up" />
        </Button>
      )}
    </form>
  );
}

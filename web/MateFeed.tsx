import { useState } from "react";
import { clockText, type MateEntry } from "../shared/assistant";
import { SNOOZE_CHOICES, type FollowUpItem } from "../shared/followups";
import { dismissFollowUp, itemText, openFollowUpSession, replyToFollowUp, snoozeFollowUp } from "./followUpActions";
import { ageText, workspaceNameOf } from "./followUpsModel";
import { DotSpinner } from "./icons";
import { openMateSession, respondToMate } from "./mateActions";
import { useNow } from "./PrBits";
import { flash, useStore } from "./store";
import { S } from "./strings";
import { Markdown } from "./Timeline";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

const A = S.assistant;

type MateFeedProps = { agentId: string; entries: MateEntry[] };

export function MateFeed({ agentId, entries }: MateFeedProps) {
  return (
    <div className="mate-feed" aria-label={A.feedAria}>
      <div className="mate-feed-inner">
        {entries.map((entry) => (
          <Entry key={entry.id} agentId={agentId} entry={entry} />
        ))}
      </div>
    </div>
  );
}

type EntryProps = { agentId: string; entry: MateEntry };

function Entry({ agentId, entry }: EntryProps) {
  switch (entry.kind) {
    case "checkIn":
      return <div className="mate-checkin">{A.checkInLine(entry.at ? clockText(new Date(entry.at)) : "")}</div>;
    case "mate":
      return (
        <div className="mate-bubble" data-from="mate">
          <Markdown className="row-assistant" text={entry.text} itemId={entry.id} breaks />
        </div>
      );
    case "user":
      return (
        <div className="mate-bubble" data-from="user">
          {entry.text}
        </div>
      );
    case "decisions":
      return (
        <>
          {entry.items.map((item) => (
            <DecisionCard key={item.id} item={item} />
          ))}
        </>
      );
    case "approval":
      return (
        <div className="mate-card" role="group" aria-label={entry.approval?.title ?? A.approvalFallback(entry.item.toolName)}>
          <div className="mate-card-title">{entry.approval?.title ?? A.approvalFallback(entry.item.toolName)}</div>
          {(entry.approval?.message || typeof entry.item.input.command === "string") && <div className="mate-card-text">{entry.approval?.message || String(entry.item.input.command)}</div>}
          <div className="mate-card-actions">
            <Button variant="primary" size="default" onClick={() => respondToMate(agentId, entry.item.id, "allow")}>
              {A.allow}
            </Button>
            <Button variant="secondary" size="default" onClick={() => respondToMate(agentId, entry.item.id, "deny")}>
              {A.skip}
            </Button>
          </div>
        </div>
      );
    case "question":
      return (
        <div className="mate-card">
          <div className="mate-card-text">{A.answerInSession}</div>
          <div className="mate-card-actions">
            <Button variant="secondary" onClick={openMateSession}>
              {A.openAsSession}
            </Button>
          </div>
        </div>
      );
    case "working":
      return (
        <div className="mate-working">
          <DotSpinner state="running" />
          <span>{A.working}</span>
        </div>
      );
    case "error":
      return (
        <div className="mate-error" role="alert">
          {entry.text}
        </div>
      );
  }
}

type DecisionCardProps = { item: FollowUpItem };

function DecisionCard({ item }: DecisionCardProps) {
  const agent = useStore((s) => s.agents.find((a) => a.id === item.agentId) ?? null);
  const workspace = useStore((s) => workspaceNameOf(s.workspaces, agent?.workspaceId ?? null));
  const now = useNow();
  const [sending, setSending] = useState(false);
  if (!agent) return null;
  const openSession = () => openFollowUpSession(agent.id);
  const choose = async (option: string) => {
    if (item.kind !== "ask") return openSession();
    if (sending) return;
    setSending(true);
    const sent = await replyToFollowUp(item, option);
    setSending(false);
    if (sent) flash(A.sentTo(option, agent.title));
  };
  return (
    <div className="mate-card" role="group" aria-label={agent.title}>
      <button type="button" className="mate-card-meta" title={A.openSession} onClick={openSession}>
        <span className="mate-card-session">{agent.title}</span>
        {workspace && <span className="session-separator" aria-hidden="true" />}
        {workspace && <span>{workspace}</span>}
        <span className="session-separator" aria-hidden="true" />
        <span>{A.waitingFor(ageText(item.since, now))}</span>
      </button>
      <div className="mate-card-text">{itemText(item)}</div>
      <div className="mate-card-actions">
        {item.options.map((option) => (
          <Button key={option} variant="secondary" className="mate-choice" disabled={sending} onClick={() => void choose(option)}>
            {option}
          </Button>
        ))}
        {item.options.length === 0 && (
          <Button variant="secondary" onClick={openSession}>
            {A.openSession}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>{A.later}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SNOOZE_CHOICES.map((choice) => (
              <DropdownMenuItem key={choice} onSelect={() => snoozeFollowUp(item.id, choice)}>
                {S.followUp.snooze[choice]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button onClick={() => dismissFollowUp(item.id)}>{A.notNeeded}</Button>
      </div>
    </div>
  );
}

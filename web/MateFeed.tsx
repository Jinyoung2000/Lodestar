import { useMemo, useState } from "react";
import { clockText, mateActionView, type AssistantAction, type AssistantApproval, type MateEntry } from "../shared/assistant";
import { reviewFollowUpLabel } from "../shared/mateCore";
import { SNOOZE_CHOICES, type FollowUpItem } from "../shared/followups";
import { dismissFollowUp, itemText, openFollowUpSession, replyToFollowUp, snoozeFollowUp } from "./followUpActions";
import { ageText, workspaceNameOf } from "./followUpsModel";
import { Codicon, DotSpinner } from "./icons";
import { respondToMate, undoMateAction } from "./mateActions";
import { useNow } from "./PrBits";
import { flash, useStore } from "./store";
import { S } from "./strings";
import { ApprovalCard } from "./Approval";
import { Markdown } from "./Timeline";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

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
      return <DecisionStack items={entry.items} />;
    case "approval":
      if (entry.approval) return <MateApprovalCard agentId={agentId} itemId={entry.item.id} approval={entry.approval} />;
      return <ApprovalCard agentId={agentId} item={entry.item} />;
    case "question":
      return <ApprovalCard agentId={agentId} item={entry.item} />;
    case "action":
      return <ActionRow action={entry.action} />;
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

function MateApprovalCard({ agentId, itemId, approval }: { agentId: string; itemId: string; approval: AssistantApproval }) {
  const [busy, setBusy] = useState(false);
  const respond = async (decision: "allow" | "deny") => {
    if (busy) return;
    setBusy(true);
    if (!(await respondToMate(agentId, itemId, decision))) setBusy(false);
  };
  return (
    <div className="mate-card" role="group" aria-label={approval.title}>
      <div className="mate-card-title">{approval.title}</div>
      {approval.message && <div className="mate-card-text">{approval.message}</div>}
      <div className="mate-card-actions">
        <Button variant="primary" size="default" disabled={busy} onClick={() => void respond("allow")}>{approval.confirmLabel}</Button>
        <Button size="default" disabled={busy} onClick={() => void respond("deny")}>{A.cancel}</Button>
      </div>
    </div>
  );
}

function DecisionStack({ items }: { items: FollowUpItem[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mate-decisions">
      {(expanded ? items : items.slice(0, 1)).map((item) => <DecisionCard key={item.id} item={item} />)}
      {items.length > 1 && <Button aria-expanded={expanded} className="mate-more-decisions" onClick={() => setExpanded(!expanded)}>
        {expanded ? A.showFewer : A.moreDecisions(items.length - 1)}<Codicon name={expanded ? "chevron-up" : "chevron-down"} size={14} />
      </Button>}
    </div>
  );
}

function DecisionCard({ item }: { item: FollowUpItem }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === item.agentId));
  const workspace = useStore((s) => workspaceNameOf(s.workspaces, agent?.workspaceId ?? null));
  const now = useNow();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  if (!agent) return null;
  const openSession = () => openFollowUpSession(agent.id);
  const reply = async (text: string) => {
    if (!text.trim() || sending !== null) return;
    setSending(text);
    if (await replyToFollowUp(item, text)) flash(A.sentTo(text.trim(), agent.title));
    else setSending(null);
  };
  return (
    <div className="mate-card" role="group" aria-label={agent.title}>
      <div className="mate-card-head">
        <button type="button" className="mate-card-meta" title={[agent.title, workspace].filter(Boolean).join(" · ")} onClick={openSession}>
          <span className="mate-card-session">{agent.title}</span>
          <span className="session-separator" aria-hidden="true" />
          <span>{A.waitingFor(ageText(item.since, now))}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" aria-label={A.decisionMenu(agent.title)} disabled={sending !== null}><Codicon name="ellipsis" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {SNOOZE_CHOICES.map((choice) => <DropdownMenuItem key={choice} onSelect={() => snoozeFollowUp(item.id, choice)}>{A.remind[choice]}</DropdownMenuItem>)}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => dismissFollowUp(item.id)}>{A.dismiss}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mate-card-title">{itemText(item)}</div>
      {item.kind === "ask" ? (
        <>
          {item.options.length > 0 && <div className="mate-replies">
            {item.options.map((option) => (
              <button key={option} type="button" className="mate-reply-option" aria-label={A.sendOption(option, agent.title)} title={A.sendOption(option, agent.title)} disabled={sending !== null} onClick={() => void reply(option)}>
                <span>{option}</span><Codicon name={sending === option ? "loading" : "reply"} spin={sending === option} size={14} />
              </button>
            ))}
          </div>}
          <form className="mate-reply-form" onSubmit={(event) => { event.preventDefault(); void reply(draft); }}>
            <input value={draft} disabled={sending !== null} aria-label={S.followUp.replyAria(agent.title)} placeholder={S.followUp.replyPlaceholder} onChange={(event) => setDraft(event.target.value)} />
            <Button type="submit" size="icon" variant={draft.trim() ? "primary" : "ghost"} aria-label={A.sendReply(agent.title)} disabled={!draft.trim() || sending !== null}><Codicon name="arrow-up" /></Button>
          </form>
        </>
      ) : (
        <Button className="mate-review" variant="secondary" size="default" onClick={openSession}>
          {reviewFollowUpLabel[item.kind]}<Codicon name="arrow-right" size={14} />
        </Button>
      )}
    </div>
  );
}

type ActionRowProps = { action: AssistantAction };

function ActionRow({ action }: ActionRowProps) {
  const agents = useStore((s) => s.agents);
  const view = useMemo(() => mateActionView(action, agents), [action, agents]);
  return (
    <div className="mate-action" data-state={view.state}>
      <span className="mate-action-icon" aria-hidden="true">
        <Codicon name={view.state === "undone" ? "discard" : "check"} />
      </span>
      <div className="mate-action-main">
        <span className="mate-action-text">
          {view.parts.map((part, index) => (part.strong ? <strong key={index} className="mate-action-name">{part.text}</strong> : <span key={index}>{part.text}</span>))}
        </span>
        {view.titles && (
          <span className="mate-action-detail" title={action.targets.map((t) => t.title).join(", ")}>
            <span className="mate-action-titles">{view.titles}</span>
            {view.more && <span className="mate-action-more">{view.more}</span>}
          </span>
        )}
        {view.note && <span className="mate-action-note">{view.note}</span>}
      </div>
      {view.state === "open" && (
        <Button variant="secondary" size="sm" data-align-free aria-label={A.undoAria(view.label)} onClick={() => undoMateAction(action.id)}>
          {A.undo}
        </Button>
      )}
      {view.state === "undone" && <span className="mate-action-state" data-align-free>{view.undoneLabel}</span>}
    </div>
  );
}

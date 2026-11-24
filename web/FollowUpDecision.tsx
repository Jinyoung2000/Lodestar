import { useState } from "react";
import { SNOOZE_CHOICES, type DecisionRow } from "../shared/followups";
import { dismissFollowUp, itemText, openFollowUpSession, replyToFollowUp, snoozeFollowUp, wakeFollowUp } from "./followUpActions";
import { ageText, untilText } from "./followUpsModel";
import { Codicon, DotSpinner } from "./icons";
import { flash } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

const F = S.followUp;

type FollowUpDecisionProps = { row: DecisionRow; workspace: string; now: number };

export function FollowUpDecision({ row, workspace, now }: FollowUpDecisionProps) {
  const { item, agent, snoozed } = row;
  const canReply = item.kind === "ask";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const openSession = () => openFollowUpSession(agent.id);
  const pick = (option: string) => {
    if (!canReply) return openSession();
    setDraft(option);
    setOpen(true);
  };
  const send = async () => {
    if (sending) return;
    setSending(true);
    const sent = await replyToFollowUp(item, draft);
    setSending(false);
    if (!sent) return;
    setDraft("");
    setOpen(false);
    flash(F.sent);
  };
  return (
    <li className="followup-row" data-kind="decision" data-item-kind={item.kind} data-snoozed={snoozed || undefined}>
      <span className="followup-glyph">{snoozed ? <Codicon name="bell-slash" /> : <DotSpinner state="waiting" />}</span>
      <button type="button" className="followup-main" aria-expanded={canReply ? open : undefined} onClick={() => (canReply ? setOpen((value) => !value) : openSession())}>
        <span className="followup-question">{itemText(item)}</span>
        <span className="followup-meta">
          <span className="followup-meta-part">
            <span className="followup-kind">{F.kinds[item.kind]}</span>
            <span className="session-separator" aria-hidden="true" />
            <span>{snoozed ? F.snoozedUntil(untilText(item.snoozedUntil, now)) : F.waiting(ageText(item.since, now))}</span>
          </span>
          <span className="session-separator followup-meta-join" aria-hidden="true" />
          <span className="followup-meta-part followup-meta-where">
            <span className="followup-session">{agent.title}</span>
            {workspace && <span className="session-separator" aria-hidden="true" />}
            {workspace && <span className="followup-workspace">{workspace}</span>}
          </span>
        </span>
      </button>
      <div className="followup-actions">
        <SnoozeMenu id={item.id} title={agent.title} snoozed={snoozed} />
        <Button className="followup-swap" aria-label={F.notNeededAria(agent.title)} title={F.notNeeded} onClick={() => dismissFollowUp(item.id)}>
          <Codicon name="close" size={14} className="followup-swap-icon" />
          <span className="followup-swap-label">{F.notNeeded}</span>
        </Button>
      </div>
      {item.options.length > 0 && !snoozed && (
        <div className="followup-extra followup-options">
          {item.options.map((option) => (
            <Button key={option} variant="secondary" className="followup-option" onClick={() => pick(option)}>
              {option}
            </Button>
          ))}
        </div>
      )}
      {open && canReply && (
        <form
          className="followup-extra followup-reply"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <input className="input followup-reply-input" autoFocus value={draft} placeholder={F.replyPlaceholder} aria-label={F.replyAria(agent.title)} onChange={(event) => setDraft(event.target.value)} />
          <Button type="submit" variant="primary" size="default" disabled={!draft.trim() || sending}>
            {F.send}
          </Button>
          <button type="button" className="automation-link followup-open" onClick={openSession}>
            {F.openSession}
          </button>
        </form>
      )}
    </li>
  );
}

type SnoozeMenuProps = { id: string; title: string; snoozed: boolean };

function SnoozeMenu({ id, title, snoozed }: SnoozeMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="followup-swap" aria-label={F.remindMeAria(title)} title={F.remindMe}>
          <Codicon name="bell" size={14} className="followup-swap-icon" />
          <span className="followup-swap-label">{F.remindMe}</span>
          <Codicon name="chevron-down" size={12} className="followup-swap-label" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {snoozed && <DropdownMenuItem onSelect={() => wakeFollowUp(id)}>{F.wake}</DropdownMenuItem>}
        {snoozed && <DropdownMenuSeparator />}
        {SNOOZE_CHOICES.map((choice) => (
          <DropdownMenuItem key={choice} onSelect={() => snoozeFollowUp(id, choice)}>
            {F.snooze[choice]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

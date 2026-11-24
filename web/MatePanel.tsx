import { useMemo, useState } from "react";
import { clockText, dayText, type AssistantState } from "../shared/assistant";
import { isSnoozed, openDecisionCount } from "../shared/followups";
import { itemText, wakeFollowUp } from "./followUpActions";
import { FollowUpsBody, FollowUpsRefresh } from "./FollowUpsView";
import { cancelMateReminder, readMateNotes, writeMateNotes } from "./mateActions";
import { useNow } from "./PrBits";
import { useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

const A = S.assistant;
const TABS = ["tracking", "reminders", "activity", "notes"] as const;
type Tab = (typeof TABS)[number];
const whenText = (iso: string) => `${dayText(new Date(iso))}, ${clockText(new Date(iso))}`;

type MatePanelProps = { state: AssistantState };

export function MatePanel({ state }: MatePanelProps) {
  const [tab, setTab] = useState<Tab>("tracking");
  const [notes, setNotes] = useState<{ text: string; saved: string } | null>(null);
  const items = useStore((s) => s.followUps?.items);
  const agents = useStore((s) => s.agents);
  const now = useNow();
  const waiting = useMemo(() => (items ? openDecisionCount(agents, items, now) : 0), [agents, items, now]);
  const open = (next: Tab) => {
    setTab(next);
    if (next === "notes" && notes === null) void readMateNotes().then((text) => text !== null && setNotes({ text, saved: text }));
  };
  const save = async () => {
    if (notes && (await writeMateNotes(notes.text))) setNotes({ text: notes.text, saved: notes.text });
  };
  return (
    <section className="mate-panel" aria-label={A.tabsAria}>
      <div className="pane-header mate-tabs" role="tablist">
        {TABS.map((name) => (
          <button key={name} type="button" role="tab" className="mate-tab" aria-selected={tab === name} onClick={() => open(name)}>
            {A.tabs[name]}
            {name === "tracking" && waiting > 0 && <span className="inbox-badge">{waiting}</span>}
          </button>
        ))}
        <span className="spacer" />
        {tab === "tracking" && <FollowUpsRefresh />}
        {tab === "notes" && notes && (
          <Button variant="secondary" disabled={notes.text === notes.saved} onClick={() => void save()}>
            {A.notesSave}
          </Button>
        )}
      </div>
      <div className="mate-panel-body">
        {tab === "tracking" && <FollowUpsBody />}
        {tab === "reminders" && <Reminders state={state} now={now} />}
        {tab === "activity" && <Activity state={state} />}
        {tab === "notes" && (
          <div className="mate-notes">
            <p className="mate-hint">{A.notesHint}</p>
            <textarea className="mate-notes-text" aria-label={A.notesAria} spellCheck={false} value={notes?.text ?? ""} disabled={notes === null} onChange={(event) => setNotes((current) => (current ? { ...current, text: event.target.value } : current))} />
          </div>
        )}
      </div>
    </section>
  );
}

type RemindersProps = { state: AssistantState; now: number };

function Reminders({ state, now }: RemindersProps) {
  const snoozed = useStore((s) => s.followUps?.items)?.filter((item) => isSnoozed(item, now)) ?? [];
  const agents = useStore((s) => s.agents);
  if (state.reminders.length === 0 && snoozed.length === 0) return <p className="mate-empty">{A.remindersEmpty}</p>;
  return (
    <ul className="mate-rows">
      {state.reminders.map((reminder) => (
        <li key={reminder.id} className="mate-row">
          <div className="mate-row-main">
            <span className="mate-row-text">{reminder.text}</span>
            <span className="mate-row-meta">
              {whenText(reminder.at)}
              <span className="session-separator" aria-hidden="true" />
              {A.reminderMate}
            </span>
          </div>
          <Button aria-label={A.cancelReminderAria(reminder.text)} onClick={() => cancelMateReminder(reminder.id)}>
            {A.cancelReminder}
          </Button>
        </li>
      ))}
      {snoozed.map((item) => (
        <li key={item.id} className="mate-row">
          <div className="mate-row-main">
            <span className="mate-row-text">{itemText(item)}</span>
            <span className="mate-row-meta">
              {item.snoozedUntil ? whenText(item.snoozedUntil) : ""}
              <span className="session-separator" aria-hidden="true" />
              {agents.find((a) => a.id === item.agentId)?.title ?? A.reminderSnoozed}
            </span>
          </div>
          <Button onClick={() => wakeFollowUp(item.id)}>{A.wake}</Button>
        </li>
      ))}
    </ul>
  );
}

type ActivityProps = { state: AssistantState };

function Activity({ state }: ActivityProps) {
  if (state.checkIns.length === 0) return <p className="mate-empty">{A.activityEmpty}</p>;
  return (
    <ul className="mate-rows">
      {state.checkIns.map((checkIn) => (
        <li key={checkIn.at} className="mate-row">
          <div className="mate-row-main">
            <span className="mate-row-text">{A.reasons[checkIn.reason]}</span>
            <span className="mate-row-meta">{whenText(checkIn.at)}</span>
          </div>
          <span className="mate-row-state" data-spoke={checkIn.spoke || undefined}>
            {checkIn.spoke ? A.spoke : A.quiet}
          </span>
        </li>
      ))}
    </ul>
  );
}

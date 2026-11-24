import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { mateFeed, type AssistantState } from "../shared/assistant";
import type { Agent } from "../shared/protocol";
import { effortName, modelChip } from "./Composer";
import { useDefaults } from "./defaults";
import { builtinEffort, supportedLevels } from "./effortLevels";
import { agoText } from "./followUpsModel";
import { Codicon, ModelIcon } from "./icons";
import { checkInMate, openMateSession, sendToMate, setMateEffort, setMateModel, stopMate } from "./mateActions";
import { MateFeed } from "./MateFeed";
import { MatePanel } from "./MatePanel";
import { EffortMenu, ModelMenu } from "./Pickers";
import { useNow } from "./PrBits";
import { useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import "./mate.css";

const A = S.assistant;
const NO_ITEMS: never[] = [];
const PANEL_KEY = "lodestar.mate.panel";

function savedPanel() {
  try {
    return localStorage.getItem(PANEL_KEY) === "open";
  } catch {
    return false;
  }
}

function savePanel(open: boolean) {
  try {
    localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
  } catch {
    return;
  }
}

export function MateView() {
  const state = useStore((s) => s.assistant);
  const agent = useStore((s) => s.agents.find((a) => a.id === s.assistant?.agentId) ?? null);
  const [panel, setPanel] = useState(savedPanel);
  const togglePanel = () => {
    savePanel(!panel);
    setPanel(!panel);
  };
  if (!state || !agent) {
    return (
      <section className="mate" aria-label={A.name}>
        <p className="mate-empty">{A.unavailable}</p>
      </section>
    );
  }
  return (
    <div className="mate" data-panel={panel ? "open" : "closed"}>
      <MateChat agent={agent} state={state} panel={panel} onTogglePanel={togglePanel} />
      {panel && <MatePanel state={state} />}
    </div>
  );
}

type MateChatProps = { agent: Agent; state: AssistantState; panel: boolean; onTogglePanel: () => void };

function MateChat({ agent, state, panel, onTogglePanel }: MateChatProps) {
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
          <Button size="icon" aria-label={panel ? A.hidePanel : A.showPanel} title={panel ? A.hidePanel : A.showPanel} aria-pressed={panel} onClick={onTogglePanel}>
            <Codicon name="layout-sidebar-right" />
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
      <MateComposer agent={agent} />
    </section>
  );
}

type MateComposerProps = { agent: Agent };

function MateComposer({ agent }: MateComposerProps) {
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<"model" | "effort" | null>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const effortRef = useRef<HTMLButtonElement>(null);
  const models = useStore((s) => s.meta?.models) ?? NO_ITEMS;
  const defaults = useDefaults();
  const model = agent.model ?? defaults.model;
  const levels = supportedLevels(model);
  const effort = agent.effort ?? defaults.effort ?? builtinEffort(levels);
  const running = agent.status === "running";
  const toggle = (name: "model" | "effort") => setMenu((open) => (open === name ? null : name));
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
      <button ref={modelRef} type="button" className="chip" data-chip="model" aria-haspopup="dialog" aria-expanded={menu === "model"} aria-label={A.model} title={A.model} onClick={() => toggle("model")}>
        <ModelIcon />
        <span className="chip-label chip-main">{modelChip(model, agent.activeModel, models).name}</span>
      </button>
      {levels.length > 0 && (
        <button ref={effortRef} type="button" className="chip" data-chip aria-haspopup="listbox" aria-expanded={menu === "effort"} aria-label={A.effort} title={A.effort} onClick={() => toggle("effort")}>
          <span className="chip-label">{effortName(effort)}</span>
        </button>
      )}
      {running && !draft.trim() ? (
        <Button size="icon" aria-label={A.stop} onClick={() => stopMate(agent.id)}>
          <Codicon name="debug-stop" />
        </Button>
      ) : (
        <Button type="submit" variant="primary" size="icon" aria-label={A.send} disabled={!draft.trim()}>
          <Codicon name="arrow-up" />
        </Button>
      )}
      {menu === "model" && <ModelMenu anchor={modelRef.current} current={model ?? "default"} onClose={() => setMenu(null)} onChoose={(value) => setMateModel(agent.id, value)} />}
      {menu === "effort" && <EffortMenu anchor={effortRef.current} label={A.effort} levels={levels} current={effort} onClose={() => setMenu(null)} onChoose={(level) => setMateEffort(agent.id, level)} />}
    </form>
  );
}

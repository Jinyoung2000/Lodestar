import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { mateFeed, type AssistantState } from "../shared/assistant";
import { harnessOf, type Agent } from "../shared/protocol";
import { effortName, modelChip } from "./Composer";
import { useDefaults } from "./defaults";
import { builtinEffort, supportedLevels } from "./effortLevels";
import { agoText } from "./followUpsModel";
import { codexDefaultModel, codexLevels, codexModelChip, useCustomProvider, useToolMeta } from "./harness";
import { Codicon, ModelIcon } from "./icons";
import { checkInMate, openMateSession, sendToMate, setMateEffort, setMateModel, stopMate } from "./mateActions";
import { MateFeed } from "./MateFeed";
import { MatePanel } from "./MatePanel";
import { sourceOf, type SourceKey } from "./modelChoices";
import { EffortMenu, ModelMenu, type ModelGroup } from "./Pickers";
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
  const harness = harnessOf(agent);
  const provider = useCustomProvider(agent.providerId);
  const toolMeta = useToolMeta(harness);
  const defaults = useDefaults();
  const model = provider ? (agent.model ?? provider.defaultModel) : harness === "claude" ? (agent.model ?? defaults.model) : (agent.model ?? codexDefaultModel(toolMeta));
  const levels = provider ? NO_ITEMS : harness === "claude" ? supportedLevels(model) : codexLevels(toolMeta, model);
  const effort = agent.effort ?? (harness === "claude" ? defaults.effort : (toolMeta?.models.find((m) => m.value === model)?.defaultEffort ?? toolMeta?.defaultEffort)) ?? builtinEffort(levels);
  const chipName = provider ? (provider.models.find((m) => m.id === model)?.name ?? model ?? provider.name) : harness === "claude" ? modelChip(model, agent.activeModel, models).name : codexModelChip(model, agent.activeModel, toolMeta, S.harnessNames[harness]).name;
  const group = harness === "claude" && !provider ? null : sourceOf(harness, provider?.id);
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
        <span className="chip-label chip-main">{chipName}</span>
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
      {menu === "model" && <MateModelMenu anchor={modelRef.current} model={model ?? "default"} group={group} onClose={() => setMenu(null)} onChoose={(value, chosen) => setMateModel(agent.id, value, chosen)} />}
      {menu === "effort" && <EffortMenu anchor={effortRef.current} label={A.effort} levels={levels} current={effort} onClose={() => setMenu(null)} onChoose={(level) => setMateEffort(agent.id, level)} />}
    </form>
  );
}

const OTHER_TOOLS = ["codex", "cursor", "antigravity"] as const;

type MateModelMenuProps = { anchor: HTMLElement | null; model: string; group: SourceKey | null; onClose: () => void; onChoose: (model: string, group: SourceKey | null) => void };

function MateModelMenu({ anchor, model, group, onClose, onChoose }: MateModelMenuProps) {
  const codex = useToolMeta("codex");
  const cursor = useToolMeta("cursor");
  const antigravity = useToolMeta("antigravity");
  const providers = useStore((s) => s.customProviders) ?? NO_ITEMS;
  const groups = useMemo<ModelGroup[]>(() => {
    const metas = { codex, cursor, antigravity };
    return [
      ...OTHER_TOOLS.filter((tool) => metas[tool]?.loggedIn).map((tool) => ({ key: tool, name: S.harnessNames[tool], models: (metas[tool]?.models ?? []).map((m) => ({ value: m.value, name: m.displayName })) })),
      ...providers.filter((p) => p.hasKey).map((p) => ({ key: sourceOf("claude", p.id), name: p.name, models: p.models.map((m) => ({ value: m.id, name: m.name ?? m.id })) })),
    ];
  }, [codex, cursor, antigravity, providers]);
  return <ModelMenu anchor={anchor} current={model} groups={groups} currentGroup={group} onClose={onClose} onChoose={(value, _asDefault, chosen) => onChoose(value, chosen as SourceKey | null)} />;
}

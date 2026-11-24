import type { EffortLevel, Harness } from "../shared/protocol";
import { currentDraftDefaults } from "./defaults";
import { activeHarness } from "./harness";
import { rpc } from "./rpc";
import { activePane, flash, getState, rememberPick, setState, type LastPicked } from "./store";

export function setModelPin(harness: Harness, model: string, pinned: boolean) {
  void rpc.call("models.setPin", { harness, model, pinned }).catch((error: Error) => flash(error.message, "warning"));
}

export function pickKeys(harness: Harness, model: string | null | undefined, effort: EffortLevel | null | undefined): LastPicked {
  const picked: LastPicked = {};
  if (model !== undefined) {
    if (harness === "codex") picked.codexModel = model;
    else if (harness === "antigravity") picked.antigravityModel = model;
    else if (harness === "cursor") picked.cursorModel = model;
    else picked.model = model;
  }
  if (effort !== undefined) {
    if (harness === "codex") picked.codexEffort = effort;
    else if (harness === "antigravity") picked.antigravityEffort = effort;
    else if (harness === "cursor") picked.cursorEffort = effort;
    else picked.effort = effort;
  }
  return picked;
}

export function lastPickedModel(harness: Harness): string | null {
  const last = getState().lastPicked;
  return (harness === "codex" ? last.codexModel : harness === "antigravity" ? last.antigravityModel : harness === "cursor" ? last.cursorModel : last.model) ?? null;
}

export function applyModel(model: string | null, harness: Harness = activeHarness()) {
  rememberPick(pickKeys(harness, model, undefined));
  const pane = activePane();
  if (pane.kind === "agent") void rpc.call("agents.setModel", { agentId: pane.agentId, model });
  else setState((s) => ({ draftModel: { ...s.draftModel, [pane.id]: model } }));
}

export function applyEffort(effort: EffortLevel | null, harness: Harness = activeHarness()) {
  rememberPick(pickKeys(harness, undefined, effort));
  const pane = activePane();
  if (pane.kind === "agent") void rpc.call("agents.setEffort", { agentId: pane.agentId, effort });
  else setState((s) => ({ draftEffort: { ...s.draftEffort, [pane.id]: effort } }));
}

export function startDraftOn(harness: Harness, model: string | null, effort: EffortLevel | null) {
  const pane = activePane();
  if (pane.kind !== "draft") return;
  rememberPick({ harness, ...pickKeys(harness, model, effort) });
  setState((s) => ({ draftHarness: { ...s.draftHarness, [pane.id]: harness }, draftModel: { ...s.draftModel, [pane.id]: model }, draftEffort: { ...s.draftEffort, [pane.id]: effort } }));
}

export function switchTool(agentId: string, harness: Harness, model: string, effort: EffortLevel | null) {
  void rpc.call("agents.switchHarness", { agentId, harness, model, effort }).then(
    () => rememberPick(pickKeys(harness, model, effort)),
    (error: Error) => flash(error.message, "warning"),
  );
}

export function currentModelAndEffort() {
  const s = getState();
  const pane = activePane();
  if (pane.kind === "agent") {
    const agent = s.agents.find((a) => a.id === pane.agentId);
    return { model: agent?.model ?? null, effort: agent?.effort ?? null };
  }
  const harness = activeHarness();
  if (harness !== "claude") {
    const lastEffort = harness === "codex" ? s.lastPicked.codexEffort : harness === "cursor" ? s.lastPicked.cursorEffort : s.lastPicked.antigravityEffort;
    return {
      model: pane.id in s.draftModel ? s.draftModel[pane.id] : lastPickedModel(harness),
      effort: pane.id in s.draftEffort ? s.draftEffort[pane.id] : (lastEffort ?? null),
    };
  }
  return {
    model: pane.id in s.draftModel ? s.draftModel[pane.id] : currentDraftDefaults().model,
    effort: pane.id in s.draftEffort ? s.draftEffort[pane.id] : currentDraftDefaults().effort,
  };
}

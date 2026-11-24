import type { EffortLevel, Harness } from "../shared/protocol";
import { currentDraftDefaults } from "./defaults";
import { activeHarness, activeProviderId } from "./harness";
import { rpc } from "./rpc";
import { activePane, flash, getState, rememberPick, setState, type LastPicked } from "./store";

export function setModelPin(harness: Harness, model: string, pinned: boolean, providerId?: string | null) {
  void rpc.call("models.setPin", { harness, model, pinned, ...(providerId ? { providerId } : {}) }).catch((error: Error) => flash(error.message, "warning"));
}

export function pickKeys(harness: Harness, model: string | null | undefined, effort: EffortLevel | null | undefined, providerId: string | null = null): LastPicked {
  const picked: LastPicked = {};
  if (providerId) {
    if (model) picked.providerModels = { ...getState().lastPicked.providerModels, [providerId]: model };
    return picked;
  }
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

export function lastPickedModel(harness: Harness, providerId: string | null = null): string | null {
  const last = getState().lastPicked;
  if (providerId) return last.providerModels?.[providerId] ?? null;
  return (harness === "codex" ? last.codexModel : harness === "antigravity" ? last.antigravityModel : harness === "cursor" ? last.cursorModel : last.model) ?? null;
}

export function applyModel(model: string | null, harness: Harness = activeHarness(), providerId: string | null = activeProviderId()) {
  rememberPick(pickKeys(harness, model, undefined, providerId));
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

export function startDraftOn(harness: Harness, model: string | null, effort: EffortLevel | null, providerId: string | null = null) {
  const pane = activePane();
  if (pane.kind !== "draft") return;
  rememberPick({ harness, providerId, ...pickKeys(harness, model, effort, providerId) });
  setState((s) => ({ draftHarness: { ...s.draftHarness, [pane.id]: harness }, draftProvider: { ...s.draftProvider, [pane.id]: providerId }, draftModel: { ...s.draftModel, [pane.id]: model }, draftEffort: { ...s.draftEffort, [pane.id]: providerId ? null : effort } }));
}

export function switchTool(agentId: string, harness: Harness, model: string, effort: EffortLevel | null, providerId: string | null = null) {
  void rpc.call("agents.switchHarness", { agentId, harness, model, effort, ...(providerId ? { providerId } : {}) }).then(
    () => rememberPick(pickKeys(harness, model, effort, providerId)),
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
  const providerId = activeProviderId();
  if (providerId) return { model: pane.id in s.draftModel ? s.draftModel[pane.id] : lastPickedModel(harness, providerId), effort: null };
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

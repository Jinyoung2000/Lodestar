import { mobileModelId, type MobileModelProvider, type MobileModelSelection } from "../shared/mobile";
import { claudeModels, modelPinKey, toolModels, type PickerModel } from "../shared/modelChoices";
import { modelNameFromId } from "../shared/modelName";
import type { EffortLevel, Harness } from "../shared/protocol";
import type { AgentRunner } from "./agents";
import { defaultsReader } from "./defaults";
import type { MetaService } from "./meta";
import type { Store } from "./store";
import { T } from "./strings";

function providerOf(harness: Harness, choices: PickerModel[], defaultId: string | null, defaultEffort: EffortLevel | null): MobileModelProvider | null {
  const visible = choices.filter((model) => mobileModelId(model.value));
  if (!visible.length) return null;
  const reportedDefault = visible.find((model) => model.value === defaultId) ?? visible.find((model) => defaultId !== null && model.resolved === defaultId);
  const advertisedDefault = harness === "claude" ? visible.find((model) => model.value === "default") : undefined;
  const namedDefault = defaultId !== null && mobileModelId(defaultId) ? defaultId : null;
  const defaultModel = reportedDefault?.value ?? namedDefault ?? advertisedDefault?.value ?? null;
  const models = visible.map((model) => {
    const resolved = mobileModelId(model.resolved) ? model.resolved : null;
    const displayName = model.value === "default" && resolved ? modelNameFromId(resolved) ?? model.displayName : model.displayName;
    return {
      value: model.value,
      pinKey: modelPinKey(harness, model.value),
      resolved,
      displayName: displayName.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 120) || model.value,
      levels: [...new Set(model.levels)],
      defaultLevel: (harness === "claude" || model.value === defaultModel) && defaultEffort && model.levels.includes(defaultEffort) ? defaultEffort : model.defaultLevel,
    };
  });
  return { harness, models, defaultModel, defaultModelKnown: !!reportedDefault };
}

export function mobileModels(store: Store, runner: AgentRunner, metaService: MetaService) {
  const pending = new Map<Harness, Promise<MobileModelProvider | null>>();
  const readProvider = async (harness: Harness) => {
    if (harness === "claude") {
      const current = metaService.meta;
      const meta = current.models.length || current.claudeMissing ? current : await metaService.refresh();
      if (meta.claudeMissing) return null;
      const defaults = defaultsReader.resolve(store.settings);
      return providerOf(harness, claudeModels(meta.models, defaults.model.value), defaults.model.value ?? "default", defaults.effort.value);
    }
    const meta = await (harness === "codex" ? runner.codexMeta() : runner.antigravityMeta());
    if (!meta.installed || !meta.loggedIn) return null;
    return providerOf(harness, toolModels(harness, meta), meta.defaultModel ?? meta.models.find((model) => model.isDefault)?.value ?? null, meta.defaultEffort);
  };

  function provider(harness: Harness) {
    const existing = pending.get(harness);
    if (existing) return existing;
    const request = readProvider(harness).catch(() => {
      console.error(`[mobile] Could not read ${harness} models`);
      return null;
    }).finally(() => pending.delete(harness));
    pending.set(harness, request);
    return request;
  }

  async function select(selection: MobileModelSelection): Promise<MobileModelSelection> {
    const origin = await provider(selection.harness);
    if (!origin) throw new Error(T.errMobileProviderUnavailable);
    const id = selection.model ?? origin.defaultModel;
    const model = origin.models.find((choice) => choice.value === id) ?? origin.models.find((choice) => id !== null && choice.resolved === id);
    if (selection.model !== null && !model) throw new Error(T.errMobileModelUnavailable);
    if (selection.effort !== null && !model?.levels.includes(selection.effort)) throw new Error(T.errMobileEffortUnavailable);
    if (selection.harness === "claude") {
      const defaultEffort = defaultsReader.resolve(store.settings).effort.value;
      const incompatibleDefault = model && defaultEffort && !model.levels.includes(defaultEffort);
      return { ...selection, effort: selection.effort ?? (incompatibleDefault ? model.defaultLevel : null) };
    }
    return { ...selection, model: selection.model ?? (origin.defaultModelKnown ? origin.defaultModel : null), effort: selection.effort ?? model?.defaultLevel ?? null };
  }

  return { provider, select };
}

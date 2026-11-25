import { mobileModelId, type MobileModelProvider, type MobileModelSelection } from "../shared/mobile";
import { claudeModels, modelPinKey, toolModels, type PickerModel } from "../shared/modelChoices";
import { modelNameFromId } from "../shared/modelName";
import type { EffortLevel, Harness } from "../shared/protocol";
import type { AgentRunner } from "./agents";
import type { CustomProviders } from "./customProviders";
import { defaultsReader } from "./defaults";
import type { MetaService } from "./meta";
import type { Store } from "./store";
import { T } from "./strings";

const withoutLongContext = (harness: Harness, id: string) => (harness === "claude" ? id.replace(/\[1m\]$/i, "") : id);

function findModel<M extends { value: string; resolved: string | null }>(harness: Harness, models: readonly M[], id: string | null): M | undefined {
  if (id === null) return undefined;
  const base = withoutLongContext(harness, id);
  return models.find((model) => model.value === id) ?? models.find((model) => model.value === base)
    ?? models.find((model) => model.value !== "default" && (model.resolved === id || model.resolved === base));
}

function providerOf(harness: Harness, choices: PickerModel[], defaultId: string | null, defaultEffort: EffortLevel | null): MobileModelProvider | null {
  const visible = choices.filter((model) => mobileModelId(model.value));
  if (!visible.length) return null;
  const reportedDefault = findModel(harness, visible, defaultId);
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

export function mobileModels(store: Store, runner: AgentRunner, metaService: MetaService, customProviders: CustomProviders) {
  async function custom(providerId: string): Promise<MobileModelProvider | null> {
    const found = (await customProviders.views()).find((p) => p.id === providerId && p.hasKey);
    if (!found) return null;
    const models = found.models.map((m) => ({ value: m.id, pinKey: modelPinKey("claude", m.id, found.id), resolved: null, displayName: m.name ?? m.id, levels: [], defaultLevel: null }));
    return { harness: "claude", providerId: found.id, name: found.name, models, defaultModel: found.defaultModel, defaultModelKnown: true };
  }

  async function customAll(): Promise<MobileModelProvider[]> {
    const views = await customProviders.views();
    const listed = await Promise.all(views.filter((p) => p.hasKey).map((p) => custom(p.id)));
    return listed.filter((p): p is MobileModelProvider => p !== null);
  }

  const pending = new Map<Harness, Promise<MobileModelProvider | null>>();
  const readProvider = async (harness: Harness) => {
    if (harness === "claude") {
      const current = metaService.meta;
      const meta = current.models.length || current.claudeMissing ? current : await metaService.refresh();
      if (meta.claudeMissing) return null;
      const defaults = defaultsReader.resolve(store.settings);
      return providerOf(harness, claudeModels(meta.models, defaults.model.value), defaults.model.value ?? "default", defaults.effort.value);
    }
    const meta = await (harness === "codex" ? runner.codexMeta() : harness === "cursor" ? runner.cursorMeta() : runner.antigravityMeta());
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
    if (selection.providerId) {
      const origin = await custom(selection.providerId);
      if (!origin || selection.harness !== "claude") throw new Error(T.errMobileProviderUnavailable);
      const model = selection.model ?? origin.defaultModel;
      if (!origin.models.some((m) => m.value === model)) throw new Error(T.errMobileModelUnavailable);
      return { harness: "claude", model, effort: null, providerId: origin.providerId };
    }
    const origin = await provider(selection.harness);
    if (!origin) throw new Error(T.errMobileProviderUnavailable);
    const id = selection.model ?? origin.defaultModel;
    const model = findModel(selection.harness, origin.models, id);
    if (selection.model !== null && !model) throw new Error(T.errMobileModelUnavailable);
    if (selection.effort !== null && !model?.levels.includes(selection.effort)) throw new Error(T.errMobileEffortUnavailable);
    if (selection.harness === "claude") {
      const defaultEffort = defaultsReader.resolve(store.settings).effort.value;
      const incompatibleDefault = model && defaultEffort && !model.levels.includes(defaultEffort);
      return { ...selection, effort: selection.effort ?? (incompatibleDefault ? model.defaultLevel : null) };
    }
    return { ...selection, model: selection.model ?? (origin.defaultModelKnown ? origin.defaultModel : null), effort: selection.effort ?? model?.defaultLevel ?? null };
  }

  return { provider, custom, customAll, select };
}

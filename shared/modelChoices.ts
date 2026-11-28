import { CLAUDE_EFFORT_LEVELS, type CodexMeta, type EffortLevel, type Harness, type ModelInfo } from "./protocol";

import type { CustomProvider } from "./customProviders";

export type PickerModel = { tool: Harness; providerId?: string | null; value: string; resolved: string | null; displayName: string; levels: EffortLevel[]; defaultLevel: EffortLevel | null; isDefault: boolean };

const CLAUDE_BUILTIN_LEVEL: EffortLevel = "high";

export function claudeModels(models: ModelInfo[], defaultModel: string | null): PickerModel[] {
  return models.map((m) => {
    const levels = m.supportedEffortLevels.length ? m.supportedEffortLevels : [...CLAUDE_EFFORT_LEVELS];
    return {
      tool: "claude",
      value: m.value,
      resolved: m.resolvedModel,
      displayName: m.displayName,
      levels,
      defaultLevel: levels.includes(CLAUDE_BUILTIN_LEVEL) ? CLAUDE_BUILTIN_LEVEL : (levels.at(-1) ?? null),
      isDefault: m.value !== "default" && m.value === defaultModel,
    };
  });
}

export function codexModelInfo(meta: CodexMeta | null, model: string | null) {
  const id = model ?? meta?.defaultModel ?? meta?.models.find((item) => item.isDefault)?.value;
  return meta?.models.find((item) => item.value === id);
}

export function compatibleCodexEffort(meta: CodexMeta | null, model: string | null, effort: EffortLevel | null): EffortLevel | null {
  const info = codexModelInfo(meta, model);
  return effort && info && !info.supportedEffortLevels.includes(effort) ? null : effort;
}

export function codexModelEffort(meta: CodexMeta | null, model: string | null): EffortLevel | null {
  const defaultModel = meta?.defaultModel ?? meta?.models.find((item) => item.isDefault)?.value;
  const configured = model === null || model === defaultModel ? compatibleCodexEffort(meta, model, meta?.defaultEffort ?? null) : null;
  return configured ?? codexModelInfo(meta, model)?.defaultEffort ?? null;
}

export function toolModels(tool: Harness, meta: CodexMeta | null): PickerModel[] {
  const fallback = meta?.defaultModel ?? meta?.models.find((m) => m.isDefault)?.value ?? null;
  return (meta?.models ?? []).map((m) => ({
    tool,
    value: m.value,
    resolved: null,
    displayName: m.displayName,
    levels: m.supportedEffortLevels,
    defaultLevel: m.defaultEffort ?? (m.value === fallback ? (meta?.defaultEffort ?? null) : null),
    isDefault: m.value === fallback,
  }));
}

export function providerModels(provider: CustomProvider): PickerModel[] {
  return provider.models.map((m) => ({ tool: "claude", providerId: provider.id, value: m.id, resolved: null, displayName: m.name ?? m.id, levels: [], defaultLevel: null, isDefault: m.id === provider.defaultModel }));
}

export const isModel = (model: PickerModel, value: string | null) => value !== null && (model.value === value || model.resolved === value);

export function carryLevel(current: EffortLevel | null, levels: readonly EffortLevel[], fallback: EffortLevel | null): EffortLevel | null {
  if (levels.length === 0) return null;
  return current && levels.includes(current) ? current : fallback;
}

export function modelPinKey(harness: Harness, model: string, providerId?: string | null): string {
  if (providerId) return `provider:${providerId}:${model}`;
  return harness === "claude" ? model : `${harness}:${model}`;
}

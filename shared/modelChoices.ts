import { CLAUDE_EFFORT_LEVELS, type CodexMeta, type EffortLevel, type Harness, type ModelInfo } from "./protocol";

export type PickerModel = { tool: Harness; value: string; resolved: string | null; displayName: string; levels: EffortLevel[]; defaultLevel: EffortLevel | null; isDefault: boolean };

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

export const isModel = (model: PickerModel, value: string | null) => value !== null && (model.value === value || model.resolved === value);

export function carryLevel(current: EffortLevel | null, levels: readonly EffortLevel[], fallback: EffortLevel | null): EffortLevel | null {
  if (levels.length === 0) return null;
  return current && levels.includes(current) ? current : fallback;
}

export function modelPinKey(harness: Harness, model: string): string {
  return harness === "claude" ? model : `${harness}:${model}`;
}

import { CLAUDE_EFFORT_LEVELS, type EffortLevel } from "../shared/protocol";
import { getState } from "./store";

const BUILTIN_EFFORT: EffortLevel = "high";

export function supportedLevels(model: string | null): EffortLevel[] {
  const models = getState().meta?.models;
  const info = models?.find((m) => m.value === model || m.resolvedModel === model) ?? models?.find((m) => m.value === "default");
  return info?.supportedEffortLevels.length ? info.supportedEffortLevels : CLAUDE_EFFORT_LEVELS;
}

export function builtinEffort(levels: readonly EffortLevel[]): EffortLevel | null {
  return levels.includes(BUILTIN_EFFORT) ? BUILTIN_EFFORT : (levels[levels.length - 1] ?? null);
}

export function shownEffort(model: string | null, effort: EffortLevel | null | undefined, defaultEffort: EffortLevel | null | undefined): EffortLevel | null {
  const levels = supportedLevels(model);
  const wanted = effort ?? defaultEffort ?? null;
  return wanted && levels.includes(wanted) ? wanted : builtinEffort(levels);
}

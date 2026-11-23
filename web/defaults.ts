import type { DefaultSource, EffortLevel, PermissionMode, RequestQueuing, ResolvedDefaults, Settings } from "../shared/protocol";
import { getState, useStore, type LastPicked } from "./store";

export type EffectiveDefaults = { model: string | null; effort: EffortLevel | null; permissionMode: PermissionMode; diffInlineWhenNarrow: boolean; requestQueuing: RequestQueuing; previewEditors: boolean };

export function effectiveDefaults(settings: Settings | null, resolved: ResolvedDefaults | null): EffectiveDefaults {
  return {
    model: resolved?.model.value ?? settings?.defaultModel ?? null,
    effort: resolved?.effort.value ?? settings?.defaultEffort ?? null,
    permissionMode: resolved?.permissionMode.value ?? settings?.defaultPermissionMode ?? "default",
    diffInlineWhenNarrow: resolved?.diffInlineWhenNarrow.value ?? settings?.diffInlineWhenNarrow ?? true,
    requestQueuing: resolved?.requestQueuing?.value ?? "queue",
    previewEditors: resolved?.previewEditors?.value ?? settings?.previewEditors ?? false,
  };
}

export function useDefaults(): EffectiveDefaults {
  const settings = useStore((s) => s.settings);
  const resolved = useStore((s) => s.defaults);
  return effectiveDefaults(settings, resolved);
}

export function currentDefaults(): EffectiveDefaults {
  const s = getState();
  return effectiveDefaults(s.settings, s.defaults);
}

export function sideChatModel(picked: string | null, agentModel: string | null | undefined, defaults: EffectiveDefaults) {
  return picked ?? agentModel ?? defaults.model ?? "default";
}

export type DraftDefaults = EffectiveDefaults & { modelSource: DefaultSource | "last"; effortSource: DefaultSource | "last"; permissionSource: DefaultSource | "last" };

export function draftDefaults(settings: Settings | null, resolved: ResolvedDefaults | null, last: LastPicked): DraftDefaults {
  const base = effectiveDefaults(settings, resolved);
  const explicit = {
    model: (resolved?.model.source ?? (settings?.defaultModel ? "agent-nav" : "builtin")) === "agent-nav",
    effort: (resolved?.effort.source ?? (settings?.defaultEffort ? "agent-nav" : "builtin")) === "agent-nav",
    permission: (resolved?.permissionMode.source ?? (settings?.defaultPermissionMode ? "agent-nav" : "builtin")) === "agent-nav",
  };
  const lastModel = "model" in last && !explicit.model ? last.model : undefined;
  const lastEffort = "effort" in last && !explicit.effort ? last.effort : undefined;
  const lastPermission = last.permissionMode !== undefined && !explicit.permission ? last.permissionMode : undefined;
  return {
    ...base,
    model: lastModel === undefined ? base.model : lastModel,
    effort: lastEffort === undefined ? base.effort : lastEffort,
    permissionMode: lastPermission ?? base.permissionMode,
    modelSource: lastModel === undefined ? (resolved?.model.source ?? (settings?.defaultModel ? "agent-nav" : "builtin")) : "last",
    effortSource: lastEffort === undefined ? (resolved?.effort.source ?? (settings?.defaultEffort ? "agent-nav" : "builtin")) : "last",
    permissionSource: lastPermission === undefined ? (resolved?.permissionMode.source ?? (settings?.defaultPermissionMode ? "agent-nav" : "builtin")) : "last",
  };
}

export function useDraftDefaults(): DraftDefaults {
  const settings = useStore((s) => s.settings);
  const resolved = useStore((s) => s.defaults);
  const last = useStore((s) => s.lastPicked);
  return draftDefaults(settings, resolved, last);
}

export function currentDraftDefaults(): DraftDefaults {
  const s = getState();
  return draftDefaults(s.settings, s.defaults, s.lastPicked);
}

export function sideChatEffort(picked: EffortLevel | null | undefined, agentEffort: EffortLevel | null | undefined, defaults: EffectiveDefaults, levels: readonly EffortLevel[]): EffortLevel | null {
  const wanted = picked ?? agentEffort ?? defaults.effort;
  if (wanted && levels.includes(wanted)) return wanted;
  return levels.includes("high") ? "high" : (levels[levels.length - 1] ?? null);
}

import { useEffect } from "react";
import { harnessOf, type Agent, type CodexMeta, type EffortLevel, type Harness, type ModelInfo } from "../shared/protocol";
import { activePane, getState, loadAntigravityMeta, loadCodexMeta, loadCursorMeta, useStore, type Pane, type State } from "./store";
import { S } from "./strings";

type StateLike = { agents: Agent[]; draftHarness: Record<string, Harness>; lastPicked: { harness?: Harness } };
type ProviderStateLike = StateLike & { draftProvider: Record<string, string | null>; lastPicked: { harness?: Harness; providerId?: string | null }; customProviders: { id: string }[] | null };

export function paneProviderId(s: ProviderStateLike, pane: Pane): string | null {
  if (paneHarness(s, pane) !== "claude") return null;
  if (pane.kind === "agent") return s.agents.find((a) => a.id === pane.agentId)?.providerId ?? null;
  if (pane.handoff) return null;
  const picked = pane.id in s.draftProvider ? s.draftProvider[pane.id] : (s.lastPicked.providerId ?? null);
  return picked && s.customProviders?.some((p) => p.id === picked) ? picked : null;
}

export function activeProviderId(): string | null {
  return paneProviderId(getState(), activePane());
}

export function usePaneProviderOfActive(): string | null {
  return useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return pane ? paneProviderId(s, pane) : null;
  });
}

export function useCustomProvider(providerId: string | null | undefined) {
  return useStore((s) => (providerId ? (s.customProviders?.find((p) => p.id === providerId) ?? null) : null));
}

export function usePaneProvider(paneId: string): string | null {
  return useStore((s) => {
    const pane = s.panes.find((p) => p.id === paneId);
    return pane ? paneProviderId(s, pane) : null;
  });
}

export function paneHarness(s: StateLike, pane: Pane): Harness {
  if (pane.kind === "agent") {
    const agent = s.agents.find((a) => a.id === pane.agentId);
    return agent ? harnessOf(agent) : "claude";
  }
  if (pane.handoff) return "claude";
  return s.draftHarness[pane.id] ?? s.lastPicked.harness ?? "claude";
}

export function activeHarness(): Harness {
  return paneHarness(getState(), activePane());
}

export function usePaneHarness(paneId: string, agent: Agent | null): Harness {
  return useStore((s) => {
    if (agent) return harnessOf(agent);
    const pane = s.panes.find((p) => p.id === paneId);
    return pane ? paneHarness(s, pane) : (s.draftHarness[paneId] ?? s.lastPicked.harness ?? "claude");
  });
}

export function toolMetaOf(s: Pick<State, "codexMeta" | "antigravityMeta" | "cursorMeta">, harness: Harness): CodexMeta | null {
  return harness === "antigravity" ? s.antigravityMeta : harness === "cursor" ? s.cursorMeta : harness === "codex" ? s.codexMeta : null;
}

export function useToolMeta(harness: Harness): CodexMeta | null {
  useEffect(() => {
    if (harness === "codex") void loadCodexMeta();
    if (harness === "antigravity") void loadAntigravityMeta();
    if (harness === "cursor") void loadCursorMeta();
  }, [harness]);
  return useStore((s) => toolMetaOf(s, harness));
}

const TOOL_TEXT = {
  codex: { loading: S.codexModelsLoading, notInstalled: S.codexNotInstalled, notSignedIn: S.codexNotSignedIn, loadFailed: S.codexLoadFailed },
  antigravity: { loading: S.antigravityModelsLoading, notInstalled: S.antigravityNotInstalled, notSignedIn: S.antigravityNotSignedIn, loadFailed: S.antigravityLoadFailed },
  cursor: { loading: S.cursorModelsLoading, notInstalled: S.cursorNotInstalled, notSignedIn: S.cursorNotSignedIn, loadFailed: S.cursorLoadFailed },
};

export function toolStatus(harness: Harness, meta: CodexMeta | null): string | null {
  const text = TOOL_TEXT[harness === "claude" ? "codex" : harness];
  if (!meta) return text.loading;
  if (!meta.installed) return text.notInstalled;
  if (!meta.loggedIn) return text.notSignedIn;
  if (!meta.models.length) return meta.error ? text.loadFailed(meta.error) : S.modelsUnavailable;
  return null;
}

export function codexModelInfos(meta: CodexMeta | null): ModelInfo[] {
  return (meta?.models ?? []).map((m) => ({ value: m.value, resolvedModel: m.value, displayName: m.displayName, supportedEffortLevels: m.supportedEffortLevels }));
}

export function codexDefaultModel(meta: CodexMeta | null): string | null {
  return meta?.defaultModel ?? meta?.models.find((m) => m.isDefault)?.value ?? null;
}

export function codexLevels(meta: CodexMeta | null, model: string | null): EffortLevel[] {
  const id = model ?? codexDefaultModel(meta);
  return meta?.models.find((m) => m.value === id)?.supportedEffortLevels ?? meta?.models.find((m) => m.isDefault)?.supportedEffortLevels ?? [];
}

export function codexModelChip(chosen: string | null, activeModel: string | null, meta: CodexMeta | null, fallback = "Codex"): { name: string; id: string | null } {
  const id = chosen ?? activeModel ?? codexDefaultModel(meta);
  if (!id) return { name: fallback, id: null };
  return { name: meta?.models.find((m) => m.value === id)?.displayName ?? id, id };
}

// The provider logo already says "GPT", so the chip shows "GPT-6.2-Sol" as "Sol 6.2".
export function compactModelName(name: string): string {
  const match = /^gpt-(\d+(?:\.\d+)*)-(.+)$/i.exec(name);
  if (!match) return name;
  const variant = match[2]!.split("-").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
  return `${variant} ${match[1]}`;
}

export function usePaneHarnessOfActive(): Harness {
  return useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return pane ? paneHarness(s, pane) : "claude";
  });
}

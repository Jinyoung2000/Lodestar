import { useEffect } from "react";
import { harnessOf, type Agent, type CodexMeta, type EffortLevel, type Harness, type ModelInfo } from "../shared/protocol";
import { activePane, getState, loadCodexMeta, useStore, type Pane } from "./store";

// CODEX: 칸이 어느 도구(Claude, Codex)로 도는지, 그리고 그 도구의 모델 목록. 입력창, 모델과 effort 팝업, 권한 메뉴가 같이 쓴다. 시험: test/codexweb.test.ts

type StateLike = { agents: Agent[]; draftHarness: Record<string, Harness>; lastPicked: { harness?: Harness } };

// 세션 칸이면 그 세션의 도구, 새 세션 화면이면 그 칸에서 고른 도구(없으면 마지막으로 고른 값, 그것도 없으면 claude)
export function paneHarness(s: StateLike, pane: Pane): Harness {
  if (pane.kind === "agent") {
    const agent = s.agents.find((a) => a.id === pane.agentId);
    return agent ? harnessOf(agent) : "claude";
  }
  return s.draftHarness[pane.id] ?? s.lastPicked.harness ?? "claude";
}

export function activeHarness(): Harness {
  return paneHarness(getState(), activePane());
}

export function usePaneHarness(paneId: string, agent: Agent | null): Harness {
  return useStore((s) => (agent ? harnessOf(agent) : (s.draftHarness[paneId] ?? s.lastPicked.harness ?? "claude")));
}

// Codex 칸이 보이면 앱 서버의 모델 목록을 한 번 읽어 둔다
export function useCodexMeta(harness: Harness): CodexMeta | null {
  useEffect(() => {
    if (harness === "codex") void loadCodexMeta();
  }, [harness]);
  return useStore((s) => s.codexMeta);
}

// Codex 모델을 Claude 쪽 팝업이 읽는 ModelInfo 모양으로 맞춘다. resolvedModel 은 모델 id 그대로다.
export function codexModelInfos(meta: CodexMeta | null): ModelInfo[] {
  return (meta?.models ?? []).map((m) => ({ value: m.value, resolvedModel: m.value, displayName: m.displayName, supportedEffortLevels: m.supportedEffortLevels }));
}

export function modelsOfHarness(harness: Harness): ModelInfo[] {
  const s = getState();
  return harness === "codex" ? codexModelInfos(s.codexMeta) : (s.meta?.models ?? []);
}

// 모델을 고르지 않은 Codex 세션이 쓰는 모델(~/.codex/config.toml 의 값, 없으면 목록의 기본 모델)
export function codexDefaultModel(meta: CodexMeta | null): string | null {
  return meta?.defaultModel ?? meta?.models.find((m) => m.isDefault)?.value ?? null;
}

// Codex 모델이 지원하는 effort 단계. 모델 정보가 없으면 빈 목록이다(팝업이 Codex 기본값만 보인다).
export function codexLevels(meta: CodexMeta | null, model: string | null): EffortLevel[] {
  const id = model ?? codexDefaultModel(meta);
  return meta?.models.find((m) => m.value === id)?.supportedEffortLevels ?? meta?.models.find((m) => m.isDefault)?.supportedEffortLevels ?? [];
}

// 입력창 모델 칩에 보일 이름. 고르지 않았으면 config.toml 의 모델이고, 목록에 없는 id 도 그대로 보인다.
export function codexModelChip(chosen: string | null, activeModel: string | null, meta: CodexMeta | null): { name: string; id: string | null } {
  const id = chosen ?? activeModel ?? codexDefaultModel(meta);
  if (!id) return { name: "Codex", id: null };
  return { name: meta?.models.find((m) => m.value === id)?.displayName ?? id, id };
}

// 활성 칸의 도구(팝업은 활성 칸의 입력창 칩 위에 열린다)
export function usePaneHarnessOfActive(): Harness {
  return useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return pane ? paneHarness(s, pane) : "claude";
  });
}

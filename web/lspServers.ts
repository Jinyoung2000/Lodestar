import type { LspServerState } from "./store";

// 에디터 머리줄의 상태 표시에 쓰는 언어 서버 요약. 주 서버(TypeScript) 라벨 뒤에 함께 도는 서버를 잇는다: "TS 7.0 + Relay".
// 서버 목록은 데몬의 멀티플렉서가 알린 $/lodestar/servers 다. 아직 안 뜬 서버(idle)는 적지 않고, 뜨는 중과 실패는 괄호로 표시한다.
export function lspSummary(primaryLabel: string | undefined, servers: readonly LspServerState[] | undefined): string | undefined {
  const others = (servers ?? []).filter((server) => !server.primary && server.state !== "idle");
  if (others.length === 0) return primaryLabel;
  const primary = primaryLabel ? shortTypescriptLabel(primaryLabel) : (servers ?? []).find((server) => server.primary)?.label;
  const names = others.map((server) => (server.state === "ready" ? server.label : `${server.label} (${server.state === "failed" ? "failed" : "starting"})`));
  return [primary, ...names].filter(Boolean).join(" + ");
}

// "TypeScript 7.0.2 (native)" 는 "TS 7.0", "TypeScript 5.9.3 (bundled)" 는 "TS 5.9 (bundled)".
export function shortTypescriptLabel(label: string): string {
  const match = /^TypeScript (\d+)\.(\d+)[\d.]*(?: \((.+)\))?$/.exec(label);
  if (!match) return label;
  const [, major, minor, source] = match;
  return `TS ${major}.${minor}${source && source !== "native" ? ` (${source})` : ""}`;
}

// 함께 도는 서버 중 시작하지 못했거나 죽은 것. 사용자가 손댈 수 있는 경우(예: watchman 설치)가 있어 이유를 표시한다.
export function failedServers(servers: readonly LspServerState[] | undefined): { label: string; reason: string }[] {
  return (servers ?? []).filter((server) => !server.primary && server.state === "failed").map((server) => ({ label: server.label, reason: server.reason ?? "stopped" }));
}

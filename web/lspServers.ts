import type { LspServerState } from "./store";

export function lspSummary(primaryLabel: string | undefined, servers: readonly LspServerState[] | undefined): string | undefined {
  const others = (servers ?? []).filter((server) => !server.primary && server.state !== "idle");
  if (others.length === 0) return primaryLabel;
  const primary = primaryLabel ? shortTypescriptLabel(primaryLabel) : (servers ?? []).find((server) => server.primary)?.label;
  const names = others.map((server) => (server.state === "ready" ? server.label : `${server.label} (${server.state === "failed" ? "failed" : "starting"})`));
  return [primary, ...names].filter(Boolean).join(" + ");
}

export function shortTypescriptLabel(label: string): string {
  const match = /^TypeScript (\d+)\.(\d+)[\d.]*(?: \((.+)\))?$/.exec(label);
  if (!match) return label;
  const [, major, minor, source] = match;
  return `TS ${major}.${minor}${source && source !== "native" ? ` (${source})` : ""}`;
}

export function failedServers(servers: readonly LspServerState[] | undefined): { label: string; reason: string }[] {
  return (servers ?? []).filter((server) => !server.primary && server.state === "failed").map((server) => ({ label: server.label, reason: server.reason ?? "stopped" }));
}

import type { PrCheck } from "../shared/prTypes";

const ORDER: Record<PrCheck["state"], number> = { failure: 0, pending: 1, success: 2, neutral: 3 };

export function sortChecks(checks: PrCheck[]): PrCheck[] {
  return [...checks].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}

export function summarizeChecks(checks: PrCheck[]): string {
  const count = (state: PrCheck["state"]) => checks.filter((c) => c.state === state).length;
  const parts: [number, string][] = [
    [count("failure"), "failing"],
    [count("pending"), "pending"],
    [count("success"), "passing"],
    [count("neutral"), "skipped"],
  ];
  return parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(", ");
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

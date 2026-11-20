import type { PrCheck } from "../shared/prTypes";

// Checks 구역의 순수 계산: 정렬(실패, 진행 중, 건너뜀, 성공 순이 아니라 실패와 진행 중을 위로), 요약 문구, 걸린 시간.
const ORDER: Record<PrCheck["state"], number> = { failure: 0, pending: 1, success: 2, neutral: 3 };

export function sortChecks(checks: PrCheck[]): PrCheck[] {
  return [...checks].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}

// "2 failing, 1 pending, 19 passing". 0 인 상태는 뺀다. 건너뜀은 "skipped" 로 센다.
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

// 1m 5s, 41s, 2h 3m. 1초 미만은 "<1s".
export function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

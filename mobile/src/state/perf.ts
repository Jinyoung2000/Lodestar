export type Metric = { name: string; ms: number; at: number; detail?: string };

const metrics: Metric[] = [];
const marks = new Map<string, number>();
const listeners = new Set<() => void>();

export const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function markStart(name: string) {
  marks.set(name, now());
}

export function markEnd(name: string, detail?: string): number | null {
  const start = marks.get(name);
  if (start === undefined) return null;
  marks.delete(name);
  const ms = Math.round((now() - start) * 10) / 10;
  record(name, ms, detail);
  return ms;
}

export function record(name: string, ms: number, detail?: string) {
  metrics.push({ name, ms, at: Date.now(), detail });
  if (metrics.length > 60) metrics.shift();
  console.log(`[perf] ${name} ${ms}ms${detail ? ` (${detail})` : ""}`);
  for (const listener of listeners) listener();
}

export const allMetrics = () => metrics;

export function subscribeMetrics(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

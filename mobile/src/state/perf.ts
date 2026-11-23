const marks = new Map<string, number>();

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
  console.log(`[perf] ${name} ${ms}ms${detail ? ` (${detail})` : ""}`);
}

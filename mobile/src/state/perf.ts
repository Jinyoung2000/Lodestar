// 성능 계측: 이름 붙인 구간의 걸린 시간을 모아 Settings 의 Diagnostics 에 보이고, 개발 서버 로그에도 한 줄 남긴다.
// 앱 번들이 개발 모드(Expo Go)로 돌 때의 값이라 릴리스 빌드보다 느리다.
export type Metric = { name: string; ms: number; at: number; detail?: string };

const metrics: Metric[] = [];
const marks = new Map<string, number>();
const listeners = new Set<() => void>();

export const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function markStart(name: string) {
  marks.set(name, now());
}

// markStart 이후 걸린 시간을 기록한다. 시작 표시가 없으면 무시한다. 한 번 끝낸 표시는 지운다.
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

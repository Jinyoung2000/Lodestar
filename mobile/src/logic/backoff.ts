const STEPS_MS = [250, 500, 1000, 2000, 3000, 5000];

export function reconnectDelay(attempt: number, jitter = Math.random()): number {
  const base = STEPS_MS[Math.min(Math.max(0, Math.floor(attempt)), STEPS_MS.length - 1)];
  return Math.round(base * (0.8 + jitter * 0.4));
}

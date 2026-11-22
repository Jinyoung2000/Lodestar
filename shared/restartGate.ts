
export const RESTART_MIN_MS = 20_000;
export const RESTART_MAX_MS = 60_000;
export const CLIENT_SETTLE_MS = 3_000;

export type RestartClock = {
  now: number;
  startedAt: number;
  firstClientAt?: number | null;
};

export function restartWaitMs({ now, startedAt, firstClientAt }: RestartClock): number {
  const up = now - startedAt;
  const min = Math.max(0, RESTART_MIN_MS - up);
  if (firstClientAt === undefined) return min;
  if (firstClientAt === null) return Math.max(min, up >= RESTART_MAX_MS ? 0 : 1000);
  return Math.max(min, CLIENT_SETTLE_MS - (now - firstClientAt));
}

export type RestartOutcome = { deferred: false } | { deferred: true; inMs: number };

type Handle = unknown;
export type RestartSchedulerDeps = {
  now: () => number;
  wait: () => number;
  run: () => void;
  setTimer: (fn: () => void, ms: number) => Handle;
  clearTimer: (handle: Handle) => void;
};

export class RestartScheduler {
  private timer: Handle | null = null;
  private dueAt = 0;
  private started = false;

  constructor(private deps: RestartSchedulerDeps) {}

  request(): RestartOutcome {
    if (this.started) return { deferred: true, inMs: 0 };
    if (this.timer !== null) return { deferred: true, inMs: Math.max(0, this.dueAt - this.deps.now()) };
    const wait = this.deps.wait();
    if (wait <= 0) {
      this.start();
      return { deferred: false };
    }
    this.arm(wait);
    return { deferred: true, inMs: wait };
  }

  cancel() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  reset() {
    this.cancel();
    this.started = false;
  }

  pending() {
    return this.timer !== null;
  }

  private arm(ms: number) {
    this.dueAt = this.deps.now() + ms;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      const wait = this.deps.wait();
      if (wait > 0) this.arm(wait);
      else this.start();
    }, ms);
  }

  private start() {
    this.started = true;
    this.deps.run();
  }
}

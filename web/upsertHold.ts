export type Schedule = (run: () => void) => () => void;

export class UpsertHold<K, E> {
  private held = new Map<K, E>();
  private cancel: (() => void) | null = null;

  constructor(
    private readonly deliver: (events: E[]) => void,
    private readonly schedule: Schedule,
  ) {}

  hold(key: K, event: E) {
    this.held.set(key, event);
    if (!this.cancel) this.cancel = this.schedule(() => this.release());
  }

  release() {
    this.cancel?.();
    this.cancel = null;
    if (!this.held.size) return;
    const events = [...this.held.values()];
    this.held.clear();
    this.deliver(events);
  }

  get size() {
    return this.held.size;
  }
}

export const frameOrTimeout =
  (maxMs: number): Schedule =>
  (run) => {
    const frame = requestAnimationFrame(run);
    const timer = window.setTimeout(run, maxMs);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  };

export const frameAfterGap = (minGapMs: number, maxMs: number, now: () => number = () => performance.now()): Schedule => {
  let last = -Infinity;
  return (run) => {
    let frame = 0;
    const go = () => {
      cancel();
      last = now();
      run();
    };
    const wait = Math.max(0, last + minGapMs - now());
    const gap = wait > 0 ? window.setTimeout(() => (frame = requestAnimationFrame(go)), wait) : 0;
    if (wait === 0) frame = requestAnimationFrame(go);
    const timer = window.setTimeout(go, Math.max(maxMs, wait));
    const cancel = () => {
      window.clearTimeout(gap);
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
    return cancel;
  };
};

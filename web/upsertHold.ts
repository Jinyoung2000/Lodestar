// 같은 항목의 갱신을 한 프레임에 마지막 것 하나로 줄인다(web/rpc.ts 가 timelineUpsert 에 쓴다).
// 응답 글은 토큰이 올 때마다 항목 전체가 다시 오므로, 이벤트 수만큼 화면을 다시 그리면 프레임 수보다 훨씬 많이 그린다.
// 항목이 처음 나온 순서는 지키고, 같은 항목이 다시 오면 그 자리의 값만 바꾼다. 다른 종류의 메시지가 오면 쥐고 있던 것을 먼저 내보내 순서를 지킨다(release).
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

  // 쥐고 있는 갱신을 지금 내보낸다. 예약된 내보내기는 취소한다.
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

// 다음 프레임 또는 maxMs 뒤 중 먼저 오는 때. 숨은 창은 rAF 가 멈추므로 시간으로도 내보낸다.
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

// frameOrTimeout 에 내보내기 사이의 최소 간격을 더한다. 지난 내보내기에서 minGapMs 가 지나기 전에는 프레임을 기다리지 않고 그때까지 미룬다.
// 응답 글 갱신은 보통 프레임보다 드물게(초당 20~60번) 와서, 프레임마다 내보내면 결국 이벤트마다 대화를 다시 그린다. 간격을 두면 그 사이 갱신이 하나로 합쳐진다(PERF2).
// 숨은 창이나 rAF 가 늦는 경우에도 지난 내보내기에서 maxMs 안에는 내보낸다.
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

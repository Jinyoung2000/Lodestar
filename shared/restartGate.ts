// 데몬 재시작을 붙여서 걸지 않게 하는 판단. 새 데몬이 뜬 직후에는 창이 다시 읽히고 첫 연결을 맺는 중이라, 그 위에 재시작이 또 오면 창이 죽어 가는 데몬 주소를 읽는다.
// 재시작 요청(daemon.restartIfIdle, feedback.restart, 메뉴 Restart Daemon)은 이 판단을 거쳐 바로 실행하거나, 기다렸다가 한 번으로 합쳐 실행한다(test/restartgate.test.ts).

// 새 데몬이 뜬 뒤 최소로 기다리는 시간
export const RESTART_MIN_MS = 20_000;
// 창이 아직 연결을 맺지 않았어도 이 시간이 지나면 기다리지 않는다(창 없이 도는 데몬)
export const RESTART_MAX_MS = 60_000;
// 첫 창이 연결한 뒤 상태를 받아 가는 시간
export const CLIENT_SETTLE_MS = 3_000;

export type RestartClock = {
  now: number;
  // 이 데몬 프로세스가 뜬 시각
  startedAt: number;
  // 첫 창이 데몬에 연결한 시각. null 이면 아직 연결한 창이 없고, undefined 이면 창 연결을 기다리지 않는다(창이 있는 메인 프로세스 쪽 판단).
  firstClientAt?: number | null;
};

// 지금 재시작해도 되기까지 남은 시간(ms). 0 이면 바로 해도 된다.
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
  // 지금 재시작해도 되기까지 남은 시간(ms). 0 이하면 된다.
  wait: () => number;
  // 실제 재시작을 시작한다
  run: () => void;
  setTimer: (fn: () => void, ms: number) => Handle;
  clearTimer: (handle: Handle) => void;
};

// 재시작 요청을 받아 바로 실행하거나 기다렸다가 한 번만 실행한다. 기다리는 동안 온 요청은 먼저 걸린 타이머에 합쳐진다.
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

  // 기다리는 요청이 있으면 취소한다(그 사이 데몬이 다시 떠서 요청이 이미 이뤄진 경우)
  cancel() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  // 새 데몬이 떴다: 기다리던 요청은 이뤄진 것으로 보고 비우고, 다음 요청부터 새 데몬의 시작 시각을 기준으로 다시 판단한다(데몬이 바뀌어도 살아 있는 메인 프로세스용).
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

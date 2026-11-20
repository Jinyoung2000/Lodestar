// 데몬 재시작 합류점 단독 시험(shared/restartGate.ts): 쿨다운 판단, 합치기, 대기 중 취소.
// 실행: npm test
import { CLIENT_SETTLE_MS, RESTART_MAX_MS, RESTART_MIN_MS, RestartScheduler, restartWaitMs } from "../shared/restartGate";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

// 1. 판단: 시작 뒤 최소 시간, 첫 창 연결, 창 없이 도는 데몬의 상한
check("just started: waits out the minimum", restartWaitMs({ now: 5_000, startedAt: 0, firstClientAt: 1_000 }) === RESTART_MIN_MS - 5_000);
check("no window yet after the minimum: polls every second", restartWaitMs({ now: RESTART_MIN_MS, startedAt: 0, firstClientAt: null }) === 1000);
check("no window for the max time: stops waiting for one", restartWaitMs({ now: RESTART_MAX_MS, startedAt: 0, firstClientAt: null }) === 0);
check("window connected just now: waits for it to settle", restartWaitMs({ now: 30_000, startedAt: 0, firstClientAt: 29_000 }) === CLIENT_SETTLE_MS - 1_000);
check("settled window after the minimum: go", restartWaitMs({ now: 40_000, startedAt: 0, firstClientAt: 5_000 }) === 0);
check("main process (no client check): only the minimum", restartWaitMs({ now: 10_000, startedAt: 0 }) === RESTART_MIN_MS - 10_000 && restartWaitMs({ now: RESTART_MIN_MS, startedAt: 0 }) === 0);

// 가짜 시계와 타이머
function harness(waits: () => number) {
  let clock = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const runs: number[] = [];
  const scheduler = new RestartScheduler({
    now: () => clock,
    wait: waits,
    run: () => runs.push(clock),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
  });
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      clock = next[1].at;
      next[1].fn();
    }
    clock = end;
  };
  return { scheduler, advance, runs, timers, now: () => clock };
}

// 2. 쿨다운이 지났으면 바로 실행
{
  const h = harness(() => 0);
  const out = h.scheduler.request();
  check("past the cooldown: runs at once", out.deferred === false && h.runs.length === 1);
  const again = h.scheduler.request();
  check("a second request after it started is not run twice", again.deferred === true && h.runs.length === 1);
}

// 3. 쿨다운 안이면 미루고, 그 사이 온 요청은 하나로 합친다
{
  let wait = 12_000;
  const h = harness(() => wait);
  const first = h.scheduler.request();
  check("inside the cooldown: deferred with the wait", first.deferred === true && first.inMs === 12_000 && h.runs.length === 0);
  h.advance(4_000);
  const second = h.scheduler.request();
  const third = h.scheduler.request();
  check("later requests join the pending one with the time left", second.deferred === true && second.inMs === 8_000 && third.deferred === true, JSON.stringify(second));
  check("one timer for all requests", h.timers.size === 1);
  wait = 0;
  h.advance(8_000);
  check("runs once when the cooldown ends", h.runs.length === 1 && h.runs[0] === 12_000, JSON.stringify(h.runs));
  check("nothing is left pending", !h.scheduler.pending() && h.timers.size === 0);
}

// 4. 기다리는 동안 조건이 바뀌면(도는 세션이 생김) 끝날 때까지 더 기다린다
{
  let wait = 5_000;
  const h = harness(() => wait);
  h.scheduler.request();
  wait = 1_000;
  h.advance(5_000);
  check("still busy when the timer fires: waits again", h.runs.length === 0 && h.scheduler.pending());
  h.advance(1_000);
  check("keeps waiting while busy", h.runs.length === 0 && h.scheduler.pending());
  wait = 0;
  h.advance(1_000);
  check("runs once idle", h.runs.length === 1 && !h.scheduler.pending());
}

// 5. 취소와 초기화
{
  const h = harness(() => 10_000);
  h.scheduler.request();
  h.scheduler.cancel();
  h.advance(20_000);
  check("a cancelled request never runs", h.runs.length === 0 && !h.scheduler.pending());
  const h2 = harness(() => 0);
  h2.scheduler.request();
  h2.scheduler.reset();
  h2.scheduler.request();
  check("after reset (a new daemon) the next request can run again", h2.runs.length === 2);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");

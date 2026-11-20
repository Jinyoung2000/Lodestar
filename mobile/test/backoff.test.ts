import { reconnectDelay } from "../src/logic/backoff";
import { relativeTime } from "../src/logic/time";
import { expect, run, test } from "./harness";

test("재연결 간격: 빠르게 시작해 5초에서 멈추고 ±20% 안에서 흔든다", () => {
  const mid = [0, 1, 2, 3, 4, 5, 6, 20].map((n) => reconnectDelay(n, 0.5));
  expect(mid.join() === "250,500,1000,2000,3000,5000,5000,5000", mid.join());
  expect(reconnectDelay(2, 0) === 800 && reconnectDelay(2, 1) === 1200, "jitter range");
  expect(reconnectDelay(-3, 0.5) === 250, "negative attempt");
  return mid.join();
});

test("relativeTime", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), now);
  expect([ago(5_000), ago(5 * 60_000), ago(3 * 3600_000), ago(2 * 86400_000)].join() === "now,5m,3h,2d", "buckets");
  return "ok";
});

void run();

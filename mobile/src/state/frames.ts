import { record } from "./perf";

export function createFrameMeter(label: string) {
  let raf = 0;
  let last = 0;
  let deltas: number[] = [];
  let running = false;
  const tick = (time: number) => {
    if (last) deltas.push(time - last);
    last = time;
    raf = requestAnimationFrame(tick);
  };
  return {
    start() {
      if (running) return;
      running = true;
      deltas = [];
      last = 0;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
      if (deltas.length < 5) return;
      const total = deltas.reduce((a, b) => a + b, 0);
      const slow = deltas.filter((d) => d > 20).length;
      const worst = Math.round(Math.max(...deltas));
      record(label, Math.round((total / deltas.length) * 10) / 10, `avg frame, ${deltas.length} frames, worst ${worst}ms, ${slow} over 20ms`);
    },
  };
}

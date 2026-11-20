// 스크롤 중 JS 스레드가 프레임을 얼마나 제때 그리는지 잰다(requestAnimationFrame 간격). 스크롤 자체는 네이티브라 부드러워도 행을 그리는 JS 가 밀리면 빈 칸이 보인다.
// 개발 모드(Expo Go)의 값이라 릴리스보다 느리다. 결과는 Settings 의 Diagnostics 에 쌓인다.
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

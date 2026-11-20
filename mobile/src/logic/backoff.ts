// 재연결 간격: 끊긴 직후는 빠르게, 계속 실패하면 5초까지 늘린다(같은 네트워크의 Mac 이라 길게 기다릴 이유가 없고, 데몬이 돌아온 뒤 최대 5초 안에 붙는다). 앱이 앞으로 오면 호출하는 쪽이 attempt 를 0 으로 되돌려 바로 시도한다.
const STEPS_MS = [250, 500, 1000, 2000, 3000, 5000];

// jitter 는 0..1 난수(시험에서는 고정값). 같은 순간에 끊긴 여러 기기가 동시에 몰리지 않게 ±20% 흔든다.
export function reconnectDelay(attempt: number, jitter = Math.random()): number {
  const base = STEPS_MS[Math.min(Math.max(0, Math.floor(attempt)), STEPS_MS.length - 1)];
  return Math.round(base * (0.8 + jitter * 0.4));
}

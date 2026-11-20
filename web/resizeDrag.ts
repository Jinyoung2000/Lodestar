// 경계 끌개(web/Resizer.tsx)가 끄는 동안 켜는 표시와 크기 계산. DOM 을 몰라서 단위 시험이 그대로 가져다 쓴다(test/resizedrag.test.ts).

// 끌기 시작 크기에 이동 거리를 방향(direction)대로 더하고 [min, max(min, limit)] 안으로 자른다. 정수 px 로 돌려준다.
// direction -1 은 왼쪽이나 위로 끌수록 커지는 패널이다. limit 이 min 보다 작으면 min 이 이긴다(창이 좁을 때).
export function dragSize(startSize: number, delta: number, direction: 1 | -1, min: number, limit: number): number {
  return Math.round(Math.min(Math.max(startSize + delta * direction, min), Math.max(min, limit)));
}

// 끄는 동안 비싼 재측정(web/stuckBubble.ts 의 경계 재계산 등)을 미루고 놓을 때 한 번만 하게 하는 표시.
// 끌개가 동시에 둘 눌릴 일은 없지만 짝이 안 맞아도 영영 켜지지 않도록 횟수로 센다.
let depth = 0;
const endListeners = new Set<() => void>();

export function isResizing(): boolean {
  return depth > 0;
}

export function beginResize() {
  depth++;
}

export function endResize() {
  depth = Math.max(0, depth - 1);
  if (depth === 0) for (const listener of [...endListeners]) listener();
}

// 모든 끌기가 끝났을 때 불린다. 돌려주는 함수가 구독을 끝낸다.
export function onResizeEnd(listener: () => void): () => void {
  endListeners.add(listener);
  return () => void endListeners.delete(listener);
}

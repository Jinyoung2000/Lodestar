
export function dragSize(startSize: number, delta: number, direction: 1 | -1, min: number, limit: number): number {
  return Math.round(Math.min(Math.max(startSize + delta * direction, min), Math.max(min, limit)));
}

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

export function onResizeEnd(listener: () => void): () => void {
  endListeners.add(listener);
  return () => void endListeners.delete(listener);
}

const handlers = new Map<string, () => void>();

export function registerReveal(paneId: string, reveal: () => void) {
  handlers.set(paneId, reveal);
  return () => {
    if (handlers.get(paneId) === reveal) handlers.delete(paneId);
  };
}

export function revealAllSteps(paneId: string): boolean {
  const reveal = handlers.get(paneId);
  reveal?.();
  return !!reveal;
}

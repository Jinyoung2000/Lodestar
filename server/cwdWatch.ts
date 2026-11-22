import { stat } from "node:fs/promises";

export async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function watchDirectory(path: string, onGone: () => void, options: { intervalMs?: number; exists?: (path: string) => Promise<boolean> } = {}): () => void {
  const exists = options.exists ?? isDirectory;
  let stopped = false;
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void exists(path)
      .then((present) => {
        if (stopped || present) return;
        stop();
        onGone();
      })
      .finally(() => {
        checking = false;
      });
  }, options.intervalMs ?? 1000);
  timer.unref();
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}

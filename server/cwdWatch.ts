import { stat } from "node:fs/promises";

export async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// 작업 폴더가 사라졌는지 주기로 확인한다. 사라진 것을 처음 본 때 onGone 을 한 번 부르고 멈춘다.
// fs.watch 는 macOS 에서 폴더가 지워지면 감시가 조용히 끊기고, 폴더가 아닌 상위 폴더에서 이름이 바뀐 것인지 구분도 안 돼서 stat 으로 확인한다.
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

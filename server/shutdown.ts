import type { TerminateReport } from "./processGroups";

export type ShutdownDeps = {
  flush: () => void;
  notifyFlushed: () => void;
  closeRuns: () => void;
  closeMeta: () => void;
  groupLeaders: () => number[];
  terminate: (roots: number[]) => Promise<TerminateReport>;
  sleep: (ms: number) => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
  now: () => number;
  politeWaitMs?: number;
  hardLimitMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
};

export const POLITE_WAIT_MS = 300;
export const DAEMON_HARD_LIMIT_MS = 4000;

export function createDaemonShutdown(deps: ShutdownDeps) {
  let started = false;
  const polite = deps.politeWaitMs ?? POLITE_WAIT_MS;
  const hardLimit = deps.hardLimitMs ?? DAEMON_HARD_LIMIT_MS;

  return async function shutdown(reason: string): Promise<void> {
    if (started) return;
    started = true;
    const t0 = deps.now();
    const since = () => `+${deps.now() - t0}ms`;
    deps.log(`[shutdown] start reason=${reason}`);
    const timer = (deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      deps.log(`[shutdown] hard limit ${hardLimit}ms reached, exiting without finishing ${since()}`);
      deps.exit(0);
    }, hardLimit);
    void timer;

    safely(deps, "flush", () => deps.flush());
    deps.log(`[shutdown] flush done ${since()}`);
    deps.notifyFlushed();

    safely(deps, "close-runs", () => {
      deps.closeMeta();
      deps.closeRuns();
    });
    safely(deps, "flush-2", () => deps.flush());
    deps.log(`[shutdown] runs closed, second flush done ${since()}`);

    if (deps.groupLeaders().length > 0) await deps.sleep(polite);
    const roots = deps.groupLeaders();
    try {
      const report = await deps.terminate(roots);
      deps.log(`[shutdown] terminate groups=${report.roots} members=${report.members} survivedTerm=${report.stillAliveAfterTerm} sigkill=${report.killed} remaining=${report.remaining} terminateMs=${report.ms} ${since()}`);
    } catch (error) {
      deps.log(`[shutdown] terminate failed: ${String(error)} ${since()}`);
    }
    deps.log(`[shutdown] exiting ${since()}`);
    deps.exit(0);
  };
}

function safely(deps: ShutdownDeps, name: string, fn: () => void) {
  try {
    fn();
  } catch (error) {
    deps.log(`[shutdown] ${name} failed: ${String(error)}`);
  }
}

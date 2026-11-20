import type { TerminateReport } from "./processGroups";

// 데몬이 끝나기 전에 해야 할 일의 순서. SIGTERM, 부모의 shutdown 메시지, 부모 연결 끊김이 모두 같은 함수를 부른다.
// 6회차 발견 1: SIGTERM 은 Node 기본 처리로 즉사해서 미뤄 둔 타임라인 저장(500ms 디바운스)과 CLI 정리를 건너뛰었다.
export type ShutdownDeps = {
  // 미뤄 둔 저장을 동기로 쓴다
  flush: () => void;
  // 부모(Electron 메인)에게 flush 가 끝났다고 알린다
  notifyFlushed: () => void;
  // CLI 에 정상 종료를 요청한다: 입력을 닫는다
  closeRuns: () => void;
  closeMeta: () => void;
  groupLeaders: () => number[];
  terminate: (roots: number[]) => Promise<TerminateReport>;
  sleep: (ms: number) => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
  now: () => number;
  // 입력을 닫은 뒤 CLI 가 스스로 끝나기를 기다리는 시간
  politeWaitMs?: number;
  // 이 시간 안에 못 끝나면 남은 단계를 건너뛰고 나간다
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
    // 닫는 도중 타임라인이 더 바뀐다(진행 중이던 도구 호출을 멈춤으로 표시 등). 한 번 더 쓴다.
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

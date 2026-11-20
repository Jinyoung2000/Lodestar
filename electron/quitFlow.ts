// 앱 종료 순서와 상한. electron 을 import 하지 않아 test/quitflow.test.ts 가 가짜 타이머로 돌린다.
// 6회차 점검에서 사용자의 앱이 SIGTERM 뒤 메인 프로세스가 끝나기까지 최대 4분 30초 걸렸고, 어느 단계였는지 로그가 없어 못 짚었다.
// 그래서 단계마다 한 줄을 남기고, 전체에 상한을 둬서 어느 단계가 막히든 상한에서 app.exit 로 끝낸다.

export const QUIT_LIMIT_MS = 5000;
// 창이 안 닫히면 이만큼만 기다리고 데몬 종료로 넘어간다.
export const WINDOW_CLOSE_MS = 1500;
// 마지막 app.quit() 뒤 will-quit 이 안 오면 누가 종료를 취소한 것으로 본다.
export const CANCEL_WATCH_MS = 2000;

export type QuitDeps = {
  now: () => number;
  log: (message: string) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  // 열려 있는 창을 닫고 모두 닫히면 끝나는 약속. 닫는 도중의 close, closed 는 부르는 쪽이 note 로 남긴다.
  closeWindows: () => Promise<void>;
  // 창 밖에서 도는 보조 자원(Playwright 실행기 등)
  closeHelpers: () => void;
  // 데몬에 종료 요청을 보낸다. 데몬이 없으면 false.
  requestDaemonShutdown: () => boolean;
  killDaemon: () => void;
  // 정상 종료를 이어 간다(app.quit)
  finishQuit: () => void;
  // 상한 초과: 남은 단계를 건너뛰고 끝낸다(app.exit)
  forceExit: () => void;
  // 종료가 취소돼 앱이 계속 떠 있게 됐을 때 데몬 상태를 되돌린다
  restoreAfterCancel: () => void;
  limitMs?: number;
  windowCloseMs?: number;
  cancelWatchMs?: number;
};

export type QuitDecision = "run" | "wait" | "pass";

type Phase = "idle" | "running" | "finishing";

export class QuitFlow {
  private phase: Phase = "idle";
  private startedAt = 0;
  private limitTimer: unknown = null;
  private cancelTimer: unknown = null;
  private current = "before-quit";
  private waitingDaemon: (() => void) | null = null;
  private daemonGone = false;
  private readonly pending: string[] = [];
  private readonly limitMs: number;
  private readonly windowCloseMs: number;
  private readonly cancelWatchMs: number;

  constructor(private readonly deps: QuitDeps) {
    this.limitMs = deps.limitMs ?? QUIT_LIMIT_MS;
    this.windowCloseMs = deps.windowCloseMs ?? WINDOW_CLOSE_MS;
    this.cancelWatchMs = deps.cancelWatchMs ?? CANCEL_WATCH_MS;
  }

  // 종료가 시작된 뒤에는 데몬을 새로 띄우지 않는다(재시작 backoff, 뜨기 전에 죽은 데몬의 번들 재시도, Restart Daemon, 데몬이 요청한 restart).
  get quitting() {
    return this.phase !== "idle";
  }

  mayStartDaemon() {
    return this.phase === "idle";
  }

  // before-quit 이벤트마다 부른다. run: 지금 종료를 시작했으니 이 이벤트는 막는다. wait: 이미 진행 중이라 막는다(창이 닫히면 window-all-closed 가 app.quit 을 다시 부른다). pass: 단계를 다 마쳤으니 통과.
  onBeforeQuit(): QuitDecision {
    if (this.phase === "finishing") return "pass";
    if (this.phase === "running") return "wait";
    this.phase = "running";
    this.startedAt = this.deps.now();
    this.daemonGone = false;
    this.pending.length = 0;
    this.pending.push("close-windows", "daemon-shutdown", "finish");
    this.note("before-quit");
    this.limitTimer = this.deps.setTimer(() => this.onLimit(), this.limitMs);
    void this.run();
    return "run";
  }

  // 단계 한 줄. 경과 시간은 before-quit 부터 잰다.
  note(event: string, detail?: string) {
    const elapsed = this.phase === "idle" ? 0 : this.deps.now() - this.startedAt;
    this.deps.log(`[electron] quit: ${event} +${elapsed}ms${detail ? ` ${detail}` : ""}`);
  }

  onDaemonMessage(type: string) {
    if (this.phase !== "idle" && type === "shutdown-flushed") this.note("daemon-flushed");
  }

  onDaemonExit(code: number | null) {
    if (this.phase === "idle") return;
    this.note("daemon-exit", `code=${code}`);
    this.daemonGone = true;
    this.waitingDaemon?.();
    this.waitingDaemon = null;
  }

  // 정상 종료가 끝까지 왔다. 상한 타이머는 일부러 지우지 않는다: 이 뒤 Chromium 이 해체되다 멈춰도 상한이 app.exit 로 끝낸다.
  onWillQuit() {
    this.note("will-quit");
    if (this.cancelTimer !== null) this.deps.clearTimer(this.cancelTimer);
    this.cancelTimer = null;
  }

  onQuit() {
    this.note("quit");
  }

  private async run() {
    this.current = "close-windows";
    this.note("close-windows");
    this.deps.closeHelpers();
    await this.waitWindows();
    if (this.phase !== "running") return;
    this.pending.shift();

    this.current = "daemon-shutdown";
    if (this.deps.requestDaemonShutdown()) {
      this.note("daemon-shutdown-sent");
      await this.waitDaemon();
    } else {
      this.note("daemon-shutdown-skipped", "no daemon");
    }
    if (this.phase !== "running") return;
    this.pending.shift();

    this.current = "finish";
    this.pending.shift();
    this.phase = "finishing";
    this.note("app-quit");
    this.cancelTimer = this.deps.setTimer(() => this.onCancelWatch(), this.cancelWatchMs);
    this.deps.finishQuit();
  }

  private waitWindows() {
    return new Promise<void>((resolve) => {
      const cap = this.deps.setTimer(() => {
        this.note("close-windows-timeout", `after ${this.windowCloseMs}ms, continuing`);
        resolve();
      }, this.windowCloseMs);
      void this.deps.closeWindows().then(() => {
        this.deps.clearTimer(cap);
        this.note("windows-closed");
        resolve();
      });
    });
  }

  private waitDaemon() {
    return new Promise<void>((resolve) => {
      if (this.daemonGone) return resolve();
      this.waitingDaemon = resolve;
    });
  }

  // 상한: 남은 단계를 건너뛰고 끝낸다. 무엇을 기다리다 건너뛰는지 남긴다.
  private onLimit() {
    this.limitTimer = null;
    const skipped = this.pending.join(", ") || "none";
    this.note("limit-reached", `after ${this.limitMs}ms while waiting for ${this.current}; skipping: ${skipped}`);
    this.deps.killDaemon();
    this.deps.forceExit();
  }

  // app.quit() 뒤 will-quit 이 안 왔다: 다른 곳이 종료를 막았다. 앱은 계속 떠 있으므로 데몬과 상태를 되돌린다.
  private onCancelWatch() {
    this.cancelTimer = null;
    if (this.phase !== "finishing") return;
    this.cancel("will-quit never arrived after app.quit()");
  }

  cancel(reason: string) {
    if (this.phase === "idle") return;
    this.note("cancelled", reason);
    if (this.limitTimer !== null) this.deps.clearTimer(this.limitTimer);
    if (this.cancelTimer !== null) this.deps.clearTimer(this.cancelTimer);
    this.limitTimer = null;
    this.cancelTimer = null;
    this.waitingDaemon = null;
    this.phase = "idle";
    this.deps.restoreAfterCancel();
  }
}


export const QUIT_LIMIT_MS = 5000;
export const WINDOW_CLOSE_MS = 1500;
export const CANCEL_WATCH_MS = 2000;

export type QuitDeps = {
  now: () => number;
  log: (message: string) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  closeWindows: () => Promise<void>;
  closeHelpers: () => void;
  finishQuit: () => void;
  forceExit: () => void;
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
  private readonly pending: string[] = [];
  private readonly limitMs: number;
  private readonly windowCloseMs: number;
  private readonly cancelWatchMs: number;

  constructor(private readonly deps: QuitDeps) {
    this.limitMs = deps.limitMs ?? QUIT_LIMIT_MS;
    this.windowCloseMs = deps.windowCloseMs ?? WINDOW_CLOSE_MS;
    this.cancelWatchMs = deps.cancelWatchMs ?? CANCEL_WATCH_MS;
  }

  get quitting() {
    return this.phase !== "idle";
  }

  onBeforeQuit(): QuitDecision {
    if (this.phase === "finishing") return "pass";
    if (this.phase === "running") return "wait";
    this.phase = "running";
    this.startedAt = this.deps.now();
    this.pending.length = 0;
    this.pending.push("close-windows", "finish");
    this.note("before-quit");
    this.limitTimer = this.deps.setTimer(() => this.onLimit(), this.limitMs);
    void this.run();
    return "run";
  }

  note(event: string, detail?: string) {
    const elapsed = this.phase === "idle" ? 0 : this.deps.now() - this.startedAt;
    this.deps.log(`[electron] quit: ${event} +${elapsed}ms${detail ? ` ${detail}` : ""}`);
  }

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

  private onLimit() {
    this.limitTimer = null;
    const skipped = this.pending.join(", ") || "none";
    this.note("limit-reached", `after ${this.limitMs}ms while waiting for ${this.current}; skipping: ${skipped}`);
    this.deps.forceExit();
  }

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
    this.phase = "idle";
  }
}

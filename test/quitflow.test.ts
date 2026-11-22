import { CANCEL_WATCH_MS, QUIT_LIMIT_MS, QuitFlow, WINDOW_CLOSE_MS } from "../electron/quitFlow";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

function harness(options: { daemon?: boolean; windows?: "closes" | "hangs" } = {}) {
  let clock = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const log: string[] = [];
  const calls: string[] = [];
  let resolveWindows: (() => void) | null = null;
  const flow: QuitFlow = new QuitFlow({
    now: () => clock,
    log: (m) => log.push(m),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
    closeWindows: () =>
      new Promise<void>((resolve) => {
        calls.push("closeWindows");
        if (options.windows === "hangs") resolveWindows = resolve;
        else resolve();
      }),
    closeHelpers: () => calls.push("closeHelpers"),
    requestDaemonShutdown: () => {
      calls.push("requestDaemonShutdown");
      return options.daemon !== false;
    },
    killDaemon: () => calls.push("killDaemon"),
    finishQuit: () => calls.push("finishQuit"),
    forceExit: () => calls.push("forceExit"),
    restoreAfterCancel: () => calls.push("restoreAfterCancel"),
  });
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      await flush();
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = Math.max(clock, due[1].at);
      timers.delete(due[0]);
      due[1].fn();
    }
    clock = end;
    await flush();
  };
  return { flow, log, calls, advance, setClock: (v: number) => (clock = v), resolveWindows: () => resolveWindows?.(), timers: () => timers.size };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const events = (log: string[]) => log.map((l) => l.replace(/^\[electron\] quit: /, "").replace(/ \+\d+ms.*/, ""));

{
  const h = harness();
  check("first before-quit starts the flow and blocks the event", h.flow.onBeforeQuit() === "run");
  await h.advance(0);
  check("windows are closed before the daemon is asked", h.calls.join(",") === "closeHelpers,closeWindows,requestDaemonShutdown", h.calls.join(","));
  check("app.quit is not called while the daemon is still running", !h.calls.includes("finishQuit"));
  check("a second before-quit while running is blocked without restarting the flow", h.flow.onBeforeQuit() === "wait" && h.calls.filter((c) => c === "closeWindows").length === 1);
  await h.advance(120);
  h.flow.onDaemonMessage("shutdown-flushed");
  await h.advance(300);
  h.flow.onDaemonExit(0);
  await h.advance(0);
  check("app.quit runs after the daemon exits", h.calls.at(-1) === "finishQuit", h.calls.join(","));
  check("the before-quit that app.quit raises passes through", h.flow.onBeforeQuit() === "pass");
  h.flow.onWillQuit();
  h.flow.onQuit();
  const order = events(h.log);
  check("log order", order.join(">") === "before-quit>close-windows>windows-closed>daemon-shutdown-sent>daemon-flushed>daemon-exit>app-quit>will-quit>quit", order.join(">"));
  check("log lines carry the elapsed time since before-quit", h.log.some((l) => l.includes("daemon-flushed +120ms")) && h.log.some((l) => l.includes("daemon-exit +420ms")), h.log.join(" | "));
  await h.advance(QUIT_LIMIT_MS + 100);
  check("the limit still fires after quit if Chromium teardown hangs", h.calls.at(-1) === "forceExit", h.calls.join(","));
}

{
  const h = harness();
  h.flow.onBeforeQuit();
  await h.advance(QUIT_LIMIT_MS - 1);
  check("nothing is forced before the limit", !h.calls.includes("forceExit"));
  await h.advance(1);
  check("at the limit the daemon is killed and the app exits", h.calls.slice(-2).join(",") === "killDaemon,forceExit", h.calls.join(","));
  const line = h.log.find((l) => l.includes("limit-reached")) ?? "";
  check("the limit line names what it was waiting for and what it skipped", line.includes("while waiting for daemon-shutdown") && line.includes("skipping: daemon-shutdown, finish"), line);
  check("app.quit is never called after the limit", !h.calls.includes("finishQuit"));
}

{
  const h = harness({ windows: "hangs" });
  h.flow.onBeforeQuit();
  await h.advance(WINDOW_CLOSE_MS - 1);
  check("daemon is not asked while windows are still closing", !h.calls.includes("requestDaemonShutdown"));
  await h.advance(1);
  check("after the window wait cap the daemon shutdown goes ahead", h.calls.includes("requestDaemonShutdown"));
  check("the window timeout is logged", h.log.some((l) => l.includes("close-windows-timeout")));
  h.flow.onDaemonExit(0);
  await h.advance(0);
  check("the flow still finishes with app.quit", h.calls.at(-1) === "finishQuit");
}

{
  const h = harness({ daemon: false });
  h.flow.onBeforeQuit();
  await h.advance(0);
  check("without a daemon the flow goes straight to app.quit", h.calls.at(-1) === "finishQuit" && h.log.some((l) => l.includes("daemon-shutdown-skipped")), h.calls.join(","));
}

{
  const h = harness();
  check("before quitting, a daemon may be started", h.flow.mayStartDaemon() && !h.flow.quitting);
  h.flow.onBeforeQuit();
  check("once quitting, no daemon may be started (backoff respawn, bundle retry, Restart Daemon, daemon restart request)", !h.flow.mayStartDaemon() && h.flow.quitting);
  await h.advance(0);
  h.flow.onDaemonExit(1);
  await h.advance(0);
  check("still blocked after the daemon exits, through app.quit", !h.flow.mayStartDaemon());
}

{
  const h = harness();
  h.flow.onDaemonExit(1);
  h.flow.onDaemonMessage("shutdown-flushed");
  check("daemon events before quitting write no quit lines", h.log.length === 0, h.log.join("|"));
}

{
  const h = harness();
  h.flow.onBeforeQuit();
  await h.advance(0);
  h.flow.onDaemonExit(0);
  await h.advance(0);
  check("finishing: still counts as quitting", h.flow.quitting);
  await h.advance(CANCEL_WATCH_MS);
  check("no will-quit within the watch window restores the state", h.calls.at(-1) === "restoreAfterCancel" && !h.flow.quitting && h.flow.mayStartDaemon(), h.calls.join(","));
  check("the cancel is logged", h.log.some((l) => l.includes("cancelled")));
  await h.advance(QUIT_LIMIT_MS * 2);
  check("a cancelled quit does not later force-exit", !h.calls.includes("forceExit"));
  check("a new quit after the cancel starts a fresh flow", h.flow.onBeforeQuit() === "run");
}

{
  const h = harness();
  h.flow.onBeforeQuit();
  await h.advance(0);
  h.flow.onDaemonExit(0);
  await h.advance(0);
  h.flow.onWillQuit();
  await h.advance(CANCEL_WATCH_MS + 10);
  check("will-quit arrival disables the cancel watch", !h.calls.includes("restoreAfterCancel"));
}

{
  const h = harness({ windows: "hangs" });
  h.flow.onBeforeQuit();
  await h.advance(0);
  h.flow.onDaemonExit(0);
  h.resolveWindows();
  await h.advance(0);
  check("a daemon that exited during window close does not stall the flow", h.calls.at(-1) === "finishQuit", h.calls.join(","));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");

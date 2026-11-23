import { CANCEL_WATCH_MS, QUIT_LIMIT_MS, QuitFlow, WINDOW_CLOSE_MS } from "../electron/quitFlow";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

function harness(options: { windows?: "closes" | "hangs" } = {}) {
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
    finishQuit: () => calls.push("finishQuit"),
    forceExit: () => calls.push("forceExit"),
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
  const h = harness({ windows: "hangs" });
  check("first before-quit starts the flow and blocks the event", h.flow.onBeforeQuit() === "run");
  check("a second before-quit while running is blocked without restarting the flow", h.flow.onBeforeQuit() === "wait" && h.calls.filter((c) => c === "closeWindows").length === 1);
  await h.advance(120);
  h.resolveWindows();
  await h.advance(0);
  check("app.quit runs after the windows close", h.calls.join(",") === "closeHelpers,closeWindows,finishQuit", h.calls.join(","));
  check("the before-quit that app.quit raises passes through", h.flow.onBeforeQuit() === "pass");
  h.flow.onWillQuit();
  h.flow.onQuit();
  const order = events(h.log);
  check("log order", order.join(">") === "before-quit>close-windows>windows-closed>app-quit>will-quit>quit", order.join(">"));
  check("log lines carry the elapsed time since before-quit", h.log.some((l) => l.includes("windows-closed +120ms")), h.log.join(" | "));
  await h.advance(QUIT_LIMIT_MS + 100);
  check("the limit still fires after quit if Chromium teardown hangs", h.calls.at(-1) === "forceExit", h.calls.join(","));
}

{
  const h = harness();
  h.flow.onBeforeQuit();
  await h.advance(0);
  h.flow.onWillQuit();
  await h.advance(QUIT_LIMIT_MS - 1);
  check("nothing is forced before the limit", !h.calls.includes("forceExit"));
  await h.advance(1);
  check("at the limit the app exits", h.calls.at(-1) === "forceExit", h.calls.join(","));
  const line = h.log.find((l) => l.includes("limit-reached")) ?? "";
  check("the limit line names what it was waiting for and what it skipped", line.includes("while waiting for finish") && line.includes("skipping: none"), line);
}

{
  const h = harness({ windows: "hangs" });
  h.flow.onBeforeQuit();
  await h.advance(WINDOW_CLOSE_MS - 1);
  check("app.quit waits while windows are still closing", !h.calls.includes("finishQuit"));
  await h.advance(1);
  check("the window timeout is logged", h.log.some((l) => l.includes("close-windows-timeout")));
  check("the flow still finishes with app.quit", h.calls.at(-1) === "finishQuit");
}

{
  const h = harness();
  h.flow.onBeforeQuit();
  await h.advance(0);
  check("finishing: still counts as quitting", h.flow.quitting);
  await h.advance(CANCEL_WATCH_MS);
  check("no will-quit within the watch window restores the state", !h.flow.quitting, h.calls.join(","));
  check("the cancel is logged", h.log.some((l) => l.includes("cancelled")));
  await h.advance(QUIT_LIMIT_MS * 2);
  check("a cancelled quit does not later force-exit", !h.calls.includes("forceExit"));
  check("a new quit after the cancel starts a fresh flow", h.flow.onBeforeQuit() === "run");
}

{
  const h = harness();
  h.flow.onBeforeQuit();
  await h.advance(0);
  h.flow.onWillQuit();
  await h.advance(CANCEL_WATCH_MS + 10);
  check("will-quit arrival disables the cancel watch", h.flow.quitting);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");

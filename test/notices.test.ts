import { currentNotices, dismissNotice, HIDE_MS, holdNotice, isStickyNotice, notify } from "../web/notices";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
let nextTimer = 1;
const timers = new Map<number, { ms: number; run: () => void }>();
globalThis.setTimeout = ((run: () => void, ms: number) => {
  const id = nextTimer++;
  timers.set(id, { ms, run });
  return id;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id: number) => void timers.delete(id)) as unknown as typeof clearTimeout;
const live = () => [...timers.values()];

check("VS Code toast times are 10, 12 and 15 seconds", HIDE_MS.info === 10_000 && HIDE_MS.warning === 12_000 && HIDE_MS.error === 15_000);
check("only an error with an action button is sticky", isStickyNotice("error", 1) && !isStickyNotice("error", 0) && !isStickyNotice("warning", 1) && !isStickyNotice("info", 1));

const info = notify({ message: "No files changed" });
check("plain info hides after 10 seconds", live().length === 1 && live()[0].ms === HIDE_MS.info);
live()[0].run();
check("the timer removes the notice", !currentNotices().some((n) => n.id === info));

timers.clear();
notify({ message: "No type here", severity: "warning" });
notify({ message: "Could not copy", severity: "error" });
check("plain warning 12 seconds, plain error 15 seconds", live().map((t) => t.ms).join() === "12000,15000");

timers.clear();
notify({ message: "Applied", actions: [{ label: "Revert", run: () => {} }] });
notify({ message: "Cannot format", severity: "warning", actions: [{ label: "Configure", run: () => {} }] });
check("info and warning with buttons still hide (10 and 12 seconds)", live().map((t) => t.ms).join() === "10000,12000");

timers.clear();
const sticky = notify({ message: "Not applied", severity: "error", actions: [{ label: "Open", run: () => {} }] });
check("error with a button has no timer", live().length === 0 && currentNotices().some((n) => n.id === sticky));
check("explicit autoHideMs still wins (format save notice)", (() => {
  timers.clear();
  notify({ message: "Saved format", severity: "warning", actions: [{ label: "Configure", run: () => {} }], autoHideMs: 15_000, key: "f" });
  return live().length === 1 && live()[0].ms === 15_000;
})());

timers.clear();
const again = notify({ message: "Saved" });
const count = currentNotices().length;
const second = notify({ message: "Saved" });
check("same message replaces instead of stacking", currentNotices().length === count && second !== again && !currentNotices().some((n) => n.id === again));
check("the replaced notice's timer is cancelled and a fresh one starts", live().length === 1);

holdNotice(second, true);
check("hovering stops the timer", live().length === 0);
holdNotice(second, false);
check("leaving restarts the full time", live().length === 1 && live()[0].ms === HIDE_MS.info);
holdNotice(999, true);
check("hold on an unknown id does nothing", live().length === 1);

for (const n of [...currentNotices()]) dismissNotice(n.id);
check("dismissing clears timers", live().length === 0 && currentNotices().length === 0);

globalThis.setTimeout = real.set;
globalThis.clearTimeout = real.clear;
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");

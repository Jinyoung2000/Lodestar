export function requestIdleReload(reload: () => void) {
  pendingReload = reload;
  if (timer === null) evaluate();
}

export const QUIET_MS = 45_000; // lint-tokens: allow 입력이 멈춘 뒤 다시 읽기까지 기다리는 시간(ms)
export const MIN_GAP_MS = 10 * 60_000; // lint-tokens: allow 피드백 반영으로 다시 읽는 최소 간격(ms)
const LAST_RELOAD_KEY = "agent-nav:idle-reload-at";
const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;

let pendingReload: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastInputAt = Date.now();

if (typeof window !== "undefined") {
  for (const type of INPUT_EVENTS) window.addEventListener(type, () => (lastInputAt = Date.now()), { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !pendingReload) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    evaluate();
  });
}

function evaluate() {
  const reload = pendingReload;
  if (!reload) return;
  const wait = idleReloadWaitMs({ now: Date.now(), lastInputAt, lastReloadAt: readLastReload(), hidden: document.hidden });
  if (wait > 0) {
    timer = setTimeout(() => {
      timer = null;
      evaluate();
    }, wait);
    return;
  }
  pendingReload = null;
  writeLastReload(Date.now());
  reload();
}

export type IdleReloadClock = { now: number; lastInputAt: number; lastReloadAt: number | null; hidden: boolean };

export function idleReloadWaitMs({ now, lastInputAt, lastReloadAt, hidden }: IdleReloadClock): number {
  if (hidden) return 0;
  const quiet = lastInputAt + QUIET_MS - now;
  const gap = lastReloadAt === null ? 0 : lastReloadAt + MIN_GAP_MS - now;
  return Math.max(0, quiet, gap);
}

function readLastReload(): number | null {
  try {
    const value = Number(sessionStorage.getItem(LAST_RELOAD_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeLastReload(at: number) {
  try {
    sessionStorage.setItem(LAST_RELOAD_KEY, String(at));
  } catch {
  }
}

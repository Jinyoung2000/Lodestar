// 피드백 반영(웹 변경)이 보낸 창 다시 읽기를 바로 하지 않고 모아서 한다. 반영이 몇 분마다 들어오면 쓰는 중에 창이 계속 다시 읽혔다.
// 디바운스: 이 창에서 입력(키, 포인터, 휠)이 QUIET_MS 동안 없을 때 읽는다. 기다리는 동안 온 요청은 하나로 합친다.
// 스로틀: 이 길로 다시 읽은 뒤 MIN_GAP_MS 가 지나기 전에는 또 읽지 않는다. 그 시각은 sessionStorage 에 둬서 다시 읽은 뒤에도 이어진다.
// 창이 가려져 있으면(document.hidden) 보는 사람이 없으니 바로 읽는다. 바로 보려면 반영 알림의 Reload 단추나 ⌘R 을 쓴다.
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
  // 기다리는 동안 창이 가려지면 그때 바로 읽는다
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

// 지금 다시 읽어도 되기까지 남은 시간(ms). 0 이면 바로 읽는다.
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
    // 저장이 막히면 다음 반영 때 간격 제한 없이 입력 멈춤만 본다
  }
}

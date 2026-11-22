
export type ChatAnchor = { turn: string; child: number; offset: number };

export type AnchorCandidate = { turn: string; child: number; top: number };

export function pickAnchor(candidates: readonly AnchorCandidate[], scrollTop: number): ChatAnchor | null {
  if (!candidates.length) return null;
  let chosen = candidates[0];
  for (const candidate of candidates) {
    if (candidate.top <= scrollTop + 0.5) chosen = candidate;
    else break;
  }
  return { turn: chosen.turn, child: chosen.child, offset: Math.round((scrollTop - chosen.top) * 10) / 10 };
}

export function restoredScrollTop(anchorTop: number, offset: number, maxScroll: number): number {
  return Math.min(Math.max(0, anchorTop + offset), Math.max(0, maxScroll));
}

const TURN = "[data-turn-key]";

const contentOrigin = (el: HTMLElement) => el.getBoundingClientRect().top - el.scrollTop;

export function readChatAnchor(el: HTMLElement): ChatAnchor | null {
  const origin = contentOrigin(el);
  const candidates: AnchorCandidate[] = [];
  for (const turnEl of el.querySelectorAll<HTMLElement>(`:scope > ${TURN}`)) {
    const turn = turnEl.dataset.turnKey ?? "";
    candidates.push({ turn, child: -1, top: turnEl.getBoundingClientRect().top - origin });
    Array.from(turnEl.children).forEach((child, index) => {
      if (child.classList.contains("turn-user") || child.classList.contains("turn-sentinel")) return;
      candidates.push({ turn, child: index, top: child.getBoundingClientRect().top - origin });
    });
  }
  return pickAnchor(candidates, el.scrollTop);
}

function anchorElement(el: HTMLElement, anchor: ChatAnchor): HTMLElement | null {
  const turnEl = Array.from(el.querySelectorAll<HTMLElement>(`:scope > ${TURN}`)).find((t) => t.dataset.turnKey === anchor.turn);
  if (!turnEl) return null;
  return anchor.child >= 0 ? ((turnEl.children[anchor.child] as HTMLElement | undefined) ?? turnEl) : turnEl;
}

export function applyChatAnchor(el: HTMLElement, anchor: ChatAnchor): boolean {
  const target = anchorElement(el, anchor);
  if (!target) return false;
  const top = target.getBoundingClientRect().top - contentOrigin(el);
  const next = restoredScrollTop(top, anchor.offset, el.scrollHeight - el.clientHeight);
  if (Math.abs(next - el.scrollTop) > 0.5) el.scrollTop = next;
  return true;
}

export const HOLD_MS = 3000;

export function holdChatAnchor(el: HTMLElement, anchor: ChatAnchor, now: () => number = () => performance.now()): () => void {
  const until = now() + HOLD_MS;
  let frame = 0;
  let stopped = false;
  const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    for (const name of events) el.removeEventListener(name, stop);
  };
  for (const name of events) el.addEventListener(name, stop, { passive: true });
  const tick = () => {
    if (stopped) return;
    if (now() > until) return stop();
    applyChatAnchor(el, anchor);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return stop;
}

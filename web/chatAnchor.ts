// 대화 스크롤 위치를 픽셀이 아니라 "기준 메시지와 그 안 오프셋" 으로 저장하고 되살리는 계산(round-5 발견 13).
// 픽셀 위치는 이미지나 코드 블록 높이가 나중에 정해지거나 칸 폭이 달라지면 다른 메시지를 가리킨다. 기준 메시지는 턴(사용자 메시지 id)과 그 턴 안의 몇 번째 자식 행이다.
// 이 파일 위쪽은 DOM 을 모르는 순수 계산(test/chatanchor.test.ts), 아래쪽은 DOM 을 읽고 쓰는 얇은 래퍼다.

export type ChatAnchor = { turn: string; child: number; offset: number };

// top 은 스크롤 내용의 맨 위에서 이 요소 위쪽 가장자리까지의 거리. child -1 은 턴 상자 자체다.
export type AnchorCandidate = { turn: string; child: number; top: number };

// 화면 맨 위(scrollTop)를 지나는 가장 안쪽 요소: 문서 순서에서 top 이 scrollTop 이하인 마지막 후보. 오프셋은 그 요소 위쪽에서 화면 맨 위까지의 거리.
// 후보가 문서 순서로 top 이 줄지 않게 정렬돼 있어야 한다. 화면 맨 위가 첫 후보보다 위면 첫 후보가 기준이다(오프셋 음수).
export function pickAnchor(candidates: readonly AnchorCandidate[], scrollTop: number): ChatAnchor | null {
  if (!candidates.length) return null;
  let chosen = candidates[0];
  for (const candidate of candidates) {
    if (candidate.top <= scrollTop + 0.5) chosen = candidate;
    else break;
  }
  return { turn: chosen.turn, child: chosen.child, offset: Math.round((scrollTop - chosen.top) * 10) / 10 };
}

// 기준 요소의 지금 top 에서 되돌릴 scrollTop. 내용이 아직 짧아 닿을 수 없는 값은 끝으로 맞춘다.
export function restoredScrollTop(anchorTop: number, offset: number, maxScroll: number): number {
  return Math.min(Math.max(0, anchorTop + offset), Math.max(0, maxScroll));
}

// --- DOM 래퍼 ---

const TURN = "[data-turn-key]";

// 스크롤 내용 맨 위의 화면 좌표. scrollTop 이 늘면 요소의 화면 top 은 그만큼 줄어든다.
const contentOrigin = (el: HTMLElement) => el.getBoundingClientRect().top - el.scrollTop;

export function readChatAnchor(el: HTMLElement): ChatAnchor | null {
  const origin = contentOrigin(el);
  const candidates: AnchorCandidate[] = [];
  for (const turnEl of el.querySelectorAll<HTMLElement>(`:scope > ${TURN}`)) {
    const turn = turnEl.dataset.turnKey ?? "";
    candidates.push({ turn, child: -1, top: turnEl.getBoundingClientRect().top - origin });
    // 말풍선(.turn-user)은 sticky 라 화면 맨 위에 붙어 top 이 스크롤을 따라 움직이고, 감시선(.turn-sentinel)은 절대 위치다. 기준이 될 수 없어 건너뛴다(인덱스는 그대로 센다).
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

// 기준 요소가 있으면 그 자리로 스크롤하고 true, 기준 메시지가 사라졌으면 false.
export function applyChatAnchor(el: HTMLElement, anchor: ChatAnchor): boolean {
  const target = anchorElement(el, anchor);
  if (!target) return false;
  const top = target.getBoundingClientRect().top - contentOrigin(el);
  const next = restoredScrollTop(top, anchor.offset, el.scrollHeight - el.clientHeight);
  if (Math.abs(next - el.scrollTop) > 0.5) el.scrollTop = next;
  return true;
}

export const HOLD_MS = 3000;

// 되살린 직후 이미지와 코드 블록 높이가 정해지며 내용이 늘어나도 같은 메시지가 같은 자리에 오도록, 사용자가 직접 스크롤하기 전까지(최대 HOLD_MS) 매 프레임 다시 맞춘다.
// 반환하는 함수로 일찍 멈춘다.
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

// 대화 맨 위에 붙는(sticky) 사용자 말풍선이 "붙었는지" 판정한다. 붙으면 두 줄로 접히는데, 접힘이 스크롤 위치를 다시 바꿔 판정을 뒤집던 순환을 끊는다.
// 접히면 말풍선 아래 내용이 D(펼친 높이 - 접힌 높이)만큼 올라오고, 브라우저의 스크롤 앵커링(overflow-anchor)이나 바닥 고정이 scrollTop 을 D 만큼 같이 내린다.
// 판정 기준은 "턴 맨 위의 감시선이 화면 맨 위를 지났나" 라서, scrollTop 이 D 만큼 내려가면 접힌 상태가 곧바로 "안 붙음" 이 되고, 펴면 scrollTop 이 다시 D 만큼 올라가 "붙음" 이 된다.
// 그래서 붙은 동안은 판정 경계를 접힘 높이만큼 아래로 물린다(히스테리시스). 이 파일 위쪽은 DOM 을 모르는 순수 계산(test/stuckbubble.test.ts), 아래쪽은 DOM 을 읽는 훅이다.
import { useLayoutEffect, useState, type RefObject } from "react";
import { isResizing, onResizeEnd } from "./resizeDrag";

// 앵커링이 소수점 단위로 어긋나도 경계에 걸리지 않게 두는 여유(px)
export const HOLD_SLACK = 4;

// 붙은 동안 판정 경계를 아래로 물릴 거리. 접힘이 줄이는 높이보다 커야 접힌 직후의 scrollTop 이 경계 안에 남는다.
// 접어도 높이가 안 줄면 물리지 않는다. 경계가 칸 높이를 넘으면 판정 영역이 뒤집히므로 칸 높이에서 멈춘다.
export function holdMargin(expandedHeight: number, foldedHeight: number, rootHeight: number): number {
  const shrink = expandedHeight - foldedHeight;
  if (shrink <= 0) return 0;
  return Math.min(shrink + HOLD_SLACK, Math.max(0, rootHeight));
}

// 감시선이 판정 경계(칸 맨 위에서 hold 만큼 아래) 위에 있으면 붙은 것. IntersectionObserver 의 entry 와 같은 뜻이다.
export function isStuckAt(sentinelTop: number, rootTop: number, hold: number): boolean {
  return sentinelTop < rootTop + hold;
}

// 사용자가 스크롤해서 맨 위에 닿았는지. 접힘 때문에 scrollTop 이 0 으로 눌린 경우(사용자 입력 없음)는 아니다.
export const INPUT_WINDOW_MS = 250;
export function reachedTopByUser(scrollTop: number, msSinceInput: number): boolean {
  return scrollTop <= 0.5 && msSinceInput < INPUT_WINDOW_MS;
}

// --- DOM 훅 ---

// 말풍선을 접지 않은 높이. 접은 채 읽으면 줄어든 높이라서, 붙음 표시를 잠깐 떼고 읽는다(같은 동기 구간이라 그려지지 않는다).
function expandedHeightOf(bubble: HTMLElement): number {
  const mark = bubble.getAttribute("data-stuck");
  if (mark === null) return bubble.offsetHeight;
  bubble.removeAttribute("data-stuck");
  const height = bubble.offsetHeight;
  bubble.setAttribute("data-stuck", mark);
  return height;
}

// 말풍선 폭이 바뀐 붙은 말풍선들의 경계 재측정을 프레임당 한 번으로 묶는다.
// 말풍선마다 따로 재면(펼친 높이를 읽으려 붙음 표시를 떼고 offsetHeight 를 읽고 다시 붙인다) 말풍선 수만큼 전체 레이아웃이 강제된다. 턴 300개짜리 대화에서 경계를 끌면 이동 하나에 약 300ms 였다.
// 묶으면 펼친 높이 읽기와 접힌 높이 읽기가 각각 레이아웃 한 번이다. 경계를 끄는 동안(isResizing)은 미루고 놓을 때 한 번 한다.
export type Remeasure = { bubble: HTMLElement; root: HTMLElement; apply: (hold: number) => void };
const queued = new Set<Remeasure>();
let flushFrame = 0;

export function queueRemeasure(item: Remeasure) {
  queued.add(item);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushFrame || isResizing() || queued.size === 0) return;
  flushFrame = requestAnimationFrame(flushRemeasure);
}

function flushRemeasure() {
  flushFrame = 0;
  if (isResizing()) return;
  const items = [...queued];
  queued.clear();
  // 쓰기와 읽기를 갈라서 레이아웃이 두 번만 일어나게 한다. 같은 동기 구간이라 붙음 표시를 뗀 상태는 그려지지 않는다.
  const marks = items.map(({ bubble }) => bubble.getAttribute("data-stuck"));
  items.forEach(({ bubble }, i) => marks[i] !== null && bubble.removeAttribute("data-stuck"));
  const expanded = items.map(({ bubble }) => bubble.offsetHeight);
  items.forEach(({ bubble }, i) => marks[i] !== null && bubble.setAttribute("data-stuck", marks[i] as string));
  const folded = items.map(({ bubble }) => bubble.offsetHeight);
  items.forEach((item, i) => item.apply(holdMargin(expanded[i], folded[i], item.root.clientHeight)));
}

onResizeEnd(scheduleFlush);

// 접힘과 펼침이 말풍선 아래 내용을 밀어 올리거나 내릴 때 브라우저의 스크롤 앵커링이 scrollTop 을 같이 옮기지 않게 잠깐 끈다(접힌 자리에서 내용이 그대로 올라오게).
// 상태가 바뀌는 판정 직후에만 켜고 곧 되돌려서, 평소 이미지나 코드 블록 높이가 늦게 정해질 때의 앵커링은 그대로 둔다.
export const ANCHOR_PAUSE_MS = 200;
const resumeTimers = new WeakMap<HTMLElement, number>();
function pauseAnchoring(root: HTMLElement) {
  root.style.overflowAnchor = "none";
  window.clearTimeout(resumeTimers.get(root));
  resumeTimers.set(
    root,
    window.setTimeout(() => {
      root.style.overflowAnchor = "";
    }, ANCHOR_PAUSE_MS),
  );
}

// sentinel 은 턴 맨 위의 감시선, bubble 은 붙는 말풍선이다. 붙었으면 true.
export function useStuckBubble(sentinelRef: RefObject<HTMLElement | null>, bubbleRef: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false);
  // 레이아웃 효과여야 접힌 레이아웃이 처음 그려지기 전에 경계를 바꾼다. passive 효과면 그 사이에 옛 경계로 한 번 더 판정해 되돌린다.
  useLayoutEffect(() => {
    const sentinel = sentinelRef.current;
    const bubble = bubbleRef.current;
    const root = sentinel?.closest<HTMLElement>(".timeline");
    if (!sentinel || !bubble || !root) return;
    const padding = parseFloat(getComputedStyle(root).paddingTop) || 0;
    let observer: IntersectionObserver | null = null;
    const watch = (hold: number) => {
      observer?.disconnect();
      const mine = new IntersectionObserver(
        ([entry]) => {
          // disconnect 전에 쌓인 알림은 옛 경계 기준이라 버린다.
          if (observer !== mine) return;
          const next = !entry.isIntersecting && isStuckAt(entry.boundingClientRect.top, entry.rootBounds?.top ?? 0, 0);
          if (next === stuck) return;
          pauseAnchoring(root);
          setStuck(next);
        },
        { root, rootMargin: `${padding - hold}px 0px 0px 0px` },
      );
      observer = mine;
      mine.observe(sentinel);
    };
    watch(stuck ? holdMargin(expandedHeightOf(bubble), bubble.offsetHeight, root.clientHeight) : 0);
    // 붙어 있는 동안 칸 폭이 바뀌면 접힘 높이도 달라지니 경계를 다시 잰다. 말풍선이 수백 개라 프레임당 한 번으로 묶는다(queueRemeasure).
    let width = bubble.offsetWidth;
    const job: Remeasure = { bubble, root, apply: (hold) => watch(hold) };
    const resize = new ResizeObserver(() => {
      if (bubble.offsetWidth === width) return;
      width = bubble.offsetWidth;
      if (stuck) queueRemeasure(job);
    });
    resize.observe(bubble);
    // 대화 맨 위에서는 접힌 말풍선이 판정 경계 안에 계속 남아(첫 턴이 긴 경우) 펼쳐 볼 수가 없다. 사용자가 스크롤해 맨 위에 닿거나 맨 위에서 더 밀면 편다.
    // 맨 위에서는 감시선이 늘 화면 아래라 펴도 다시 붙지 않는다.
    let lastInput = -Infinity;
    const reveal = () => {
      pauseAnchoring(root);
      setStuck(false);
    };
    const onWheel = (event: WheelEvent) => {
      lastInput = performance.now();
      if (event.deltaY < 0 && root.scrollTop <= 0.5) reveal();
    };
    const onInput = () => {
      lastInput = performance.now();
    };
    const onScroll = () => {
      if (reachedTopByUser(root.scrollTop, performance.now() - lastInput)) reveal();
    };
    if (stuck) {
      root.addEventListener("wheel", onWheel, { passive: true });
      root.addEventListener("touchmove", onInput, { passive: true });
      root.addEventListener("keydown", onInput);
      root.addEventListener("scroll", onScroll, { passive: true });
    }
    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("touchmove", onInput);
      root.removeEventListener("keydown", onInput);
      root.removeEventListener("scroll", onScroll);
      queued.delete(job);
      observer?.disconnect();
      observer = null;
      resize.disconnect();
    };
  }, [stuck, sentinelRef, bubbleRef]);
  return stuck;
}

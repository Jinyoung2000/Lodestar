import { useLayoutEffect, useState, type RefObject } from "react";
import { isResizing, onResizeEnd } from "./resizeDrag";

export const HOLD_SLACK = 4;

export function holdMargin(expandedHeight: number, foldedHeight: number, rootHeight: number): number {
  const shrink = expandedHeight - foldedHeight;
  if (shrink <= 0) return 0;
  return Math.min(shrink + HOLD_SLACK, Math.max(0, rootHeight));
}

export function isStuckAt(sentinelTop: number, rootTop: number, hold: number): boolean {
  return sentinelTop < rootTop + hold;
}

export const INPUT_WINDOW_MS = 250;
export function reachedTopByUser(scrollTop: number, msSinceInput: number): boolean {
  return scrollTop <= 0.5 && msSinceInput < INPUT_WINDOW_MS;
}

function expandedHeightOf(bubble: HTMLElement): number {
  const mark = bubble.getAttribute("data-stuck");
  if (mark === null) return bubble.offsetHeight;
  bubble.removeAttribute("data-stuck");
  const height = bubble.offsetHeight;
  bubble.setAttribute("data-stuck", mark);
  return height;
}

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
  const marks = items.map(({ bubble }) => bubble.getAttribute("data-stuck"));
  items.forEach(({ bubble }, i) => marks[i] !== null && bubble.removeAttribute("data-stuck"));
  const expanded = items.map(({ bubble }) => bubble.offsetHeight);
  items.forEach(({ bubble }, i) => marks[i] !== null && bubble.setAttribute("data-stuck", marks[i] as string));
  const folded = items.map(({ bubble }) => bubble.offsetHeight);
  items.forEach((item, i) => item.apply(holdMargin(expanded[i], folded[i], item.root.clientHeight)));
}

onResizeEnd(scheduleFlush);

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

export function useStuckBubble(sentinelRef: RefObject<HTMLElement | null>, bubbleRef: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false);
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
    let width = bubble.offsetWidth;
    const job: Remeasure = { bubble, root, apply: (hold) => watch(hold) };
    const resize = new ResizeObserver(() => {
      if (bubble.offsetWidth === width) return;
      width = bubble.offsetWidth;
      if (stuck) queueRemeasure(job);
    });
    resize.observe(bubble);
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

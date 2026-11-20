import type { PointerEvent as ReactPointerEvent } from "react";
import { useSyncExternalStore } from "react";
import { dropMarkAt } from "./tabDropMark";
import { copyTabToGroup, copyTabToNewGroup, getState, moveTabToGroup, moveTabToNewGroup } from "./store";

// 오른쪽 패널 탭을 끌어서 순서를 바꾸고 다른 에디터 그룹으로 옮긴다. HTML 끌어놓기가 아니라 포인터 이벤트로 직접 만든다(창구로 합성한 마우스 입력으로도 같게 움직이고, 놓을 자리를 직접 그려야 해서다).
// 놓을 곳은 셋이다: 탭줄(마우스 아래 탭 앞), 그룹 본문 가운데(그 그룹 맨 끝), 그룹 본문 가장자리(그 방향에 새 그룹).

export type DropTarget =
  | { kind: "strip"; group: string; beforeKey: string | null; x: number; top: number; height: number }
  | { kind: "body"; group: string }
  | { kind: "edge"; group: string; side: "left" | "right" | "top" | "bottom"; rect: { left: number; top: number; width: number; height: number } };

export type TabDrag = { key: string; label: string; x: number; y: number; target: DropTarget | null; copy: boolean };

const THRESHOLD = 4;
// 본문 가장자리로 치는 비율. 가운데 절반은 그 그룹으로 옮기기다.
const EDGE = 0.25;

let drag: TabDrag | null = null;
const listeners = new Set<() => void>();

function set(next: TabDrag | null) {
  drag = next;
  // 끄는 동안 글자 선택과 webview 가 포인터를 가로채지 않게 한다(styles.css 의 data-tab-dragging)
  document.body.toggleAttribute("data-tab-dragging", next !== null);
  for (const listener of listeners) listener();
}

export function useTabDrag() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => drag,
  );
}

// 탭을 누른 채 THRESHOLD 이상 움직이면 끌기가 시작된다. 그 전에 떼면 평범한 클릭이다.
export function beginTabDrag(event: ReactPointerEvent, key: string, label: string) {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let started = false;
  let copy = event.altKey;
  let last = { x: startX, y: startY };
  const move = (e: PointerEvent) => {
    copy = e.altKey;
    last = { x: e.clientX, y: e.clientY };
    if (!started) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
      started = true;
    }
    set({ key, label, x: e.clientX, y: e.clientY, target: dropTargetAt(e.clientX, e.clientY, key), copy });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    if (!started) return;
    const target = drag?.target ?? null;
    set(null);
    // 끌기 끝에 따라오는 click 은 탭을 누른 것으로 치지 않는다
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (commit && target) commitDrop(key, target, copy);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      finish(false);
    } else if (e.key === "Alt" && started && copy !== (e.type === "keydown")) {
      // 끄는 도중 ⌥ 를 눌렀다 떼면 복사 표시도 따라 바뀐다
      copy = e.type === "keydown";
      set({ key, label, x: last.x, y: last.y, target: drag?.target ?? null, copy });
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
}

export function dropTargetAt(x: number, y: number, draggedKey: string): DropTarget | null {
  const element = document.elementFromPoint(x, y);
  const strip = element?.closest<HTMLElement>("[data-tab-strip]");
  if (strip) {
    const group = strip.dataset.tabStrip!;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>(":scope > .tab[data-tab-key]")).filter((t) => t.dataset.tabKey !== draggedKey);
    const stripRect = strip.getBoundingClientRect();
    const boxes = tabs.map((t) => {
      const rect = t.getBoundingClientRect();
      return { key: t.dataset.tabKey!, left: rect.left, right: rect.right, sticky: t.dataset.sticky !== undefined, editor: t.dataset.kind !== "card" && !isPinnedSlot(t.dataset.tabKey!) };
    });
    const mark = dropMarkAt(boxes, x, { key: draggedKey, sticky: getState().tabs.find((t) => t.key === draggedKey)?.sticky === true }, stripRect.left);
    return { kind: "strip", group, beforeKey: mark.beforeKey, x: mark.x, top: stripRect.top, height: stripRect.height };
  }
  const body = element?.closest<HTMLElement>("[data-group-body]");
  if (!body) return null;
  const group = body.dataset.groupBody!;
  const rect = body.getBoundingClientRect();
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  if (fx < EDGE) return { kind: "edge", group, side: "left", rect: { ...box, width: rect.width / 2 } };
  if (fx > 1 - EDGE) return { kind: "edge", group, side: "right", rect: { ...box, left: rect.left + rect.width / 2, width: rect.width / 2 } };
  if (fy < EDGE) return { kind: "edge", group, side: "top", rect: { ...box, height: rect.height / 2 } };
  if (fy > 1 - EDGE) return { kind: "edge", group, side: "bottom", rect: { ...box, top: rect.top + rect.height / 2, height: rect.height / 2 } };
  return { kind: "body", group };
}

function commitDrop(key: string, target: DropTarget, copy: boolean) {
  const place = copy ? copyTabToGroup : moveTabToGroup;
  if (target.kind === "strip") place(key, target.group, target.beforeKey);
  else if (target.kind === "body") place(key, target.group, null);
  else (copy ? copyTabToNewGroup : moveTabToNewGroup)(key, target.group, target.side === "left" || target.side === "right" ? "row" : "column", target.side === "left" || target.side === "top");
}

// 탭줄에 같이 있는 고정 칸 탭(Changes, Files)은 에디터 탭이 아니다. 탭 키가 곧 그 이름이다.
const isPinnedSlot = (key: string) => key === "changes" || key === "files" || key === "card";

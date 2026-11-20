import { EditorView } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import { announce } from "./announce";
import { canShowEditorMessage, showEditorMessage } from "./editorMessage";
import { chooseAnchor, hasArea, windowPoint, type HintRect } from "./hintModel";

// 방금 한 동작의 사소한 결과("Copied", "No definition found", "Open a Browser tab first")를 알림 카드 대신 동작 자리 근처에 잠깐 보인다.
// 에디터 안 동작은 커서 위 말풍선(web/editorMessage.ts), 그 밖은 누른 곳이나 포커스가 있는 곳 옆 말풍선(web/HintLayer.tsx)이다. 화면 낭독기에는 두 경우 모두 읽어 준다.
// 실패, 되돌릴 수 없는 변경, 버튼이 필요한 안내는 hint 가 아니라 flash 와 notify(알림 카드)에 둔다.

// 에디터 / 요소 / 직접 잰 영역 중 하나. 없으면 방금 누른 곳, 포커스가 있는 곳, 창 아래쪽 순으로 고른다.
export type HintTarget = EditorView | Element | HintRect;
export type HintOptions = { check?: boolean };
export type HintBubble = { id: number; text: string; rect: HintRect; check: boolean };

export function hint(text: string, target?: HintTarget, options: HintOptions = {}) {
  announce(text);
  const chosen = chooseAnchor({
    explicit: explicitOf(target),
    focusInEditor: focusedView() !== null,
    pointer: lastPointer,
    now: performance.now(),
    focused: focusedRect(),
  });
  if (chosen.kind === "explicit-editor" || chosen.kind === "focused-editor") {
    const view = chosen.kind === "explicit-editor" ? (target as EditorView) : focusedView();
    if (view) {
      showOnEditor(view, text, options);
      return;
    }
  }
  show(text, chosen.kind === "rect" ? chosen.rect : windowPoint({ width: window.innerWidth, height: window.innerHeight }, WINDOW_LIFT), options);
}

export function dismissHint(id?: number) {
  if (current && (id === undefined || current.id === id)) emit(null);
}

export function currentHint(): HintBubble | null {
  return current;
}

export function useHint(): HintBubble | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

// 가운데 아래로 떨어질 때 창 바닥에서 띄우는 거리. 입력창과 알림 영역을 가리지 않을 만큼.
const WINDOW_LIFT = 96;

let current: HintBubble | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
let lastPointer: { rect: HintRect; at: number } | null = null;

function emit(next: HintBubble | null) {
  current = next;
  for (const listener of listeners) listener();
}

function show(text: string, rect: HintRect, options: HintOptions) {
  emit({ id: nextId++, text, rect, check: options.check === true });
}

function showOnEditor(view: EditorView, text: string, options: HintOptions) {
  if (canShowEditorMessage(view)) {
    emit(null);
    showEditorMessage(view, text);
    return;
  }
  // 말풍선 확장이 없는 에디터(미리보기 등)는 커서 자리에 일반 말풍선을 띄운다
  const box = view.coordsAtPos(view.state.selection.main.head);
  show(text, box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : rectOf(view.dom), options);
}

function explicitOf(target: HintTarget | undefined) {
  if (!target) return null;
  if (target instanceof EditorView) return { kind: "editor" } as const;
  const rect = target instanceof Element ? rectOf(target) : target;
  return hasArea(rect) ? ({ kind: "rect", rect } as const) : null;
}

function rectOf(el: Element): HintRect {
  const { left, top, right, bottom } = el.getBoundingClientRect();
  return { left, top, right, bottom };
}

function focusedElement() {
  const el = document.activeElement;
  return el && el !== document.body && el !== document.documentElement ? el : null;
}

function focusedView(): EditorView | null {
  const dom = focusedElement()?.closest(".cm-editor");
  return dom ? EditorView.findFromDOM(dom as HTMLElement) : null;
}

function focusedRect(): HintRect | null {
  const el = focusedElement();
  return el ? rectOf(el) : null;
}

// 누른 곳을 누르는 순간 재 둔다. 메뉴 항목처럼 누르면 사라지는 요소도 그 자리에 말풍선을 띄울 수 있다.
const PRESSABLE = "button, a, [role=button], [role=menuitem], [role=tab], input, textarea, select, summary";

function trackPointer() {
  window.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const el = target?.closest(PRESSABLE) ?? target;
      lastPointer = el ? { rect: rectOf(el), at: performance.now() } : null;
    },
    true,
  );
}

// 시험의 가짜 window 에는 addEventListener 가 없을 수 있다
if (typeof window !== "undefined" && typeof window.addEventListener === "function") trackPointer();

import { EditorView } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import { announce } from "./announce";
import { canShowEditorMessage, showEditorMessage } from "./editorMessage";
import { chooseAnchor, hasArea, windowPoint, type HintRect } from "./hintModel";

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

export function useHint(): HintBubble | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

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

if (typeof window !== "undefined" && typeof window.addEventListener === "function") trackPointer();

import type { Extension } from "@codemirror/state";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { rangeHighlightExtension } from "./editorRangeHighlight";

const listeners = new Set<() => void>();
let version = 0;
let scheduled = false;

export function subscribeEditorStatus(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const editorStatusVersion = () => version;

function notify() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    version++;
    for (const listener of listeners) listener();
  });
}

const notifier = ViewPlugin.fromClass(
  class {
    constructor() {
      notify();
    }
    update(update: ViewUpdate) {
      if (update.transactions.length) notify();
    }
    destroy() {
      notify();
    }
  },
);

export function editorStatusExtensions(): Extension {
  return [notifier, rangeHighlightExtension];
}

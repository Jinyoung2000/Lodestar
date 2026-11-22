import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

export type QuickAnchor = { from: number; to: number };

export const setQuickAnchor = StateEffect.define<QuickAnchor | null>();

export const quickAnchorField = StateField.define<QuickAnchor | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setQuickAnchor)) return effect.value;
    if (!value || !tr.docChanged) return value;
    const from = tr.changes.mapPos(value.from, -1);
    return { from, to: Math.max(from, tr.changes.mapPos(value.to, -1)) };
  },
});

const listeners = new Map<EditorView, Set<() => void>>();

export function subscribeQuickAnchor(view: EditorView, listener: () => void) {
  const set = listeners.get(view) ?? new Set();
  set.add(listener);
  listeners.set(view, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(view);
  };
}

export function quickAnchorExtension(): Extension {
  return [
    quickAnchorField,
    ViewPlugin.define(() => ({
      update(update) {
        if (!update.docChanged && !update.geometryChanged && !update.viewportChanged) return;
        for (const listener of listeners.get(update.view) ?? []) listener();
      },
    })),
  ];
}

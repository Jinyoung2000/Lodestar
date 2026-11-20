import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

// 빠른 질문 창(web/QuickAsk.tsx)이 따라갈 줄. 질문한 선택 영역의 문서 위치를 에디터 상태에 두면 앞뒤 줄이 추가, 삭제될 때 changes.mapPos 가 알아서 옮긴다.

export type QuickAnchor = { from: number; to: number };

export const setQuickAnchor = StateEffect.define<QuickAnchor | null>();

export const quickAnchorField = StateField.define<QuickAnchor | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setQuickAnchor)) return effect.value;
    if (!value || !tr.docChanged) return value;
    // 선택 시작에 글을 입력해도 시작은 그 자리에 머물고(assoc 1이면 뒤로 밀린다), 끝은 뒤로 밀리지 않는다.
    const from = tr.changes.mapPos(value.from, -1);
    return { from, to: Math.max(from, tr.changes.mapPos(value.to, -1)) };
  },
});

const listeners = new Map<EditorView, Set<() => void>>();

// 글이 바뀌거나 크기, 보이는 범위가 바뀔 때 알린다(스크롤은 view.scrollDOM 의 scroll 이벤트로 따로 듣는다).
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

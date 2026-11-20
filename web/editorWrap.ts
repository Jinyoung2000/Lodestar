import { Facet, StateEffect, StateField, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";

const setOverride = StateEffect.define<boolean | null>();

const overrideField = StateField.define<boolean | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setOverride)) value = effect.value;
    return value;
  },
});

const WRAPPING: Record<string, string> = { class: "cm-lineWrapping" };
const NOT_WRAPPING: Record<string, string> = {};

// 설정 쪽 값(editor.wordWrap === "on")
const settingWrap = Facet.define<boolean, boolean>({ combine: (values) => values[0] ?? false });

export function wrapExtension(options: EditorOptions): Extension {
  return [
    overrideField,
    settingWrap.of(options.wordWrap === "on"),
    // EditorView.lineWrapping 이 하는 일(content 에 cm-lineWrapping 클래스)을 필드에 따라 켜고 끈다
    EditorView.contentAttributes.compute([overrideField, settingWrap], (state) => (isWrapped(state) ? WRAPPING : NOT_WRAPPING)),
  ];
}

export function isWrapped(state: EditorState): boolean {
  return state.field(overrideField, false) ?? state.facet(settingWrap);
}

export function toggleWordWrap(target: { state: EditorState; dispatch: (spec: TransactionSpec) => void }): boolean {
  if (target.state.field(overrideField, false) === undefined) return false;
  target.dispatch({ effects: setOverride.of(!isWrapped(target.state)) });
  return true;
}

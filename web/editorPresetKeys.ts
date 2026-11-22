import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { activeCommandKeys, activeKeymapPreset, editorTakenStrokes, strokeOf } from "./keymap";
import type { CommandKeys, KeymapPreset } from "../shared/protocol";

export const presetKeys: Extension = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event) {
      if (event.isComposing) return false;
      const taken = takenStrokes();
      if (taken.size === 0) return false;
      const stroke = strokeOf(event);
      return stroke !== null && taken.has(stroke);
    },
  }),
);

let cache: { preset: KeymapPreset; overrides: CommandKeys | undefined; strokes: ReadonlySet<string> } | null = null;

function takenStrokes() {
  const preset = activeKeymapPreset();
  const overrides = activeCommandKeys();
  if (cache?.preset !== preset || cache.overrides !== overrides) cache = { preset, overrides, strokes: editorTakenStrokes(preset, overrides) };
  return cache.strokes;
}

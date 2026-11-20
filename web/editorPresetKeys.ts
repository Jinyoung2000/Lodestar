import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { activeCommandKeys, activeKeymapPreset, editorTakenStrokes, strokeOf } from "./keymap";
import type { CommandKeys, KeymapPreset } from "../shared/protocol";

// 단축키 프리셋이 표에서 처리하는 키를 CodeMirror 기본 키맵이 또 처리하지 않게 먹는다.
// 앱의 keydown 은 window 버블 단계라 에디터 키맵이 먼저 돌고 멈추지 않아서, ⌘D 처럼 둘 다 쓰는 키는 selectNextOccurrence 와 표의 duplicateSelection 이 같이 일어난다.
// true 를 돌려주면 CodeMirror 는 그 키를 처리한 것으로 보고 키맵(Prec.default)을 건너뛰지만 이벤트는 window 까지 올라가 표가 명령을 부른다.
// 프리셋은 이벤트가 올 때 읽어서 프리셋을 바꿔도 에디터를 다시 만들지 않는다. 한글 조합 중 키는 건드리지 않는다.
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

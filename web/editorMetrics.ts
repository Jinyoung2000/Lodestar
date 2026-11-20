import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

// 글자 한 칸의 폭을 CSS 변수 --editor-char-w 로 에디터 루트에 둔다. 들여쓰기 안내선, 공백 점, 마지막 열 뒤 여백이 같이 쓴다.
// CSS 의 1ch 는 자간(letterSpacing)을 빼므로 CodeMirror 가 실제 글자에서 잰 defaultCharacterWidth 를 쓴다. 글꼴이나 크기가 바뀌면 geometryChanged 로 다시 온다.
export const CHAR_WIDTH_VARIABLE = "--editor-char-w";

export function editorMetrics(): Extension {
  return charWidthPlugin;
}

const charWidthPlugin = ViewPlugin.fromClass(
  class {
    private applied = 0;
    constructor(private view: EditorView) {
      this.apply();
    }
    update(update: ViewUpdate) {
      if (update.geometryChanged || update.viewportChanged) this.apply();
    }
    private apply() {
      const width = this.view.defaultCharacterWidth;
      if (width === this.applied) return;
      this.applied = width;
      this.view.dom.style.setProperty(CHAR_WIDTH_VARIABLE, `${width}px`);
    }
  },
);

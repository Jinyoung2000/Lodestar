import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

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

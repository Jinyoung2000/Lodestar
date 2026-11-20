import { getIndentUnit } from "@codemirror/language";
import type { Extension, Text } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import "./editorGuides.css";
import { activeGuide, guideCounts, indentColumns, isOffSideLanguage, type IndentSource } from "./editorGuidesModel";
import { editorMetrics } from "./editorMetrics";
import { languageIdFor } from "./languageId";

// 들여쓰기 안내선(editor.guides.indentation)과 활성 안내선(editor.guides.highlightActiveIndentation).
// 줄마다 단 수(--guide-n)와 활성 단(--guide-active)을 CSS 변수로 주고 editorGuides.css 가 배경 그라데이션으로 그린다.
// 보이는 줄만 계산한다. 빈 줄의 단 수는 위아래 가까운 줄이 정하므로 범위 밖까지 찾아볼 수 있다.
export function indentGuidesExtension(options: EditorOptions, context: OptionContext): Extension {
  if (!options.indentGuides) return [];
  const offSide = isOffSideLanguage(context.path ? languageIdFor(context.path) : null);
  const highlight = options.highlightActiveIndentGuide;
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private step = 0;
      constructor(private view: EditorView) {
        this.build();
      }
      update(update: ViewUpdate) {
        const unitChanged = getIndentUnit(update.startState) !== getIndentUnit(update.state) || update.startState.tabSize !== update.state.tabSize;
        if (update.docChanged || update.viewportChanged || update.geometryChanged || unitChanged || (highlight && update.selectionSet)) this.build();
      }
      private build() {
        const { state } = this.view;
        const indentSize = Math.max(1, getIndentUnit(state));
        this.applyStep(indentSize);
        this.decorations = buildGuideDecorations(this.view, indentSize, offSide, highlight);
      }
      // 한 단의 폭(px). 글자 폭이 바뀌어도 geometryChanged 로 다시 온다.
      private applyStep(indentSize: number) {
        const step = indentSize * this.view.defaultCharacterWidth;
        if (step === this.step) return;
        this.step = step;
        this.view.dom.style.setProperty("--editor-indent-step", `${step}px`);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
  return [editorMetrics(), plugin];
}

const decorationCache = new Map<string, Decoration>();

function guideDecoration(count: number, active: number): Decoration {
  const key = `${count}:${active}`;
  let decoration = decorationCache.get(key);
  if (!decoration) {
    decoration = Decoration.line({ attributes: { class: active > 0 ? "cm-indent-guides cm-indent-guide-active" : "cm-indent-guides", style: `--guide-n:${count};--guide-active:${active};` } });
    decorationCache.set(key, decoration);
  }
  return decoration;
}

function buildGuideDecorations(view: EditorView, indentSize: number, offSide: boolean, highlight: boolean): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const source = indentSource(doc, state.tabSize);
  const ranges: ReturnType<Decoration["range"]>[] = [];
  const cursorLine = doc.lineAt(state.selection.main.head).number;
  for (const { from, to } of view.visibleRanges) {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    const counts = guideCounts(source, first, last, indentSize, offSide);
    const active = highlight ? activeGuide(source, cursorLine, first, Math.min(last + 1, doc.lines), indentSize, offSide) : null;
    for (let line = first; line <= last; line++) {
      const count = counts[line - first]!;
      if (count <= 0) continue;
      const inActive = active && active.indent > 0 && line >= active.startLine && line <= active.endLine && active.indent <= count ? active.indent : 0;
      ranges.push(guideDecoration(count, inActive).range(doc.line(line).from));
    }
  }
  return Decoration.set(ranges, true);
}

// 줄별 들여쓰기 칸 수를 필요할 때 재고 기억해 둔다(한 번 그릴 동안만 유효).
function indentSource(doc: Text, tabSize: number): IndentSource {
  const memo = new Map<number, number>();
  return {
    lineCount: doc.lines,
    indentOf(index) {
      let value = memo.get(index);
      if (value === undefined) {
        value = indentColumns(doc.line(index + 1).text, tabSize);
        memo.set(index, value);
      }
      return value;
    },
  };
}

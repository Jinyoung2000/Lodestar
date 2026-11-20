import { EditorState, Facet, Prec, StateField, findClusterBreak, type Extension } from "@codemirror/state";
import { EditorView, layer, type LayerMarker } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import "./editorCursor.css";
import { blockWidth, effectiveBlinking, linePiece, type CursorBlinking, type CursorStyle } from "./editorCursorModel";

export function cursorExtension(options: EditorOptions, context: OptionContext): Extension {
  void context;
  return [
    cursorConfig.of({ style: options.cursorStyle, width: options.cursorWidth, blinking: options.cursorBlinking }),
    blinkPhase,
    blinkClasses,
    cursorLayer,
    hideNativeSelection,
  ];
}

type CursorConfig = { style: CursorStyle; width: number; blinking: CursorBlinking };
const cursorConfig = Facet.define<CursorConfig, CursorConfig>({
  combine: (values) => values[values.length - 1] ?? { style: "line", width: 0, blinking: "blink" },
});

const blinkPhase = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => (tr.selection || tr.docChanged ? !value : value),
});

const blinkClasses = EditorView.editorAttributes.compute([cursorConfig, blinkPhase, EditorState.readOnly], (state) => {
  const blinking = effectiveBlinking(state.facet(cursorConfig).blinking, state.readOnly);
  return { class: `cm-vsc-blink-${blinking} cm-vsc-phase-${state.field(blinkPhase) ? "b" : "a"}` };
});

// 브라우저 기본 선택 색과 커서를 숨긴다(CodeMirror hideNativeSelection 과 같은 규칙). 선택은 우리 레이어가 그린다.
const hideNativeSelection = Prec.highest(
  EditorView.theme({
    ".cm-line": {
      "& ::selection, &::selection": { backgroundColor: "transparent !important" },
      caretColor: "transparent !important",
    },
    ".cm-content": {
      caretColor: "transparent !important",
      "& :focus": {
        caretColor: "initial !important",
        "&::selection, & ::selection": { backgroundColor: "Highlight !important" },
      },
    },
  }),
);

const cursorLayer = layer({
  above: true,
  class: "cm-vsc-cursorLayer",
  markers: cursorMarkers,
  update: (update) =>
    update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.focusChanged || update.startState.facet(cursorConfig) !== update.state.facet(cursorConfig),
});

class CursorMarker implements LayerMarker {
  constructor(
    private className: string,
    private left: number,
    private top: number,
    private width: number,
    private height: number,
    private text: string,
  ) {}
  draw() {
    const element = document.createElement("div");
    element.className = this.className;
    this.apply(element);
    return element;
  }
  update(element: HTMLElement, previous: LayerMarker) {
    if ((previous as CursorMarker).className !== this.className) return false;
    this.apply(element);
    return true;
  }
  eq(other: LayerMarker) {
    const o = other as CursorMarker;
    return o.className === this.className && o.left === this.left && o.top === this.top && o.width === this.width && o.height === this.height && o.text === this.text;
  }
  private apply(element: HTMLElement) {
    element.style.left = `${this.left}px`;
    element.style.top = `${this.top}px`;
    element.style.width = `${this.width}px`;
    element.style.height = `${this.height}px`;
    element.style.lineHeight = `${this.height}px`;
    if (element.textContent !== this.text) element.textContent = this.text;
  }
}

function cursorMarkers(view: EditorView): readonly LayerMarker[] {
  const { style, width: widthSetting } = view.state.facet(cursorConfig);
  const rect = view.scrollDOM.getBoundingClientRect();
  const baseLeft = rect.left - view.scrollDOM.scrollLeft * view.scaleX;
  const baseTop = rect.top - view.scrollDOM.scrollTop * view.scaleY;
  const charWidth = view.defaultCharacterWidth;
  const lineHeight = view.defaultLineHeight;
  const pixelRatio = window.devicePixelRatio || 1;
  const { doc, selection } = view.state;
  const markers: LayerMarker[] = [];
  for (const range of selection.ranges) {
    const head = range.head;
    const coords = view.coordsAtPos(head, range.assoc || 1);
    if (!coords) continue;
    const line = doc.lineAt(head);
    const offset = head - line.from;
    let char = "";
    let measured: number | null = null;
    if (offset < line.length) {
      const length = findClusterBreak(line.text, offset, true) - offset;
      char = line.text.slice(offset, offset + length);
      const after = view.coordsAtPos(head + length, -1);
      if (after && Math.abs(after.top - coords.top) < lineHeight / 2) measured = after.right - coords.left;
    }
    const left = coords.left - baseLeft;
    const top = (coords.top + coords.bottom) / 2 - lineHeight / 2 - baseTop;
    const kind = range === selection.main ? "cm-vsc-cursor-primary" : "cm-vsc-cursor-secondary";
    const className = `cm-vsc-cursor cm-vsc-cursor-${style} ${kind}`;
    if (style === "line" || style === "line-thin") {
      const piece = linePiece({ style, widthSetting, charWidth, pixelRatio, left });
      // 폭이 2px 보다 넓은 세로선 안에는 그 자리 글자가 비쳐 보이게 같이 그린다(번들 ViewCursor)
      markers.push(new CursorMarker(className, piece.left, top, piece.width, lineHeight, style === "line" && piece.width > 2 ? char : ""));
      continue;
    }
    const width = blockWidth(char, measured, charWidth);
    if (style === "block") markers.push(new CursorMarker(className, left, top, width, lineHeight, char));
    else if (style === "block-outline") markers.push(new CursorMarker(className, left, top, width, lineHeight, ""));
    else markers.push(new CursorMarker(className, left, top + lineHeight - 2, width, 2, ""));
  }
  return markers;
}

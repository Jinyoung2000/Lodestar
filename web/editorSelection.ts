import { Facet, type Extension, type SelectionRange } from "@codemirror/state";
import { BlockType, EditorView, layer, RectangleMarker, type LayerMarker } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import "./editorSelection.css";
import { filletPieces, pieceCorners, radiusClasses, type PieceSpan } from "./editorSelectionModel";

export function selectionExtension(options: EditorOptions, context: OptionContext): Extension {
  void context;
  return [rounded.of(options.roundedSelection), selectionLayer];
}

const rounded = Facet.define<boolean, boolean>({ combine: (values) => values[values.length - 1] ?? true });

// 오목한 모서리를 채우는 조각의 폭(번들 ROUNDED_PIECE_WIDTH)
const FILLET_WIDTH = 10;

const selectionLayer = layer({
  above: false,
  class: "cm-vsc-selectionLayer",
  markers: selectionMarkers,
  update: (update) => update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.startState.facet(rounded) !== update.state.facet(rounded),
});

type LinePiece = PieceSpan & { top: number; bottom: number };

function selectionMarkers(view: EditorView): readonly LayerMarker[] {
  const markers: LayerMarker[] = [];
  const { ranges } = view.state.selection;
  const multiple = ranges.length > 1;
  for (const range of ranges) {
    if (range.empty) continue;
    // 줄 바꿈 모드는 한 줄이 여러 화면 줄이라 조각 모양을 정할 수 없어 CodeMirror 의 기본 조각을 쓴다
    if (view.lineWrapping) markers.push(...RectangleMarker.forRange(view, "cm-selectionBackground", range));
    else markers.push(...rangeMarkers(view, range, multiple));
  }
  return markers;
}

function rangeMarkers(view: EditorView, range: SelectionRange, multiple: boolean): LayerMarker[] {
  const { doc } = view.state;
  const rect = view.scrollDOM.getBoundingClientRect();
  const baseLeft = rect.left - view.scrollDOM.scrollLeft * view.scaleX;
  const baseTop = rect.top - view.scrollDOM.scrollTop * view.scaleY;
  const charWidth = view.defaultCharacterWidth;
  const lastLine = doc.lineAt(range.to).number;
  const pieces: LinePiece[] = [];
  for (const block of view.viewportLineBlocks) {
    if (block.type !== BlockType.Text || block.to < range.from || block.from > range.to) continue;
    const line = doc.lineAt(block.from);
    // 선택이 다음 줄의 맨 앞에서 끝나면 그 줄은 칠하지 않는다
    if (line.number === lastLine && range.to === line.from && range.from < line.from) continue;
    const start = Math.max(range.from, line.from);
    const end = Math.min(range.to, line.to);
    const left = caretX(view, start, line.from);
    const lineEnd = caretX(view, range.to > line.to ? line.to : end, line.from);
    if (left === null || lineEnd === null) continue;
    const right = range.to > line.to ? lineEnd + charWidth : lineEnd;
    const top = view.documentTop + block.top - baseTop;
    pieces.push({ left: left - baseLeft, right: right - baseLeft, top, bottom: top + block.height });
  }
  const roundedOn = view.state.facet(rounded);
  const corners = roundedOn ? pieceCorners(pieces, charWidth) : null;
  const markers: LayerMarker[] = [];
  pieces.forEach((piece, i) => {
    const top = multiple && i === 0 ? 1 : 0;
    const bottom = multiple && i === pieces.length - 1 && i !== 0 ? 1 : 0;
    const y = piece.top + top;
    const height = piece.bottom - piece.top - top - bottom;
    const corner = corners?.[i];
    if (corner) {
      for (const fillet of filletPieces(corner)) {
        const x = fillet.side === "start" ? piece.left - FILLET_WIDTH : piece.right;
        markers.push(new RectangleMarker("cm-selectionBackground", x, y, FILLET_WIDTH, height));
        markers.push(new RectangleMarker(`cm-selectionBackdrop ${fillet.radius.join(" ")}`, x, y, FILLET_WIDTH, height));
      }
    }
    const classes = corner ? radiusClasses(corner) : [];
    markers.push(new RectangleMarker(["cm-selectionBackground", ...classes].join(" "), piece.left, y, piece.right - piece.left, height));
  });
  return markers;
}

// 글자 사이 위치의 가로 좌표(화면 기준). 줄 처음이면 오른쪽 글자의 왼쪽, 아니면 왼쪽 글자의 오른쪽.
function caretX(view: EditorView, pos: number, lineStart: number): number | null {
  const coords = pos > lineStart ? view.coordsAtPos(pos, -1) : view.coordsAtPos(pos, 1);
  if (!coords) return null;
  return pos > lineStart ? coords.right : coords.left;
}

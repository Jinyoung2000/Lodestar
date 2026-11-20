import { codeFolding, foldService, foldState, foldedRanges, language, syntaxTree } from "@codemirror/language";
import { Prec, RangeSet, RangeSetBuilder, type EditorState, type Extension, type Range } from "@codemirror/state";
import { BlockType, Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import { registerEditorCommands } from "./editorCommands";
import "./editorFold.css";
import { FOLD_COMMANDS, foldCommandSpec, foldSetup, foldedAt, iconClickSpec, rangeOf, regionAtLine, type FoldSetup } from "./editorFoldRegions";
import { regionMarkersFor } from "./editorFoldModel";
import { isOffSideLanguage } from "./editorGuidesModel";
import { languageIdFor } from "./languageId";

// 접기 확장(editor.folding, showFoldingControls, foldingStrategy, foldingHighlight). 구간 계산은 editorFoldRegions.ts, 이 파일은 화면 쪽이다:
// 접기 화살표 열, 접힌 줄 뒤의 생략 표시, 접힌 줄 배경, 명령 등록.
export function foldExtension(options: EditorOptions, context: OptionContext): Extension {
  const layout = gutterLayout(options);
  if (!options.folding) return layout;
  const setup: FoldSetup = {
    strategy: options.foldingStrategy,
    markers: regionMarkersFor(context.path),
    offSide: isOffSideLanguage(context.path ? languageIdFor(context.path) : null),
  };
  const controls = options.showFoldingControls;
  return [
    layout,
    foldSetup.of(setup),
    codeFolding({ placeholderDOM }),
    foldService.of((state, from) => {
      const region = regionAtLine(state, state.doc.lineAt(from).number);
      return region ? rangeOf(state.doc, region) : null;
    }),
    EditorView.editorAttributes.of({ class: controls === "never" ? "cm-vsc-fold-never" : controls === "always" ? "cm-vsc-fold-always" : "cm-vsc-fold-mouseover" }),
    // 접기 화살표 열은 변경 거터(quick diff) 오른쪽에 둔다. 변경 거터는 기본 우선순위라 이쪽을 낮춘다.
    controls === "never" ? [] : Prec.low([markerPlugin, foldGutter]),
    options.foldingHighlight ? EditorView.decorations.compute([foldState], foldedLineDecorations) : [],
  ];
}

// 거터 배치 규칙(editorFold.css)을 켜는 루트 클래스. 접기 화살표 열이 있으면 변경 거터가 그 열 위에 겹쳐 앉는다.
function gutterLayout(options: EditorOptions): Extension {
  const hasFoldColumn = options.folding && options.showFoldingControls !== "never";
  return EditorView.editorAttributes.of({ class: hasFoldColumn ? "cm-vsc-layout cm-vsc-layout-fold" : "cm-vsc-layout" });
}

// 키는 web/keymap.ts 의 BINDINGS(command "editor:<id>")가 건다. 여기서 올린 명령은 팔레트에도 이름으로 뜬다.
registerEditorCommands(
  FOLD_COMMANDS.map((command) => ({
    id: command.id,
    title: command.title,
    run: (view: EditorView) => {
      const spec = foldCommandSpec(view.state, command);
      if (!spec) return false;
      view.dispatch(spec);
      return true;
    },
  })),
);

// --- 접기 화살표 열 ---

class FoldMarker extends GutterMarker {
  constructor(readonly open: boolean) {
    super();
  }
  eq(other: GutterMarker) {
    return other instanceof FoldMarker && other.open === this.open;
  }
  toDOM() {
    const icon = document.createElement("span");
    icon.className = `codicon ${this.open ? "codicon-chevron-down cm-vsc-fold-open" : "codicon-chevron-right cm-vsc-fold-closed"}`;
    icon.title = this.open ? "Click to collapse the range." : "Click to expand the range.";
    return icon;
  }
}

const openMarker = new FoldMarker(true);
const closedMarker = new FoldMarker(false);

const markerPlugin = ViewPlugin.fromClass(
  class {
    markers: RangeSet<GutterMarker> = RangeSet.empty;
    constructor(view: EditorView) {
      this.markers = this.build(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.facet(language) !== update.state.facet(language) ||
        update.startState.field(foldState, false) !== update.state.field(foldState, false) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.markers = this.build(update.view);
      }
    }
    private build(view: EditorView) {
      const builder = new RangeSetBuilder<GutterMarker>();
      const { state } = view;
      for (const block of view.viewportLineBlocks) {
        if (block.type !== BlockType.Text) continue;
        const line = state.doc.lineAt(block.from);
        if (foldedAt(state, line)) builder.add(line.from, line.from, closedMarker);
        else if (regionAtLine(state, line.number)) builder.add(line.from, line.from, openMarker);
      }
      return builder.finish();
    }
  },
);

const foldGutter = gutter({
  class: "cm-vsc-foldGutter",
  markers: (view) => view.plugin(markerPlugin)?.markers ?? RangeSet.empty,
  initialSpacer: () => closedMarker,
  domEventHandlers: {
    click: (view, block, event) => toggleFromGutter(view, block.from, (event as MouseEvent).altKey ? "others" : (event as MouseEvent).shiftKey ? "recursive" : "plain"),
    auxclick: (view, block, event) => (event as MouseEvent).button === 1 && toggleFromGutter(view, block.from, "recursive"),
  },
});

function toggleFromGutter(view: EditorView, pos: number, modifier: "plain" | "recursive" | "others"): boolean {
  const spec = iconClickSpec(view.state, view.state.doc.lineAt(pos).number, modifier);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

// 접힌 줄 뒤의 생략 표시(번들 .inline-folded:after). 누르면 펼친다.
function placeholderDOM(_view: EditorView, onclick: (event: Event) => void): HTMLElement {
  const element = document.createElement("span");
  element.className = "cm-vsc-folded";
  element.textContent = "⋯";
  element.onclick = onclick;
  return element;
}

// 접힌 줄 전체 배경(editor.foldingHighlight, editor.foldBackground)
const foldedLine = Decoration.line({ class: "cm-vsc-folded-line" });

function foldedLineDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let last = -1;
  foldedRanges(state).between(0, state.doc.length, (from) => {
    const line = state.doc.lineAt(from);
    if (line.from !== last) ranges.push(foldedLine.range(line.from));
    last = line.from;
  });
  return Decoration.set(ranges, true);
}

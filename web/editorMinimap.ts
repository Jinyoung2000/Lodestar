import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, Facet, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import type { EditorOptions } from "../shared/editorOptions";
import "./editorMinimap.css";
import { changeMarksOf } from "./changeGutter";
import { parseColor, toCanvasColor, transparent, type Rgba } from "./editorColorModel";
import { registerEditorCommands } from "./editorCommands";
import { currentEditorOptions, saveEditorOption } from "./editorOptions";
import { diagnosticRanges, findMatchRanges, selectionMatchRanges, wordHighlightMarks } from "./editorMarks";
import { rightFurniture, verticalScrollbarWidth } from "./editorRightLayout";
import {
  MINIMAP_PAD,
  backgroundIsLight,
  lineAtOffset,
  lineOffsets,
  lineRuns,
  minimapLayout,
  minimapUsable,
  renderLayout,
  renderMinimapLine,
  scrollTopFromSliderDelta,
  xForColumn,
  yForLine,
  type ImageLike,
  type LineRun,
  type MinimapLayout,
  type RenderLayout,
  type Span,
} from "./editorMinimapModel";
import { syntaxHighlighters } from "./editorSyntax";

type MinimapSettings = { enabled: boolean; renderCharacters: boolean; showSlider: "always" | "mouseover"; selectionHighlight: boolean; scrollBeyondLastLine: boolean };

const minimapSettings = Facet.define<MinimapSettings, MinimapSettings>({
  combine: (values) => values[values.length - 1] ?? { enabled: true, renderCharacters: true, showSlider: "mouseover", selectionHighlight: true, scrollBeyondLastLine: true },
});

export function minimapExtension(options: EditorOptions): Extension {
  return [
    minimapSettings.of({
      enabled: options.minimap,
      renderCharacters: options.minimapRenderCharacters,
      showSlider: options.minimapShowSlider,
      selectionHighlight: options.selectionHighlight,
      scrollBeyondLastLine: options.scrollBeyondLastLine,
    }),
    rightFurniture,
    minimapPlugin,
  ];
}

// 줄이 아주 길어도 폭 120칸 안쪽만 그리므로 앞부분만 읽는다(탭이 칸을 늘려도 충분한 여유)
const MAX_LINE_CHARS = 600;
const ZERO_WIDTH = "0px";

type Palette = {
  background: Rgba;
  foreground: Rgba;
  selection: Rgba;
  selectionMatch: Rgba;
  find: Rgba;
  error: Rgba;
  warning: Rgba;
  info: Rgba;
  added: Rgba;
  modified: Rgba;
  deleted: Rgba;
};

const PALETTE_VARS: Record<Exclude<keyof Palette, "foreground">, string> = {
  background: "--editor-bg",
  selection: "--editor-selection",
  selectionMatch: "--editor-selection-match",
  find: "--find-match-bg",
  error: "--ruler-error",
  warning: "--editor-warning",
  info: "--editor-info",
  added: "--editor-gutter-added",
  modified: "--editor-gutter-modified",
  deleted: "--editor-gutter-deleted",
};

// 미니맵 장식: position 1 은 글자 위 칸 범위, 2 는 왼쪽 가장자리 2픽셀 띠(변경 줄)
type Decoration = { from: number; to: number; color: Rgba; z: number; position: 1 | 2 };

class MinimapPlugin {
  private readonly root = element("div", "cm-minimap");
  private readonly canvas = element("canvas", "");
  private readonly decorations = element("canvas", "cm-minimap-decorations");
  private readonly slider = element("div", "cm-minimap-slider");
  private readonly sliderFill = element("div", "cm-minimap-slider-fill");
  private readonly shadow = element("div", "cm-minimap-shadow");
  private readonly probe = element("span", "");
  private readonly scroller: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly themeObserver: MutationObserver;
  private frame = 0;
  private layout: MinimapLayout | null = null;
  private rendered: RenderLayout | null = null;
  private charsKey = "";
  private palette: Palette | null = null;
  private classColors = new Map<string, Rgba>();
  private themeVersion = 0;
  private drag: { startY: number; layout: RenderLayout; pointerId: number } | null = null;

  constructor(private readonly view: EditorView) {
    this.scroller = view.scrollDOM;
    this.probe.style.display = "none";
    this.slider.append(this.sliderFill);
    this.root.append(this.shadow, this.canvas, this.decorations, this.slider);
    view.dom.append(this.root, this.probe);
    this.root.addEventListener("pointerdown", this.onPointerDown);
    this.root.addEventListener("wheel", this.onWheel, { passive: false });
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(view.dom);
    this.observer.observe(this.scroller);
    this.themeObserver = new MutationObserver(() => {
      this.palette = null;
      this.classColors.clear();
      this.themeVersion++;
      this.schedule();
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-style", "data-black"] });
    this.schedule();
  }

  update(update: ViewUpdate) {
    if (update.startState.facet(minimapSettings) !== update.state.facet(minimapSettings)) this.charsKey = "";
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.heightChanged || update.transactions.some((tr) => tr.effects.length > 0) || update.startState.facet(minimapSettings) !== update.state.facet(minimapSettings)) this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.themeObserver.disconnect();
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.root.remove();
    this.probe.remove();
    this.setWidth(ZERO_WIDTH);
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.run();
    });
  }

  private readonly onScroll = () => this.schedule();

  private run() {
    const view = this.view;
    if (!view.dom.isConnected) return;
    const settings = view.state.facet(minimapSettings);
    const layout = settings.enabled ? this.measure(settings) : null;
    if (!layout || !minimapUsable(layout)) {
      this.hide();
      return;
    }
    this.show(layout);
    const rendered = this.computeRendered(layout, settings);
    this.rendered = rendered;
    const palette = this.readPalette();
    const key = this.charsKeyOf(layout, rendered);
    if (key !== this.charsKey) {
      this.charsKey = key;
      this.renderChars(layout, rendered, palette);
    }
    this.renderDecorations(layout, rendered, palette, settings);
    this.placeSlider(rendered);
    const scroller = this.scroller;
    this.root.toggleAttribute("data-shadow", scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
  }

  private charsKeyOf(layout: MinimapLayout, rendered: RenderLayout) {
    const state = this.view.state;
    return `${layout.canvasInnerWidth}x${layout.canvasInnerHeight}:${layout.minimapScale}:${layout.renderMinimap}:${rendered.startLineNumber}-${rendered.endLineNumber}+${rendered.topPaddingLineCount}:${this.themeVersion}:${state.tabSize}:${state.doc.length}:${syntaxTreeKey(state)}:${docId(state)}`;
  }

  // --- 크기 ---

  private measure(settings: MinimapSettings): MinimapLayout {
    const view = this.view;
    const scroller = this.scroller;
    const gutters = view.dom.querySelector<HTMLElement>(".cm-gutters");
    const outerWidth = view.dom.clientWidth;
    return minimapLayout({
      outerWidth,
      outerHeight: scroller.clientHeight,
      pixelRatio: window.devicePixelRatio || 1,
      remainingWidth: outerWidth - (gutters?.offsetWidth ?? 0),
      charWidth: view.defaultCharacterWidth,
      verticalScrollbarWidth: verticalScrollbarWidth(scroller),
      renderCharacters: settings.renderCharacters,
    });
  }

  private computeRendered(layout: MinimapLayout, settings: MinimapSettings): RenderLayout {
    const view = this.view;
    const scroller = this.scroller;
    const doc = view.state.doc;
    const padding = view.documentPadding.top;
    const scrollTop = scroller.scrollTop;
    const viewportHeight = scroller.clientHeight;
    const first = view.lineBlockAtHeight(Math.max(0, scrollTop - padding));
    const last = view.lineBlockAtHeight(Math.max(0, scrollTop + viewportHeight - padding));
    const lineHeight = view.defaultLineHeight;
    const extra = scroller.scrollHeight - (padding + view.contentHeight + view.documentPadding.bottom);
    return renderLayout(
      {
        pixelRatio: window.devicePixelRatio || 1,
        minimapLineHeight: layout.minimapLineHeight,
        canvasInnerHeight: layout.canvasInnerHeight,
        lineHeight,
        editorHeight: viewportHeight,
        scrollBeyondLastLine: settings.scrollBeyondLastLine && extra > lineHeight,
        viewportStartLine: doc.lineAt(first.from).number,
        viewportEndLine: doc.lineAt(last.from).number,
        viewportStartLineTop: padding + first.top,
        lineCount: doc.lines,
        scrollTop,
        scrollHeight: scroller.scrollHeight,
      },
      this.rendered,
    );
  }

  private show(layout: MinimapLayout) {
    const root = this.root;
    root.style.display = "block";
    root.style.top = `${this.scroller.offsetTop}px`;
    root.style.width = `${layout.minimapWidth}px`;
    root.style.height = `${this.scroller.clientHeight}px`;
    root.setAttribute("data-slider", this.view.state.facet(minimapSettings).showSlider);
    if (this.layout?.canvasInnerWidth !== layout.canvasInnerWidth || this.layout?.canvasInnerHeight !== layout.canvasInnerHeight) {
      for (const canvas of [this.canvas, this.decorations]) {
        canvas.width = layout.canvasInnerWidth;
        canvas.height = layout.canvasInnerHeight;
        canvas.style.width = `${layout.canvasOuterWidth}px`;
        canvas.style.height = `${layout.canvasOuterHeight}px`;
      }
      this.charsKey = "";
    }
    this.layout = layout;
    this.slider.style.width = `${layout.minimapWidth}px`;
    this.setWidth(`${layout.minimapWidth}px`);
  }

  private hide() {
    this.root.style.display = "none";
    this.layout = null;
    this.charsKey = "";
    this.setWidth(ZERO_WIDTH);
  }

  // 다른 확장이 editorAttributes 로 style 속성 전체를 다시 쓰면(editorScroll.ts 의 --editor-last-columns) 적어 둔 값이 지워지므로 매번 실제 값과 비교해 다시 적는다
  private setWidth(width: string) {
    const style = this.view.dom.style;
    if (style.getPropertyValue("--editor-minimap-width") !== width) style.setProperty("--editor-minimap-width", width);
  }

  // --- 색 ---

  private readPalette(): Palette {
    if (this.palette) return this.palette;
    const style = getComputedStyle(this.view.dom);
    // Black 테마(web/styles.css)의 바탕은 color-mix() 라 문자열로 못 읽으면 숨긴 span 의 계산된 color 로 다시 읽는다
    const computed = (name: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      probe.hidden = true;
      this.view.dom.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const read = (name: string) => parseColor(style.getPropertyValue(name)) ?? parseColor(computed(name)) ?? { r: 0, g: 0, b: 0, a: 0 };
    const palette = { foreground: parseColor(getComputedStyle(this.view.contentDOM).color) ?? { r: 204, g: 204, b: 204, a: 1 } } as Palette;
    for (const key of Object.keys(PALETTE_VARS) as (keyof typeof PALETTE_VARS)[]) palette[key] = read(PALETTE_VARS[key]);
    this.palette = palette;
    return palette;
  }

  // 구문 색 클래스(cm-syn-*)의 실제 색. 에디터 안에 숨긴 span 에 클래스를 붙여 계산된 color 를 읽는다.
  private colorOfClass(cls: string, palette: Palette): Rgba {
    if (!cls) return palette.foreground;
    const cached = this.classColors.get(cls);
    if (cached) return cached;
    this.probe.className = cls;
    const color = parseColor(getComputedStyle(this.probe).color) ?? palette.foreground;
    this.classColors.set(cls, color);
    return color;
  }

  // --- 글자 ---

  private renderChars(layout: MinimapLayout, rendered: RenderLayout, palette: Palette) {
    const context = this.canvas.getContext("2d");
    if (!context || layout.canvasInnerWidth <= 0) return;
    const state = this.view.state;
    const doc = state.doc;
    const image = context.createImageData(layout.canvasInnerWidth, layout.canvasInnerHeight);
    const bg = { r: palette.background.r, g: palette.background.g, b: palette.background.b };
    new Uint32Array(image.data.buffer).fill((255 << 24) | (bg.b << 16) | (bg.g << 8) | bg.r);
    const first = doc.line(Math.min(rendered.startLineNumber, doc.lines));
    const last = doc.line(Math.min(Math.max(rendered.endLineNumber, 1), doc.lines));
    const spans = this.spansBetween(first.from, last.to);
    const cursor = { index: 0 };
    const light = backgroundIsLight(bg);
    const charWidth = layout.minimapScale;
    for (let number = first.number; number <= last.number; number++) {
      const line = doc.line(number);
      const text = line.length > MAX_LINE_CHARS ? line.text.slice(0, MAX_LINE_CHARS) : line.text;
      const raw = lineRuns(spans, cursor, line.from, line.from + text.length);
      const runs: LineRun[] = raw.map((run) => {
        const color = this.colorOfClass(run.cls, palette);
        return { end: run.end, color: { r: color.r, g: color.g, b: color.b } };
      });
      renderMinimapLine(image as ImageLike, {
        mode: layout.renderMinimap === 2 ? 2 : 1,
        scale: layout.minimapScale,
        bg,
        bgAlpha: 255,
        bgIsLight: light,
        fgAlpha: 255,
        charWidth,
        y: yForLine(rendered, number, layout.minimapLineHeight),
        tabSize: state.tabSize,
        lineHeight: layout.minimapLineHeight,
        text,
        runs,
      });
    }
    context.putImageData(image, 0, 0);
  }

  // 구문 트리의 색 구간. 보이는 범위까지 파서를 잠깐 돌려 둔다(예산 안에서만).
  private spansBetween(from: number, to: number): Span[] {
    const state = this.view.state;
    const tree = ensureSyntaxTree(state, to, 30) ?? syntaxTree(state);
    const spans: Span[] = [];
    highlightTree(tree, syntaxHighlighters, (start, end, cls) => spans.push({ from: start, to: end, cls }), from, to);
    return spans;
  }

  // --- 장식 ---

  private renderDecorations(layout: MinimapLayout, rendered: RenderLayout, palette: Palette, settings: MinimapSettings) {
    const context = this.decorations.getContext("2d");
    if (!context || layout.canvasInnerWidth <= 0) return;
    const state = this.view.state;
    const doc = state.doc;
    const { canvasInnerWidth: width, canvasInnerHeight: height, minimapLineHeight: lineHeight, minimapScale: charWidth } = layout;
    context.clearRect(0, 0, width, height);
    const start = rendered.startLineNumber;
    const end = rendered.endLineNumber;
    if (end < start) return;
    const windowFrom = doc.line(start).from;
    const windowTo = doc.line(end).to;
    const y = (line: number) => yForLine(rendered, line, lineHeight);
    const decorations = this.collectDecorations(state, palette, settings, windowFrom, windowTo);
    const offsets = new Map<number, number[]>();
    const offsetsOf = (number: number) => {
      let cached = offsets.get(number);
      if (!cached) {
        cached = lineOffsets(doc.line(number).text.slice(0, MAX_LINE_CHARS), state.tabSize, charWidth, width);
        offsets.set(number, cached);
      }
      return cached;
    };
    const lineRange = (from: number, to: number): [number, number] | null => {
      const a = Math.max(start, doc.lineAt(Math.max(from, windowFrom)).number);
      const b = Math.min(end, doc.lineAt(Math.min(to, windowTo)).number);
      return from > windowTo || to < windowFrom || a > b ? null : [a, b];
    };
    const fillColumns = (from: number, to: number, number: number, color: Rgba) => {
      const line = doc.line(number);
      const startColumn = from >= line.from && from <= line.to ? from - line.from + 1 : 1;
      const endColumn = to >= line.from && to <= line.to ? to - line.from + 1 : line.length + 1;
      const offs = offsetsOf(number);
      const x1 = xForColumn(offs, startColumn, charWidth, width);
      const x2 = xForColumn(offs, endColumn, charWidth, width);
      context.fillStyle = toCanvasColor(color);
      context.fillRect(x1, y(number), x2 - x1, lineHeight);
    };

    const seen = new Set<number>();
    const selectionColor = palette.selection;
    // 1. 선택이 걸친 줄의 옅은 띠. 번들 그대로 첫 줄 위쪽에서 마지막 줄 위쪽까지 칠한다(여러 줄 선택에서만 띠가 생긴다).
    context.fillStyle = toCanvasColor(transparent(selectionColor, 0.5));
    let bandStart = 0;
    let bandEnd = 0;
    for (const range of state.selection.ranges) {
      const lines = lineRange(range.from, range.to);
      if (!lines) continue;
      for (let line = lines[0]; line <= lines[1]; line++) seen.add(line);
      const top = y(lines[0]);
      if (!(bandEnd >= top)) {
        if (bandEnd > bandStart) context.fillRect(MINIMAP_PAD, bandStart, width, bandEnd - bandStart);
        bandStart = top;
      }
      bandEnd = y(lines[1]);
    }
    if (bandEnd > bandStart) context.fillRect(MINIMAP_PAD, bandStart, width, bandEnd - bandStart);
    // 2. 장식이 걸친 줄의 옅은 띠(z 가 높은 것부터, 줄마다 한 번)
    for (let index = decorations.length - 1; index >= 0; index--) {
      const decoration = decorations[index]!;
      if (decoration.position !== 1) continue;
      const lines = lineRange(decoration.from, decoration.to);
      if (!lines || decoration.color.a === 0) continue;
      context.fillStyle = toCanvasColor(transparent(decoration.color, 0.5));
      for (let line = lines[0]; line <= lines[1]; line++) {
        if (seen.has(line)) continue;
        seen.add(line);
        context.fillRect(MINIMAP_PAD, y(line), width, lineHeight);
      }
    }
    // 3. 선택한 글자 범위, 4. 장식의 글자 범위와 왼쪽 띠(z 가 낮은 것부터)
    if (selectionColor.a > 0) {
      for (const range of state.selection.ranges) {
        const lines = lineRange(range.from, range.to);
        if (lines) for (let line = lines[0]; line <= lines[1]; line++) fillColumns(range.from, range.to, line, selectionColor);
      }
    }
    for (const decoration of decorations) {
      const lines = lineRange(decoration.from, decoration.to);
      if (!lines || decoration.color.a === 0) continue;
      if (decoration.position === 1) {
        for (let line = lines[0]; line <= lines[1]; line++) fillColumns(decoration.from, decoration.to, line, decoration.color);
      } else {
        context.fillStyle = toCanvasColor(decoration.color);
        for (let line = lines[0]; line <= lines[1]; line++) context.fillRect(2, y(line), 2, lineHeight);
      }
    }
  }

  // 보이는 줄 범위에 걸친 장식만 모은다. 찾기 일치, 선택 일치, 진단은 번들과 같이 글자 위(position 1), 변경 줄은 왼쪽 띠(position 2)다.
  private collectDecorations(state: EditorState, palette: Palette, settings: MinimapSettings, windowFrom: number, windowTo: number): Decoration[] {
    const out: Decoration[] = [];
    const inside = (from: number, to: number) => from <= windowTo && to >= windowFrom;
    for (const match of findMatchRanges(state)) if (inside(match.from, match.to)) out.push({ ...match, color: palette.find, z: 10, position: 1 });
    if (settings.selectionHighlight) for (const match of selectionMatchRanges(state)) if (inside(match.from, match.to)) out.push({ ...match, color: palette.selectionMatch, z: 0, position: 1 });
    for (const word of wordHighlightMarks(state)) if (inside(word.from, word.to)) out.push({ from: word.from, to: word.to, color: palette.selectionMatch, z: 0, position: 1 });
    for (const diagnostic of diagnosticRanges(state)) {
      if (!inside(diagnostic.from, diagnostic.to)) continue;
      const color = diagnostic.severity === "error" ? palette.error : diagnostic.severity === "warning" ? palette.warning : palette.info;
      out.push({ from: diagnostic.from, to: diagnostic.to, color, z: diagnostic.severity === "error" ? 30 : diagnostic.severity === "warning" ? 20 : 10, position: 1 });
    }
    const { set, kindOf } = changeMarksOf(state);
    for (const iter = set.iter(); iter.value; iter.next()) {
      const kind = kindOf(iter.value);
      if (kind && inside(iter.from, iter.from)) out.push({ from: iter.from, to: iter.from, color: kind === "added" ? palette.added : kind === "modified" ? palette.modified : palette.deleted, z: 0, position: 2 });
    }
    return out.sort((a, b) => a.z - b.z);
  }

  // --- 슬라이더와 입력 ---

  private placeSlider(rendered: RenderLayout) {
    this.slider.style.display = rendered.sliderNeeded ? "block" : "none";
    this.slider.style.top = `${rendered.sliderTop}px`;
    this.slider.style.height = `${rendered.sliderHeight}px`;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    const rendered = this.rendered;
    const layout = this.layout;
    if (!rendered || !layout) return;
    event.preventDefault();
    if (event.target === this.slider || event.target === this.sliderFill) {
      if (event.button !== 0) return;
      event.stopPropagation();
      this.drag = { startY: event.clientY, layout: rendered, pointerId: event.pointerId };
      this.slider.setAttribute("data-active", "");
      this.root.setPointerCapture(event.pointerId);
      this.root.addEventListener("pointermove", this.onPointerMove);
      this.root.addEventListener("pointerup", this.onPointerUp);
      this.root.addEventListener("pointercancel", this.onPointerUp);
      return;
    }
    // 글자 부분을 누르면 그 줄을 에디터 가운데로 보낸다(커서는 옮기지 않는다)
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const line = lineAtOffset(rendered, { ...layout, lineCount: this.view.state.doc.lines }, event.clientY - this.root.getBoundingClientRect().top);
    this.centerLine(line);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag) return;
    this.scroller.scrollTop = scrollTopFromSliderDelta(drag.layout, event.clientY - drag.startY);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.root.hasPointerCapture(drag.pointerId)) this.root.releasePointerCapture(event.pointerId);
    this.slider.removeAttribute("data-active");
    this.root.removeEventListener("pointermove", this.onPointerMove);
    this.root.removeEventListener("pointerup", this.onPointerUp);
    this.root.removeEventListener("pointercancel", this.onPointerUp);
  };

  private centerLine(lineNumber: number) {
    const view = this.view;
    const block = view.lineBlockAt(view.state.doc.line(lineNumber).from);
    const target = view.documentPadding.top + block.top - (this.scroller.clientHeight - block.height) / 2;
    this.scroller.scrollTop = Math.max(0, target);
  }

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? this.view.defaultLineHeight : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.scroller.clientHeight : 1;
    this.scroller.scrollBy({ top: event.deltaY * unit, left: event.deltaX * unit });
  };
}

const minimapPlugin = ViewPlugin.fromClass(MinimapPlugin);

registerEditorCommands([{ id: "toggleMinimap", title: "View: Toggle Minimap", run: () => saveEditorOption("minimap", !currentEditorOptions().minimap) }]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// 구문 트리와 문서가 같은지 판별하는 열쇠. 객체 자체를 비교할 수 없어(키 문자열이어야 한다) 마지막으로 본 객체에 번호를 붙인다.
const identity = new WeakMap<object, number>();
let identityCounter = 0;
function idOf(object: object): number {
  let id = identity.get(object);
  if (id === undefined) {
    id = ++identityCounter;
    identity.set(object, id);
  }
  return id;
}
const syntaxTreeKey = (state: EditorState) => idOf(syntaxTree(state));
const docId = (state: EditorState) => idOf(state.doc);


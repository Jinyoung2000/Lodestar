import { matchBrackets } from "@codemirror/language";
import { Facet, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import "./editorRuler.css";
import { changeMarksOf } from "./changeGutter";
import { parseColor, toCanvasColor, transparent } from "./editorColorModel";
import { rightFurniture } from "./editorRightLayout";
import { diagnosticRanges, findMatchRanges, selectionMatchRanges, wordHighlightMarks } from "./editorMarks";
import { LANE_CENTER, LANE_LEFT, LANE_RIGHT, SEVERITY_Z, layoutCursors, layoutZones, overSlider, rulerLanes, scrollFromDelta, scrollFromOffset, sliderMetrics, type RulerLane, type RulerZone } from "./editorRulerModel";

type RulerSettings = { border: boolean; hideCursor: boolean; selectionMatches: boolean; brackets: boolean };

const rulerSettings = Facet.define<RulerSettings, RulerSettings>({
  combine: (values) => values[values.length - 1] ?? { border: true, hideCursor: false, selectionMatches: true, brackets: true },
});

export function rulerExtension(options: EditorOptions): Extension {
  return [
    rulerSettings.of({ border: options.overviewRulerBorder, hideCursor: options.hideCursorInOverviewRuler, selectionMatches: options.selectionHighlight, brackets: options.matchBrackets !== "never" }),
    rightFurniture,
    rulerPlugin,
  ];
}

const HIDE_DELAY_MS = 500;
const RECOUNT_DELAY_MS = 120;
const LARGE_DOC = 100_000;

type SourceZone = { from: number; to: number; lane: RulerLane; color: string; z: number };

type Colors = Record<"error" | "warning" | "info" | "find" | "selection" | "wordWrite" | "bracket" | "added" | "modified" | "deleted" | "border" | "cursor", string>;

const COLOR_VARS: Record<keyof Colors, string> = {
  error: "--ruler-error",
  warning: "--editor-warning",
  info: "--editor-info",
  find: "--find-ruler",
  selection: "--ruler-selection",
  wordWrite: "--ruler-word-write",
  bracket: "--ruler-bracket",
  added: "--ruler-added",
  modified: "--ruler-modified",
  deleted: "--ruler-deleted",
  border: "--ruler-border",
  cursor: "--editor-cursor",
};

class RulerPlugin {
  private readonly lane = element("div", "cm-ruler");
  private readonly canvas = element("canvas", "cm-ruler-canvas");
  private readonly slider = element("div", "cm-ruler-slider");
  private readonly decoration = element("div", "cm-scroll-decoration");
  private readonly scroller: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly themeObserver: MutationObserver;
  private frame = 0;
  private hideTimer = 0;
  private recountTimer = 0;
  private hovering = false;
  private dragging: { startY: number; startScroll: number; pointerId: number } | null = null;
  private colors: Colors | null = null;
  private sourcesDirty = true;
  private paintKey = "";
  private lastChangeSet: unknown = null;
  private diagnostics: SourceZone[] = [];
  private changes: SourceZone[] = [];
  private finds: SourceZone[] = [];
  private selections: SourceZone[] = [];
  private brackets: SourceZone[] = [];
  private words: SourceZone[] = [];
  private cursors: number[] = [];

  constructor(private readonly view: EditorView) {
    this.scroller = view.scrollDOM;
    this.lane.append(this.canvas, this.slider);
    view.dom.append(this.decoration, this.lane);
    this.lane.addEventListener("pointerdown", this.onPointerDown);
    this.lane.addEventListener("mousedown", preventFocusSteal);
    this.lane.addEventListener("wheel", this.onWheel, { passive: false });
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    view.dom.addEventListener("pointerenter", this.onEnter);
    view.dom.addEventListener("pointerleave", this.onLeave);
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(view.dom);
    this.observer.observe(this.scroller);
    this.themeObserver = new MutationObserver(() => {
      this.colors = null;
      this.paintKey = "";
      this.schedule();
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-style"] });
    this.schedule();
  }

  update(update: ViewUpdate) {
    const before = update.startState.facet(rulerSettings);
    const now = update.state.facet(rulerSettings);
    if (before !== now) this.paintKey = "";
    if (update.docChanged || update.selectionSet || before !== now || update.transactions.some((tr) => tr.effects.length > 0)) this.sourcesDirty = true;
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.heightChanged || before !== now || update.transactions.some((tr) => tr.effects.length > 0)) this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.recountTimer);
    this.observer.disconnect();
    this.themeObserver.disconnect();
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.view.dom.removeEventListener("pointerenter", this.onEnter);
    this.view.dom.removeEventListener("pointerleave", this.onLeave);
    this.lane.remove();
    this.decoration.remove();
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.run();
    });
  }

  private run() {
    if (!this.view.dom.isConnected) return;
    this.layout();
    if (this.sourcesDirty) this.collect();
    this.paint();
    this.placeSlider();
  }

  private layout() {
    const top = this.scroller.offsetTop;
    const height = this.scroller.offsetHeight;
    this.lane.style.top = `${top}px`;
    this.lane.style.height = `${height}px`;
    this.decoration.style.top = `${top}px`;
    this.decoration.toggleAttribute("hidden", this.scroller.scrollTop <= 0);
  }

  private collect() {
    this.sourcesDirty = false;
    this.paintKey = "";
    const state = this.view.state;
    const settings = state.facet(rulerSettings);
    const colors = this.readColors();
    this.diagnostics = diagnosticZones(state, colors);
    this.changes = changeZones(state, colors);
    this.brackets = settings.brackets ? bracketZones(state, colors) : [];
    this.words = wordZones(state, colors);
    this.cursors = state.selection.ranges.map((range) => range.head);
    const changeSet = changeMarksOf(state).set;
    this.lastChangeSet = changeSet;
    this.collectSlow(settings, colors);
  }

  private collectSlow(settings: RulerSettings, colors: Colors) {
    window.clearTimeout(this.recountTimer);
    const run = () => {
      const state = this.view.state;
      this.finds = findZones(state, colors);
      this.selections = settings.selectionMatches ? selectionZones(state, colors) : [];
      this.paintKey = "";
      this.schedule();
    };
    if (this.view.state.doc.length > LARGE_DOC) this.recountTimer = window.setTimeout(run, RECOUNT_DELAY_MS);
    else run();
  }

  private readColors(): Colors {
    if (this.colors) return this.colors;
    const style = getComputedStyle(this.view.dom);
    const read = (name: string) => style.getPropertyValue(name).trim();
    const colors = {} as Colors;
    for (const key of Object.keys(COLOR_VARS) as (keyof Colors)[]) colors[key] = read(COLOR_VARS[key]);
    const cursor = parseColor(colors.cursor);
    if (cursor) colors.cursor = toCanvasColor(transparent(cursor, 0.7));
    this.colors = colors;
    return colors;
  }

  private paint() {
    const state = this.view.state;
    const settings = state.facet(rulerSettings);
    const cssWidth = this.lane.clientWidth;
    const cssHeight = this.lane.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const scrollHeight = this.scroller.scrollHeight;
    const changeSet = changeMarksOf(state).set;
    if (changeSet !== this.lastChangeSet) {
      this.sourcesDirty = true;
      this.schedule();
    }
    const key = `${cssWidth}x${cssHeight}@${dpr}:${scrollHeight}:${this.view.contentHeight}:${settings.border}${settings.hideCursor}`;
    if (key === this.paintKey) return;
    this.paintKey = key;
    const width = Math.floor(cssWidth * dpr);
    const height = Math.floor(cssHeight * dpr);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    const colors = this.readColors();
    const lanes = rulerLanes(width);
    const metrics = { scrollHeight, canvasHeight: height, dpr, lanes };
    const base = this.view.documentPadding.top;
    const toZone = (zone: SourceZone): RulerZone => ({
      lane: zone.lane,
      color: zone.color,
      z: zone.z,
      top: base + this.view.lineBlockAt(zone.from).top,
      bottom: base + this.view.lineBlockAt(zone.to).bottom,
    });
    const all = [...this.changes, ...this.selections, ...this.words, ...this.brackets, ...this.finds, ...this.diagnostics].map(toZone);
    for (const rect of layoutZones(all, metrics)) {
      context.fillStyle = rect.color;
      context.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    if (!settings.hideCursor) {
      const cursors = this.cursors.map((head) => ({ top: base + this.view.lineBlockAt(head).top, color: colors.cursor })).sort((a, b) => a.top - b.top);
      for (const rect of layoutCursors(cursors, metrics)) {
        context.fillStyle = rect.color;
        context.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
    }
    if (settings.border && colors.border) {
      context.beginPath();
      context.lineWidth = 1;
      context.strokeStyle = colors.border;
      context.moveTo(0, 0);
      context.lineTo(0, height);
      context.moveTo(1, 0);
      context.lineTo(width, 0);
      context.stroke();
    }
  }

  private metrics() {
    return sliderMetrics({ visible: this.scroller.clientHeight, scrollSize: this.scroller.scrollHeight, scrollPosition: this.scroller.scrollTop, oppositeSize: 0 });
  }

  private placeSlider() {
    const metrics = this.metrics();
    this.slider.style.display = metrics.needed ? "block" : "none";
    this.slider.style.top = `${metrics.position}px`;
    this.slider.style.height = `${metrics.size}px`;
  }

  private readonly onScroll = () => {
    this.layout();
    this.placeSlider();
    this.reveal();
    this.scheduleHide();
  };

  private reveal() {
    window.clearTimeout(this.hideTimer);
    this.lane.setAttribute("data-reveal", "");
  }

  private scheduleHide() {
    window.clearTimeout(this.hideTimer);
    if (this.hovering || this.dragging) return;
    this.hideTimer = window.setTimeout(() => this.lane.removeAttribute("data-reveal"), HIDE_DELAY_MS);
  }

  private readonly onEnter = () => {
    this.hovering = true;
    this.reveal();
  };

  private readonly onLeave = () => {
    this.hovering = false;
    this.scheduleHide();
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const metrics = this.metrics();
    if (!metrics.needed) return;
    const offset = event.clientY - this.lane.getBoundingClientRect().top;
    if (offset > metrics.track) return;
    if (!overSlider(metrics, offset)) this.scroller.scrollTop = scrollFromOffset(metrics, offset);
    this.dragging = { startY: event.clientY, startScroll: this.scroller.scrollTop, pointerId: event.pointerId };
    this.lane.setPointerCapture(event.pointerId);
    this.slider.setAttribute("data-active", "");
    this.lane.addEventListener("pointermove", this.onPointerMove);
    this.lane.addEventListener("pointerup", this.onPointerUp);
    this.lane.addEventListener("pointercancel", this.onPointerUp);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.dragging;
    if (!drag) return;
    this.scroller.scrollTop = scrollFromDelta(this.metrics(), drag.startScroll, event.clientY - drag.startY);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const drag = this.dragging;
    this.dragging = null;
    if (drag && this.lane.hasPointerCapture(drag.pointerId)) this.lane.releasePointerCapture(event.pointerId);
    this.slider.removeAttribute("data-active");
    this.lane.removeEventListener("pointermove", this.onPointerMove);
    this.lane.removeEventListener("pointerup", this.onPointerUp);
    this.lane.removeEventListener("pointercancel", this.onPointerUp);
    this.scheduleHide();
  };

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? this.view.defaultLineHeight : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.scroller.clientHeight : 1;
    this.scroller.scrollBy({ top: event.deltaY * unit, left: event.deltaX * unit });
  };
}

const rulerPlugin = ViewPlugin.fromClass(RulerPlugin);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function preventFocusSteal(event: MouseEvent) {
  event.preventDefault();
}


function diagnosticZones(state: EditorState, colors: Colors): SourceZone[] {
  return diagnosticRanges(state).map(({ from, to, severity }) => ({ from, to, lane: LANE_RIGHT, color: colors[severity], z: SEVERITY_Z[severity] }));
}

function changeZones(state: EditorState, colors: Colors): SourceZone[] {
  const { set, kindOf } = changeMarksOf(state);
  const zones: SourceZone[] = [];
  for (const iter = set.iter(); iter.value; iter.next()) {
    const kind = kindOf(iter.value);
    if (kind) zones.push({ from: iter.from, to: iter.from, lane: LANE_LEFT, color: kind === "added" ? colors.added : kind === "modified" ? colors.modified : colors.deleted, z: 0 });
  }
  return zones;
}

function findZones(state: EditorState, colors: Colors): SourceZone[] {
  return findMatchRanges(state).map(({ from, to }) => ({ from, to, lane: LANE_CENTER, color: colors.find, z: 10 }));
}

function selectionZones(state: EditorState, colors: Colors): SourceZone[] {
  return selectionMatchRanges(state).map(({ from, to }) => ({ from, to, lane: LANE_CENTER, color: colors.selection, z: 0 }));
}

function wordZones(state: EditorState, colors: Colors): SourceZone[] {
  return wordHighlightMarks(state).map(({ from, to, kind }) => ({ from, to, lane: LANE_CENTER, color: kind === "write" ? colors.wordWrite : colors.selection, z: 0 }));
}

function bracketZones(state: EditorState, colors: Colors): SourceZone[] {
  const zones: SourceZone[] = [];
  for (const range of state.selection.ranges) {
    if (!range.empty) continue;
    const head = range.head;
    const match =
      matchBrackets(state, head, -1) ||
      (head > 0 ? matchBrackets(state, head - 1, 1) : null) ||
      matchBrackets(state, head, 1) ||
      (head < state.doc.length ? matchBrackets(state, head + 1, -1) : null);
    if (!match?.matched || !match.end) continue;
    zones.push({ from: match.start.from, to: match.start.to, lane: LANE_CENTER, color: colors.bracket, z: 0 }, { from: match.end.from, to: match.end.to, lane: LANE_CENTER, color: colors.bracket, z: 0 });
  }
  return zones;
}

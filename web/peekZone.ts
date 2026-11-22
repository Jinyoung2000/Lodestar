import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import "./peekView.css";


export type ZoneParts = {
  root: HTMLElement;
  head: HTMLElement;
  title: HTMLElement;
  actions: HTMLElement;
  body: HTMLElement;
  host: EditorView;
  close: () => void;
  onLayout: (listener: (size: { width: number; height: number }) => void) => void;
};

export type ZoneSpec = {
  id: number;
  anchor: number;
  arrowAt: number;
  lines: number;
  className: string;
  mount: (parts: ZoneParts) => () => void;
  onResize?: (lines: number) => void;
};

const setZone = StateEffect.define<ZoneSpec | null>();

const zoneField = StateField.define<ZoneSpec | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setZone)) return effect.value;
    if (!value || !tr.docChanged) return value;
    return { ...value, anchor: tr.changes.mapPos(value.anchor, 1), arrowAt: tr.changes.mapPos(value.arrowAt, 1) };
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state): DecorationSet => {
      const spec = state.field(field);
      if (!spec) return Decoration.none;
      return Decoration.set([Decoration.widget({ widget: new ZoneWidget(spec), block: true, side: 1 }).range(state.doc.lineAt(Math.min(spec.anchor, state.doc.length)).to)]);
    }),
});

export function zoneExtension(): Extension {
  return zoneField;
}

export function currentZone(view: EditorView) {
  return view.state.field(zoneField, false) ?? null;
}

export function showZone(view: EditorView, spec: ZoneSpec) {
  view.dispatch({ effects: setZone.of(spec) });
}

export function hideZone(view: EditorView, options: { refocus?: boolean } = {}) {
  if (!currentZone(view)) return false;
  view.dispatch({ effects: setZone.of(null) });
  if (options.refocus !== false) view.focus();
  return true;
}

class ZoneWidget extends WidgetType {
  private cleanup: (() => void) | null = null;
  private observer: ResizeObserver | null = null;

  constructor(private spec: ZoneSpec) {
    super();
  }

  eq(other: ZoneWidget) {
    return other.spec.id === this.spec.id;
  }

  get estimatedHeight() {
    return this.spec.lines * 20; // lint-tokens: allow 높이 추정값, 실제 높이는 toDOM 이 줄 높이로 정한다
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view: EditorView) {
    const { spec } = this;
    const lineHeight = view.defaultLineHeight;
    const headHeight = Math.ceil(lineHeight * 1.2);
    const arrowHeight = Math.round(lineHeight / 3);
    let lines = spec.lines;
    const layoutListeners: ((size: { width: number; height: number }) => void)[] = [];

    const root = document.createElement("div");
    root.className = `cm-zone ${spec.className}`;
    root.dataset.testid = "peek-zone";
    const arrow = document.createElement("div");
    arrow.className = "cm-zone-arrow";
    arrow.style.borderWidth = `0 ${arrowHeight}px ${arrowHeight}px`;
    arrow.style.top = "0";
    const container = document.createElement("div");
    container.className = "cm-zone-container";
    const head = document.createElement("div");
    head.className = "cm-zone-head";
    head.style.height = `${headHeight}px`;
    head.style.lineHeight = `${headHeight}px`;
    const title = document.createElement("div");
    title.className = "cm-zone-title";
    const actions = document.createElement("div");
    actions.className = "cm-zone-actions";
    head.append(title, actions);
    const body = document.createElement("div");
    body.className = "cm-zone-body";
    const sash = document.createElement("div");
    sash.className = "cm-zone-sash";
    container.append(head, body, sash);
    root.append(arrow, container);
    root.style.paddingTop = `${arrowHeight}px`;

    const applyHeight = () => {
      root.style.height = `${lines * lineHeight}px`;
      const bodyHeight = lines * lineHeight - arrowHeight - headHeight - 3;
      body.style.height = `${Math.max(bodyHeight, 0)}px`;
    };
    applyHeight();

    const layout = () => {
      const gutters = view.dom.querySelector<HTMLElement>(".cm-gutters");
      const offset = gutters?.offsetWidth ?? 0;
      root.style.left = `${offset}px`;
      root.style.width = `${Math.max(view.scrollDOM.clientWidth - offset, 0)}px`;
      const coords = view.coordsAtPos(spec.arrowAt);
      const rootBox = root.getBoundingClientRect();
      if (coords) arrow.style.left = `${Math.min(Math.max(coords.left - rootBox.left - arrowHeight, arrowHeight), Math.max(rootBox.width - arrowHeight * 3, 0))}px`;
      const size = { width: body.clientWidth, height: body.clientHeight };
      for (const listener of layoutListeners) listener(size);
    };

    sash.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      sash.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const startLines = lines;
      const move = (e: PointerEvent) => {
        lines = Math.max(6, startLines + Math.round((e.clientY - startY) / lineHeight));
        applyHeight();
        layout();
        view.requestMeasure();
      };
      const up = () => {
        sash.removeEventListener("pointermove", move);
        sash.removeEventListener("pointerup", up);
        spec.onResize?.(lines);
      };
      sash.addEventListener("pointermove", move);
      sash.addEventListener("pointerup", up);
    });

    const close = () => hideZone(view);
    this.cleanup = spec.mount({ root, head, title, actions, body, host: view, close, onLayout: (listener) => layoutListeners.push(listener) });
    this.observer = new ResizeObserver(layout);
    this.observer.observe(view.scrollDOM);
    let placed = false;
    const place = () => {
      if (placed || !root.isConnected) return;
      placed = true;
      layout();
      revealZone(view, root);
    };
    requestAnimationFrame(place);
    setTimeout(place, 30);
    return root;
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    const cleanup = this.cleanup;
    this.cleanup = null;
    cleanup?.();
  }
}

function revealZone(view: EditorView, root: HTMLElement) {
  const scroller = view.scrollDOM.getBoundingClientRect();
  const rect = root.getBoundingClientRect();
  if (rect.bottom > scroller.bottom) view.scrollDOM.scrollTop += Math.min(rect.bottom - scroller.bottom, Math.max(rect.top - scroller.top, 0));
}

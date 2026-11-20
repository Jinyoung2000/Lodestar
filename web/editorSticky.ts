import { LSPPlugin } from "@codemirror/lsp-client";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Facet, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import type { EditorOptions } from "../shared/editorOptions";
import "./editorSticky.css";
import { mapSymbols } from "./breadcrumbModel";
import { rightFurniture } from "./editorRightLayout";
import { registerEditorCommands } from "./editorCommands";
import { currentEditorOptions, saveEditorOption } from "./editorOptions";
import { fetchDocumentSymbolsOrNull, type SymbolNode } from "./documentSymbols";
import { foldSymbols, stickyFromSymbols } from "./editorStickyFolds";
import { EMPTY_STICKY, STICKY_MODEL_MS, STICKY_UPDATE_MS, candidateLines, findStickyState, maxStickyLines, stickyLayout, stickyStateEquals, type StickyNode, type StickyState } from "./editorStickyModel";
import { syntaxHighlighters } from "./editorSyntax";

type StickySettings = { enabled: boolean; maxLineCount: number; lineNumbers: EditorOptions["lineNumbers"] };

const stickySettings = Facet.define<StickySettings, StickySettings>({
  combine: (values) => values[values.length - 1] ?? { enabled: true, maxLineCount: 5, lineNumbers: "on" },
});

export function stickyExtension(options: EditorOptions): Extension {
  return [
    stickySettings.of({ enabled: options.stickyScroll, maxLineCount: options.stickyScrollMaxLineCount, lineNumbers: options.lineNumbers }),
    rightFurniture,
    stickyPlugin,
    // 커서나 선택을 화면에 들일 때 고정 줄에 가려지지 않도록 위쪽 여백으로 알린다
    EditorView.scrollMargins.of((view) => {
      const height = view.plugin(stickyPlugin)?.height ?? 0;
      return height > 0 ? { top: height } : null;
    }),
  ];
}

// LSP 는 열자마자 심볼이 비어 있을 수 있어(서버가 색인 중) 몇 번 더 묻는다
const EMPTY_RETRY_MS = 1500;
const EMPTY_RETRY_COUNT = 4;
// 아주 긴 줄은 앞부분만 그린다
const MAX_LINE_CHARS = 1000;

class StickyPlugin {
  readonly root = element("div", "cm-sticky");
  private readonly numbers = element("div", "cm-sticky-numbers");
  private readonly scroll = element("div", "cm-sticky-scroll");
  private readonly lines = element("div", "cm-sticky-lines");
  private readonly scroller: HTMLElement;
  private readonly observer: ResizeObserver;
  private frame = 0;
  private modelTimer = 0;
  private renderTimer = 0;
  private request = 0;
  private retries = 0;
  private destroyed = false;
  private symbols: SymbolNode[] = [];
  private derived: { symbols: SymbolNode[]; doc: EditorState["doc"]; tree: StickyNode[] } | null = null;
  private shown: StickyState = EMPTY_STICKY;
  private shownKey = "";
  height = 0;

  constructor(private readonly view: EditorView) {
    this.scroller = view.scrollDOM;
    this.scroll.append(this.lines);
    this.root.append(this.numbers, this.scroll);
    view.dom.append(this.root);
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("mousedown", preventDefault);
    this.root.addEventListener("wheel", this.onWheel, { passive: false });
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(view.dom);
    this.observer.observe(this.scroller);
    this.scheduleModel(0);
  }

  update(update: ViewUpdate) {
    const settings = update.state.facet(stickySettings);
    const changed = update.startState.facet(stickySettings) !== settings;
    if (update.docChanged) {
      // 새 심볼이 오기 전까지는 이전 트리를 변경에 맞춰 옮겨 쓴다
      this.symbols = mapSymbols(this.symbols, update.changes);
      this.derived = null;
      this.scheduleModel(STICKY_MODEL_MS);
      this.scheduleRender(STICKY_UPDATE_MS, true);
    } else if (changed) {
      this.shownKey = "";
      this.scheduleModel(0);
      this.schedule();
    } else if (update.viewportChanged || update.geometryChanged || update.heightChanged) this.schedule();
    else if (update.selectionSet && settings.lineNumbers === "relative") this.schedule();
    else if (update.transactions.some((tr) => tr.effects.length > 0)) this.schedule();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.modelTimer);
    window.clearTimeout(this.renderTimer);
    this.observer.disconnect();
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.root.remove();
    this.height = 0;
  }

  // --- 모델 ---

  private scheduleModel(delay: number) {
    window.clearTimeout(this.modelTimer);
    this.modelTimer = window.setTimeout(() => void this.refreshModel(), delay);
  }

  private async refreshModel() {
    if (this.destroyed) return;
    const view = this.view;
    if (!view.state.facet(stickySettings).enabled) return;
    const token = ++this.request;
    const doc = view.state.doc;
    if (this.symbols.length === 0) {
      this.symbols = foldSymbols(view.state);
      this.derived = null;
      this.schedule();
    }
    const remote = LSPPlugin.get(view) ? await fetchDocumentSymbolsOrNull(view) : null;
    if (this.destroyed || token !== this.request) return;
    // 묻는 사이 글이 바뀌었으면 위치가 어긋난 응답이니 버리고 다시 묻는다
    if (view.state.doc !== doc) return this.scheduleModel(STICKY_MODEL_MS);
    if (remote && remote.length > 0) {
      this.symbols = remote;
      this.retries = 0;
    } else {
      this.symbols = foldSymbols(view.state);
      if (remote && this.retries < EMPTY_RETRY_COUNT) {
        this.retries++;
        this.modelTimer = window.setTimeout(() => void this.refreshModel(), EMPTY_RETRY_MS);
      }
    }
    this.derived = null;
    this.schedule();
  }

  private candidateTree(): StickyNode[] {
    const doc = this.view.state.doc;
    if (this.derived?.symbols === this.symbols && this.derived.doc === doc) return this.derived.tree;
    const tree = stickyFromSymbols(this.symbols, (pos) => doc.lineAt(Math.min(pos, doc.length)).number);
    this.derived = { symbols: this.symbols, doc, tree };
    return tree;
  }

  // --- 그리기 ---

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private scheduleRender(delay: number, force: boolean) {
    window.clearTimeout(this.renderTimer);
    if (force) this.shownKey = "";
    this.renderTimer = window.setTimeout(() => this.schedule(), delay);
  }

  private render() {
    if (this.destroyed || !this.view.dom.isConnected) return;
    const view = this.view;
    const settings = view.state.facet(stickySettings);
    if (!settings.enabled) return this.clear();
    const doc = view.state.doc;
    const scroller = this.scroller;
    const lineHeight = view.defaultLineHeight;
    const padding = view.documentPadding.top;
    const scrollTop = scroller.scrollTop;
    const viewportHeight = scroller.clientHeight;
    if (viewportHeight <= 0 || lineHeight <= 0) return this.clear();
    const first = doc.lineAt(view.lineBlockAtHeight(Math.max(0, scrollTop - padding)).from).number;
    const last = doc.lineAt(view.lineBlockAtHeight(Math.max(0, scrollTop + viewportHeight - padding)).from).number;
    const candidates = candidateLines(this.candidateTree(), { start: first, end: last }, lineHeight, doc.lines);
    const max = Math.min(maxStickyLines(viewportHeight, lineHeight), settings.maxLineCount);
    const state = findStickyState(
      candidates,
      max,
      scrollTop,
      (line) => padding + view.lineBlockAt(doc.line(line).from).top,
      (line) => padding + view.lineBlockAt(doc.line(line).from).bottom,
    );
    const layout = stickyLayout(state, lineHeight);
    const cursorLine = doc.lineAt(view.state.selection.main.head).number;
    const key = `${state.startLines.join(",")}|${lineHeight}|${settings.lineNumbers}|${settings.lineNumbers === "relative" ? cursorLine : ""}|${view.state.tabSize}`;
    if (!stickyStateEquals(state, this.shown) || key !== this.shownKey) {
      this.shown = state;
      this.shownKey = key;
      this.buildLines(state, lineHeight, cursorLine, settings);
    }
    this.place(state, layout.tops, layout.height);
  }

  private clear() {
    this.shown = EMPTY_STICKY;
    this.shownKey = "";
    this.root.style.display = "none";
    this.numbers.replaceChildren();
    this.lines.replaceChildren();
    this.height = 0;
  }

  private buildLines(state: StickyState, lineHeight: number, cursorLine: number, settings: StickySettings) {
    const view = this.view;
    const doc = view.state.doc;
    const numbers: HTMLElement[] = [];
    const lines: HTMLElement[] = [];
    state.startLines.forEach((number, index) => {
      const line = doc.line(number);
      const text = line.length > MAX_LINE_CHARS ? line.text.slice(0, MAX_LINE_CHARS) : line.text;
      const content = element("span", "cm-sticky-line");
      content.dataset.stickyLine = String(index);
      content.style.height = `${lineHeight}px`;
      content.style.lineHeight = `${lineHeight}px`;
      for (const part of this.coloredParts(line.from, text)) {
        const span = element("span", part.cls);
        span.dataset.from = String(part.from);
        span.textContent = part.text;
        content.append(span);
      }
      const label = element("span", "cm-sticky-number");
      label.dataset.stickyLine = String(index);
      label.style.height = `${lineHeight}px`;
      label.style.lineHeight = `${lineHeight}px`;
      if (settings.lineNumbers === "on") label.textContent = String(number);
      else if (settings.lineNumbers === "relative") label.textContent = String(number === cursorLine ? number : Math.abs(number - cursorLine));
      numbers.push(label);
      lines.push(content);
    });
    this.numbers.replaceChildren(...numbers);
    this.lines.replaceChildren(...lines);
  }

  // 한 줄을 구문 색 클래스가 붙은 조각으로 나눈다(클래스 없는 조각은 기본 글자색 조각)
  private coloredParts(lineFrom: number, text: string): { from: number; text: string; cls: string }[] {
    const state = this.view.state;
    const to = lineFrom + text.length;
    const tree = ensureSyntaxTree(state, to, 10) ?? syntaxTree(state);
    const parts: { from: number; text: string; cls: string }[] = [];
    let position = lineFrom;
    highlightTree(
      tree,
      syntaxHighlighters,
      (start, end, cls) => {
        if (start > position) parts.push({ from: position, text: text.slice(position - lineFrom, start - lineFrom), cls: "cm-sticky-plain" });
        parts.push({ from: start, text: text.slice(start - lineFrom, end - lineFrom), cls });
        position = end;
      },
      lineFrom,
      to,
    );
    if (position < to) parts.push({ from: position, text: text.slice(position - lineFrom), cls: "cm-sticky-plain" });
    return parts.length ? parts : [{ from: lineFrom, text, cls: "cm-sticky-plain" }];
  }

  // 위치와 크기: 에디터 위쪽(스크롤러 위)에서 세로 스크롤바 앞까지. 글자는 에디터 글자와 같은 자리에서 시작하고 옆으로 스크롤하면 같이 움직인다.
  private place(state: StickyState, tops: number[], height: number) {
    const view = this.view;
    const root = this.root;
    this.height = height;
    if (state.startLines.length === 0 || height <= 0) {
      root.style.display = "none";
      this.height = 0;
      return;
    }
    root.style.display = "block";
    root.style.top = `${this.scroller.offsetTop}px`;
    root.style.height = `${height}px`;
    const viewRect = view.dom.getBoundingClientRect();
    const gutters = view.dom.querySelector<HTMLElement>(".cm-gutters");
    const gutterWidth = gutters?.offsetWidth ?? 0;
    this.numbers.style.width = `${gutterWidth}px`;
    this.numbers.style.height = `${height}px`;
    this.scroll.style.left = `${gutterWidth}px`;
    this.scroll.style.height = `${height}px`;
    this.syncFont();
    const origin = view.contentDOM.getBoundingClientRect().left - viewRect.left + this.linePaddingLeft() - gutterWidth;
    const shift = Math.min(origin, 0);
    const wrapperWidth = this.scroll.clientWidth;
    this.lines.style.left = `${shift}px`;
    this.lines.style.width = `${wrapperWidth - shift}px`;
    this.lines.style.setProperty("--sticky-indent", `${Math.max(origin, 0)}px`);
    const lineNumbers = view.dom.querySelector<HTMLElement>(".cm-lineNumbers");
    const numberLeft = lineNumbers ? lineNumbers.getBoundingClientRect().left - viewRect.left : 0;
    const numberWidth = lineNumbers?.offsetWidth ?? 0;
    const numberStyle = lineNumbers ? getComputedStyle(lineNumbers.querySelector(".cm-gutterElement") ?? lineNumbers) : null;
    const lastIndex = tops.length - 1;
    Array.from(this.lines.children).forEach((child, index) => {
      const line = child as HTMLElement;
      line.style.top = `${tops[index]!}px`;
      line.style.zIndex = index === lastIndex ? "0" : "1";
    });
    Array.from(this.numbers.children).forEach((child, index) => {
      const label = child as HTMLElement;
      label.style.top = `${tops[index]!}px`;
      label.style.zIndex = index === lastIndex ? "0" : "1";
      label.style.left = `${numberLeft}px`;
      label.style.width = `${numberWidth}px`;
      if (numberStyle) {
        label.style.paddingLeft = numberStyle.paddingLeft;
        label.style.paddingRight = numberStyle.paddingRight;
      }
    });
  }

  // 에디터 글꼴을 그대로 쓴다(설정으로 바뀌는 글꼴, 글자 간격, 합자, 탭 너비)
  private syncFont() {
    const style = getComputedStyle(this.view.contentDOM);
    const root = this.root;
    root.style.fontFamily = style.fontFamily;
    root.style.fontSize = style.fontSize;
    root.style.letterSpacing = style.letterSpacing;
    root.style.fontVariantLigatures = style.fontVariantLigatures;
    root.style.fontFeatureSettings = style.fontFeatureSettings;
    root.style.tabSize = String(this.view.state.tabSize);
  }

  private linePaddingLeft(): number {
    const line = this.view.contentDOM.querySelector(".cm-line");
    return line ? parseFloat(getComputedStyle(line).paddingLeft) || 0 : 0;
  }

  private readonly onScroll = () => this.schedule();

  // 위쪽에서 굴린 휠도 에디터를 스크롤한다
  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? this.view.defaultLineHeight : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.scroller.clientHeight : 1;
    this.scroller.scrollBy({ top: event.deltaY * unit, left: event.deltaX * unit });
  };

  // 줄을 누르면 그 줄(글자를 눌렀으면 그 칸)로 커서를 옮기고 화면에 들인다. Shift 를 누르면 블록의 끝 줄을 보여 준다. ⌃, ⌥, ⌘ 클릭은 정의 이동 자리라 건드리지 않는다.
  private readonly onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-sticky-line]") : null;
    if (!target) return;
    const index = Number(target.dataset.stickyLine);
    const view = this.view;
    const doc = view.state.doc;
    if (event.shiftKey) {
      const end = this.shown.endLines[index];
      if (end === undefined) return;
      this.revealCenteredIfOutside(Math.min(end, doc.lines));
      return;
    }
    const lineNumber = this.shown.startLines[index];
    if (lineNumber === undefined) return;
    const line = doc.line(lineNumber);
    const position = target.classList.contains("cm-sticky-line") ? (this.positionAt(event, line.from, line.to) ?? line.from) : line.from;
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "nearest" }), userEvent: "select.pointer" });
    view.focus();
  };

  // 눌린 자리의 문서 위치. 글자 조각의 data-from 에 조각 안 오프셋을 더한다.
  private positionAt(event: MouseEvent, lineFrom: number, lineTo: number): number | null {
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY) ?? (() => {
      const range = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
      return range ? { offsetNode: range.startContainer, offset: range.startOffset } : null;
    })();
    if (!caret) return null;
    const owner = caret.offsetNode instanceof Element ? caret.offsetNode : caret.offsetNode.parentElement;
    const from = owner?.closest<HTMLElement>("[data-from]")?.dataset.from;
    if (from === undefined) return null;
    return Math.min(Math.max(Number(from) + caret.offset, lineFrom), lineTo);
  }

  private revealCenteredIfOutside(lineNumber: number) {
    const view = this.view;
    const position = view.state.doc.line(lineNumber).from;
    const block = view.lineBlockAt(position);
    const top = view.documentPadding.top + block.top;
    const scrollTop = this.scroller.scrollTop;
    if (top >= scrollTop + this.height && top + block.height <= scrollTop + this.scroller.clientHeight) return;
    view.dispatch({ effects: EditorView.scrollIntoView(position, { y: "center" }) });
  }
}

const stickyPlugin = ViewPlugin.fromClass(StickyPlugin);

registerEditorCommands([{ id: "toggleStickyScroll", title: "View: Toggle Editor Sticky Scroll", run: () => saveEditorOption("stickyScroll", !currentEditorOptions().stickyScroll) }]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function preventDefault(event: Event) {
  event.preventDefault();
}

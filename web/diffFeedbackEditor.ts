import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, lineNumberMarkers, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { DiffFeedback } from "../shared/protocol";
import { chunksToLineChanges, groupForPills, hunksForRange, type LineChange } from "../shared/diffFeedback";
import { currentDefaults } from "./defaults";
import { addDiffFeedback, hideSubmitted, relativeToAgent, removeDiffFeedback, sendDiffFeedback, subscribeDiffFeedback, updateDiffFeedback, visibleFeedback } from "./diffFeedbackState";
import { flash, getState } from "./store";
import { S } from "./strings";


// 이 확장이 붙는 편집기가 어느 세션의 어느 파일(절대 경로)인지. diff 편집기면 hunk 를 구할 변경 덩어리를 돌려주는 함수를 준다.
export type FeedbackTarget = {
  agentId: string;
  path: string;
  diff?: (view: EditorView) => { original: string; changes: LineChange[] } | null;
  // false 면 줄 번호에 마우스를 올려도 `+` 를 띄우지 않는다(일반 파일 에디터, 사용자가 성가시다고 해서 끔). 글자를 골라 여는 상자는 그대로다.
  lineGlyph?: boolean;
};

// unifiedMergeView 한 줄 보기에서 변경 덩어리와 기준 본문을 읽는다.
export function inlineDiffSource(view: EditorView) {
  const info = getChunks(view.state);
  if (!info) return null;
  const original = getOriginalDoc(view.state);
  return { original: original.toString(), changes: chunksToLineChanges(info.chunks, original, view.state.doc) };
}

export function diffFeedbackExtension(target: FeedbackTarget): Extension {
  return [
    marksField,
    pillsField,
    lineNumberMarkers.from(marksField, (v) => v.marks),
    EditorView.decorations.from(marksField, (v) => v.deco),
    lineNumbers({
      domEventHandlers: {
        mousedown(view, line, event) {
          const plugin = view.plugin(pluginFor(target));
          const lineNumber = view.state.doc.lineAt(line.from).number;
          if (!plugin || view.state.field(marksField).hover !== lineNumber) return false;
          event.preventDefault();
          plugin.selectLine(lineNumber);
          return true;
        },
      },
    }),
    pluginFor(target),
  ];
}

// 같은 편집기에 확장이 한 번만 붙으므로 대상마다 플러그인 정의를 캐시한다(gutter 핸들러가 view.plugin 으로 찾는다).
const plugins = new WeakMap<FeedbackTarget, ViewPlugin<FeedbackPlugin>>();
function pluginFor(target: FeedbackTarget) {
  let plugin = plugins.get(target);
  if (!plugin) {
    plugin = ViewPlugin.define((view) => new FeedbackPlugin(view, target));
    plugins.set(target, plugin);
  }
  return plugin;
}

// --- 줄 표시: 줄 번호 열의 `+` 와 쌓인 줄의 표시, 호버 강조 ---

const setHover = StateEffect.define<number | null>();
const setMarks = StateEffect.define<{ lines: number[]; highlight: [number, number] | null }>();

type MarksValue = { hover: number | null; lines: number[]; highlight: [number, number] | null; marks: RangeSet<GutterMarker>; deco: DecorationSet };

class NumberMark extends GutterMarker {
  constructor(cls: string) {
    super();
    this.elementClass = cls;
  }
  eq(other: GutterMarker) {
    return other instanceof NumberMark && other.elementClass === this.elementClass;
  }
}

function buildMarks(state: EditorState, value: Omit<MarksValue, "marks" | "deco">): MarksValue {
  const doc = state.doc;
  const clamp = (n: number) => Math.min(Math.max(n, 1), doc.lines);
  const kinds = new Map<number, { numbered: boolean; glyph: boolean; highlight: boolean }>();
  const touch = (n: number) => {
    const line = clamp(n);
    let kind = kinds.get(line);
    if (!kind) kinds.set(line, (kind = { numbered: false, glyph: false, highlight: false }));
    return kind;
  };
  for (const n of value.lines) touch(n).numbered = true;
  if (value.hover !== null) touch(value.hover).glyph = true;
  if (value.highlight) for (let n = value.highlight[0]; n <= value.highlight[1]; n++) touch(n).highlight = true;
  const marks = new RangeSetBuilder<GutterMarker>();
  const deco = new RangeSetBuilder<Decoration>();
  for (const [lineNumber, kind] of [...kinds].sort((a, b) => a[0] - b[0])) {
    const line = doc.line(lineNumber);
    const numberClass = [kind.numbered && "cm-feedback-numbered", kind.glyph && "cm-feedback-glyph"].filter(Boolean).join(" ");
    if (numberClass) marks.add(line.from, line.from, new NumberMark(numberClass));
    const lineClass = [kind.numbered && "cm-feedback-line", kind.highlight && "cm-feedback-highlight"].filter(Boolean).join(" ");
    if (lineClass) deco.add(line.from, line.from, Decoration.line({ class: lineClass }));
  }
  return { ...value, marks: marks.finish(), deco: deco.finish() };
}

const marksField = StateField.define<MarksValue>({
  create: (state) => buildMarks(state, { hover: null, lines: [], highlight: null }),
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setHover)) next = { ...next, hover: effect.value };
      if (effect.is(setMarks)) next = { ...next, lines: effect.value.lines, highlight: effect.value.highlight };
    }
    return next !== value || tr.docChanged ? buildMarks(tr.state, next) : value;
  },
});


type PillContext = { build: (group: DiffFeedback[], open: boolean) => HTMLElement };
type PillGroups = { groups: DiffFeedback[][]; expanded: string | null; ctx: PillContext };
const setPills = StateEffect.define<PillGroups>();

class PillWidget extends WidgetType {
  constructor(
    private group: DiffFeedback[],
    private open: boolean,
    private ctx: PillContext,
  ) {
    super();
  }
  eq(other: PillWidget) {
    return other.open === this.open && other.group.length === this.group.length && other.group.every((f, i) => f.id === this.group[i].id && f.text === this.group[i].text && f.state === this.group[i].state);
  }
  toDOM() {
    return this.ctx.build(this.group, this.open);
  }
  // 위젯 안의 클릭과 글자 입력은 CodeMirror 가 아니라 위젯의 DOM 이 받는다
  ignoreEvent() {
    return true;
  }
}

const pillsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setPills)) continue;
      const { groups, expanded, ctx } = effect.value;
      const doc = tr.state.doc;
      next = Decoration.set(
        groups.map((group) => {
          const end = Math.min(Math.max(...group.map((f) => f.endLine)), doc.lines);
          return Decoration.widget({ widget: new PillWidget(group, expanded === group[0].id, ctx), block: true, side: 1 }).range(doc.line(end).to);
        }),
        true,
      );
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// --- 플러그인: 입력 상자, 쌓인 것의 위젯 ---

type Pinned = { from: number; to: number; forward: boolean };

class FeedbackPlugin {
  private layer = document.createElement("div");
  private box: HTMLElement | null = null;
  private textarea!: HTMLTextAreaElement;
  private measure!: HTMLElement;
  private primary!: HTMLButtonElement;
  private menu: HTMLElement | null = null;
  private pinned: Pinned | null = null;
  private mouseDown = false;
  private settingSelection = false;
  private expanded: string | null = null;
  private busy = false;
  private unsubscribe: () => void;
  private disposers: (() => void)[] = [];
  private destroyed = false;

  constructor(
    private view: EditorView,
    private target: FeedbackTarget,
  ) {
    this.layer.className = "df-layer";
    view.dom.appendChild(this.layer);
    this.unsubscribe = subscribeDiffFeedback(() => this.refresh());
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K | string, handler: (e: never) => void, capture = false) => {
      el.addEventListener(type, handler as EventListener, capture);
      this.disposers.push(() => el.removeEventListener(type, handler as EventListener, capture));
    };
    on(view.dom, "mousedown", (e: MouseEvent) => {
      if (this.inLayer(e.target)) return;
      this.mouseDown = true;
    }, true);
    on(window, "mouseup", () => {
      if (!this.mouseDown) return;
      this.mouseDown = false;
      setTimeout(() => !this.destroyed && this.onSelection(true), 0);
    }, true);
    on(view.dom, "mousemove", (e: MouseEvent) => this.onMove(e));
    on(view.dom, "mouseleave", () => this.hover(null));
    on(view.scrollDOM, "scroll", () => this.layout());
    on(window, "keydown", (e: KeyboardEvent) => this.onEditorKey(e), true);
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.measureAvail();
      this.refresh();
    });
  }

  update(update: ViewUpdate) {
    if (update.geometryChanged || update.viewportChanged) this.measureAvail();
    // 갱신 도중에는 dispatch 할 수 없어서(이 확장이 상태에 선택을 넣는다) 다음 틱에 처리한다. 상태 선택만 본다: Esc 로 상태 선택이 접힌 뒤에도 남은 브라우저 선택으로 상자가 다시 뜨면 안 된다.
    if (update.selectionSet && !this.settingSelection) queueMicrotask(() => !this.destroyed && this.onSelection(false));
    if (update.docChanged || update.viewportChanged || update.geometryChanged) this.layout();
  }

  // 위젯이 쓸 수 있는 폭: 보이는 편집기 폭에서 거터와 좌우 여백을 뺀 값
  private measureAvail() {
    const gutters = this.view.dom.querySelector<HTMLElement>(".cm-gutters")?.offsetWidth ?? 0;
    const avail = this.view.scrollDOM.clientWidth - gutters - 2 * cssLength("--space-2");
    if (avail > 0) this.view.dom.style.setProperty("--df-avail", `${avail}px`);
  }

  destroy() {
    this.destroyed = true;
    this.unsubscribe();
    for (const dispose of this.disposers) dispose();
    this.layer.remove();
  }

  private inLayer(node: EventTarget | null) {
    return node instanceof Node && this.layer.contains(node);
  }

  private items() {
    return visibleFeedback(this.target.agentId, this.target.path);
  }

  // --- 줄 번호 `+` ---

  private lineEligible(lineNumber: number) {
    const doc = this.view.state.doc;
    if (lineNumber < 1 || lineNumber > doc.lines || doc.line(lineNumber).text.trim() === "") return false;
    return !this.items().some((f) => f.state === "accepted" && lineNumber >= f.startLine && lineNumber <= f.endLine);
  }

  private onMove(event: MouseEvent) {
    if (!this.target.agentId) return;
    if (this.mouseDown || this.inLayer(event.target) || this.box?.style.display === "flex") {
      if (this.box?.style.display === "flex") this.hover(null);
      return;
    }
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    const lineNumber = this.view.state.doc.lineAt(pos).number;
    this.hover(this.target.lineGlyph !== false && this.lineEligible(lineNumber) ? lineNumber : null);
  }

  // 확장이 갱신 도중(선택 변경 처리 중)에도 부르므로 다음 틱에 반영한다. 갱신 중에는 dispatch 할 수 없다.
  private hover(lineNumber: number | null) {
    if (this.view.state.field(marksField).hover === lineNumber) return;
    queueMicrotask(() => {
      if (!this.destroyed && this.view.state.field(marksField).hover !== lineNumber) this.view.dispatch({ effects: setHover.of(lineNumber) });
    });
  }

  // 줄 번호의 `+` 를 눌렀을 때: 그 줄 전체를 고르고 상자를 연다
  selectLine(lineNumber: number) {
    if (!this.target.agentId) return;
    if (this.box?.style.display === "flex" && this.textarea.value.trim()) {
      this.textarea.focus();
      return;
    }
    if (!this.lineEligible(lineNumber)) return;
    const line = this.view.state.doc.line(lineNumber);
    this.settingSelection = true;
    this.view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: setHover.of(null) });
    this.settingSelection = false;
    this.show({ from: line.from, to: line.to, forward: true }, line.from, true);
    this.glyphPinned = true;
  }

  // --- 선택하면 뜨는 상자 ---

  private hasText() {
    return !!this.box && this.textarea.value.trim().length > 0;
  }

  private visible() {
    return !!this.box && this.box.style.display === "flex";
  }

  private onSelection(fromMouse: boolean) {
    if (this.mouseDown || !this.target.agentId) return;
    if (this.visible() && this.hasText()) return;
    const selection = this.currentSelection(fromMouse);
    // 글자를 고르는 것만으로는 상자를 열지 않는다(복사하려고 고른 것뿐일 때 거슬린다). 줄 번호 `+` 로 연 상자만 그 선택이 남아 있는 동안 유지한다.
    if (selection && this.visible() && this.glyphPinned && this.pinned && this.pinned.from === selection.from && this.pinned.to === selection.to) return;
    this.autoHide();
  }

  // 고른 글자 범위. diff 편집기는 읽기 전용이라 포커스를 받지 않아 CodeMirror 가 선택을 상태로 옮기지 않으므로, 상태가 비어 있으면 브라우저의 선택에서 읽는다.
  private currentSelection(fromMouse: boolean) {
    const main = this.view.state.selection.main;
    // 포커스가 있는 편집기는 상태 선택이 맞다. 읽기 전용 diff 는 포커스를 못 받아 상태 선택이 옛 값일 수 있어, 마우스를 놓은 때는 브라우저 선택을 따른다.
    if (!main.empty && !(fromMouse && !this.view.hasFocus)) return { from: main.from, to: main.to, forward: main.head >= main.anchor };
    if (!fromMouse) return null;
    const dom = window.getSelection();
    const content = this.view.contentDOM;
    if (!dom || dom.isCollapsed || !dom.anchorNode || !dom.focusNode || !content.contains(dom.anchorNode) || !content.contains(dom.focusNode)) {
      // 줄 번호 `+` 로 연 상자는 브라우저 선택 없이 상태 선택만 있다. 그 클릭의 mouseup 이 상자를 닫으면 안 된다.
      return this.glyphPinned && this.visible() && !main.empty ? { from: main.from, to: main.to, forward: true } : null;
    }
    const anchor = this.view.posAtDOM(dom.anchorNode, dom.anchorOffset);
    const head = this.view.posAtDOM(dom.focusNode, dom.focusOffset);
    return anchor === head ? null : { from: Math.min(anchor, head), to: Math.max(anchor, head), forward: head >= anchor };
  }

  private glyphPinned = false;

  private autoHide() {
    if (!this.hasText()) this.hide();
  }

  private anchorPos = 0;

  private show(pinned: Pinned, anchorPos: number, focus: boolean) {
    this.glyphPinned = false;
    this.ensureBox();
    this.pinned = pinned;
    this.anchorPos = anchorPos;
    this.textarea.value = "";
    this.textarea.placeholder = (getState().gitChanges[this.target.agentId]?.files.length ?? 0) > 0 ? S.fbPlaceholder : S.fbPlaceholderNoChanges;
    this.box!.style.display = "flex";
    this.hover(null);
    this.autoSize();
    this.updateActions();
    this.layout();
    if (focus) this.textarea.focus();
  }

  private hide() {
    this.glyphPinned = false;
    this.closeMenu();
    if (!this.box || this.box.style.display === "none") return;
    this.box.style.display = "none";
    this.pinned = null;
    this.textarea.value = "";
  }

  private onEditorKey(event: KeyboardEvent) {
    // 찾기 위젯(web/findWidget.ts)은 view.dom 안에 있어서 거기서 친 글자가 입력 상자로 새지 않게 건너뛴다.
    if (!this.visible() || this.inLayer(event.target) || (event.target as Element | null)?.closest?.(".cm-find")) return;
    if (event.key === "Escape") {
      this.hide();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
    this.textarea.focus();
  }

  private ensureBox() {
    if (this.box) return;
    const box = document.createElement("div");
    box.className = "df-input";
    box.style.display = "none";
    this.textarea = document.createElement("textarea");
    this.textarea.rows = 1;
    this.textarea.className = "df-input-text";
    this.measure = document.createElement("span");
    this.measure.className = "df-input-measure";
    const actions = document.createElement("div");
    actions.className = "df-input-actions";
    this.primary = this.actionButton("add", S.fbAdd, () => void this.add(this.altDown));
    const more = this.actionButton("chevron-down", S.fbMoreActions, () => this.toggleMenu(more));
    more.className += " df-input-more";
    actions.append(this.primary, more);
    box.append(this.textarea, this.measure, actions);
    // 상자 안을 누르면 편집기가 선택을 풀지 않게 하고, 글자 칸이 아닌 곳을 눌러도 글자 칸에 포커스가 간다
    box.addEventListener("mousedown", (e) => {
      const target = e.target as Node;
      if (target !== this.textarea && !actions.contains(target)) {
        e.preventDefault();
        this.textarea.focus();
      }
    });
    this.textarea.addEventListener("input", () => {
      this.autoSize();
      this.updateActions();
      this.layout();
    });
    this.textarea.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.hide();
        this.view.focus();
        return;
      }
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      void this.add(e.altKey);
    });
    this.textarea.addEventListener("blur", () => {
      setTimeout(() => {
        if (!this.visible() || this.menu) return;
        const active = document.activeElement;
        if (active && (this.view.dom.contains(active) || this.layer.contains(active))) return;
        this.autoHide();
      }, 0);
    });
    const alt = (e: KeyboardEvent) => this.setAlt(e.altKey);
    window.addEventListener("keydown", alt);
    window.addEventListener("keyup", alt);
    this.disposers.push(() => {
      window.removeEventListener("keydown", alt);
      window.removeEventListener("keyup", alt);
    });
    this.layer.appendChild(box);
    this.box = box;
  }

  private altDown = false;

  private setAlt(down: boolean) {
    if (this.altDown === down) return;
    this.altDown = down;
    this.updateActions();
  }

  private actionButton(icon: string, label: string, run: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "df-input-action";
    button.dataset.icon = icon;
    button.setAttribute("aria-label", label);
    const glyph = document.createElement("span");
    glyph.className = `codicon codicon-${icon}`;
    button.appendChild(glyph);
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", run);
    return button;
  }

  private updateActions() {
    if (!this.box) return;
    const enabled = this.textarea.value.trim().length > 0 && !this.busy;
    const label = this.altDown ? `${S.fbAddAndSubmit} (⌥Enter)` : `${S.fbAdd} (Enter)`;
    this.primary.disabled = !enabled;
    this.primary.title = label;
    this.primary.setAttribute("aria-label", this.altDown ? S.fbAddAndSubmit : S.fbAdd);
    this.primary.dataset.icon = this.altDown ? "send" : "add";
    const glyph = this.primary.firstElementChild as HTMLElement;
    glyph.className = `codicon codicon-${this.altDown ? "send" : "add"}`;
    const more = this.box.querySelector<HTMLButtonElement>(".df-input-more");
    if (more) more.disabled = !enabled;
  }

  // 글 길이만큼 넓어지고(최소 150, 최대 400 또는 편집기 폭의 90%), 줄바꿈 되면 높아진다. 높이 아래 한계는 한 줄(22)이다.
  private autoSize() {
    const text = this.textarea;
    this.measure.textContent = text.value || text.placeholder;
    const content = this.view.contentDOM.clientWidth;
    // 상자는 글자 칸 말고 안쪽 여백, 테두리, 단추 열이 더 있어서, 보이는 편집기 폭에서 그만큼을 빼야 좁은 패널에서 오른쪽이 잘리지 않는다.
    const chrome = this.box && this.box.offsetWidth > 0 ? this.box.offsetWidth - text.offsetWidth : 0;
    const gutters = this.view.dom.querySelector<HTMLElement>(".cm-gutters")?.offsetWidth ?? 0;
    const visible = this.view.dom.clientWidth - gutters - chrome;
    const max = Math.max(cssLength("--size-row"), Math.min(cssLength("--size-feedback-input-max"), content * 0.9, visible));
    const min = Math.min(cssLength("--size-feedback-input-min"), max);
    const width = Math.min(Math.max(min, this.measure.scrollWidth + 10), max);
    text.style.width = `${width}px`;
    text.style.minWidth = `${min}px`;
    text.style.height = "auto";
    text.style.height = `${text.scrollHeight}px`;
  }

  private toggleMenu(anchor: HTMLElement) {
    if (this.menu) {
      this.closeMenu();
      return;
    }
    const menu = document.createElement("div");
    menu.className = "df-menu";
    for (const [label, hint, submit] of [[S.fbAdd, "Enter", false] as const, [S.fbAddAndSubmit, "⌥Enter", true] as const]) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "df-menu-item";
      const name = document.createElement("span");
      name.textContent = label;
      const key = document.createElement("span");
      key.className = "df-menu-hint";
      key.textContent = hint;
      item.append(name, key);
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => {
        this.closeMenu();
        void this.add(submit);
      });
      menu.appendChild(item);
    }
    this.layer.appendChild(menu);
    const layer = this.layer.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(0, rect.left - layer.left - menu.offsetWidth + rect.width)}px`;
    menu.style.top = `${rect.bottom - layer.top + 2}px`;
    this.menu = menu;
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  // 만들 피드백: 선택한 글자, 줄 범위, diff 에서 고른 경우 그 변경 덩어리
  private build(pinned: Pinned, text: string) {
    const doc = this.view.state.doc;
    const start = doc.lineAt(pinned.from);
    const end = doc.lineAt(pinned.to);
    // 줄 전체를 끌어 고르면 끝이 다음 줄 맨 앞에 놓인다. 그 줄은 고르지 않은 것이라 한 줄 앞으로 당긴다.
    const trimEnd = pinned.to > pinned.from && pinned.to === end.from && end.number > start.number;
    const endLine = trimEnd ? end.number - 1 : end.number;
    const endTo = trimEnd ? doc.line(endLine).to : pinned.to;
    const range = { startLine: start.number, startColumn: pinned.from - start.from + 1, endLine, endColumn: endTo - doc.line(endLine).from + 1 };
    const codeSelection = doc.sliceString(pinned.from, endTo);
    const diff = this.target.diff?.(this.view);
    const diffHunks = diff ? hunksForRange(range, diff.changes, diff.original, doc.toString()) : undefined;
    const agent = getState().agents.find((a) => a.id === this.target.agentId);
    return { path: this.target.path, rel: relativeToAgent(agent, this.target.path), ...range, text, ...(codeSelection ? { codeSelection } : {}), ...(diffHunks ? { diffHunks } : {}) };
  }

  private async add(submit: boolean) {
    const text = this.textarea.value.trim();
    const pinned = this.pinned;
    if (!text || !pinned || this.busy) return;
    const item = this.build(pinned, text);
    this.busy = true;
    this.updateActions();
    const created = await addDiffFeedback(this.target.agentId, item);
    this.busy = false;
    this.updateActions();
    if (!created) return;
    this.hide();
    this.view.focus();
    // Add and Submit: 이 피드백과 먼저 쌓아 둔 것을 한 메시지로 보낸다. 응답 중이면 서버가 큐에 넣는다.
    if (submit) void sendDiffFeedback(this.target.agentId, "", currentDefaults().requestQueuing === "steer").catch((e: Error) => flash(e.message));
  }

  // --- 쌓인 피드백 표시 ---

  private refresh() {
    if (this.destroyed) return;
    const items = this.items();
    const lines = items.flatMap((f) => Array.from({ length: f.endLine - f.startLine + 1 }, (_, i) => f.startLine + i));
    this.view.dispatch({ effects: setMarks.of({ lines, highlight: this.view.state.field(marksField).highlight }) });
    this.renderPills(items);
    this.layout();
  }

  private renderPills(items: DiffFeedback[]) {
    const groups = groupForPills(items);
    if (this.expanded && !groups.some((g) => g[0].id === this.expanded)) this.expanded = null;
    this.view.dispatch({ effects: setPills.of({ groups, expanded: this.expanded, ctx: { build: (group, open) => this.buildPill(group, open) } }) });
  }

  private highlight(item: DiffFeedback | null) {
    this.view.dispatch({ effects: setMarks.of({ lines: this.view.state.field(marksField).lines, highlight: item ? [item.startLine, item.endLine] : null }) });
  }

  private buildPill(group: DiffFeedback[], open: boolean) {
    const key = group[0].id;
    const pill = document.createElement("div");
    pill.className = "df-pill";
    if (open) pill.dataset.open = "";
    pill.dataset.key = key;
    const head = document.createElement("div");
    head.className = "df-pill-head";
    const icon = document.createElement("span");
    icon.className = "codicon codicon-comment";
    const title = document.createElement("span");
    title.className = "df-pill-title";
    title.textContent = group.length === 1 ? group[0].text : S.fbCommentCount(group.length);
    const toggle = document.createElement("span");
    toggle.className = `df-pill-toggle codicon codicon-chevron-${open ? "up" : "down"}`;
    toggle.title = open ? S.fbCollapse : S.fbExpand;
    head.append(icon, title, toggle);
    head.addEventListener("click", () => {
      this.expanded = this.expanded === key ? null : key;
      this.refresh();
    });
    pill.appendChild(head);
    if (open) {
      const body = document.createElement("div");
      body.className = "df-pill-body";
      for (const item of group) body.appendChild(this.buildItem(item));
      pill.appendChild(body);
    }
    return pill;
  }

  private buildItem(item: DiffFeedback) {
    const row = document.createElement("div");
    row.className = "df-item";
    const head = document.createElement("div");
    head.className = "df-item-head";
    const meta = document.createElement("span");
    meta.className = "df-item-line";
    meta.textContent = item.startLine === item.endLine ? S.fbLine(item.startLine) : S.fbLines(item.startLine, item.endLine);
    const actions = document.createElement("span");
    actions.className = "df-item-actions";
    const text = document.createElement("div");
    text.className = "df-item-text";
    text.textContent = item.text;
    const button = (icon: string, label: string, run: () => void) => {
      const b = this.actionButton(icon, label, run);
      b.title = label;
      return b;
    };
    if (item.state === "accepted") {
      actions.append(
        button("edit", S.fbEdit, () => this.edit(item, text)),
        button("close", S.fbRemove, () => removeDiffFeedback(this.target.agentId, item.id)),
      );
    } else actions.append(button("close", S.fbHide, () => hideSubmitted(this.target.agentId, item.id)));
    head.append(meta, actions);
    row.append(head, text);
    if (item.state === "submitted") {
      const sent = document.createElement("span");
      sent.className = "df-item-sent";
      sent.textContent = S.fbSent;
      head.insertBefore(sent, actions);
    }
    row.addEventListener("mouseenter", () => this.highlight(item));
    row.addEventListener("mouseleave", () => this.highlight(null));
    return row;
  }

  // 글을 그 자리에서 고친다. Enter 로 저장하고 Esc 로 그만둔다.
  private edit(item: DiffFeedback, text: HTMLElement) {
    const area = document.createElement("textarea");
    area.className = "df-edit";
    area.value = item.text;
    area.rows = 1;
    area.placeholder = S.fbEditPlaceholder;
    const fit = () => {
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
    };
    text.replaceChildren(area);
    fit();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    area.addEventListener("input", () => {
      fit();
      this.layout();
    });
    area.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        text.textContent = item.text;
      } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const next = area.value.trim();
        if (next && next !== item.text) updateDiffFeedback(this.target.agentId, item.id, next);
        else text.textContent = item.text;
      }
    });
  }

  // 입력 상자와 위젯의 자리. 편집기 위에 겹쳐 있어 스크롤과 크기 변화 때마다 다시 잰다.
  private layout() {
    this.view.requestMeasure({ key: this, read: (view) => this.readLayout(view), write: (m) => this.writeLayout(m) });
  }

  private readLayout(view: EditorView) {
    const rect = view.dom.getBoundingClientRect();
    const gutters = view.dom.querySelector<HTMLElement>(".cm-gutters")?.offsetWidth ?? 0;
    let input: { top: number; left: number; hidden: boolean } | null = null;
    if (this.box && this.pinned && this.visible()) {
      const coords = view.coordsAtPos(Math.min(this.anchorPos, view.state.doc.length));
      const height = this.box.offsetHeight || cssLength("--size-row");
      const width = this.box.offsetWidth || cssLength("--size-feedback-input-min");
      if (!coords) input = { top: 0, left: 0, hidden: true };
      else {
        const lineHeight = coords.bottom - coords.top;
        const top = coords.top - rect.top;
        let y = this.pinned.forward ? top + lineHeight : top - height;
        if (this.pinned.forward) {
          if (y + height > rect.height) y = top - height;
        } else if (y < 0) y = top + lineHeight;
        y = Math.max(0, Math.min(y, rect.height - height));
        const left = Math.max(gutters, Math.min(coords.left - rect.left, rect.width - width));
        input = { top: y, left, hidden: coords.bottom < rect.top || coords.top > rect.bottom };
      }
    }
    return { input };
  }

  private writeLayout(m: ReturnType<FeedbackPlugin["readLayout"]>) {
    if (this.box && m.input) {
      this.box.style.top = `${m.input.top}px`;
      this.box.style.left = `${m.input.left}px`;
      this.box.style.visibility = m.input.hidden ? "hidden" : "visible";
    }
  }
}

function cssLength(name: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return Number.parseFloat(value) || 0;
}

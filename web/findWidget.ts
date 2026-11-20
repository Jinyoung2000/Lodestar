import { EditorSelection, EditorState, Annotation, Prec, StateEffect, StateField, type ChangeSet, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, runScopeHandlers, type DecorationSet, type KeyBinding, type ViewUpdate } from "@codemirror/view";
import type { SearchQuery } from "@codemirror/search";
import "./find.css";
import {
  buildQuery,
  collectMatches,
  containingIndex,
  countLabel,
  firstMatchFrom,
  nextIndex,
  previousIndex,
  regexError,
  replacementFor,
  seedText,
  type FindOptions,
  type Matches,
  type Scope,
} from "./findModel";

export function findWidget(): Extension {
  return [findField, findPlugin, findKeymap, readOnlyFocusable];
}

// 읽기 전용 보기(diff)의 본문은 contenteditable 이 아니라 포커스를 못 받아서 ⌘F 가 편집기까지 오지 않는다. 포커스를 받게 해 둔다.
const readOnlyFocusable = EditorView.contentAttributes.of((view) => (view.state.facet(EditorView.editable) ? null : { tabindex: "0" }));

// 개요 눈금자(web/editorRuler.ts)가 일치 위치를 칠하려고 읽는 찾기 상태. 위젯이 열려 있고 검색어가 있을 때만 값이 있다.
export function findStateOf(state: EditorState): { search: string; options: FindOptions; scope: Scope } | null {
  const value = state.field(findField, false);
  return value?.open && value.search ? { search: value.search, options: value.options, scope: value.scope } : null;
}

type FindState = { open: boolean; replaceOpen: boolean; search: string; replace: string; options: FindOptions; scope: Scope };

const shared = { search: "", replace: "", options: { caseSensitive: false, wholeWord: false, regexp: false, preserveCase: false } as FindOptions };

const setFind = StateEffect.define<Partial<FindState>>();
// 입력 중에 자동으로 고른 일치. 입력을 시작한 자리(anchor)를 옮기지 않으려고 표시한다.
const incremental = Annotation.define<boolean>();

const findField = StateField.define<FindState>({
  create: () => ({ open: false, replaceOpen: false, search: shared.search, replace: shared.replace, options: shared.options, scope: null }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.scope) next = { ...next, scope: mapScope(value.scope, tr.changes) };
    for (const effect of tr.effects) if (effect.is(setFind)) next = { ...next, ...effect.value };
    return next;
  },
});

function mapScope(scope: NonNullable<Scope>, changes: ChangeSet): Scope {
  const from = changes.mapPos(scope.from, 1);
  const to = changes.mapPos(scope.to, -1);
  return from < to ? { from, to } : null;
}

const TIPS = {
  caseSensitive: "Match Case (⌥⌘C)",
  wholeWord: "Match Whole Word (⌥⌘W)",
  regexp: "Use Regular Expression (⌥⌘R)",
  preserveCase: "Preserve Case (⌥⌘P)",
  previous: "Previous Match (⇧Enter)",
  next: "Next Match (Enter)",
  scope: "Find in Selection (⌥⌘L)",
  close: "Close (Escape)",
  toggleReplace: "Toggle Replace",
  replace: "Replace (Enter)",
  replaceAll: "Replace All (⌥⌘Enter)",
  find: "Find",
  replacePlaceholder: "Replace",
} as const;

// 큰 파일에서는 글자마다 전체를 다시 세지 않도록 늦춘다.
const LARGE_DOC = 100_000;
const RECOUNT_DELAY = 120;
const REDUCED_WIDTH = 411;
// 화면에 보이는 일치만 칠하지만 한 화면에 이만큼이 넘으면 더 칠하지 않는다.
const MAX_MARKS = 5000;

const isReadOnly = (view: EditorView) => view.state.readOnly || !view.state.facet(EditorView.editable);

function optionKey(options: FindOptions) {
  return `${options.caseSensitive ? 1 : 0}${options.wholeWord ? 1 : 0}${options.regexp ? 1 : 0}${options.preserveCase ? 1 : 0}`;
}

// --- 명령 ---

// ⌘F, ⌥⌘F. 한 줄 선택이나 커서 아래 낱말을 검색어로 쓰고 입력칸에 포커스를 준다(위젯 안에서 누르면 입력칸 글만 전체 선택).
export function openFind(view: EditorView, { replace = false, focus = true, seed = true } = {}): boolean {
  const plugin = view.plugin(findPlugin);
  const current = view.state.field(findField);
  const inside = plugin?.hasFocus() ?? false;
  const change: Partial<FindState> = { open: true };
  if (replace && !isReadOnly(view)) change.replaceOpen = true;
  if (seed && !inside) {
    const text = seedText(view.state);
    if (text !== null && text !== current.search) change.search = text;
  }
  view.dispatch({ effects: setFind.of(change) });
  if (focus) view.plugin(findPlugin)?.focusInput(replace && !isReadOnly(view) && view.state.field(findField).search !== "" ? "replace" : "find");
  return true;
}

function closeFind(view: EditorView): boolean {
  if (!view.state.field(findField).open) return false;
  const had = view.plugin(findPlugin)?.hasFocus() ?? false;
  view.dispatch({ effects: setFind.of({ open: false, scope: null }) });
  if (had) view.focus();
  return true;
}

// ⌘E (actions.findWithSelection). 선택(없으면 커서 아래 낱말)을 검색어로 정하고 위젯을 열되 포커스는 옮기지 않는다. ⌘F3, ⇧⌘F3 (Find Next, Previous Selection)은 같은 일에 이어서 그 일치로 이동한다.
function findWithSelection(view: EditorView, step?: "next" | "previous"): boolean {
  const text = seedText(view.state);
  if (text === null) return false;
  const current = view.state.field(findField);
  const change: Partial<FindState> = { open: true };
  if (text !== current.search) change.search = text;
  view.dispatch({ effects: setFind.of(change) });
  if (step) view.plugin(findPlugin)?.goTo(step === "previous");
  return true;
}

// ⌘G, F3 (위젯이 닫혀 있으면 포커스를 옮기지 않고 열어서 이동)
function step(view: EditorView, backward: boolean): boolean {
  if (!view.state.field(findField).open) openFind(view, { focus: false, seed: false });
  view.plugin(findPlugin)?.goTo(backward);
  return true;
}

const whenOpen = (run: (view: EditorView) => void) => (view: EditorView) => {
  if (!view.state.field(findField).open) return false;
  run(view);
  return true;
};

function toggleOption(view: EditorView, key: keyof FindOptions) {
  const { options } = view.state.field(findField);
  view.dispatch({ effects: setFind.of({ options: { ...options, [key]: !options[key] } }) });
  view.plugin(findPlugin)?.restartFromAnchor();
}

function toggleScope(view: EditorView) {
  const { scope } = view.state.field(findField);
  const range = view.state.selection.main;
  if (!scope && range.empty) return;
  view.dispatch({ effects: setFind.of({ scope: scope ? null : { from: range.from, to: range.to } }) });
  view.plugin(findPlugin)?.restartFromAnchor();
}

function replaceOne(view: EditorView) {
  const plugin = view.plugin(findPlugin);
  const state = view.state.field(findField);
  if (!plugin || isReadOnly(view)) return;
  const { list } = plugin.currentMatches();
  const range = view.state.selection.main;
  const index = list.findIndex((m) => m.from === range.from && m.to === range.to);
  if (index < 0) {
    plugin.goTo(false);
    return;
  }
  const found = list[index];
  const insert = replacementFor(view.state, found, state.replace, state.options);
  const changes = view.state.changes({ from: found.from, to: found.to, insert });
  const next = list.length > 1 ? list[(index + 1) % list.length] : null;
  const selection = next ? EditorSelection.range(changes.mapPos(next.from, 1), changes.mapPos(next.to, -1)) : EditorSelection.cursor(changes.mapPos(found.to, 1));
  view.dispatch({ changes, selection, scrollIntoView: true, userEvent: "input.replace" });
}

function replaceAll(view: EditorView) {
  const plugin = view.plugin(findPlugin);
  const state = view.state.field(findField);
  if (!plugin || isReadOnly(view)) return;
  const all = collectMatches(plugin.query(), view.state, state.scope, Infinity).list;
  if (!all.length) return;
  view.dispatch({ changes: all.map((m) => ({ from: m.from, to: m.to, insert: replacementFor(view.state, m, state.replace, state.options) })), userEvent: "input.replace.all" });
}

// ⌥Enter. 모든 일치를 선택하고 편집기로 돌아간다.
function selectAllMatches(view: EditorView) {
  const { list } = view.plugin(findPlugin)?.currentMatches() ?? { list: [] };
  if (!list.length) return;
  const range = view.state.selection.main;
  view.dispatch({ selection: EditorSelection.create(list.map((m) => EditorSelection.range(m.from, m.to)), Math.max(containingIndex(list, range.from, range.to), 0)), scrollIntoView: true, userEvent: "select.search.matches" });
  view.focus();
}

// --- 화면 ---

type Ui = {
  root: HTMLElement;
  expand: HTMLButtonElement;
  find: HTMLInputElement;
  findField: HTMLElement;
  message: HTMLElement;
  replace: HTMLInputElement;
  caseSensitive: HTMLButtonElement;
  wholeWord: HTMLButtonElement;
  regexp: HTMLButtonElement;
  preserveCase: HTMLButtonElement;
  count: HTMLElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  scope: HTMLButtonElement;
  replaceButton: HTMLButtonElement;
  replaceAllButton: HTMLButtonElement;
  close: HTMLButtonElement;
};

class FindPlugin {
  decorations: DecorationSet = Decoration.none;
  private ui: Ui | null = null;
  private ruler: HTMLCanvasElement | null = null;
  private observer: ResizeObserver | null = null;
  private matches: Matches | null = null;
  private timer = 0;
  private cachedQuery: { key: string; query: SearchQuery } | null = null;
  private rulerKey = "";
  // 입력으로 일치를 고를 때 훑기 시작하는 자리. 사용자가 직접 선택을 옮기면 따라간다.
  private anchor: number;

  constructor(readonly view: EditorView) {
    this.anchor = view.state.selection.main.from;
    if (view.state.field(findField).open) this.mount();
  }

  update(update: ViewUpdate) {
    const before = update.startState.field(findField);
    const state = update.state.field(findField);
    for (const tr of update.transactions) if (tr.selection && !tr.annotation(incremental)) this.anchor = tr.newSelection.main.from;
    if (state.open !== before.open) {
      if (state.open) this.mount();
      else this.unmount();
    }
    if (state.search !== before.search) shared.search = state.search;
    if (state.replace !== before.replace) shared.replace = state.replace;
    if (state.options !== before.options) shared.options = state.options;
    if (!state.open) return;
    const queryChanged = state.search !== before.search || optionKey(state.options) !== optionKey(before.options) || state.scope !== before.scope;
    if (update.docChanged || queryChanged) this.invalidate(update.state.doc.length > LARGE_DOC ? RECOUNT_DELAY : 0);
    this.syncUi();
    if (update.selectionSet || update.docChanged || update.viewportChanged || queryChanged || state.open !== before.open) this.decorations = this.buildDecorations();
    if (update.selectionSet) this.renderCount();
    if (update.geometryChanged || update.heightChanged) this.drawRuler();
  }

  destroy() {
    this.unmount();
  }

  hasFocus() {
    return !!this.ui && this.ui.root.contains(this.view.root.activeElement);
  }

  focusInput(which: "find" | "replace") {
    const input = which === "replace" ? this.ui?.replace : this.ui?.find;
    input?.focus();
    input?.select();
  }

  query(): SearchQuery {
    const state = this.view.state.field(findField);
    const key = `${state.search}\0${optionKey(state.options)}`;
    if (this.cachedQuery?.key !== key) this.cachedQuery = { key, query: buildQuery(state.search, state.options) };
    return this.cachedQuery.query;
  }

  // 목록이 낡았으면(디바운스 중) 여기서 바로 다시 센다. Enter, ⌘G, 바꾸기는 항상 최신 목록으로 움직인다.
  currentMatches(): Matches {
    if (!this.matches) this.recount();
    return this.matches!;
  }

  goTo(backward: boolean) {
    const { list } = this.currentMatches();
    if (!list.length) return;
    const range = this.view.state.selection.main;
    const found = list[backward ? previousIndex(list, range.from) : nextIndex(list, range.to)];
    this.select(found.from, found.to, false);
  }

  // 토글이나 범위가 바뀌면 입력을 시작한 자리에서부터 다시 고른다.
  restartFromAnchor() {
    const state = this.view.state.field(findField);
    if (state.search) this.selectFrom(this.anchor);
  }

  revealEffect(from: number, to: number) {
    return EditorView.scrollIntoView(EditorSelection.range(from, to), { y: "center" });
  }

  // 이미 화면 안에 보이는 일치는 스크롤하지 않고 선택만 옮긴다. 화면 밖일 때만 가운데로 보낸다.
  private isRevealed(from: number) {
    const coords = this.view.coordsAtPos(from);
    const box = this.view.scrollDOM.getBoundingClientRect();
    return coords !== null && coords.top >= box.top + REVEAL_TOP_MARGIN && coords.bottom <= box.bottom;
  }

  private select(from: number, to: number, auto: boolean) {
    this.view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: this.isRevealed(from) ? [] : this.revealEffect(from, to),
      annotations: auto ? incremental.of(true) : [],
      userEvent: "select.search",
    });
  }

  private selectFrom(pos: number) {
    const state = this.view.state.field(findField);
    const hit = firstMatchFrom(this.query(), this.view.state, pos, state.scope);
    if (hit) this.select(hit.from, hit.to, true);
  }

  private invalidate(delay: number) {
    window.clearTimeout(this.timer);
    this.matches = null;
    if (delay === 0) this.recount();
    else this.timer = window.setTimeout(() => this.recount(), delay);
  }

  private recount() {
    window.clearTimeout(this.timer);
    const state = this.view.state.field(findField);
    this.matches = collectMatches(this.query(), this.view.state, state.scope);
    this.renderCount();
    this.drawRuler();
  }

  private mount() {
    const ui = buildUi(this);
    this.ui = ui;
    this.anchor = this.view.state.selection.main.from;
    const ruler = document.createElement("canvas");
    ruler.className = "cm-find-ruler";
    this.ruler = ruler;
    this.view.dom.append(ui.root, ruler);
    this.observer = new ResizeObserver(() => {
      this.syncWidth();
      this.drawRuler();
    });
    this.observer.observe(this.view.dom);
    this.syncUi();
    this.decorations = this.buildDecorations();
    this.invalidate(0);
  }

  private unmount() {
    window.clearTimeout(this.timer);
    this.observer?.disconnect();
    this.observer = null;
    this.ui?.root.remove();
    this.ruler?.remove();
    this.ui = null;
    this.ruler = null;
    this.matches = null;
    this.rulerKey = "";
    this.decorations = Decoration.none;
  }

  private syncWidth() {
    if (this.ui) this.ui.root.toggleAttribute("data-reduced", this.ui.root.offsetWidth < REDUCED_WIDTH);
  }

  private syncUi() {
    const ui = this.ui;
    if (!ui) return;
    const state = this.view.state.field(findField);
    const readOnly = isReadOnly(this.view);
    if (ui.find.value !== state.search) ui.find.value = state.search;
    if (ui.replace.value !== state.replace) ui.replace.value = state.replace;
    const replaceOpen = state.replaceOpen && !readOnly;
    ui.root.toggleAttribute("data-replace", replaceOpen);
    ui.expand.hidden = readOnly;
    ui.expand.setAttribute("aria-expanded", String(replaceOpen));
    ui.expand.firstElementChild?.setAttribute("class", `codicon codicon-chevron-${replaceOpen ? "down" : "right"}`);
    ui.caseSensitive.setAttribute("aria-checked", String(state.options.caseSensitive));
    ui.wholeWord.setAttribute("aria-checked", String(state.options.wholeWord));
    ui.regexp.setAttribute("aria-checked", String(state.options.regexp));
    ui.preserveCase.setAttribute("aria-checked", String(state.options.preserveCase));
    ui.scope.setAttribute("aria-checked", String(state.scope !== null));
    const error = state.options.regexp ? regexError(state.search) : null;
    ui.message.hidden = error === null;
    ui.message.textContent = error ?? "";
    ui.findField.toggleAttribute("data-invalid", error !== null);
    this.syncWidth();
    this.renderCount();
  }

  private renderCount() {
    const ui = this.ui;
    if (!ui) return;
    const state = this.view.state.field(findField);
    const list = this.matches?.list ?? [];
    const range = this.view.state.selection.main;
    ui.count.textContent = countLabel(list.length, containingIndex(list, range.from, range.to), this.matches?.capped ?? false);
    ui.root.toggleAttribute("data-empty-result", state.search !== "" && list.length === 0);
    const none = list.length === 0;
    const readOnly = isReadOnly(this.view);
    for (const button of [ui.previous, ui.next]) button.setAttribute("aria-disabled", String(none));
    for (const button of [ui.replaceButton, ui.replaceAllButton]) button.setAttribute("aria-disabled", String(none || readOnly));
  }

  private buildDecorations(): DecorationSet {
    const state = this.view.state.field(findField);
    const doc = this.view.state.doc;
    const marks: Range<Decoration>[] = [];
    if (state.scope) marks.push(scopeMark.range(state.scope.from, state.scope.to));
    const query = this.query();
    if (state.search && query.valid) {
      const selection = this.view.state.selection.main;
      let count = 0;
      for (const visible of this.view.visibleRanges) {
        const from = Math.max(doc.lineAt(visible.from).from, state.scope?.from ?? 0);
        const to = Math.min(doc.lineAt(visible.to).to, state.scope?.to ?? doc.length);
        if (from >= to) continue;
        const cursor = query.getCursor(this.view.state, from, to);
        for (let found = cursor.next(); !found.done && count < MAX_MARKS; found = cursor.next()) {
          const { from: start, to: end } = found.value;
          if (end === start) continue;
          marks.push((start <= selection.from && selection.to <= end ? currentMark : matchMark).range(start, end));
          count++;
        }
      }
    }
    return Decoration.set(marks, true);
  }

  // 스크롤바 위 표시: 문서 높이에 대한 일치 줄의 위치를 줄마다 한 칸(같은 칸이면 한 번)으로 그린다.
  private drawRuler() {
    const canvas = this.ruler;
    const matches = this.matches;
    if (!canvas) return;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const total = this.view.contentHeight;
    const key = `${cssWidth}x${cssHeight}:${total}:${matches ? matches.list.length : -1}:${matches?.list[0]?.from ?? 0}:${matches?.list.at(-1)?.from ?? 0}`;
    if (!cssHeight || key === this.rulerKey) return;
    this.rulerKey = key;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    const context = canvas.getContext("2d");
    if (!context || !matches?.list.length) return;
    context.fillStyle = getComputedStyle(canvas).getPropertyValue("--find-ruler").trim();
    const markWidth = Math.max(Math.round(cssWidth / 3), 2) * ratio;
    const markHeight = RULER_MARK_HEIGHT * ratio;
    const x = (canvas.width - markWidth) / 2;
    const span = Math.max(canvas.height - markHeight, 1);
    let last = -1;
    for (const m of matches.list) {
      const y = Math.round((this.view.lineBlockAt(m.from).top / Math.max(total, 1)) * span);
      if (y === last) continue;
      last = y;
      context.fillRect(x, y, markWidth, markHeight);
    }
  }
}

const REVEAL_TOP_MARGIN = 48;
const RULER_MARK_HEIGHT = 3;
const matchMark = Decoration.mark({ class: "cm-findMatch" });
const currentMark = Decoration.mark({ class: "cm-findMatch cm-findMatch-current" });
const scopeMark = Decoration.mark({ class: "cm-findScope" });

const findPlugin = ViewPlugin.fromClass(FindPlugin, { decorations: (plugin) => plugin.decorations });

// --- DOM 만들기 ---

function buildUi(plugin: FindPlugin): Ui {
  const view = plugin.view;
  const root = element("div", "cm-find");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Find");

  const expand = iconButton("cm-find-expand", "chevron-right", TIPS.toggleReplace);
  expand.setAttribute("aria-expanded", "false");
  expand.addEventListener("click", () => {
    const open = !view.state.field(findField).replaceOpen;
    view.dispatch({ effects: setFind.of({ replaceOpen: open }) });
    if (open) view.plugin(findPlugin)?.focusInput("replace");
  });

  const findInput = input(TIPS.find);
  const caseSensitive = toggle("case-sensitive", TIPS.caseSensitive);
  const wholeWord = toggle("whole-word", TIPS.wholeWord);
  const regexp = toggle("regex", TIPS.regexp);
  const message = element("div", "cm-find-message");
  message.hidden = true;
  message.setAttribute("role", "alert");
  const findBox = field(findInput, [caseSensitive, wholeWord, regexp], 3);
  findBox.append(message);

  const count = element("div", "cm-find-count");
  count.setAttribute("aria-live", "polite");
  const previous = iconButton("cm-find-button", "arrow-up", TIPS.previous);
  const next = iconButton("cm-find-button", "arrow-down", TIPS.next);
  const scope = iconButton("cm-find-button", "selection", TIPS.scope);
  scope.setAttribute("role", "checkbox");
  const actions = element("div", "cm-find-actions");
  actions.append(count, previous, next, scope);

  const replaceInput = input(TIPS.replacePlaceholder);
  const preserveCase = toggle("preserve-case", TIPS.preserveCase);
  const replaceBox = field(replaceInput, [preserveCase], 1);
  replaceBox.classList.add("cm-find-replace-part");
  const replaceButton = iconButton("cm-find-button", "replace", TIPS.replace);
  const replaceAllButton = iconButton("cm-find-button", "replace-all", TIPS.replaceAll);
  const replaceActions = element("div", "cm-find-actions cm-find-replace-part");
  replaceActions.append(replaceButton, replaceAllButton);

  const close = iconButton("cm-find-button cm-find-close", "close", TIPS.close);
  root.append(expand, findBox, actions, replaceBox, replaceActions, close);

  const enabled = (button: HTMLElement, run: () => void) => () => {
    if (button.getAttribute("aria-disabled") !== "true") run();
  };
  findInput.addEventListener("input", () => {
    view.dispatch({ effects: setFind.of({ search: findInput.value }) });
    plugin.restartFromAnchor();
  });
  replaceInput.addEventListener("input", () => view.dispatch({ effects: setFind.of({ replace: replaceInput.value }) }));
  const flip = (key: keyof FindOptions) => () => toggleOption(view, key);
  caseSensitive.addEventListener("click", flip("caseSensitive"));
  wholeWord.addEventListener("click", flip("wholeWord"));
  regexp.addEventListener("click", flip("regexp"));
  preserveCase.addEventListener("click", flip("preserveCase"));
  scope.addEventListener("click", () => toggleScope(view));
  previous.addEventListener("click", enabled(previous, () => plugin.goTo(true)));
  next.addEventListener("click", enabled(next, () => plugin.goTo(false)));
  replaceButton.addEventListener("click", enabled(replaceButton, () => replaceOne(view)));
  replaceAllButton.addEventListener("click", enabled(replaceAllButton, () => replaceAll(view)));
  close.addEventListener("click", () => closeFind(view));

  root.addEventListener("keydown", (event) => {
    if (runScopeHandlers(view, event, "find-widget")) {
      event.preventDefault();
      return;
    }
    // 한글 조합 중 Enter 는 조합을 끝내는 키라 이동하지 않는다.
    if (event.isComposing || event.keyCode === 229 || event.key !== "Enter" || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.target === findInput) {
      event.preventDefault();
      plugin.goTo(event.shiftKey);
    } else if (event.target === replaceInput && !event.shiftKey) {
      event.preventDefault();
      replaceOne(view);
    }
  });
  // 편집기의 오른쪽 클릭 메뉴(Editor.tsx)로 올라가지 않게 해서 입력칸에서는 기본 메뉴(복사, 붙여넣기)가 뜬다.
  root.addEventListener("contextmenu", (event) => event.stopPropagation());

  return { root, expand, find: findInput, findField: findBox, message, replace: replaceInput, caseSensitive, wholeWord, regexp, preserveCase, count, previous, next, scope, replaceButton, replaceAllButton, close };
}

function element(tag: string, className: string) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function input(label: string) {
  const node = element("input", "cm-find-input") as HTMLInputElement;
  node.type = "text";
  node.placeholder = label;
  node.setAttribute("aria-label", label);
  node.setAttribute("spellcheck", "false");
  node.setAttribute("autocomplete", "off");
  node.setAttribute("autocapitalize", "off");
  // 찾기 칸에는 CodeMirror 의 getSearchInput 이 찾는 속성을 단다.
  if (label === TIPS.find) node.setAttribute("main-field", "true");
  return node;
}

function field(inputNode: HTMLInputElement, toggles: HTMLElement[], toggleCount: number) {
  const box = element("div", "cm-find-field");
  box.style.setProperty("--toggles", String(toggleCount));
  const group = element("div", "cm-find-toggles");
  group.append(...toggles);
  box.append(inputNode, group);
  return box;
}

function iconButton(className: string, icon: string, label: string) {
  const button = element("button", className) as HTMLButtonElement;
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  const glyph = element("span", `codicon codicon-${icon}`);
  glyph.setAttribute("aria-hidden", "true");
  button.append(glyph);
  return button;
}

function toggle(icon: string, label: string) {
  const button = iconButton("cm-find-toggle", icon, label);
  button.setAttribute("role", "checkbox");
  button.setAttribute("aria-checked", "false");
  return button;
}

// --- 단축키 ---
// scope 의 "find-widget" 은 위젯 안(입력칸과 버튼)에서도 같은 키가 듣게 한다. 위젯이 닫혀 있으면 whenOpen 이 false 를 줘서 다른 키맵으로 넘어간다.
const SCOPE = "editor find-widget";

const bindings: KeyBinding[] = [
  { key: "Mod-f", run: (view) => openFind(view), scope: SCOPE, preventDefault: true },
  { key: "Mod-Alt-f", run: (view) => openFind(view, { replace: true }), scope: SCOPE, preventDefault: true },
  { key: "Mod-g", run: (view) => step(view, false), shift: (view) => step(view, true), scope: SCOPE, preventDefault: true },
  { key: "F3", run: (view) => step(view, false), shift: (view) => step(view, true), scope: SCOPE, preventDefault: true },
  { key: "Mod-e", run: (view) => findWithSelection(view), scope: SCOPE, preventDefault: true },
  { key: "Mod-F3", run: (view) => findWithSelection(view, "next"), shift: (view) => findWithSelection(view, "previous"), scope: SCOPE, preventDefault: true },
  { key: "Escape", run: closeFind, scope: SCOPE },
  { key: "Alt-Enter", run: whenOpen(selectAllMatches), scope: SCOPE, preventDefault: true },
  { key: "Mod-Alt-Enter", run: whenOpen(replaceAll), scope: SCOPE, preventDefault: true },
  { key: "Mod-Alt-c", run: whenOpen((view) => toggleOption(view, "caseSensitive")), scope: SCOPE, preventDefault: true },
  { key: "Mod-Alt-w", run: whenOpen((view) => toggleOption(view, "wholeWord")), scope: SCOPE, preventDefault: true },
  { key: "Mod-Alt-r", run: whenOpen((view) => toggleOption(view, "regexp")), scope: SCOPE, preventDefault: true },
  { key: "Mod-Alt-p", run: whenOpen((view) => toggleOption(view, "preserveCase")), scope: SCOPE, preventDefault: true },
  { key: "Mod-Alt-l", run: whenOpen(toggleScope), scope: SCOPE, preventDefault: true },
];

// basicSetup 의 searchKeymap(⌘F, ⌘G, F3, Esc) 보다 먼저 받는다.
const findKeymap = Prec.high(keymap.of(bindings));

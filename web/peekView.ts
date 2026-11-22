import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { LSPPlugin } from "@codemirror/lsp-client";
import { Annotation, EditorState, Facet, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { saveTab } from "./editorDocs";
import { MAIN_GROUP } from "./editorGroups";
import { editorSyntax } from "./editorSyntax";
import { pushHistory, revealFrom, revealLocation, toTarget, uriToPath, viewFor } from "./lsp";
import { flatten, nearestIndex, peekMeta, previewLine, splitPath, stepIndex, type PeekGroup, type PeekKind, type PeekRef } from "./peekModel";
import { currentZone, hideZone, showZone, zoneExtension, type ZoneParts } from "./peekZone";
import { rpc } from "./rpc";
import { fileTabKey, getState, setState } from "./store";
import { S } from "./strings";


export type PeekOptions = {
  workspaceId: string;
  previewExtensions: (path: string) => Extension[];
};

export const peekOptions = Facet.define<PeekOptions, PeekOptions | null>({ combine: (values) => values[0] ?? null });

export type PeekSession = {
  kind: PeekKind;
  keepOpen: boolean;
  workspaceId: string;
  groups: PeekGroup[];
  flat: PeekRef[];
  index: number;
  texts: Map<string, string>;
};

export function peekExtension(options: PeekOptions): Extension {
  return [
    zoneExtension(),
    peekOptions.of(options),
    Prec.highest(
      keymap.of([
        { key: "Escape", run: (view) => hideZone(view) },
        { key: "F4", run: (view) => stepPeek(view, 1) },
        { key: "Shift-F4", run: (view) => stepPeek(view, -1) },
      ]),
    ),
  ];
}


const LAYOUT_KEY = "agent-nav.peekLayout";
const layout = loadLayout();

function loadLayout() {
  const fallback = { lines: 18, ratio: 0.7 };
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as { lines?: number; ratio?: number };
    return { lines: saved.lines && saved.lines >= 6 ? saved.lines : fallback.lines, ratio: saved.ratio && saved.ratio > 0.1 && saved.ratio < 0.95 ? saved.ratio : fallback.ratio };
  } catch {
    return fallback;
  }
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
  }
}

const MIN_PREVIEW_WIDTH = 200;
const MIN_RESULTS_WIDTH = 160;
const STACK_BELOW_WIDTH = MIN_PREVIEW_WIDTH + MIN_RESULTS_WIDTH + 120;
const STACKED_PREVIEW_SHARE = 0.6;

let zoneCounter = 0;
const handles = new WeakMap<EditorView, { step: (delta: 1 | -1) => void }>();

const previewSaves = new WeakMap<Element, () => void>();

export function savePeekPreview() {
  const container = document.activeElement?.closest(".cm-peek-preview");
  const save = container ? previewSaves.get(container) : undefined;
  save?.();
  return !!save;
}

export function isPeekOpen(view: EditorView) {
  return handles.has(view) && currentZone(view) !== null;
}

export function stepPeek(view: EditorView, delta: 1 | -1) {
  const handle = handles.get(view);
  if (!handle || !currentZone(view)) return false;
  handle.step(delta);
  return true;
}

export async function loadTexts(session: Pick<PeekSession, "workspaceId" | "groups" | "texts">) {
  await Promise.all(
    session.groups.map(async (group) => {
      session.texts.set(group.uri, await textOf(session.workspaceId, group.uri));
    }),
  );
}

async function textOf(workspaceId: string, uri: string) {
  const target = toTarget(uriToPath(uri), workspaceId);
  const live = viewFor(fileTabKey(target.workspaceId, target.path));
  if (live) return live.state.doc.toString();
  return rpc
    .call("files.read", { workspaceId: target.workspaceId, path: target.path })
    .then(({ text }) => text ?? "")
    .catch(() => "");
}

export function makeSession(workspaceId: string, kind: PeekKind, keepOpen: boolean, groups: PeekGroup[], index: number): PeekSession {
  return { kind, keepOpen, workspaceId, groups, flat: flatten(groups), index, texts: new Map() };
}

export function nearestOf(groups: PeekGroup[], host: EditorView) {
  const plugin = LSPPlugin.get(host);
  if (!plugin) return 0;
  const head = host.state.selection.main.head;
  const pos = plugin.toPosition(head);
  return nearestIndex(groups, plugin.uri, pos.line, pos.character);
}

export function openPeek(host: EditorView, session: PeekSession, options: { focus?: "list" | "host" } = {}) {
  const head = host.state.selection.main.head;
  showZone(host, {
    id: ++zoneCounter,
    anchor: head,
    arrowAt: head,
    lines: layout.lines,
    className: "cm-peek",
    onResize: (lines) => {
      layout.lines = lines;
      saveLayout();
    },
    mount: (parts) => mountPeek(parts, session, options.focus ?? "list"),
  });
}

async function activateRef(host: EditorView, session: PeekSession, ref: PeekRef, trigger: "enter" | "step", focus: "list" | "host") {
  pushHistory();
  if (!session.keepOpen && trigger === "enter") {
    hideZone(host, { refocus: false });
    revealFrom(host, session.workspaceId, ref);
    return;
  }
  const plugin = LSPPlugin.get(host);
  if (plugin?.uri === ref.uri) {
    const pos = plugin.fromPosition(ref.range.start);
    host.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    openPeek(host, session, { focus });
    return;
  }
  const target = toTarget(uriToPath(ref.uri), session.workspaceId);
  const key = fileTabKey(target.workspaceId, target.path);
  revealLocation(session.workspaceId, ref);
  const next = await waitForReveal(key);
  if (!next) return;
  hideZone(host, { refocus: false });
  openPeek(next, session, { focus });
}

function waitForReveal(key: string) {
  return new Promise<EditorView | null>((resolve) => {
    const started = performance.now();
    const check = () => {
      const view = viewFor(key);
      if (view && !getState().pendingReveal[key]) {
        resolve(view);
        return;
      }
      if (performance.now() - started > 3000) {
        resolve(null);
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

type Item = { type: "file"; group: PeekGroup } | { type: "ref"; ref: PeekRef };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function codicon(name: string) {
  const node = document.createElement("span");
  node.className = `codicon codicon-${name}`;
  node.setAttribute("aria-hidden", "true");
  return node;
}

function mountPeek(parts: ZoneParts, session: PeekSession, focus: "list" | "host"): () => void {
  const { host, title, actions, body } = parts;
  const options = host.state.facet(peekOptions);
  const grouped = session.groups.length > 1;
  const collapsed = new Set<string>();
  let disposed = false;
  let token = 0;
  let preview: EditorView | null = null;
  let previewUri: string | null = null;
  let stopMirror: (() => void) | null = null;
  let saveMirror: (() => void) | null = null;

  const closeButton = el("button", "cm-zone-action");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", S.close);
  closeButton.title = S.close;
  closeButton.append(codicon("close"));
  closeButton.addEventListener("click", () => parts.close());
  actions.append(closeButton);

  const nameEl = el("span", "cm-zone-name");
  const dirEl = el("span", "cm-zone-dir");
  const metaEl = el("span", "cm-zone-meta", peekMeta(session.kind, session.flat.length));
  title.append(nameEl, dirEl, metaEl);

  const previewEl = el("div", "cm-peek-preview");
  const split = el("div", "cm-peek-split");
  const resultsEl = el("div", "cm-peek-results");
  resultsEl.tabIndex = 0;
  resultsEl.setAttribute("role", "tree");
  if (grouped) resultsEl.dataset.grouped = "";
  body.append(previewEl, split, resultsEl);
  previewSaves.set(previewEl, () => saveMirror?.());

  const visible = (): Item[] => {
    const items: Item[] = [];
    for (const group of session.groups) {
      if (grouped) items.push({ type: "file", group });
      if (!collapsed.has(group.uri)) for (const ref of group.refs) items.push({ type: "ref", ref });
    }
    return items;
  };

  const selectedRef = () => session.flat[session.index];
  const itemIsSelected = (item: Item) => (item.type === "ref" ? item.ref === selectedRef() : item.group.refs[0] === selectedRef() && collapsed.has(item.group.uri));

  const render = () => {
    const items = visible();
    resultsEl.replaceChildren();
    items.forEach((item, position) => {
      const row = el("div", item.type === "file" ? "cm-peek-row cm-peek-row-file" : "cm-peek-row cm-peek-row-ref");
      row.setAttribute("role", "treeitem");
      row.dataset.position = String(position);
      if (itemIsSelected(item)) row.setAttribute("aria-selected", "true");
      if (item.type === "file") {
        const { name, dir } = fileLabel(session, item.group.uri);
        row.append(codicon(collapsed.has(item.group.uri) ? "chevron-right" : "chevron-down"));
        row.append(el("span", "cm-peek-name", name), el("span", "cm-peek-dir", dir), el("span", "cm-peek-count", String(item.group.refs.length)));
        row.title = `${item.group.refs.length === 1 ? "1 reference" : `${item.group.refs.length} references`} in ${name}`;
      } else {
        const text = refText(session, item.ref);
        const label = el("span", "cm-peek-text");
        if (text) {
          label.append(text.text.slice(0, text.matchStart));
          label.append(el("span", "cm-peek-hl", text.text.slice(text.matchStart, text.matchEnd)));
          label.append(text.text.slice(text.matchEnd));
        } else label.textContent = `${item.ref.range.start.line + 1}:${item.ref.range.start.character + 1}`;
        row.append(label);
        row.title = `${item.ref.range.start.line + 1}:${item.ref.range.start.character + 1}`;
      }
      resultsEl.append(row);
    });
    resultsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };

  const updateSelection = () => {
    const items = visible();
    resultsEl.querySelectorAll<HTMLElement>(".cm-peek-row").forEach((row) => {
      const item = items[Number(row.dataset.position)];
      if (item && itemIsSelected(item)) row.setAttribute("aria-selected", "true");
      else row.removeAttribute("aria-selected");
    });
    resultsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };

  const select = (ref: PeekRef) => {
    session.index = Math.max(session.flat.indexOf(ref), 0);
    updateSelection();
    void showRef(ref);
  };

  const move = (delta: 1 | -1) => {
    const refs = visible().filter((item): item is Extract<Item, { type: "ref" }> => item.type === "ref");
    if (refs.length === 0) return;
    const current = refs.findIndex((item) => item.ref === selectedRef());
    const next = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), refs.length - 1);
    select(refs[next].ref);
  };

  const setCollapsed = (uri: string, value: boolean) => {
    if (value) collapsed.add(uri);
    else collapsed.delete(uri);
    render();
  };

  const open = (ref: PeekRef, trigger: "enter" | "step", target: "list" | "host" = "list") => void activateRef(host, session, ref, trigger, target);

  resultsEl.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".cm-peek-row");
    if (!row) return;
    const item = visible()[Number(row.dataset.position)];
    if (!item) return;
    if (item.type === "ref") select(item.ref);
    else {
      setCollapsed(item.group.uri, !collapsed.has(item.group.uri));
      select(item.group.refs[0]);
    }
    resultsEl.focus({ preventScroll: true });
  });
  resultsEl.addEventListener("dblclick", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".cm-peek-row");
    const item = row ? visible()[Number(row.dataset.position)] : null;
    if (item?.type === "ref") open(item.ref, "enter");
  });
  resultsEl.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "ArrowDown") (stop(), move(1));
    else if (event.key === "ArrowUp") (stop(), move(-1));
    else if (event.key === "Enter") {
      stop();
      const ref = selectedRef();
      if (ref) open(ref, "enter");
    } else if (event.key === "Escape") (stop(), parts.close());
    else if (event.key === "F4" || event.key === "F12") (stop(), step(event.shiftKey ? -1 : 1));
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const ref = selectedRef();
      const group = session.groups.find((g) => g.refs.includes(ref));
      if (grouped && group) {
        stop();
        setCollapsed(group.uri, event.key === "ArrowLeft");
      }
    }
  });

  const step = (delta: 1 | -1) => {
    const next = session.flat[stepIndex(session.index, delta, session.flat.length)];
    if (!next) return;
    session.index = session.flat.indexOf(next);
    open(next, "step", focus === "host" ? "host" : "list");
  };
  handles.set(host, { step });

  let totalWidth = 0;
  const applyWidths = (width: number) => {
    totalWidth = width;
    const height = body.clientHeight;
    if (width < STACK_BELOW_WIDTH) {
      body.dataset.stacked = "";
      const previewHeight = Math.round(height * STACKED_PREVIEW_SHARE);
      previewEl.style.width = resultsEl.style.width = `${width}px`;
      previewEl.style.height = `${previewHeight}px`;
      resultsEl.style.height = `${height - previewHeight}px`;
      preview?.requestMeasure();
      return;
    }
    delete body.dataset.stacked;
    const previewWidth = Math.min(Math.max(width * layout.ratio, MIN_PREVIEW_WIDTH), Math.max(width - MIN_RESULTS_WIDTH, MIN_PREVIEW_WIDTH));
    previewEl.style.width = `${previewWidth}px`;
    resultsEl.style.width = `${Math.max(width - previewWidth, 0)}px`;
    split.style.left = `${previewWidth}px`;
    previewEl.style.height = resultsEl.style.height = `${height}px`;
    preview?.requestMeasure();
  };
  parts.onLayout((size) => applyWidths(size.width));
  split.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    split.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const left = body.getBoundingClientRect().left;
      layout.ratio = Math.min(Math.max((e.clientX - left) / totalWidth, MIN_PREVIEW_WIDTH / totalWidth), 1 - MIN_RESULTS_WIDTH / totalWidth);
      applyWidths(totalWidth);
    };
    const up = () => {
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", up);
      saveLayout();
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
  });

  async function showRef(ref: PeekRef) {
    const mine = ++token;
    const { name, dir } = fileLabel(session, ref.uri);
    nameEl.textContent = name;
    dirEl.textContent = dir;
    const text = session.texts.get(ref.uri) ?? (await textOf(session.workspaceId, ref.uri));
    if (disposed || mine !== token) return;
    if (!preview || previewUri !== ref.uri) {
      stopMirror?.();
      stopMirror = null;
      preview?.destroy();
      const target = toTarget(uriToPath(ref.uri), session.workspaceId);
      const mirror = createMirror(target.workspaceId, target.path, () => preview);
      preview = new EditorView({
        parent: previewEl,
        state: EditorState.create({
          doc: text,
          extensions: [
            lineNumbers(),
            history(),
            bracketMatching(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            Prec.highest(
              keymap.of([
                { key: "Escape", run: () => (parts.close(), true) },
                { key: "F4", run: () => (step(1), true) },
                { key: "F12", run: () => (step(1), true) },
                { key: "Shift-F4", run: () => (step(-1), true) },
                { key: "Shift-F12", run: () => (step(-1), true) },
                { key: "Mod-s", run: () => (mirror.save(), true) },
              ]),
            ),
            ...(options?.previewExtensions(target.path) ?? []),
            editorSyntax({ semantic: false }),
            matchField,
            EditorView.updateListener.of((update) => mirror.fromPreview(update)),
            EditorView.domEventHandlers({
              dblclick: (event, view) => {
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                const current = selectedRef();
                if (pos === null || !current) return false;
                const line = view.state.doc.lineAt(pos);
                const at = { line: line.number - 1, character: pos - line.from };
                open({ uri: current.uri, range: { start: at, end: at } }, "enter");
                return true;
              },
            }),
          ],
        }),
      });
      previewUri = ref.uri;
      stopMirror = mirror.start(preview);
      saveMirror = mirror.save;
      applyWidths(totalWidth || body.clientWidth);
    }
    const view = preview;
    const doc = view.state.doc;
    const at = (position: { line: number; character: number }) => {
      const line = doc.line(Math.min(Math.max(position.line + 1, 1), doc.lines));
      return Math.min(line.from + position.character, line.to);
    };
    const ranges = (session.groups.find((g) => g.uri === ref.uri)?.refs ?? [ref]).map((r) => ({ from: at(r.range.start), to: Math.max(at(r.range.end), at(r.range.start)) }));
    const start = at(ref.range.start);
    view.dispatch({ effects: [setMatches.of(ranges), EditorView.scrollIntoView(start, { y: "center" })], selection: { anchor: start } });
  }

  render();
  const first = selectedRef();
  if (first) void showRef(first);
  let focused = false;
  const placeFocus = () => {
    if (disposed || focused) return;
    focused = true;
    if (focus === "list") resultsEl.focus({ preventScroll: true });
    else host.focus();
  };
  requestAnimationFrame(placeFocus);
  setTimeout(placeFocus, 30);

  return () => {
    disposed = true;
    if (handles.get(host)?.step === step) handles.delete(host);
    stopMirror?.();
    preview?.destroy();
    preview = null;
  };
}

function fileLabel(session: PeekSession, uri: string) {
  const target = toTarget(uriToPath(uri), session.workspaceId);
  return splitPath(target.path);
}

function refText(session: PeekSession, ref: PeekRef) {
  const text = session.texts.get(ref.uri);
  if (text === undefined) return null;
  const lines = text.split("\n");
  const lineText = (lines[ref.range.start.line] ?? "").replace(/\r$/, "");
  const end = ref.range.end.line === ref.range.start.line ? ref.range.end.character : lineText.length;
  return previewLine(lineText, ref.range.start.character, end);
}

const setMatches = StateEffect.define<{ from: number; to: number }[]>();
const matchMark = Decoration.mark({ class: "cm-peek-match" });

const matchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setMatches)) value = Decoration.set(effect.value.filter((r) => r.to > r.from).map((r) => matchMark.range(r.from, r.to)), true);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const mirrored = Annotation.define<boolean>();
const watchers = new WeakMap<EditorView, Set<(update: ViewUpdate) => void>>();

function watchView(view: EditorView, handler: (update: ViewUpdate) => void) {
  let set = watchers.get(view);
  if (!set) {
    const created = new Set<(update: ViewUpdate) => void>();
    set = created;
    watchers.set(view, created);
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          for (const watcher of created) watcher(update);
        }),
      ),
    });
  }
  set.add(handler);
  const owned = set;
  return () => owned.delete(handler);
}

function createMirror(workspaceId: string, path: string, previewOf: () => EditorView | null) {
  const key = fileTabKey(workspaceId, path);
  let tab: EditorView | null = null;
  let unwatch: (() => void) | null = null;
  let requested = false;

  const attach = (view: EditorView) => {
    tab = view;
    unwatch?.();
    unwatch = watchView(view, (update) => {
      const preview = previewOf();
      if (!preview || !update.docChanged || update.transactions.some((tr) => tr.annotation(mirrored))) return;
      if (update.changes.length === preview.state.doc.length) preview.dispatch({ changes: update.changes, annotations: mirrored.of(true) });
      else preview.dispatch({ changes: { from: 0, to: preview.state.doc.length, insert: update.state.doc.toString() }, annotations: mirrored.of(true) });
    });
  };

  const connectLater = () => {
    if (requested) return;
    requested = true;
    setState((s) => (s.tabs.some((t) => t.key === key) ? {} : { tabs: [...s.tabs, s.activeGroupId === MAIN_GROUP ? { key, kind: "file" as const, workspaceId, path } : { key, kind: "file" as const, workspaceId, path, group: s.activeGroupId }] }));
    void waitForTabView(key).then((view) => {
      const preview = previewOf();
      if (!view || !preview) {
        requested = false;
        return;
      }
      const text = preview.state.doc.toString();
      if (view.state.doc.toString() !== text && getState().dirtyTabs[key]) return;
      if (view.state.doc.toString() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: mirrored.of(true) });
      attach(view);
    });
  };

  return {
    start(preview: EditorView) {
      const existing = viewFor(key);
      if (existing) {
        if (!existing.state.doc.eq(preview.state.doc)) preview.dispatch({ changes: { from: 0, to: preview.state.doc.length, insert: existing.state.doc.toString() }, annotations: mirrored.of(true) });
        attach(existing);
      }
      return () => {
        unwatch?.();
        unwatch = null;
      };
    },
    fromPreview(update: ViewUpdate) {
      if (!update.docChanged || update.transactions.some((tr) => tr.annotation(mirrored))) return;
      if (tab) tab.dispatch({ changes: update.changes, annotations: mirrored.of(true) });
      else connectLater();
    },
    save() {
      if (viewFor(key)) void saveTab(key);
    },
  };
}

function waitForTabView(key: string) {
  return new Promise<EditorView | null>((resolve) => {
    const started = performance.now();
    const check = () => {
      const view = viewFor(key);
      if (view) resolve(view);
      else if (performance.now() - started > 3000) resolve(null);
      else requestAnimationFrame(check);
    };
    check();
  });
}

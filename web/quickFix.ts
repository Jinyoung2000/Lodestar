import { LSPPlugin, type WorkspaceMapping } from "@codemirror/lsp-client";
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { buildRows, focusableIndexes, MAC_KEYS, MENU_TEXT, isQuickFix, isSourceAction, placeMenu, sortActions, stepFocus, type MenuAnchor, type MenuRow } from "./codeActionModel";
import { diagnosticsOf, type LspDiagnostic, type LspRange } from "./diagnosticsStore";
import { toTarget, uriToPath, viewFor } from "./lsp";
import { collectEdits, type TextEdit, type WorkspaceEdit } from "./renameModel";
import { previewWorkspaceEdit } from "./refactorPreview";
import { rpc } from "./rpc";
import { fileTabKey, flash, getState } from "./store";
import { S } from "./strings";
import { hint } from "./hint";
import "./quickFix.css";


export type { TextEdit, WorkspaceEdit };
export type CodeAction = { title: string; kind?: string; isPreferred?: boolean; disabled?: { reason: string }; edit?: WorkspaceEdit; command?: unknown; data?: unknown; diagnostics?: LspDiagnostic[] };

type Menu = { anchor: MenuAnchor; actions: CodeAction[]; index: number; showDisabled: boolean; offerDisabled: boolean };

const setMenu = StateEffect.define<Menu | null>();
const moveMenu = StateEffect.define<1 | -1>();
const focusRow = StateEffect.define<number>();
const toggleDisabled = StateEffect.define<null>();

const SHOW_HEADERS = true;

const rowsOf = (menu: Menu) => buildRows(menu.actions, { showHeaders: SHOW_HEADERS, showDisabled: menu.showDisabled });
const firstFocus = (menu: Menu) => focusableIndexes(rowsOf(menu))[0] ?? -1;

const menuField = StateField.define<Menu | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMenu)) return effect.value;
      if (!value) continue;
      if (effect.is(moveMenu)) return { ...value, index: stepFocus(rowsOf(value), value.index, effect.value) };
      if (effect.is(focusRow)) return { ...value, index: effect.value };
      if (effect.is(toggleDisabled)) {
        const next = { ...value, showDisabled: !value.showDisabled };
        return { ...next, index: firstFocus(next) };
      }
    }
    return tr.docChanged || tr.selection ? null : value;
  },
});

export function quickFix(): Extension {
  return [
    menuField,
    menuOverlay,
    Prec.highest(
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (!event.metaKey || event.code !== "Period" || event.shiftKey || event.altKey || event.ctrlKey || !view.state.field(menuField, false)) return false;
          event.preventDefault();
          event.stopPropagation();
          return choose(view, false);
        },
      }),
    ),
    Prec.highest(
      keymap.of([
        { key: "ArrowDown", run: (view) => step(view, 1) },
        { key: "ArrowUp", run: (view) => step(view, -1) },
        { key: "Ctrl-n", run: (view) => step(view, 1) },
        { key: "Ctrl-p", run: (view) => step(view, -1) },
        { key: "Enter", run: (view) => choose(view, false) },
        { key: "Mod-Enter", run: (view) => choose(view, true) },
        { key: "Escape", run: (view) => close(view) },
      ]),
    ),
  ];
}

export async function openQuickFix(view: EditorView, pos?: number) {
  if (view.state.field(menuField, false)) {
    choose(view, false);
    return;
  }
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const selection = view.state.selection.main;
  const head = pos ?? selection.head;
  const from = pos === undefined ? selection.from : head;
  const to = pos === undefined ? selection.to : head;
  const diagnostics = diagnosticsOver(plugin, from, to);
  const range = diagnostics.length ? diagnostics[0]!.range : { start: plugin.toPosition(from), end: plugin.toPosition(to) };
  const doc = view.state.doc;
  let all: CodeAction[];
  try {
    all = await requestCodeActions(plugin, range, diagnostics, 1);
    if (pos === undefined) all = await withNearbyQuickFixes(plugin, view, all, selection.head);
  } catch {
    all = [];
  }
  if (view.state.doc !== doc) return;
  const valid = usable(plugin, all);
  if (!valid.length) {
    hint(MENU_TEXT.noActions, view);
    return;
  }
  const disabled = all.filter((action) => action.disabled);
  showCodeActionMenu(view, valid.concat(disabled), cursorAnchor(view, head), { offerDisabled: disabled.length > 0 });
}

export async function autoFixAtCursor(view: EditorView) {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  const selection = view.state.selection.main;
  const diagnostics = diagnosticsOver(plugin, selection.from, selection.to);
  const range = diagnostics.length ? diagnostics[0]!.range : { start: plugin.toPosition(selection.from), end: plugin.toPosition(selection.to) };
  const doc = view.state.doc;
  let preferred: CodeAction[];
  try {
    preferred = usable(plugin, await requestCodeActions(plugin, range, diagnostics, 1, ["quickfix"])).filter((action) => action.isPreferred);
  } catch {
    preferred = [];
  }
  if (view.state.doc !== doc) return true;
  if (!preferred.length) {
    hint(MENU_TEXT.noAutoFix, view);
    return true;
  }
  if (preferred.length === 1) void apply(view, preferred[0]!);
  else showCodeActionMenu(view, preferred, cursorAnchor(view, selection.head), { offerDisabled: false });
  return true;
}

export function showCodeActionMenu(view: EditorView, actions: CodeAction[], anchor: MenuAnchor, options: { offerDisabled?: boolean } = {}) {
  const menu: Menu = { anchor, actions, index: -1, showDisabled: false, offerDisabled: options.offerDisabled ?? false };
  view.dispatch({ effects: setMenu.of({ ...menu, index: firstFocus(menu) }) });
  view.focus();
}

export function cursorAnchor(view: EditorView, pos: number): MenuAnchor {
  const box = view.coordsAtPos(pos) ?? view.dom.getBoundingClientRect();
  return { x: box.left, top: box.top, bottom: box.bottom };
}

export async function requestCodeActions(plugin: LSPPlugin, range: LspRange, diagnostics: LspDiagnostic[], triggerKind: 1 | 2, only?: string[], signal?: { cancelled: boolean }): Promise<CodeAction[]> {
  plugin.client.sync();
  const result = await plugin.client.request<object, CodeAction[] | null>("textDocument/codeAction", {
    textDocument: { uri: plugin.uri },
    range,
    context: { diagnostics, triggerKind, ...(only ? { only } : {}) },
  });
  if (signal?.cancelled) return [];
  return (result ?? []).filter((action) => typeof action.title === "string" && !isSourceAction(action));
}

export function usable(plugin: LSPPlugin, actions: CodeAction[]): CodeAction[] {
  const resolvable = !!(plugin.client.serverCapabilities?.codeActionProvider as { resolveProvider?: boolean } | undefined)?.resolveProvider;
  return sortActions(actions.filter((action) => !action.disabled && (action.edit || (resolvable && action.data !== undefined && !action.command))));
}

export async function loadCodeActions(plugin: LSPPlugin, range: LspRange, diagnostics: LspDiagnostic[]): Promise<CodeAction[]> {
  return usable(plugin, await requestCodeActions(plugin, range, diagnostics, 1));
}

async function withNearbyQuickFixes(plugin: LSPPlugin, view: EditorView, all: CodeAction[], head: number) {
  if (usable(plugin, all).some(isQuickFix)) return all;
  const line = view.state.doc.lineAt(head);
  const column = head - line.from;
  const nearby = diagnosticsOver(plugin, line.from, line.to)
    .map((diagnostic) => ({ diagnostic, end: plugin.fromPosition(diagnostic.range.end) }))
    .sort((a, b) => Math.abs(a.end - line.from - column) - Math.abs(b.end - line.from - column));
  const extra: CodeAction[] = [];
  for (const { diagnostic } of nearby) {
    const point = { start: diagnostic.range.end, end: diagnostic.range.end };
    try {
      extra.push(...usable(plugin, await requestCodeActions(plugin, point, [diagnostic], 1, ["quickfix"])));
    } catch {
    }
  }
  const seen = new Set(all.map((action) => action.title));
  return [...all, ...extra.filter((action) => !seen.has(action.title) && seen.add(action.title))];
}

export function diagnosticsOver(plugin: LSPPlugin, from: number, to: number) {
  return diagnosticsOf(plugin.uri).filter((d) => {
    const start = plugin.unsyncedChanges.mapPos(plugin.fromPosition(d.range.start, plugin.syncedDoc));
    const end = plugin.unsyncedChanges.mapPos(plugin.fromPosition(d.range.end, plugin.syncedDoc));
    return start <= to && from <= end;
  });
}

function step(view: EditorView, delta: 1 | -1) {
  if (!view.state.field(menuField, false)) return false;
  view.dispatch({ effects: moveMenu.of(delta) });
  return true;
}

function close(view: EditorView) {
  if (!view.state.field(menuField, false)) return false;
  view.dispatch({ effects: setMenu.of(null) });
  return true;
}

function choose(view: EditorView, preview: boolean) {
  const menu = view.state.field(menuField, false);
  if (!menu) return false;
  const row = rowsOf(menu)[menu.index];
  if (row?.type !== "action" || row.disabled) return true;
  if (preview && !row.canPreview) return true;
  void apply(view, row.action, preview);
  return true;
}

const menuOverlay = ViewPlugin.fromClass(
  class {
    private dom: HTMLElement | null = null;
    private rowEls: HTMLElement[] = [];
    private stop: (() => void) | null = null;

    constructor(private view: EditorView) {}

    update(update: ViewUpdate) {
      const prev = update.startState.field(menuField);
      const next = update.state.field(menuField);
      if (prev === next) return;
      if (!next) {
        this.remove();
        return;
      }
      if (!this.dom || !prev || prev.actions !== next.actions || prev.showDisabled !== next.showDisabled) this.render(next);
      else this.select(next);
    }

    destroy() {
      this.remove();
    }

    private remove() {
      this.stop?.();
      this.stop = null;
      this.dom?.remove();
      this.dom = null;
      this.rowEls = [];
    }

    private render(menu: Menu) {
      this.remove();
      const view = this.view;
      const rows = rowsOf(menu);
      const root = document.createElement("div");
      root.className = "cm-quickfix";
      root.setAttribute("aria-label", "Action Widget");
      const list = document.createElement("div");
      list.className = "cm-quickfix-list";
      list.setAttribute("role", "listbox");
      root.append(list);
      this.rowEls = [];
      rows.forEach((row, index) => {
        if (row.type === "header") {
          const header = document.createElement("div");
          header.className = "cm-quickfix-header";
          header.setAttribute("role", "presentation");
          header.textContent = row.title;
          list.append(header);
          return;
        }
        const item = actionRow(row);
        item.addEventListener("mousemove", () => {
          if (!row.disabled && view.state.field(menuField, false)?.index !== index) view.dispatch({ effects: focusRow.of(index) });
        });
        item.addEventListener("click", () => {
          if (!row.disabled) void apply(view, row.action, false);
        });
        this.rowEls[index] = item;
        list.append(item);
      });
      if (menu.offerDisabled) {
        const bar = document.createElement("div");
        bar.className = "cm-quickfix-bar";
        const label = document.createElement("button");
        label.type = "button";
        label.className = "cm-quickfix-bar-label";
        label.textContent = menu.showDisabled ? MENU_TEXT.hideDisabled : MENU_TEXT.showDisabled;
        label.addEventListener("click", () => view.dispatch({ effects: toggleDisabled.of(null) }));
        bar.append(label);
        root.append(bar);
      }
      root.addEventListener("mousedown", (event) => event.preventDefault());
      root.style.visibility = "hidden";
      document.body.append(root);
      this.dom = root;
      this.select(menu);
      this.place(menu.anchor);
      root.style.visibility = "";

      const onDown = (event: MouseEvent) => {
        if (!(event.target as HTMLElement).closest?.(".cm-quickfix")) close(view);
      };
      const onDismiss = () => void close(view);
      document.addEventListener("mousedown", onDown, true);
      view.scrollDOM.addEventListener("scroll", onDismiss);
      view.contentDOM.addEventListener("blur", onDismiss);
      window.addEventListener("resize", onDismiss);
      this.stop = () => {
        document.removeEventListener("mousedown", onDown, true);
        view.scrollDOM.removeEventListener("scroll", onDismiss);
        view.contentDOM.removeEventListener("blur", onDismiss);
        window.removeEventListener("resize", onDismiss);
      };
    }

    private select(menu: Menu) {
      this.rowEls.forEach((el, index) => {
        if (!el) return;
        const selected = index === menu.index;
        el.setAttribute("aria-selected", String(selected));
        if (selected) el.scrollIntoView({ block: "nearest" });
      });
    }

    private place(anchor: MenuAnchor) {
      const root = this.dom;
      if (!root) return;
      const box = root.getBoundingClientRect();
      const placement = placeMenu(anchor, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight });
      root.style.left = `${placement.left}px`;
      root.style.top = `${placement.top}px`;
      root.style.maxHeight = `${placement.maxHeight}px`;
      root.dataset.side = placement.above ? "above" : "below";
    }
  },
);

function actionRow(row: Extract<MenuRow, { type: "action" }>) {
  const item = document.createElement("div");
  item.className = "cm-quickfix-item";
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", "false");
  if (row.disabled) item.dataset.disabled = "";
  const icon = document.createElement("span");
  icon.className = `codicon codicon-${row.group.icon === "wrench" ? "wrench" : "light-bulb"} cm-quickfix-icon`;
  if (row.group.icon === "lightbulb") icon.dataset.bulb = "";
  const title = document.createElement("span");
  title.className = "cm-quickfix-title";
  title.textContent = row.label;
  item.append(icon, title);
  if (row.hint) {
    const hintEl = document.createElement("span");
    hintEl.className = "cm-quickfix-hint";
    hintEl.textContent = row.hint;
    item.append(hintEl);
  }
  item.title = row.disabled ? row.label : row.canPreview ? MENU_TEXT.applyPreview(MAC_KEYS.accept, MAC_KEYS.preview) : MENU_TEXT.apply(MAC_KEYS.accept);
  return item;
}

async function apply(view: EditorView, action: CodeAction, preview = false) {
  view.dispatch({ effects: setMenu.of(null) });
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  try {
    await plugin.client.withMapping(async (mapping) => {
      let resolved = action;
      if (!resolved.edit) resolved = await plugin.client.request<object, CodeAction>("codeAction/resolve", action);
      if (!resolved.edit) {
        flash(S.quickFixUnsupported(action.title));
        return;
      }
      let edit: WorkspaceEdit | null = resolved.edit;
      if (preview) {
        edit = await previewWorkspaceEdit(view, plugin, resolved.edit, action.title);
        if (!edit) {
          view.focus();
          return;
        }
      }
      await applyWorkspaceEdit(view, plugin, edit, mapping);
      view.focus();
    });
  } catch (error) {
    flash(S.quickFixFailed((error as Error).message), "error");
  }
}

function offsetIn(mapping: WorkspaceMapping | undefined, uri: string, plugin: LSPPlugin, pos: TextEdit["range"]["start"]) {
  return mapping?.getMapping(uri) ? mapping.mapPosition(uri, pos) : plugin.fromPosition(pos);
}

export async function applyWorkspaceEdit(view: EditorView, plugin: LSPPlugin, edit: WorkspaceEdit, mapping?: WorkspaceMapping) {
  const { perUri, fileOps } = collectEdits(edit);
  if (fileOps) throw new Error(S.quickFixFileOps);
  for (const [uri, edits] of perUri) {
    if (uri === plugin.uri) {
      view.dispatch({ changes: edits.map((e) => ({ from: offsetIn(mapping, uri, plugin, e.range.start), to: offsetIn(mapping, uri, plugin, e.range.end), insert: e.newText })), userEvent: "input.quickfix" });
      continue;
    }
    await editOtherFile(uri, edits, mapping);
  }
}

async function editOtherFile(uri: string, edits: TextEdit[], mapping?: WorkspaceMapping) {
  const workspaceId = getState().activeWorkspaceId ?? "";
  const target = toTarget(uriToPath(uri), workspaceId);
  const open = viewFor(fileTabKey(target.workspaceId, target.path));
  const openPlugin = open ? LSPPlugin.get(open) : null;
  if (open && openPlugin) {
    open.dispatch({ changes: edits.map((e) => ({ from: offsetIn(mapping, uri, openPlugin, e.range.start), to: offsetIn(mapping, uri, openPlugin, e.range.end), insert: e.newText })) });
    return;
  }
  const { text, mtimeMs } = await rpc.call("files.read", { workspaceId: target.workspaceId, path: target.path });
  if (text === null) throw new Error(S.fileNotFound);
  const result = await rpc.call("files.save", { workspaceId: target.workspaceId, path: target.path, text: applyTextEdits(text, edits), baseMtimeMs: mtimeMs ?? null });
  if (!result.saved) throw new Error(S.quickFixConflict);
}

export function applyTextEdits(text: string, edits: TextEdit[]) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const offsetOf = (p: { line: number; character: number }) => Math.min((lineStarts[p.line] ?? text.length) + p.character, text.length);
  const spans = edits.map((e) => ({ from: offsetOf(e.range.start), to: offsetOf(e.range.end), insert: e.newText })).sort((a, b) => b.from - a.from);
  let out = text;
  for (const span of spans) out = out.slice(0, span.from) + span.insert + out.slice(span.to);
  return out;
}

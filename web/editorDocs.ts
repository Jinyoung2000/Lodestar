import { isolateHistory } from "@codemirror/commands";
import { Prec, type Extension, type StateCommand, type Text } from "@codemirror/state";
import { redo, undo } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import type { FormatResult, FormatterId } from "../shared/protocol";
import { confirmAction, confirmDialog, promptText } from "./ConfirmDialog";
import { currentEditorOptions } from "./editorOptions";
import { copyName } from "./fileKind";
import { FV } from "./fileViewStrings";
import { absolutePath, lspFormat, notifySaved } from "./lsp";
import { notify } from "./notices";
import { rpc } from "./rpc";
import { hasSaveTransforms, saveTransformChanges, type SaveTransformPhase } from "./saveTransforms";
import { activeKeyOfGroup, closeTab, fileTabKey, flash, getState, openFile, pinEditorTab, refreshGit, replaceTab, setDirty, setState } from "./store";
import { S } from "./strings";
import { groupOf } from "./editorGroups";
import { baseKeyOf, sameContent } from "./editorTabs";
import { forwardUpdate, mirrored, noHistory, ownerOnlyHistory, runOwnerHistory, shouldForward, skipMirror, type MirrorHost, type MirrorTarget } from "./viewMirror";
import { foreignFolder } from "./tabFolder";
import { WORKSPACE_CHANGED_EVENT } from "./workspaceEvents";
import { clearHotExit, noteHotChanged, planHotRestore, registerHotReader, saveHotExitNow, type HotDoc } from "./windowState";
import { hint } from "./hint";
import { announce } from "./announce";

export type DocConflict = { diskText: string; mtimeMs: number | null; reason: "external" | "save"; comparing: boolean };

type DocEntry = {
  key: string;
  workspaceId: string;
  path: string | null;
  view: EditorView;
  savedDoc: Text;
  savedBreak: string;
  baseMtimeMs: number | null;
  checking: boolean;
  recheck: boolean;
};

const docs = new Map<string, DocEntry>();
const conflicts = new Map<string, DocConflict>();
const conflictListeners = new Set<() => void>();

const hotOff = new Map<string, () => void>();

export function attachDoc(entry: Omit<DocEntry, "checking" | "recheck" | "savedBreak">) {
  const doc: DocEntry = { ...entry, savedBreak: entry.view.state.lineBreak, checking: false, recheck: false };
  docs.set(entry.key, doc);
  adoptSibling(doc);
  hotOff.get(entry.key)?.();
  hotOff.set(
    entry.key,
    registerHotReader(entry.key, () => hotDocOf(entry.key)),
  );
  syncDirty(entry.key);
}


const siblingsOf = (doc: DocEntry) => [...docs.values()].filter((d) => d !== doc && d.path !== null && d.path === doc.path && d.workspaceId === doc.workspaceId);

function historyOwner(key: string): DocEntry | null {
  const self = docs.get(key);
  const same = [...docs.values()].filter((d) => d.path !== null && (self ? d.path === self.path && d.workspaceId === self.workspaceId : baseKeyOf(d.key) === baseKeyOf(key)));
  return same[0] ?? null;
}

const isHistoryOwner = (key: string) => {
  const owner = historyOwner(key);
  return !owner || owner.key === key;
};

function routeHistory(key: string, view: EditorView, command: StateCommand) {
  const owner = historyOwner(key);
  if (!owner || owner.key === key) return false;
  runOwnerHistory(command, ownerHost(owner.view), view);
  return true;
}

function ownerHost(view: EditorView): MirrorHost {
  return {
    get state() {
      return view.state;
    },
    dispatch: (...specs) => view.dispatch(...specs),
    scrollSnapshot: () => (view.dom.offsetParent === null ? undefined : view.scrollSnapshot()),
  };
}

export function docMirror(key: string): Extension {
  return [
    ownerOnlyHistory(() => isHistoryOwner(key)),
    Prec.highest([
      keymap.of([
        { key: "Mod-z", run: (view) => routeHistory(key, view, undo), preventDefault: true },
        { key: "Mod-y", mac: "Mod-Shift-z", run: (view) => routeHistory(key, view, redo), preventDefault: true },
        { linux: "Ctrl-Shift-z", run: (view) => routeHistory(key, view, redo), preventDefault: true },
      ]),
      EditorView.domEventHandlers({
        beforeinput(event, view) {
          const command = event.inputType === "historyUndo" ? undo : event.inputType === "historyRedo" ? redo : null;
          if (!command || !routeHistory(key, view, command)) return false;
          event.preventDefault();
          return true;
        },
      }),
    ]),
    EditorView.updateListener.of((update) => {
      if (!shouldForward(update)) return;
      const self = docs.get(key);
      if (!self) return;
      const owner = historyOwner(key);
      forwardUpdate(update, [...siblingsOf(self).map((other) => ({ host: other.view, keepsHistory: other === owner })), ...mirrorTargets(self.workspaceId, self.path, update.view)]);
    }),
  ];
}

type MirrorView = { workspaceId: string; path: string; view: EditorView };
const mirrorViews = new Set<MirrorView>();

const sameFile = (aWorkspace: string, aPath: string, bWorkspace: string, bPath: string) => aWorkspace === bWorkspace && absolutePath(aWorkspace, aPath) === absolutePath(bWorkspace, bPath);

function mirrorTargets(workspaceId: string, path: string | null, except: EditorView): MirrorTarget[] {
  if (path === null) return [];
  return [...mirrorViews].filter((m) => m.view !== except && sameFile(m.workspaceId, m.path, workspaceId, path)).map((m) => ({ host: m.view, keepsHistory: false }));
}

export function unsavedTextOf(workspaceId: string, path: string): string | null {
  for (const doc of docs.values()) {
    if (doc.path !== null && isDirty(doc) && sameFile(doc.workspaceId, doc.path, workspaceId, path)) return doc.view.state.doc.toString();
  }
  return null;
}

export function attachMirrorView(workspaceId: string, path: string, view: EditorView): () => void {
  const entry: MirrorView = { workspaceId, path, view };
  mirrorViews.add(entry);
  return () => void mirrorViews.delete(entry);
}

export function mirrorOnly(workspaceId: string, path: string): Extension {
  return EditorView.updateListener.of((update) => {
    if (!shouldForward(update)) return;
    const owner = historyOwnerOf(workspaceId, path);
    const docTargets = [...docs.values()].filter((d) => d.path !== null && sameFile(d.workspaceId, d.path, workspaceId, path)).map((d) => ({ host: d.view, keepsHistory: d === owner }));
    forwardUpdate(update, [...docTargets, ...mirrorTargets(workspaceId, path, update.view)]);
  });
}

function historyOwnerOf(workspaceId: string, path: string): DocEntry | null {
  return [...docs.values()].find((d) => d.path !== null && sameFile(d.workspaceId, d.path, workspaceId, path)) ?? null;
}

function adoptSibling(doc: DocEntry) {
  const sibling = siblingsOf(doc)[0];
  if (!sibling) return;
  if (!doc.view.state.doc.eq(sibling.view.state.doc)) doc.view.dispatch({ changes: { from: 0, to: doc.view.state.doc.length, insert: sibling.view.state.doc }, annotations: [mirrored.of(true), noHistory] });
  doc.savedDoc = sibling.savedDoc;
  doc.savedBreak = sibling.savedBreak;
  doc.baseMtimeMs = sibling.baseMtimeMs;
}

function hasOtherView(key: string, closing: readonly string[]) {
  const tabs = getState().tabs;
  const tab = tabs.find((t) => t.key === key);
  return !!tab && tabs.some((t) => t.key !== key && !closing.includes(t.key) && sameContent(t, tab));
}

export function detachDoc(key: string, view: EditorView) {
  if (docs.get(key)?.view !== view) return;
  hotOff.get(key)?.();
  hotOff.delete(key);
  docs.delete(key);
  setConflict(key, null);
  setFlags(key, null);
}

export type DocFlags = { deleted?: boolean; readOnly?: boolean };
const flags = new Map<string, DocFlags>();
const NO_FLAGS: DocFlags = {};

function setFlags(key: string, patch: DocFlags | null) {
  const next = patch === null ? NO_FLAGS : { ...(flags.get(key) ?? NO_FLAGS), ...patch };
  const before = flags.get(key) ?? NO_FLAGS;
  if (!!before.deleted === !!next.deleted && !!before.readOnly === !!next.readOnly) return;
  if (next.deleted || next.readOnly) flags.set(key, next);
  else flags.delete(key);
  for (const listener of conflictListeners) listener();
}

export function setDocReadOnly(key: string, readOnly: boolean) {
  setFlags(key, { readOnly });
}

export function useDocFlags(key: string): DocFlags {
  return useSyncExternalStore(
    (listener) => {
      conflictListeners.add(listener);
      return () => conflictListeners.delete(listener);
    },
    () => flags.get(key) ?? NO_FLAGS,
  );
}

export function docView(key: string) {
  return docs.get(key)?.view ?? null;
}

export function viewsOfSameFile(view: EditorView): EditorView[] {
  const self = [...docs.values()].find((d) => d.view === view);
  return self ? [self.view, ...siblingsOf(self).map((d) => d.view)] : [view];
}

export function refocusActiveEditor() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = getState().activeTabKey;
      if (active) docView(active)?.focus();
    }),
  );
}

export function syncDirty(key: string) {
  const doc = docs.get(key);
  if (!doc) return;
  setDirty(key, isDirty(doc));
  noteHotChanged();
}

const isDirty = (doc: DocEntry) => (doc.path === null ? doc.view.state.doc.length > 0 : !doc.savedDoc.eq(doc.view.state.doc) || doc.savedBreak !== doc.view.state.lineBreak);

function hotDocOf(key: string): HotDoc | null {
  const doc = docs.get(key);
  return doc && isDirty(doc) ? { text: textOf(doc.view), baseMtimeMs: doc.baseMtimeMs } : null;
}

export function restoreHotDoc(key: string, hot: HotDoc) {
  const doc = docs.get(key);
  if (!doc) return;
  const diskText = textOf(doc.view);
  const { externalChange } = planHotRestore(doc.baseMtimeMs, hot);
  const next = doc.view.state.toText(hot.text.replace(/\r?\n/g, doc.view.state.lineBreak));
  doc.view.dispatch({ changes: { from: 0, to: doc.view.state.doc.length, insert: next }, annotations: [noHistory, skipMirror.of(true)] });
  syncDirty(key);
  if (externalChange) setConflict(key, { diskText, mtimeMs: doc.baseMtimeMs, reason: "external", comparing: false });
}

function setConflict(key: string, conflict: DocConflict | null) {
  if (conflict) conflicts.set(key, conflict);
  else if (!conflicts.delete(key)) return;
  for (const listener of conflictListeners) listener();
}

export function useDocConflict(key: string) {
  return useSyncExternalStore(
    (listener) => {
      conflictListeners.add(listener);
      return () => conflictListeners.delete(listener);
    },
    () => conflicts.get(key) ?? null,
  );
}

export function toggleCompare(key: string) {
  const conflict = conflicts.get(key);
  if (conflict) setConflict(key, { ...conflict, comparing: !conflict.comparing });
}

const nameOf = (key: string) => {
  const tab = getState().tabs.find((t) => t.key === key);
  return !tab ? key : tab.kind === "untitled" ? S.untitledName(tab.n) : "path" in tab ? tab.path.slice(tab.path.lastIndexOf("/") + 1) : key;
};

function textOf(view: EditorView) {
  return view.state.sliceDoc(0, view.state.doc.length);
}

const savesInFlight = new Map<string, Promise<boolean>>();

export function saveTab(key: string, options: { force?: boolean } = {}): Promise<boolean> {
  const before = savesInFlight.get(key);
  const run = before ? before.catch(() => false).then(() => saveTabNow(key, options)) : saveTabNow(key, options);
  savesInFlight.set(key, run);
  const done = () => {
    if (savesInFlight.get(key) === run) savesInFlight.delete(key);
  };
  run.then(done, done);
  return run;
}

async function saveTabNow(key: string, options: { force?: boolean }): Promise<boolean> {
  const doc = docs.get(key);
  const tab = getState().tabs.find((t) => t.key === key);
  if (!doc || !tab) return false;
  if (tab.kind === "untitled") return saveUntitled(doc, tab.n);
  if (doc.path === null) return false;
  const path = doc.path;
  if (!(await confirmForeignSave(key, doc.workspaceId, path))) return false;
  if (await formatOnSaveEnabled(doc.workspaceId)) {
    applySaveTransforms(doc.view, "beforeFormat");
    await formatDoc(key, false, true);
    applySaveTransforms(doc.view, "afterFormat");
  } else {
    applySaveTransforms(doc.view, "all");
  }
  const snapshot = doc.view.state.doc;
  const savedBreak = doc.view.state.lineBreak;
  const text = textOf(doc.view);
  try {
    const result = await rpc.call("files.save", { workspaceId: doc.workspaceId, path, text, baseMtimeMs: doc.baseMtimeMs, force: options.force });
    if (!result.saved && result.conflict === "readonly") {
      reportReadOnly(key);
      return false;
    }
    if (!result.saved) {
      const disk = await rpc.call("files.read", { workspaceId: doc.workspaceId, path });
      setConflict(key, { diskText: disk.text ?? "", mtimeMs: result.mtimeMs, reason: "save", comparing: false });
      if (!isTabShown(key)) flash(S.saveFailedNewer(nameOf(key)), "error");
      return false;
    }
    doc.baseMtimeMs = result.mtimeMs;
    doc.savedDoc = snapshot;
    doc.savedBreak = savedBreak;
    for (const other of siblingsOf(doc)) {
      if (!other.view.state.doc.eq(snapshot)) continue;
      other.savedDoc = snapshot;
      other.savedBreak = savedBreak;
      other.baseMtimeMs = result.mtimeMs;
      setConflict(other.key, null);
      syncDirty(other.key);
    }
    pinEditorTab(key);
    setConflict(key, null);
    if (flags.get(key)?.deleted) void refreshFileList(doc.workspaceId);
    setFlags(key, { deleted: false, readOnly: false });
    syncDirty(key);
    notifySaved(doc.workspaceId, path, text);
    refreshAgentsOf(doc.workspaceId);
    return true;
  } catch (error) {
    flash(S.saveFailed(nameOf(key), (error as Error).message), "error");
    return false;
  }
}

function applySaveTransforms(view: EditorView, phase: SaveTransformPhase) {
  const options = currentEditorOptions();
  if (view.state.readOnly || !hasSaveTransforms(options, phase)) return;
  const changes = saveTransformChanges(view.state.doc, options, phase);
  if (changes.empty) return;
  view.dispatch({ changes, annotations: isolateHistory.of("full"), userEvent: "save.transform" });
}

function isTabShown(key: string) {
  const s = getState();
  const tab = s.tabs.find((t) => t.key === key);
  if (!tab || !(s.layoutMode === "editor" || s.rightOpen)) return false;
  return activeKeyOfGroup(s, groupOf(tab)) === key;
}

function reportReadOnly(key: string) {
  setFlags(key, { readOnly: true });
  if (isTabShown(key)) return;
  notify({ message: FV.readOnlyMessage, severity: "error", key: `readonly:${key}`, actions: [{ label: FV.saveAs, run: () => void saveAsTab(key), primary: true }] });
}

export async function saveAsTab(key: string): Promise<boolean> {
  const doc = docs.get(key);
  if (!doc) return false;
  const path = await promptText(
    FV.saveAsTitle,
    FV.saveAsConfirm,
    { initial: doc.path ? copyName(doc.path) : "", placeholder: S.saveAsPlaceholder, label: FV.saveAsTitle, validate: (value) => validateNewPath(doc.workspaceId, value) },
    S.saveAsDetail,
  );
  if (path === null) return false;
  const clean = path.trim().replace(/^\.\//, "");
  applySaveTransforms(doc.view, "all");
  try {
    await rpc.call("files.create", { workspaceId: doc.workspaceId, path: clean, kind: "file", text: textOf(doc.view) });
  } catch (error) {
    flash(S.saveFailed(clean, (error as Error).message), "error");
    return false;
  }
  await refreshFileList(doc.workspaceId);
  replaceTab(key, { key: fileTabKey(doc.workspaceId, clean), kind: "file", workspaceId: doc.workspaceId, path: clean });
  refreshAgentsOf(doc.workspaceId);
  return true;
}

const confirmedForeign = new Set<string>();

async function confirmForeignSave(key: string, workspaceId: string, path: string) {
  const state = getState();
  const pane = state.panes.find((p) => p.id === state.activePaneId);
  const agent = pane?.kind === "agent" ? state.agents.find((a) => a.id === pane.agentId) : undefined;
  const found = foreignFolder(state.workspaces.find((w) => w.id === workspaceId)?.dir, path, agent, agent ? state.gitInfo[agent.id]?.repoRoot : null);
  if (!found) return true;
  const id = `${key}|${found.session}`;
  if (confirmedForeign.has(id)) return true;
  if (!(await confirmAction(S.saveOutsideSessionConfirm(found.file, found.session), S.save))) return false;
  confirmedForeign.add(id);
  return true;
}

async function saveUntitled(doc: DocEntry, n: number): Promise<boolean> {
  const path = await promptText(
    S.saveAsTitle,
    S.saveAsConfirm,
    { initial: "", placeholder: S.saveAsPlaceholder, label: S.saveAsTitle, validate: (value) => validateNewPath(doc.workspaceId, value) },
    S.saveAsDetail,
  );
  if (path === null) return false;
  const clean = path.trim().replace(/^\.\//, "");
  applySaveTransforms(doc.view, "all");
  try {
    await rpc.call("files.create", { workspaceId: doc.workspaceId, path: clean, kind: "file", text: textOf(doc.view) });
  } catch (error) {
    flash(S.saveFailed(S.untitledName(n), (error as Error).message), "error");
    return false;
  }
  await refreshFileList(doc.workspaceId);
  replaceTab(doc.key, { key: fileTabKey(doc.workspaceId, clean), kind: "file", workspaceId: doc.workspaceId, path: clean });
  refreshAgentsOf(doc.workspaceId);
  return true;
}

export async function validateNewPath(workspaceId: string, value: string): Promise<string | null> {
  const name = value.trim();
  if (!name) return S.newEntryEmpty;
  if (name.startsWith("/") || name.split("/").some((part) => part === "..")) return S.newEntryInvalid;
  const exists = await rpc.call("files.stat", { workspaceId, path: name }).then((r) => r.mtimeMs !== null).catch(() => false);
  return exists ? S.newEntryExists(name) : null;
}

export async function refreshFileList(workspaceId: string) {
  const [files, dirs] = await Promise.all([rpc.call("files.list", { workspaceId }), rpc.call("files.dirs", { workspaceId }).catch(() => [] as string[])]);
  setState((s) => ({ files: { ...s.files, [workspaceId]: files }, emptyDirs: { ...s.emptyDirs, [workspaceId]: dirs } }));
}

function refreshAgentsOf(workspaceId: string) {
  for (const agent of getState().agents) if (agent.workspaceId === workspaceId) void refreshGit(agent.id);
}

export async function resolveConflict(key: string) {
  if (!docs.get(key) || !conflicts.get(key)) return;
  await saveTab(key, { force: true });
}

function replaceWholeDoc(doc: DocEntry, text: string, mtimeMs: number | null) {
  const next = doc.view.state.toText(text.replace(/\r?\n/g, doc.view.state.lineBreak));
  doc.savedDoc = next;
  doc.savedBreak = doc.view.state.lineBreak;
  doc.baseMtimeMs = mtimeMs;
  doc.view.dispatch({ changes: { from: 0, to: doc.view.state.doc.length, insert: next }, annotations: [noHistory, skipMirror.of(true)] });
  syncDirty(doc.key);
}


export async function checkDisk(key: string) {
  const doc = docs.get(key);
  if (!doc || doc.path === null) return;
  if (doc.checking) {
    doc.recheck = true;
    return;
  }
  doc.checking = true;
  try {
    const { mtimeMs } = await rpc.call("files.stat", { workspaceId: doc.workspaceId, path: doc.path });
    if (docs.get(key) !== doc) return;
    setFlags(key, { deleted: mtimeMs === null });
    if (mtimeMs === null || mtimeMs === doc.baseMtimeMs) return;
    const disk = await rpc.call("files.read", { workspaceId: doc.workspaceId, path: doc.path });
    if (disk.text === null || disk.binary || docs.get(key) !== doc) return;
    const diskDoc = doc.view.state.toText(disk.text.replace(/\r?\n/g, doc.view.state.lineBreak));
    if (diskDoc.eq(doc.savedDoc)) {
      doc.baseMtimeMs = disk.mtimeMs ?? mtimeMs;
      return;
    }
    if (doc.savedDoc.eq(doc.view.state.doc)) {
      const stale = siblingsOf(doc).filter((other) => other.savedDoc.eq(doc.savedDoc) && other.savedDoc.eq(other.view.state.doc));
      for (const target of [doc, ...stale]) replaceWholeDoc(target, disk.text, disk.mtimeMs ?? mtimeMs);
      return;
    }
    if (doc.view.state.doc.eq(diskDoc)) {
      doc.savedDoc = diskDoc;
      doc.savedBreak = doc.view.state.lineBreak;
      doc.baseMtimeMs = disk.mtimeMs ?? mtimeMs;
      syncDirty(key);
      return;
    }
    const known = conflicts.get(key);
    if (known?.mtimeMs !== mtimeMs) setConflict(key, { diskText: disk.text, mtimeMs, reason: "external", comparing: known?.comparing ?? false });
  } catch {
  } finally {
    doc.checking = false;
    if (doc.recheck) {
      doc.recheck = false;
      void checkDisk(key);
    }
  }
}

export function checkAllDisks() {
  for (const key of docs.keys()) void checkDisk(key);
}

let started = false;
let keepUnsavedOnUnload = true;
export const setKeepUnsavedOnUnload = (keep: boolean) => {
  keepUnsavedOnUnload = keep;
};
export function initEditorDocs() {
  if (started) return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  rpc.onEvent((event) => {
    if (event.type !== "timelineUpsert" || event.item.kind !== "tool" || event.item.status !== "done") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(checkAllDisks, 300);
  });
  window.addEventListener("focus", checkAllDisks);
  window.addEventListener(WORKSPACE_CHANGED_EVENT, (event) => {
    const ids = (event as CustomEvent<{ workspaceIds: string[] }>).detail.workspaceIds;
    for (const [key, doc] of docs) if (ids.includes(doc.workspaceId)) void checkDisk(key);
  });
  const keepOrDiscard = () => (keepUnsavedOnUnload ? saveHotExitNow() : clearHotExit());
  window.addEventListener("beforeunload", keepOrDiscard);
  window.addEventListener("pagehide", keepOrDiscard);
}

export async function requestCloseTabs(keys: string[]): Promise<boolean> {
  const dirty = keys.filter((key) => getState().dirtyTabs[key] && !hasOtherView(key, keys));
  if (dirty.length) {
    const names = dirty.map(nameOf);
    const choice = await confirmDialog({
      title: dirty.length === 1 ? S.saveChangesTitle(names[0]) : S.saveChangesTitleMany(dirty.length),
      detail: dirty.length === 1 ? S.saveChangesDetail : `${names.join("\n")}\n\n${S.saveChangesDetail}`,
      buttons: [S.dontSave, S.cancel, S.save],
      severity: "warning",
    });
    if (choice === null || choice === 1) return false;
    if (choice === 2) for (const key of dirty) if (!(await saveTab(key))) return false;
  }
  for (const key of keys) closeTab(key);
  return true;
}

export function requestCloseTab(key: string) {
  return requestCloseTabs([key]);
}

async function formatOnSaveEnabled(workspaceId: string) {
  try {
    return (await rpc.call("format.config", { workspaceId })).formatOnSave;
  } catch {
    return false;
  }
}

const FORMATTER_NAME: Record<FormatterId, string> = { eslint: "ESLint", prettier: "Prettier", oxc: "oxfmt", tsserver: "TypeScript" };

export function formatActive(selection: boolean) {
  const s = getState();
  const tab = s.tabs.find((t) => t.key === s.activeTabKey);
  if (!tab || tab.kind !== "file") {
    hint(S.formatNeedsEditor);
    return Promise.resolve(false);
  }
  return formatDoc(tab.key, selection, false);
}

export async function formatDoc(key: string, selection: boolean, silent: boolean, formatter?: FormatterId, options: { range?: { from: number; to: number }; quiet?: boolean } = {}): Promise<boolean> {
  const doc = docs.get(key);
  if (!doc || doc.path === null) return false;
  const { view, path } = doc;
  const before = view.state.doc;
  const text = textOf(view);
  let range: { from: number; to: number } | undefined;
  if (selection && options.range) {
    range = options.range;
  } else if (selection) {
    const main = view.state.selection.main;
    const line = view.state.doc.lineAt(main.head);
    range = main.empty ? { from: line.from, to: line.to } : { from: main.from, to: main.to };
  }
  let result;
  try {
    result = await rpc.call("format.run", { workspaceId: doc.workspaceId, path, text, range, formatter });
  } catch (error) {
    if (!options.quiet) flash(S.formatFailed((error as Error).message), "error");
    return false;
  }
  if (result.problem) {
    if (!options.quiet) reportFormatProblem(key, result, selection, silent);
    return false;
  }
  let formatted = result.text;
  if (formatted === null && result.formatter === "tsserver") {
    try {
      formatted = await lspFormat(view, range);
    } catch (error) {
      if (!options.quiet) flash(S.formatFailed((error as Error).message), "error");
      return false;
    }
  }
  if (formatted === null) return false;
  if (view.state.doc !== before) {
    if (!options.quiet) flash(S.formatDocChanged);
    return false;
  }
  const changed = applyMinimalText(view, formatted);
  const label = FORMATTER_NAME[result.formatter ?? "tsserver"];
  if (!silent && changed) announce(S.formattedWith(label));
  else if (!silent) hint(S.formatUnchanged(label), view);
  return changed;
}

export function formatPastedRange(view: EditorView, range: { from: number; to: number }) {
  const doc = [...docs.values()].find((entry) => entry.view === view);
  if (!doc || doc.path === null || !currentEditorOptions().formatOnPaste) return;
  void formatDoc(doc.key, true, true, undefined, { range: { from: Math.min(range.from, view.state.doc.length), to: Math.min(range.to, view.state.doc.length) }, quiet: true });
}

function reportFormatProblem(key: string, result: FormatResult, selection: boolean, silent: boolean) {
  const { problem, language } = result;
  if (!problem) return;
  if (problem.kind === "none") {
    if (!silent) hint(S.noFormatter(language), docs.get(key)?.view);
    return;
  }
  const message =
    problem.kind === "cannotFormat"
      ? S.formatCannot(problem.extension, language)
      : problem.kind === "selectionUnsupported"
        ? S.formatWholeOnly(problem.extension, language)
        : problem.kind === "unavailable"
          ? S.formatUnavailable(problem.extensionId)
          : problem.kind === "unsupported"
            ? S.formatUnsupported(problem.extension)
            : S.formatAmbiguous(language);
  const actions = [
    { label: S.formatConfigure, run: () => setState({ overlay: { kind: "status", section: "format" } }), primary: true },
    ...(result.alternatives ?? []).map((choice) => ({ label: S.formatWith(choice.label), run: () => void formatDoc(key, selection, false, choice.formatter) })),
  ];
  notify({
    message,
    severity: "warning",
    detail: problem.kind === "cannotFormat" && problem.detail ? problem.detail : undefined,
    actions,
    key: `format:${language}:${problem.kind}`,
    ...(silent ? { autoHideMs: SAVE_NOTICE_MS } : {}),
  });
}

const SAVE_NOTICE_MS = 15_000;

export function applyMinimalText(view: EditorView, newText: string): boolean {
  const lineBreak = view.state.lineBreak;
  const next = newText.replace(/\r?\n/g, lineBreak);
  const current = textOf(view);
  if (next === current) return false;
  let start = 0;
  const max = Math.min(current.length, next.length);
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endCurrent = current.length;
  let endNext = next.length;
  while (endCurrent > start && endNext > start && current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)) {
    endCurrent--;
    endNext--;
  }
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
  if (endCurrent < current.length && isLowSurrogate(current.charCodeAt(endCurrent))) {
    endCurrent++;
    endNext++;
  }
  view.dispatch({ changes: { from: start, to: endCurrent, insert: next.slice(start, endNext) }, userEvent: "input.format" });
  return true;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export async function newFileByPath(workspaceId: string, initial = "") {
  const path = await promptText(
    S.newFileTitle,
    S.newFileConfirm,
    { initial, placeholder: S.saveAsPlaceholder, label: S.newFileTitle, validate: (value) => validateNewPath(workspaceId, value) },
    S.newFileDetail,
  );
  if (path === null) return;
  await createEntry(workspaceId, path.trim().replace(/^\.\//, ""), "file");
}

export async function createEntry(workspaceId: string, path: string, kind: "file" | "folder"): Promise<boolean> {
  try {
    await rpc.call("files.create", { workspaceId, path, kind });
  } catch (error) {
    flash(S.newEntryFailed((error as Error).message), "error");
    return false;
  }
  await refreshFileList(workspaceId);
  if (kind === "file") {
    openFile({ workspaceId, path });
  }
  refreshAgentsOf(workspaceId);
  return true;
}

import { LSPPlugin } from "@codemirror/lsp-client";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorTheme } from "./Editor";
import { attachMirrorView, mirrorOnly } from "./editorDocs";
import { lspDocument } from "./editorLsp";
import { absolutePath, fileUri, languageIdFor, lspClient } from "./lsp";
import type { NavWorkspace } from "./lspWorkspace";

export type PrDocMode = "checked-out" | "commit";

export type PrDoc = {
  workspaceId: string;
  path: string;
  uri: string;
  mode: PrDocMode;
  view: EditorView;
  plugin: LSPPlugin;
  evicted: boolean;
  onEvicted: Set<() => void>;
};

type Entry = { doc: PrDoc; refs: number; detach: () => void };
const docs = new Map<string, Entry>();
const keyOf = (workspaceId: string, path: string) => `${workspaceId}\0${path}`;

export type AcquireResult = { doc: PrDoc } | { doc: null; reason: "language" | "occupied" };

export function acquirePrDoc(input: { workspaceId: string; path: string; mode: PrDocMode; text: string }): AcquireResult & { release: () => void } {
  const { workspaceId, path, mode, text } = input;
  const key = keyOf(workspaceId, path);
  const existing = docs.get(key);
  if (existing) {
    existing.refs++;
    return { doc: existing.doc, release: once(() => releaseEntry(key)) };
  }
  const languageId = languageIdFor(path);
  if (!languageId) return { doc: null, reason: "language", release: () => undefined };
  const absolute = absolutePath(workspaceId, path);
  const uri = fileUri(absolute);
  const workspace = lspClient(workspaceId).workspace as NavWorkspace;
  if (mode === "commit" && workspace.getFile(uri)) return { doc: null, reason: "occupied", release: () => undefined };
  const view = new EditorView({
    state: EditorState.create({ doc: text, extensions: [EditorState.readOnly.of(true), editorTheme, lspDocument(workspaceId, absolute, languageId), ...(mode === "checked-out" ? [mirrorOnly(workspaceId, path)] : [])] }),
  });
  const plugin = LSPPlugin.get(view);
  if (!plugin) {
    view.destroy();
    return { doc: null, reason: "language", release: () => undefined };
  }
  const doc: PrDoc = { workspaceId, path, uri, mode, view, plugin, evicted: false, onEvicted: new Set() };
  if (mode === "commit") {
    workspace.markVirtual(uri, () => {
      doc.evicted = true;
      for (const listener of [...doc.onEvicted]) listener();
    });
  }
  const detach = mode === "checked-out" ? attachMirrorView(workspaceId, path, view) : () => undefined;
  docs.set(key, { doc, refs: 1, detach });
  return { doc, release: once(() => releaseEntry(key)) };
}

function releaseEntry(key: string) {
  const entry = docs.get(key);
  if (!entry || --entry.refs > 0) return;
  docs.delete(key);
  entry.detach();
  entry.doc.view.destroy();
}

function once(fn: () => void) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

export const openPrDoc = (workspaceId: string, path: string): PrDoc | null => docs.get(keyOf(workspaceId, path))?.doc ?? null;

export function docPosition(doc: PrDoc, line: number, column: number): number | null {
  const text = doc.view.state.doc;
  if (line < 1 || line > text.lines) return null;
  const at = text.line(line);
  return at.from + Math.min(column, at.length);
}

import { LSPPlugin } from "@codemirror/lsp-client";
import { setDiagnostics } from "@codemirror/lint";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { editorTheme } from "./Editor";
import { presetKeys } from "./editorPresetKeys";
import { currentEditorOptions } from "./editorOptions";
import { wordHighlightExtension } from "./editorWordHighlight";
import { attachMirrorView, mirrorOnly, unsavedTextOf } from "./editorDocs";
import { cmdClickDefinition, lspDocument, lspKeys, lspViewExtensions } from "./editorLsp";
import { editorMessage } from "./editorMessage";
import { intellisenseExtension } from "./intellisenseKeys";
import { diagnosticsOf } from "./diagnosticsStore";
import { toViewDiagnostics } from "./diagnosticViews";
import { absolutePath, languageIdFor, registerDiffView } from "./lsp";


export type DiffLspTarget = { workspaceId: string; path: string };

export function diffLspTarget(workspaceId: string, path: string, exists: boolean): DiffLspTarget | null {
  return exists && languageIdFor(path) !== null ? { workspaceId, path } : null;
}

export function initialModifiedText(target: DiffLspTarget | null, diskText: string): string {
  return (target && unsavedTextOf(target.workspaceId, target.path)) ?? diskText;
}

export function diffLspExtensions(target: DiffLspTarget): Extension[] {
  const { workspaceId, path } = target;
  return [
    intellisenseExtension,
    presetKeys,
    Prec.highest(keymap.of(lspKeys(workspaceId))),
    lspViewExtensions(workspaceId, editorTheme),
    cmdClickDefinition(workspaceId),
    editorMessage(),
    wordHighlightExtension(currentEditorOptions()),
    EditorState.readOnly.of(true),
    Prec.highest(EditorView.editable.of(true)),
    mirrorOnly(workspaceId, path),
    lspDocument(workspaceId, absolutePath(workspaceId, path), languageIdFor(path)!),
  ];
}

export function bindDiffView(target: DiffLspTarget, view: EditorView): () => void {
  paintKnownDiagnostics(view);
  const detachMirror = attachMirrorView(target.workspaceId, target.path, view);
  const unregister = registerDiffView(target.workspaceId, view);
  return () => {
    detachMirror();
    unregister();
  };
}

function paintKnownDiagnostics(view: EditorView) {
  const plugin = LSPPlugin.get(view);
  const known = plugin ? diagnosticsOf(plugin.uri) : [];
  if (plugin && known.length) view.dispatch(setDiagnostics(view.state, toViewDiagnostics(known, plugin)));
}

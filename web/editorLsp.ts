import { type Extension } from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { definitionLink } from "./definitionLink";
import { hoverSpace } from "./hoverSpace";
import { intellisenseKeymap } from "./intellisenseKeys";
import { languageFor } from "./languages";
import { fileUri, goBack, goForward, lspClient } from "./lsp";
import { findAllReferences, goToDefinition, goToImplementation, goToReferences, peekDefinition, peekImplementation } from "./peekCommands";
import { peekExtension } from "./peekView";

export function lspKeys(workspaceId: string): KeyBinding[] {
  return [
    { key: "F12", run: (view) => (void goToDefinition(view, workspaceId), true) },
    { key: "Shift-F12", run: (view) => (void goToReferences(view, workspaceId), true) },
    { key: "Mod-F12", run: (view) => (void goToImplementation(view, workspaceId), true) },
    { key: "Alt-F12", run: (view) => (void peekDefinition(view, workspaceId), true) },
    { key: "Shift-Mod-F12", run: (view) => (void peekImplementation(view, workspaceId), true) },
    { key: "Shift-Alt-F12", run: (view) => (void findAllReferences(view, workspaceId), true) },
    { key: "Ctrl--", run: () => (goBack(), true) },
    { key: "Ctrl-Shift--", run: () => (goForward(), true) },
    ...intellisenseKeymap,
  ];
}

export function cmdClickDefinition(workspaceId: string): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      event.preventDefault();
      view.dispatch({ selection: { anchor: pos } });
      void goToDefinition(view, workspaceId, event.altKey);
      return true;
    },
  });
}

export function lspViewExtensions(workspaceId: string, previewTheme: Extension): Extension[] {
  return [definitionLink(workspaceId), hoverSpace(), peekExtension({ workspaceId, previewExtensions: (previewPath) => [previewTheme, languageFor(previewPath)] })];
}

export function lspDocument(workspaceId: string, absolutePath: string, languageId: string): Extension {
  return lspClient(workspaceId).plugin(fileUri(absolutePath), languageId);
}

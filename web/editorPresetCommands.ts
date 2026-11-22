import { cursorMatchingBracket, deleteLine, insertBlankLine, moveLineDown, moveLineUp, toggleBlockComment } from "@codemirror/commands";
import { selectNextOccurrence } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { registerEditorCommands, workspaceIdOfView } from "./editorCommands";
import { moveHighlight } from "./editorWordHighlight";
import { openFind } from "./findWidget";
import { reopenSignature } from "./intellisenseKeys";
import { goBack, goForward } from "./lsp";
import { findAllReferences, goToDefinition, goToImplementation, peekDefinition } from "./peekCommands";
import { renameSymbolAtCursor } from "./renameSymbol";


export function insertLineAbove(view: EditorView) {
  if (view.state.readOnly) return false;
  view.dispatch(
    view.state.changeByRange((range) => {
      const line = view.state.doc.lineAt(range.head);
      const indent = /^\s*/.exec(line.text)![0];
      return { changes: { from: line.from, insert: `${indent}\n` }, range: EditorSelection.cursor(line.from + indent.length) };
    }),
    { scrollIntoView: true, userEvent: "input" },
  );
  return true;
}

function withWorkspace(run: (view: EditorView, workspaceId: string) => Promise<void>) {
  return (view: EditorView) => {
    const workspaceId = workspaceIdOfView(view);
    if (!workspaceId) return false;
    void run(view, workspaceId);
    return true;
  };
}

registerEditorCommands([
  { id: "deleteLines", title: "Delete Lines", run: deleteLine },
  { id: "blockComment", title: "Toggle Block Comment", run: toggleBlockComment },
  { id: "moveLinesUp", title: "Move Lines Up", run: moveLineUp },
  { id: "moveLinesDown", title: "Move Lines Down", run: moveLineDown },
  { id: "addSelectionToNextFindMatch", title: "Add Selection to Next Find Match", run: selectNextOccurrence },
  { id: "jumpToBracket", title: "Go to Matching Bracket", run: cursorMatchingBracket },
  { id: "insertLineAfter", title: "Insert Line Below", run: insertBlankLine },
  { id: "insertLineBefore", title: "Insert Line Above", run: insertLineAbove },
  { id: "startFindReplace", title: "Replace", run: (view) => openFind(view, { replace: true }) },
  { id: "goToDeclaration", title: "Go to Declaration", run: withWorkspace(goToDefinition) },
  { id: "goToImplementation", title: "Go to Implementation", run: withWorkspace(goToImplementation) },
  { id: "peekDefinition", title: "Peek Definition", run: withWorkspace(peekDefinition) },
  { id: "findReferences", title: "Find Usages", run: withWorkspace(findAllReferences) },
  { id: "rename", title: "Rename Symbol", run: renameSymbolAtCursor },
  { id: "triggerParameterHints", title: "Trigger Parameter Hints", run: reopenSignature },
  { id: "wordHighlightNext", title: "Go to Next Symbol Highlight", run: (view) => moveHighlight(view, 1) },
  { id: "wordHighlightPrev", title: "Go to Previous Symbol Highlight", run: (view) => moveHighlight(view, -1) },
  { id: "navigateBack", title: "Navigate Back", run: () => (goBack(), true) },
  { id: "navigateForward", title: "Navigate Forward", run: () => (goForward(), true) },
]);

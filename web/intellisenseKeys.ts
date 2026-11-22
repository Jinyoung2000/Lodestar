import { acceptCompletion, closeCompletion, completionStatus, moveCompletionSelection, startCompletion } from "@codemirror/autocomplete";
import { nextSignature, prevSignature, showSignatureHelp } from "@codemirror/lsp-client";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { closeHoverTooltips, EditorView, type KeyBinding } from "@codemirror/view";
import { toggleSuggestionDetails } from "./completionResolve";
import { arrowAction, escapeAction, signatureContext, spaceKeyAction, type Arrow, type KeyAction } from "./editorKeys";
import { renameSymbolAtCursor } from "./renameSymbol";


function contextOf(view: EditorView) {
  const context = signatureContext(view.dom, completionStatus(view.state) === "active");
  return view.state.field(signatureDismissed) ? { ...context, signatureOpen: false, signatureMultiple: false } : context;
}

const nextSuggestion = moveCompletionSelection(true);
const prevSuggestion = moveCompletionSelection(false);

const setDismissed = StateEffect.define<boolean>();

const signatureDismissed = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((acc, effect) => (effect.is(setDismissed) ? effect.value : acc), tr.docChanged ? false : value),
  provide: (field) => EditorView.editorAttributes.from(field, (dismissed) => ({ class: dismissed ? "cm-signature-dismissed" : "" })),
});

export const intellisenseExtension: Extension = signatureDismissed;

export function closeEditorWidgets(view: EditorView) {
  closeCompletion(view);
  view.dispatch({ effects: [closeHoverTooltips, setDismissed.of(true)] });
}

export function reopenSignature(view: EditorView) {
  view.dispatch({ effects: setDismissed.of(false) });
  return showSignatureHelp(view);
}

function perform(action: KeyAction, view: EditorView) {
  switch (action) {
    case "closeSignature":
      view.dispatch({ effects: setDismissed.of(true) });
      return true;
    case "toggleDetails":
      return toggleSuggestionDetails(view);
    case "triggerSuggest":
      return startCompletion(view);
    case "nextSuggestion":
      return nextSuggestion(view);
    case "prevSuggestion":
      return prevSuggestion(view);
    case "nextSignature":
      return nextSignature(view);
    case "prevSignature":
      return prevSignature(view);
    case "pass":
      return false;
  }
}

const arrow = (direction: Arrow["direction"], via: Arrow["via"]) => (view: EditorView) => perform(arrowAction({ direction, via }, contextOf(view)), view);

export const intellisenseKeymap: KeyBinding[] = [
  { key: "Tab", run: acceptCompletion },
  { key: "Alt-Space", run: startCompletion },
  { key: "Alt-Escape", run: startCompletion },
  { key: "Ctrl-Space", run: (view) => perform(spaceKeyAction("ctrl-space", contextOf(view)), view) },
  { key: "Mod-Shift-Space", run: reopenSignature },
  { key: "Escape", run: (view) => perform(escapeAction(contextOf(view)), view) },
  { key: "ArrowDown", run: arrow("down", "plain") },
  { key: "ArrowUp", run: arrow("up", "plain") },
  { key: "Alt-ArrowDown", run: arrow("down", "alt") },
  { key: "Alt-ArrowUp", run: arrow("up", "alt") },
  { key: "Ctrl-n", run: arrow("down", "ctrl") },
  { key: "Ctrl-p", run: arrow("up", "ctrl") },
  { key: "F2", run: renameSymbolAtCursor, preventDefault: true },
];

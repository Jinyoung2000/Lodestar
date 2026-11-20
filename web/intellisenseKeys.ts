import { acceptCompletion, closeCompletion, completionStatus, moveCompletionSelection, startCompletion } from "@codemirror/autocomplete";
import { nextSignature, prevSignature, showSignatureHelp } from "@codemirror/lsp-client";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { closeHoverTooltips, EditorView, type KeyBinding } from "@codemirror/view";
import { toggleSuggestionDetails } from "./completionResolve";
import { arrowAction, escapeAction, signatureContext, spaceKeyAction, type Arrow, type KeyAction } from "./editorKeys";
import { renameSymbolAtCursor } from "./renameSymbol";


function contextOf(view: EditorView) {
  const context = signatureContext(view.dom, completionStatus(view.state) === "active");
  // Esc 로 닫은 힌트는 DOM 에 남아 있어도 없는 것으로 본다.
  return view.state.field(signatureDismissed) ? { ...context, signatureOpen: false, signatureMultiple: false } : context;
}

const nextSuggestion = moveCompletionSelection(true);
const prevSuggestion = moveCompletionSelection(false);

// Esc 로 닫은 파라미터 힌트. @codemirror/lsp-client 는 힌트 상태를 밖에서 지우는 방법을 내보내지 않아서, 상자를 CSS 로 숨기고(web/Editor.tsx 의 cm-signature-dismissed)
// 글을 고치거나 ⇧⌘Space 로 다시 열면 보이게 한다.
const setDismissed = StateEffect.define<boolean>();

const signatureDismissed = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((acc, effect) => (effect.is(setDismissed) ? effect.value : acc), tr.docChanged ? false : value),
  provide: (field) => EditorView.editorAttributes.from(field, (dismissed) => ({ class: dismissed ? "cm-signature-dismissed" : "" })),
});

export const intellisenseExtension: Extension = signatureDismissed;

// 떠 있는 상자를 모두 닫는다: 자동완성, hover, 파라미터 힌트(Esc 와 같은 방식으로 숨긴다). 에디터가 포커스를 잃거나 오버레이가 열릴 때 부른다(web/editorWidgets.ts).
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
  // ⌘I 는 닫혀 있을 때 앱의 빠른 질문이라 에디터는 가져가지 않는다. 제안이 열려 있을 때의 상세 토글은 web/shortcuts.ts 가 한다.
  // Tab 도 Enter 처럼 제안을 수락한다. 제안이 없으면 false 라서 들여쓰기(indentWithTab)로 간다.
  { key: "Tab", run: acceptCompletion },
  { key: "Alt-Space", run: startCompletion },
  { key: "Alt-Escape", run: startCompletion },
  { key: "Ctrl-Space", run: (view) => perform(spaceKeyAction("ctrl-space", contextOf(view)), view) },
  { key: "Mod-Shift-Space", run: reopenSignature },
  { key: "Escape", run: (view) => perform(escapeAction(contextOf(view)), view) },
  // 오버로드 이동: 파라미터 힌트가 떠 있고 오버로드가 여럿일 때만. 아니면 줄 이동(⌥↑↓) 등 원래 키로 간다.
  { key: "ArrowDown", run: arrow("down", "plain") },
  { key: "ArrowUp", run: arrow("up", "plain") },
  { key: "Alt-ArrowDown", run: arrow("down", "alt") },
  { key: "Alt-ArrowUp", run: arrow("up", "alt") },
  { key: "Ctrl-n", run: arrow("down", "ctrl") },
  { key: "Ctrl-p", run: arrow("up", "ctrl") },
  { key: "F2", run: renameSymbolAtCursor, preventDefault: true },
];

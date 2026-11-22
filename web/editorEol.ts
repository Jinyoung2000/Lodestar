import { Compartment, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

const eolCompartment = new Compartment();

export function eolExtension(lineSeparator: string | null): Extension {
  return eolCompartment.of(separatorFor(lineSeparator === "\r\n" ? "\r\n" : "\n"));
}

export function eolOf(state: EditorState): "\n" | "\r\n" {
  return state.lineBreak === "\r\n" ? "\r\n" : "\n";
}

export function eolChanged(update: ViewUpdate): boolean {
  return update.startState.lineBreak !== update.state.lineBreak;
}

export function setEol(target: { state: EditorState; dispatch: (spec: TransactionSpec) => void }, eol: "\n" | "\r\n") {
  if (eolOf(target.state) !== eol) target.dispatch({ effects: eolCompartment.reconfigure(separatorFor(eol)) });
}

const separatorFor = (eol: "\n" | "\r\n"): Extension => (eol === "\r\n" ? EditorState.lineSeparator.of("\r\n") : []);

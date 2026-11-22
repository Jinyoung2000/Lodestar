import { Annotation, EditorSelection, EditorState, Transaction, type ChangeSet, type Extension, type StateCommand, type StateEffect, type TransactionSpec } from "@codemirror/state";


export const mirrored = Annotation.define<boolean>();
export const skipMirror = Annotation.define<boolean>();
export const noHistory = Transaction.addToHistory.of(false);

export type MirrorHost = {
  state: EditorState;
  dispatch(...specs: (TransactionSpec | Transaction)[]): void;
  scrollSnapshot?: () => StateEffect<unknown> | undefined;
};

export type MirrorUpdate = {
  docChanged: boolean;
  startState: EditorState;
  state: EditorState;
  changes: ChangeSet;
  transactions: readonly Transaction[];
};

export type MirrorTarget = {
  host: MirrorHost;
  keepsHistory: boolean;
};

export const isMirroredUpdate = (update: Pick<MirrorUpdate, "transactions">) => update.transactions.some((tr) => tr.annotation(mirrored));

export const shouldForward = (update: Pick<MirrorUpdate, "docChanged" | "transactions">) => update.docChanged && !update.transactions.some((tr) => tr.annotation(mirrored) || tr.annotation(skipMirror));

export function forwardUpdate(update: MirrorUpdate, targets: readonly MirrorTarget[]) {
  const userEvent = update.transactions.map((tr) => tr.annotation(Transaction.userEvent)).find((event) => event !== undefined);
  const time = update.transactions[0]?.annotation(Transaction.time);
  for (const { host, keepsHistory } of targets) {
    const annotations = [mirrored.of(true), ...(keepsHistory ? [] : [noHistory]), ...(time === undefined ? [] : [Transaction.time.of(time)])];
    if (host.state.doc.length === update.startState.doc.length) host.dispatch({ changes: update.changes, annotations, userEvent });
    else host.dispatch({ changes: { from: 0, to: host.state.doc.length, insert: update.state.doc }, annotations: [mirrored.of(true), noHistory] });
  }
}

export function ownerOnlyHistory(isOwner: () => boolean): Extension {
  return EditorState.transactionExtender.of((tr) => (tr.docChanged && !isOwner() ? { annotations: noHistory } : null));
}

export function runOwnerHistory(command: StateCommand, owner: MirrorHost, requester: MirrorHost): boolean {
  const selectionBefore = owner.state.selection;
  const snapshot = owner.scrollSnapshot?.();
  let applied: Transaction | null = null;
  const ok = command({
    state: owner.state,
    dispatch: (tr) => {
      applied = tr;
      owner.dispatch(tr);
    },
  });
  const done = applied as Transaction | null;
  if (!ok || !done) return ok;
  owner.dispatch({ selection: selectionBefore.map(done.changes), effects: snapshot, annotations: noHistory });
  const at = cursorAfterChange(done.changes);
  if (at !== null) requester.dispatch({ selection: EditorSelection.cursor(Math.min(at, requester.state.doc.length)), scrollIntoView: true, annotations: noHistory });
  return true;
}

export function cursorAfterChange(changes: ChangeSet): number | null {
  let at: number | null = null;
  changes.iterChangedRanges((_fromA, _toA, _fromB, toB) => {
    at = toB;
  });
  return at;
}

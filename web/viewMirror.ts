import { Annotation, EditorSelection, EditorState, Transaction, type ChangeSet, type Extension, type StateCommand, type StateEffect, type TransactionSpec } from "@codemirror/state";


// mirrored 는 다른 보기에서 흘러온 변경(다시 흘려보내지 않는다), skipMirror 는 이 보기에서만 일어나는 전체 교체(디스크 다시 읽기, 보관한 내용 복원)다.
export const mirrored = Annotation.define<boolean>();
export const skipMirror = Annotation.define<boolean>();
export const noHistory = Transaction.addToHistory.of(false);

// EditorView 가 만족하는 최소 모양(시험에서는 EditorState 를 감싼 가짜가 대신한다)
export type MirrorHost = {
  state: EditorState;
  dispatch(...specs: (TransactionSpec | Transaction)[]): void;
  // 지금 스크롤 위치로 돌아오게 하는 효과(EditorView.scrollSnapshot). 가짜 보기에는 없다.
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
  // 이 보기가 되돌리기 기록의 주인이면 흘러온 변경을 일반 입력으로 기록한다
  keepsHistory: boolean;
};

// 이 업데이트를 다른 보기에 흘려야 하는가: 글이 바뀌었고, 다른 보기에서 흘러온 것이나 이 보기에서만 일어나는 전체 교체가 아닐 때
// 다른 보기(같은 파일의 탭)에서 흘러온 변경인가. diff 의 수정본 쪽은 이런 변경을 디스크에 쓰지 않는다(탭의 저장 안 한 편집이 diff 를 열었다는 이유로 저장되면 안 된다).
export const isMirroredUpdate = (update: Pick<MirrorUpdate, "transactions">) => update.transactions.some((tr) => tr.annotation(mirrored));

export const shouldForward = (update: Pick<MirrorUpdate, "docChanged" | "transactions">) => update.docChanged && !update.transactions.some((tr) => tr.annotation(mirrored) || tr.annotation(skipMirror));

export function forwardUpdate(update: MirrorUpdate, targets: readonly MirrorTarget[]) {
  // 입력 종류와 시각은 그대로 넘긴다. CodeMirror 의 기록은 input.type, delete 가 이어질 때만 한 묶음으로 합치므로, 빼면 글자마다 ⌘Z 한 번이 필요하다.
  const userEvent = update.transactions.map((tr) => tr.annotation(Transaction.userEvent)).find((event) => event !== undefined);
  const time = update.transactions[0]?.annotation(Transaction.time);
  for (const { host, keepsHistory } of targets) {
    const annotations = [mirrored.of(true), ...(keepsHistory ? [] : [noHistory]), ...(time === undefined ? [] : [Transaction.time.of(time)])];
    // 두 보기의 글이 어긋나 있으면(변경을 놓친 경우) 이 보기의 내용으로 통째로 맞춘다. 이 경우는 기록에 넣지 않는다.
    if (host.state.doc.length === update.startState.doc.length) host.dispatch({ changes: update.changes, annotations, userEvent });
    else host.dispatch({ changes: { from: 0, to: host.state.doc.length, insert: update.state.doc }, annotations: [mirrored.of(true), noHistory] });
  }
}

// 기록의 주인이 아닌 보기는 자기 입력을 기록하지 않는다(주인 쪽에 흘러가 기록된다). 안 막으면 주인이 바뀐 뒤에 이 보기에 반쪽짜리 기록이 남는다.
export function ownerOnlyHistory(isOwner: () => boolean): Extension {
  return EditorState.transactionExtender.of((tr) => (tr.docChanged && !isOwner() ? { annotations: noHistory } : null));
}

// 주인 보기에서 undo 나 redo 를 실행한다. 주인 보기의 커서와 스크롤은 원격 변경을 받은 것처럼 그대로 두고, 요청한 보기의 커서를 되돌린 자리로 옮긴다.
// 주인에서 일어난 변경은 docMirror 의 업데이트 리스너가 요청한 보기에 이미 흘려 보낸 뒤다(dispatch 가 동기).
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

// 변경이 끝난 자리(새 글 기준): 마지막으로 바뀐 구간의 끝. 변경이 없으면 null.
export function cursorAfterChange(changes: ChangeSet): number | null {
  let at: number | null = null;
  changes.iterChangedRanges((_fromA, _toA, _fromB, toB) => {
    at = toB;
  });
  return at;
}

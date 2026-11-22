import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction, type ChangeSet, type TransactionSpec } from "@codemirror/state";
import { cursorAfterChange, forwardUpdate, ownerOnlyHistory, runOwnerHistory, shouldForward, skipMirror, type MirrorHost, type MirrorUpdate } from "../web/viewMirror";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

class FakeView implements MirrorHost {
  state: EditorState;
  scrolled = 0;
  constructor(
    doc: string,
    private group: FakeView[],
    isOwner: () => boolean,
  ) {
    this.state = EditorState.create({ doc, extensions: [history(), ownerOnlyHistory(isOwner)] });
  }
  dispatch(...specs: (TransactionSpec | Transaction)[]) {
    const first = specs[0];
    const tr = first instanceof Transaction ? first : this.state.update(...(specs as TransactionSpec[]));
    const startState = this.state;
    this.state = tr.state;
    const update: MirrorUpdate = { docChanged: tr.docChanged, startState, state: tr.state, changes: tr.changes, transactions: [tr] };
    if (!shouldForward(update)) return;
    forwardUpdate(
      update,
      this.group.filter((view) => view !== this).map((host) => ({ host, keepsHistory: host === this.group[0] })),
    );
  }
  type(at: number, text: string, time: number) {
    this.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type", annotations: Transaction.time.of(time) });
  }
  get text() {
    return this.state.doc.toString();
  }
}

function pair(doc = "") {
  const group: FakeView[] = [];
  const a: FakeView = new FakeView(doc, group, () => group[0] === a);
  const b: FakeView = new FakeView(doc, group, () => group[0] === b);
  group.push(a, b);
  return { a, b, group };
}

{
  const { a, b } = pair("hello");
  a.type(5, "!", 1000);
  same("typing in the first view reaches the second", [a.text, b.text], ["hello!", "hello!"]);
  same("the owner records the typing", undoDepth(a.state), 1);
  same("the other view does not record what it receives", undoDepth(b.state), 0);
}

{
  const { a, b } = pair("hello");
  b.type(0, ">", 1000);
  same("typing in the second view reaches the owner", [a.text, b.text], [">hello", ">hello"]);
  same("the owner records what the other view typed", undoDepth(a.state), 1);
  same("the typing view does not keep its own history", undoDepth(b.state), 0);
}

{
  const { a, b } = pair("");
  for (const [i, ch] of [..."hello"].entries()) b.type(i, ch, 1000 + i * 50);
  same("a typed burst in the other view is one undo group in the owner", undoDepth(a.state), 1);
  b.type(5, "!", 5000);
  same("typing after a pause starts a new group", undoDepth(a.state), 2);
}

{
  const { a, b } = pair("");
  a.type(0, "A", 1000);
  b.type(1, "B", 3000);
  a.type(2, "C", 5000);
  same("mixed typing from both views", [a.text, b.text], ["ABC", "ABC"]);
  same("each pause is its own step", undoDepth(a.state), 3);

  const selA = a.state.selection.main.head;
  check("undo asked from the other view reverts the last edit in both", runOwnerHistory(undo, a, b) && a.text === "AB" && b.text === "AB");
  same("the requesting view's cursor lands where the text was removed", b.state.selection.main.head, 2);
  same("the owner keeps its own cursor (mapped through the change)", a.state.selection.main.head, Math.min(selA, 2));
  check("undo again reverts the edit made in the other view", runOwnerHistory(undo, a, b) && a.text === "A" && b.text === "A");
  same("cursor after the second undo", b.state.selection.main.head, 1);
  same("the redo stack lives in the owner", redoDepth(a.state), 2);
  check("redo asked from the other view restores it in both", runOwnerHistory(redo, a, b) && a.text === "AB" && b.text === "AB");
  same("redo puts the requesting view's cursor after the restored text", b.state.selection.main.head, 2);
  check("the other view still has no history of its own", undoDepth(b.state) === 0 && redoDepth(b.state) === 0);
  check("nothing left to undo returns false", (() => {
    runOwnerHistory(undo, a, b);
    runOwnerHistory(undo, a, b);
    return runOwnerHistory(undo, a, b) === false;
  })());
  same("both views are empty after undoing everything", [a.text, b.text], ["", ""]);
}

{
  const group: FakeView[] = [];
  const a: FakeView = new FakeView("x", group, () => group[0] === a);
  const b: FakeView = new FakeView("x", group, () => group[0] === b);
  group.push(a, b);
  a.type(1, "y", 1000);
  group.shift();
  same("a new owner starts without history", undoDepth(b.state), 0);
  b.type(2, "z", 3000);
  same("a new owner records its own typing", undoDepth(b.state), 1);
  check("a new owner can undo it", undo({ state: b.state, dispatch: (tr) => b.dispatch(tr) }) && b.text === "xy");
}

{
  const { a, b } = pair("abc");
  b.state = EditorState.create({ doc: "different length", extensions: [history()] });
  a.type(3, "d", 1000);
  same("a mismatched view is replaced as a whole", b.text, "abcd");
  same("the replacement is not an undo step", undoDepth(b.state), 0);
}

{
  const group: FakeView[] = [];
  const a = new FakeView("abc", group, () => true);
  const b = new FakeView("abc", group, () => false);
  group.push(a, b);
  a.dispatch({ changes: { from: 0, to: 3, insert: "XYZ" }, annotations: skipMirror.of(true) });
  same("a whole-document replace marked skipMirror stays in its own view", [a.text, b.text], ["XYZ", "abc"]);
}

{
  const state = EditorState.create({ doc: "0123456789" });
  const range = (changes: ChangeSet) => cursorAfterChange(changes);
  same("an insertion ends after the inserted text", range(state.changes({ from: 3, insert: "ab" })), 5);
  same("a deletion ends where the text was", range(state.changes({ from: 3, to: 6 })), 3);
  same("the last of several ranges wins", range(state.changes([{ from: 1, insert: "a" }, { from: 8, to: 9 }])), 9);
  same("no change gives nothing", range(state.changes([])), null);
  same("a selection set is untouched by the helper", state.update({ selection: EditorSelection.cursor(2) }).state.selection.main.head, 2);
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");

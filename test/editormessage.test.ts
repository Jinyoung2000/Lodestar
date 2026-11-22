import { EditorState, type StateEffect } from "@codemirror/state";
import { closeEditorMessage, editorMessage, messageField, showEditorMessage } from "../web/editorMessage";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const state0 = EditorState.create({ doc: "const a = 1;\nconst b = 2;", extensions: [editorMessage()] });
check("starts empty", state0.field(messageField) === null);

type FakeView = { state: EditorState; dispatch: (spec: { effects?: StateEffect<unknown> | StateEffect<unknown>[] }) => void };
const fake: FakeView = { state: state0, dispatch: (spec) => void (fake.state = fake.state.update(spec).state) };

showEditorMessage(fake as never, "No definition found", 6);
check("showing sets the message at the position", fake.state.field(messageField)?.text === "No definition found" && fake.state.field(messageField)?.pos === 6);

fake.state = fake.state.update({ selection: { anchor: 0 } }).state;
check("moving the cursor closes it", fake.state.field(messageField) === null);

showEditorMessage(fake as never, "No references found", 3);
fake.state = fake.state.update({ changes: { from: 0, insert: "x" } }).state;
check("typing closes it", fake.state.field(messageField) === null);

showEditorMessage(fake as never, "Nothing to rename here", 3);
fake.state = fake.state.update({ scrollIntoView: true }).state;
check("a transaction that does not move the cursor keeps it", fake.state.field(messageField)?.text === "Nothing to rename here");

showEditorMessage(fake as never, "A", 1);
showEditorMessage(fake as never, "B", 2);
check("a new message replaces the old one", fake.state.field(messageField)?.text === "B");

closeEditorMessage(fake as never);
check("closing clears it", fake.state.field(messageField) === null);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("editor message: all passed");

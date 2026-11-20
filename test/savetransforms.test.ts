import { Text } from "@codemirror/state";
import { saveTransformChanges, type SaveTransformOptions, type SaveTransformPhase } from "../web/saveTransforms";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const none: SaveTransformOptions = { trimTrailingWhitespace: false, insertFinalNewline: false, trimFinalNewlines: false };
const run = (text: string, options: Partial<SaveTransformOptions>, phase: SaveTransformPhase) => {
  const doc = Text.of(text.split("\n"));
  const changes = saveTransformChanges(doc, { ...none, ...options }, phase);
  return changes.apply(doc).toString();
};
const both = (text: string, options: Partial<SaveTransformOptions>) => {
  const doc = Text.of(text.split("\n"));
  const first = saveTransformChanges(doc, { ...none, ...options }, "beforeFormat").apply(doc);
  return saveTransformChanges(first, { ...none, ...options }, "afterFormat").apply(first).toString();
};
const trim = { trimTrailingWhitespace: true };

// 끝 공백
check("trailing spaces and tabs are removed", run("a  \nb\t\n c \t \n", trim, "beforeFormat") === "a\nb\n c\n");
check("a whitespace-only line becomes empty", run("a\n   \n\t\nb", trim, "beforeFormat") === "a\n\n\nb");
check("leading whitespace stays", run("  a  ", trim, "beforeFormat") === "  a");
check("the last line without a newline is trimmed too", run("a   ", trim, "beforeFormat") === "a");
check("nothing to trim gives an empty change set", saveTransformChanges(Text.of(["a", "b"]), { ...none, ...trim }, "beforeFormat").empty);
check("trim does not run in the after-format phase", run("a  ", trim, "afterFormat") === "a  ");
check("other whitespace such as a form feed is kept", run("a\f ", trim, "beforeFormat") === "a\f");
check("an off setting changes nothing", run("a  \n", {}, "beforeFormat") === "a  \n");

// 마지막 줄바꿈 넣기
const final = { insertFinalNewline: true };
check("a final newline is added", run("a", final, "afterFormat") === "a\n");
check("an existing final newline stays", run("a\n", final, "afterFormat") === "a\n");
check("a whitespace-only last line gets nothing", run("a\n  ", final, "afterFormat") === "a\n  ");
check("an empty file stays empty", run("", final, "afterFormat") === "");

// 끝 빈 줄 제거
const trimEnd = { trimFinalNewlines: true };
check("extra empty lines are removed and one newline stays", run("a\n\n\n", trimEnd, "afterFormat") === "a\n");
check("a single trailing newline stays", run("a\n", trimEnd, "afterFormat") === "a\n");
check("no trailing newline stays without one", run("a\n\n\nb", trimEnd, "afterFormat") === "a\n\n\nb");
check("a whitespace-only last line counts as content", run("a\n  \n\n", trimEnd, "afterFormat") === "a\n  \n");
check("a file of only newlines becomes empty", run("\n\n\n", trimEnd, "afterFormat") === "");
check("a one-line file is left alone", run("a", trimEnd, "afterFormat") === "a");

// 조합과 순서
check("insert then trim leaves exactly one final newline", both("a\n\n\n", { insertFinalNewline: true, trimFinalNewlines: true }) === "a\n");
check("insert then trim on text without a newline", both("a", { insertFinalNewline: true, trimFinalNewlines: true }) === "a\n");
check("all three together", both("a  \nb \n\n\n", { trimTrailingWhitespace: true, insertFinalNewline: true, trimFinalNewlines: true }) === "a\nb\n");
check("trim before insert: a whitespace-only last line is emptied first, then no newline is added", both("a\n  ", { trimTrailingWhitespace: true, insertFinalNewline: true }) === "a\n");

// 포맷이 끼지 않는 저장은 세 변환이 한 번의 변경이 된다
check("the all phase applies trim, insert and trim-final in one change set", (() => {
  const doc = Text.of(["a  ", "b ", "", ""]);
  const changes = saveTransformChanges(doc, { trimTrailingWhitespace: true, insertFinalNewline: true, trimFinalNewlines: true }, "all");
  return changes.apply(doc).toString() === "a\nb\n" && !changes.empty;
})());
check("the all phase equals the two phases run in order", both("a  \nb \n\n\n", { trimTrailingWhitespace: true, insertFinalNewline: true, trimFinalNewlines: true }) === run("a  \nb \n\n\n", { trimTrailingWhitespace: true, insertFinalNewline: true, trimFinalNewlines: true }, "all"));

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");

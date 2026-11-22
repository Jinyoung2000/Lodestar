import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { countLineChanges } from "../shared/lineDiff";
import { chunkKind, DIFF_CONFIG, visibleLineCount, wholeLines } from "../web/diffMarks";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const same = (actual: unknown, expected: unknown, label: string) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
};
const build = (original: string, current: string) => {
  const a = Text.of(original.split("\n"));
  const b = Text.of(current.split("\n"));
  return { a, b, chunks: Chunk.build(a, b, DIFF_CONFIG) };
};

test("a block of added lines is one added chunk and every line gets the band", () => {
  const { a, b, chunks } = build("a\nb\n", "a\nx\ny\nz\nb\n");
  same(chunks.length, 1, "chunk count");
  same(chunkKind(chunks[0], a, b), "added", "kind");
  same(wholeLines(chunks[0], "b", b, a), [0, 1, 2], "current side lines");
  same(wholeLines(chunks[0], "a", a, b), [], "base side has no lines");
  return "3 lines";
});

test("a block of removed lines is one removed chunk and every base line gets the band", () => {
  const { a, b, chunks } = build("a\nx\ny\nb\n", "a\nb\n");
  same(chunkKind(chunks[0], a, b), "removed", "kind");
  same(wholeLines(chunks[0], "a", a, b), [0, 1], "base side lines");
  same(wholeLines(chunks[0], "b", b, a), [], "current side has no lines");
  return "2 lines";
});

test("a new file (empty base) is added and the last line without a trailing newline still gets the band", () => {
  const { a, b, chunks } = build("", "x\ny\nz");
  same(chunkKind(chunks[0], a, b), "added", "kind");
  same(wholeLines(chunks[0], "b", b, a), [0, 1, 2], "lines");
  return "3 lines";
});

test("a one-word change in a line keeps only the inline text mark, so no band", () => {
  const { a, b, chunks } = build("const total = 1;\n", "const total = 2;\n");
  same(chunkKind(chunks[0], a, b), "modified", "kind");
  same(wholeLines(chunks[0], "a", a, b), [], "base");
  same(wholeLines(chunks[0], "b", b, a), [], "current");
  return "no band";
});

test("a modified chunk gets the band only on lines whose change crosses the line break", () => {
  const { a, b, chunks } = build("head\nfoo bar\ntail\n", "head\nfoo one\ntwo\nthree\ntail\n");
  same(chunkKind(chunks[0], a, b), "modified", "kind");
  const lines = wholeLines(chunks[0], "b", b, a);
  same(lines, [1], "only the middle line crosses a line break at both ends; the first starts mid-line and the last ends at its text end");
  return JSON.stringify(lines);
});

test("changes that only add or remove leading or trailing spaces are not chunks", () => {
  same(build("a\nb\n", "a \nb\n").chunks.length, 0, "trailing space added");
  same(build("a\n  b\n", "a\nb\n").chunks.length, 0, "indent removed");
  same(build("a\nb\t\n", "a\nb\n").chunks.length, 0, "trailing tab removed");
  same(build("x\n    ret\ny\n", "x  \n  ret\ny\n").chunks.length, 0, "indent shrinks while the previous line gains a trailing space");
  same(build("x\n  a\n  b\n", "x\n\ta\n\tb\n").chunks.length, 0, "tabs for spaces");
  return "5 cases";
});

test("whitespace changes inside a line, blank line changes and real edits stay chunks", () => {
  same(build("a  b\n", "a b\n").chunks.length, 1, "inner spaces");
  same(build("a\nb\n", "a\n\nb\n").chunks.length, 1, "blank line added");
  same(build("a\nb\n", "a \nB\n").chunks.length, 1, "real edit next to a trailing space");
  const edit = build("a\n    b\nc\n", "a  \n  b\nC\n");
  same(edit.chunks.length, 1, "indent changes do not merge into the real edit's chunk");
  same([edit.chunks[0].fromB, edit.chunks[0].toB], [edit.b.line(3).from, edit.b.length], "the chunk is just the edited line");
  return "3 cases";
});

test("a new file has zero deleted lines and a deleted file has zero added lines, with or without a trailing newline", () => {
  for (const [original, current, added, deleted] of [
    ["", "hello", 1, 0],
    ["", "hello\n", 1, 0],
    ["", "a\nb\nc", 3, 0],
    ["hello", "", 0, 1],
    ["hello\n", "", 0, 1],
    ["a\nb\nc", "", 0, 3],
  ] as const) {
    const { a, b, chunks } = build(original, current);
    same(chunks.length, 1, `${JSON.stringify(original)} to ${JSON.stringify(current)} chunk count`);
    same([visibleLineCount(chunks[0], "b", b), visibleLineCount(chunks[0], "a", a)], [added, deleted], `${JSON.stringify(original)} to ${JSON.stringify(current)} visible lines`);
    same(countLineChanges(original, current), { additions: added, deletions: deleted }, `${JSON.stringify(original)} to ${JSON.stringify(current)} counts`);
  }
  return "6 cases";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);

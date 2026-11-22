import { acceptChunk, Chunk, getChunks, getOriginalDoc, rejectChunk, unifiedMergeView } from "@codemirror/merge";
import { ChangeSet, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { chunkEdit, revertedNewFile, type ChunkAction } from "../web/diffChunks";
import { DIFF_CONFIG } from "../web/diffMarks";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};


function inlineView(original: string, current: string) {
  const view = {
    state: EditorState.create({ doc: current, extensions: [unifiedMergeView({ original, mergeControls: false, diffConfig: DIFF_CONFIG })] }),
    dispatch(spec: TransactionSpec) {
      this.state = this.state.update(spec).state;
    },
  };
  return view;
}

function runInline(original: string, current: string, index: number, action: ChunkAction): [string, string] {
  const view = inlineView(original, current);
  const chunk = getChunks(view.state)!.chunks[index];
  const ok = (action === "keep" ? acceptChunk : rejectChunk)(view as unknown as EditorView, chunk.fromB);
  if (!ok) throw new Error("inline action found no chunk");
  return [getOriginalDoc(view.state).toString(), view.state.doc.toString()];
}

function runSplit(original: string, current: string, index: number, action: ChunkAction): [string, string] {
  const a = Text.of(original.split("\n"));
  const b = Text.of(current.split("\n"));
  const chunk = Chunk.build(a, b, DIFF_CONFIG)[index];
  const edit = chunkEdit(chunk, a, b, action);
  const doc = edit.target === "a" ? a : b;
  const next = ChangeSet.of({ from: edit.from, to: edit.to, insert: edit.insert }, doc.length).apply(doc).toString();
  return edit.target === "a" ? [next, current] : [original, next];
}

function compare(original: string, current: string) {
  const chunks = Chunk.build(Text.of(original.split("\n")), Text.of(current.split("\n")), DIFF_CONFIG);
  const fromView = getChunks(inlineView(original, current).state)!.chunks;
  if (chunks.length !== fromView.length) throw new Error(`chunk count differs: ${chunks.length} vs ${fromView.length} for ${JSON.stringify({ original, current })}`);
  for (let i = 0; i < chunks.length; i++) {
    for (const action of ["keep", "undo"] as const) {
      const inline = runInline(original, current, i, action);
      const split = runSplit(original, current, i, action);
      if (inline[0] !== split[0] || inline[1] !== split[1]) {
        throw new Error(`${action} chunk ${i} differs for ${JSON.stringify({ original, current })}: inline ${JSON.stringify(inline)} split ${JSON.stringify(split)}`);
      }
    }
  }
  return chunks.length;
}

const PAIRS: [string, string, string][] = [
  ["one changed line in the middle", "a\nb\nc\n", "a\nB\nc\n"],
  ["several chunks: change, add, delete", "1\n2\n3\n4\n5\n6\n7\n8\n", "1\nTWO\n3\n4\n4.5\n5\n7\n8\n"],
  ["no trailing newline on either side", "a\nb\nc", "a\nB\nc"],
  ["trailing newline added", "a\nb", "a\nb\n"],
  ["trailing newline removed", "a\nb\n", "a\nb"],
  ["new file (empty base)", "", "x\ny\nz\n"],
  ["everything deleted", "x\ny\nz\n", ""],
  ["insert at the end", "a\nb\n", "a\nb\nc\nd\n"],
  ["delete at the end", "a\nb\nc\nd\n", "a\nb\n"],
  ["insert at the start", "b\nc\n", "a\nb\nc\n"],
  ["delete at the start", "a\nb\nc\n", "c\n"],
  ["adjacent modifications", "a\nb\nc\nd\n", "a\nB\nC\nd\n"],
  ["blank lines", "a\n\n\nb\n", "a\n\nb\n\n"],
  ["identical", "a\nb\n", "a\nb\n"],
  ["both empty", "", ""],
  ["replace everything", "a\nb\nc", "x\ny"],
  ["indent and trailing space changes next to a real edit", "a\n    b\nc\nd\n", "a  \n  b\nC\nd\n"],
  ["whitespace only", "a\n    b\n", "a  \n  b\n"],
];
for (const [name, original, current] of PAIRS) test(`Keep and Undo of each chunk match inline: ${name}`, () => `${compare(original, current)} chunks`);

test("Keep and Undo of each chunk match inline on 400 random pairs", () => {
  let seed = 20261014;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = (n: number) => Math.floor(random() * n);
  let total = 0;
  for (let i = 0; i < 400; i++) {
    const base = Array.from({ length: pick(14) }, (_, n) => `line ${n} ${"x".repeat(pick(4))}`);
    const next = [...base];
    for (let k = pick(5); k > 0; k--) {
      const at = pick(next.length + 1);
      const op = pick(3);
      if (op === 0) next.splice(at, 1);
      else if (op === 1) next.splice(at, 0, `new ${pick(100)}`);
      else if (at < next.length) next[at] = `${next[at]} edited`;
    }
    const withEol = (lines: string[]) => (lines.length ? lines.join("\n") + (pick(2) ? "\n" : "") : "");
    total += compare(withEol(base), withEol(next));
  }
  return `${total} chunks checked`;
});

test("A long inserted block before an edited line splits into an insertion and a modification, like git", () => {
  const head = ["const a = 1", "", "return (", "  <Screen", "    noBorder", "    appBar={{", "      title: 'old',", "    }}", "  />", ")"];
  const block = Array.from({ length: 30 }, (_, i) => `  const field${i} = { key: 'k${i}', title: '제목 ${i}', value: value${i} ?? empty }`);
  const next = [...head.slice(0, 2), ...block, "", ...head.slice(2, 6), "      title: match(type)", "        .with('A', () => 'new')", "        .otherwise(() => 'old'),", ...head.slice(7)];
  const a = Text.of(head);
  const b = Text.of(next);
  const lines = Chunk.build(a, b, DIFF_CONFIG).map((c) => `${a.lineAt(Math.min(c.fromA, a.length)).number}-${a.lineAt(Math.min(c.toA, a.length)).number}>${b.lineAt(Math.min(c.fromB, b.length)).number}-${b.lineAt(Math.min(c.toB, b.length)).number}`);
  expect(lines.length === 2, `two chunks: ${lines.join(", ")}`);
  expect(lines[0] === "3-3>3-34", `pure insertion of the block: ${lines[0]}`);
  expect(lines[1] === "7-8>38-41", `title line modified: ${lines[1]}`);
  return lines.join(", ");
});

test("Keeping every chunk one by one makes the base equal the current text, undoing makes the current equal the base", () => {
  const original = "1\n2\n3\n4\n5\n6\n7\n8\n";
  const current = "1\nTWO\n3\n4.5\n5\n6\n8\nnine\n";
  for (const action of ["keep", "undo"] as const) {
    let a = original;
    let b = current;
    for (let guard = 0; guard < 20; guard++) {
      const chunks = Chunk.build(Text.of(a.split("\n")), Text.of(b.split("\n")), DIFF_CONFIG);
      if (!chunks.length) break;
      const [nextA, nextB] = runSplit(a, b, 0, action);
      a = nextA;
      b = nextB;
    }
    expect(a === b, `${action}: base and current end equal`);
    expect(action === "keep" ? a === current : b === original, `${action}: ends at ${action === "keep" ? "the current text" : "the base"}`);
  }
  return "ok";
});

test("Undoing the only chunk of a new file removes the file, but emptying it by hand does not", () => {
  const original = "";
  const current = "export const a = 1;\nexport const b = 2;\n";
  const view = inlineView(original, current);
  let reverted = false;
  view.dispatch = (spec: TransactionSpec) => {
    const next = view.state.update(spec);
    reverted = next.isUserEvent("revert");
    view.state = next.state;
  };
  rejectChunk(view as unknown as EditorView, getChunks(view.state)!.chunks[0].fromB);
  const text = view.state.doc.toString();
  expect(text === "" && reverted, `undo leaves an empty doc by a revert event (${JSON.stringify(text)}, reverted ${reverted})`);
  expect(revertedNewFile({ baseMissing: true, reverted, original: getOriginalDoc(view.state).toString(), text }), "new file undone in full is removed");
  expect(!revertedNewFile({ baseMissing: true, reverted: false, original: "", text: "" }), "emptied by typing is kept");
  expect(!revertedNewFile({ baseMissing: false, reverted: true, original: "", text: "" }), "an existing empty file is kept");
  expect(!revertedNewFile({ baseMissing: true, reverted: true, original: "", text: "export const a = 1;\n" }), "a partial undo keeps the file");
  expect(!revertedNewFile({ baseMissing: true, reverted: true, original: "kept\n", text: "" }), "a kept base keeps the file");
  return "ok";
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

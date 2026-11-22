import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { EditorState } from "@codemirror/state";
import { candidateLines, findStickyState, indentRanges, maxStickyLines, nestRanges, stickyLayout, stickyStateEquals, symbolsToSticky, type StickyNode, type StickySymbol } from "../web/editorStickyModel";
import { foldSymbols, indentSymbols, stickyFromSymbols } from "../web/editorStickyFolds";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const json = (value: unknown) => JSON.stringify(value);

const sym = (start: number, end: number, children: StickySymbol[] = [], sel = start): StickySymbol => ({ rangeStartLine: start, selStartLine: sel, rangeEndLine: end, children });
const node = (start: number, end: number, children: StickyNode[] = []): StickyNode => ({ start, end, children });

const tree = symbolsToSticky([sym(1, 10, [sym(2, 5), sym(3, 3), sym(6, 9)])]);
check("a class with two methods keeps both and drops the one liner", json(tree) === json([node(1, 10, [node(2, 5), node(6, 9)])]), json(tree));
check("top level symbols are sorted by range start", json(symbolsToSticky([sym(20, 30), sym(1, 10)]).map((n) => n.start)) === json([1, 20]));
check("a child that names itself on the parent's line is replaced by its own children", (() => {
  const flat = symbolsToSticky([sym(1, 10, [sym(1, 8, [sym(2, 5), sym(6, 7)], 1)])]);
  return json(flat) === json([node(1, 10, [node(2, 5), node(6, 7)])]);
})());
check("a decorator above the name uses the name line as the start", symbolsToSticky([{ rangeStartLine: 1, selStartLine: 3, rangeEndLine: 9, children: [] }])[0]!.start === 3);
check("children are ordered by start, then wider first", (() => {
  const ordered = symbolsToSticky([sym(1, 20, [sym(10, 12), sym(2, 9), sym(2, 5)])])[0]!.children;
  return json(ordered.map((c) => [c.start, c.end])) === json([[2, 9], [2, 5], [10, 12]]);
})());

const roots = [node(1, 10, [node(2, 5), node(6, 9)])];
const candidates = candidateLines(roots, { start: 3, end: 12 }, 20, 20);
check("candidates are the class, then both methods one slot lower", json(candidates) === json([{ start: 1, end: 9, top: 0, height: 20 }, { start: 2, end: 4, top: 20, height: 20 }, { start: 6, end: 8, top: 20, height: 20 }]), json(candidates));
check("a block of two lines never sticks", candidateLines([node(1, 2)], { start: 1, end: 5 }, 20, 10).length === 0 && candidateLines([node(1, 3)], { start: 1, end: 5 }, 20, 10).length === 1);
check("a block fully below the visible range is not a candidate", candidateLines([node(30, 40)], { start: 1, end: 10 }, 20, 50).length === 0);
check("a block fully above the visible range is not a candidate", candidateLines([node(1, 5)], { start: 20, end: 30 }, 20, 50).length === 0);
check("a nested block that starts on its parent's line is skipped along with its children", (() => {
  const result = candidateLines([node(1, 10, [node(1, 8, [node(2, 6)])])], { start: 3, end: 5 }, 20, 20);
  return result.length === 1 && result[0]!.start === 1;
})());
check("only siblings that meet the viewport are visited in a long list", (() => {
  const many = Array.from({ length: 1000 }, (_, i) => node(i * 10 + 1, i * 10 + 9));
  const result = candidateLines(many, { start: 5001, end: 5030 }, 20, 20_000);
  return result.length >= 3 && result.length <= 5 && result.every((c) => c.start >= 4991 && c.start <= 5031);
})());

const top = (line: number) => (line - 1) * 20;
const bottom = (line: number) => line * 20;
const at = (scrollTop: number, max = 5) => findStickyState(candidates, max, scrollTop, top, bottom);
check("nothing sticks at the top of the file", at(0).startLines.length === 0);
check("scrolled into the second method: class and method stick", json(at(100).startLines) === json([1, 6]) && at(100).lastLineRelativePosition === 0);
check("the first method has ended, so it no longer sticks", !at(100).startLines.includes(2));
check("the last line is pushed up as the next declaration arrives", (() => {
  const state = at(140);
  return json(state.startLines) === json([1, 6]) && state.lastLineRelativePosition === -20 && stickyLayout(state, 20).height === 20 && json(stickyLayout(state, 20).tops) === json([0, 0]);
})());
check("after the method ends only the class remains", json(at(160).startLines) === json([1]) && at(160).lastLineRelativePosition === 0);
check("the class itself slides out at the end", json(at(170).startLines) === json([1]) && at(170).lastLineRelativePosition === -10 && stickyLayout(at(170), 20).height === 10);
check("the cap on the number of lines", at(100, 1).startLines.length === 1);
check("end lines point one past the block", json(at(100).endLines) === json([10, 9]));
check("state equality", stickyStateEquals(at(100), at(101)) && !stickyStateEquals(at(100), at(140)));
check("at most a quarter of the editor height", maxStickyLines(800, 20) === 10 && maxStickyLines(200, 20) === 3 && maxStickyLines(60, 20) === 1 && maxStickyLines(40, 20) === 1 && maxStickyLines(20, 20) === 0);
check("layout stacks lines one slot apart", json(stickyLayout({ startLines: [1, 6, 8], endLines: [], lastLineRelativePosition: 0 }, 20)) === json({ tops: [0, 20, 40], height: 60 }));

const python1 = ["def a():", "  x", "  y", "z"];
check("indent blocks close at the line where the indent returns", json(indentRanges(python1, 2)) === json([{ start: 1, end: 4 }]));
check("nested indent blocks and blank lines", (() => {
  const lines = ["class A:", "  def m(self):", "    a", "", "    b", "  def n(self):", "    c", "end"];
  return json(indentRanges(lines, 2).sort((x, y) => x.start - y.start)) === json([{ start: 1, end: 8 }, { start: 2, end: 6 }, { start: 6, end: 8 }]);
})());
check("tabs count to the next tab stop", json(indentRanges(["f", "\tx", "g"], 4)) === json([{ start: 1, end: 3 }]));
check("nesting by containment", json(nestRanges([{ start: 1, end: 10 }, { start: 2, end: 5 }, { start: 3, end: 4 }, { start: 6, end: 9 }])) === json([node(1, 10, [node(2, 5, [node(3, 4)]), node(6, 9)])]));

const source = ["class Box {", "  size = 1;", "  grow(n) {", "    if (n) {", "      this.size += n;", "    }", "    return this.size;", "  }", "}", "", "function top() {", "  return 1;", "}"].join("\n");
const state = EditorState.create({ doc: source, extensions: [javascript()] });
const folded = stickyFromSymbols(foldSymbols(state), (pos) => state.doc.lineAt(pos).number);
check("a class body, a method body and an if body come out of the syntax tree", (() => {
  const flat: number[][] = [];
  const visit = (nodes: StickyNode[]) => nodes.forEach((n) => (flat.push([n.start, n.end]), visit(n.children)));
  visit(folded);
  return json(flat.sort((a, b) => a[0]! - b[0]!)) === json([[1, 9], [3, 8], [4, 6], [11, 13]]);
})(), json(folded));
const foldCandidates = candidateLines(folded, { start: 5, end: 7 }, 20, state.doc.lines);
check("while the cursor area is inside the if, class, method and if stick", json(foldCandidates.map((c) => c.start)) === json([1, 3, 4]), json(foldCandidates));
const py = EditorState.create({ doc: "def a():\n    x = 1\n    y = 2\n\nz = 3\n", extensions: [python()] });
check("python blocks are found by the parser or the indentation fallback", foldSymbols(py).length === 1 && stickyFromSymbols(foldSymbols(py), (pos) => py.doc.lineAt(pos).number)[0]!.start === 1);
const plain = EditorState.create({ doc: "title\n  one\n  two\n  three\nnext" });
check("a file with no parser falls back to indentation", stickyFromSymbols(foldSymbols(plain), (pos) => plain.doc.lineAt(pos).number)[0]!.start === 1 && indentSymbols(plain).length === 1);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("editor sticky: all passed");

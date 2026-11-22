import { javascript } from "@codemirror/lang-javascript";
import { codeFolding, ensureSyntaxTree, foldedRanges } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { blockWidth, effectiveBlinking, linePiece, screenAwareSize } from "../web/editorCursorModel";
import { FOLD_COMMANDS, foldCommandSpec, foldSetup, iconClickSpec, regionAtLine, type FoldSetup } from "../web/editorFoldRegions";
import { buildRegionTree, computeIndentRegions, computeMarkerRegions, planByStartLine, planExcept, planFoldAtLines, planIconClick, planLevel, planSetState, planToggle, regionIndexAt, regionMarkersFor, regionsAtLine, regionsInside } from "../web/editorFoldModel";
import { activeGuide, guideCounts, indentColumns, isOffSideLanguage, whitespaceLineLevel, type IndentSource } from "../web/editorGuidesModel";
import { filletPieces, pieceCorners, radiusClasses } from "../web/editorSelectionModel";
import { whitespaceOffsets, whitespaceRuns } from "../web/editorWhitespaceModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const sourceOf = (text: string, tabSize = 4): IndentSource => {
  const lines = text.split("\n");
  return { lineCount: lines.length, indentOf: (i) => indentColumns(lines[i]!, tabSize) };
};

check("indent columns: spaces count one each", indentColumns("    x", 4) === 4);
check("indent columns: a tab goes to the next tab stop", indentColumns("\tx", 4) === 4 && indentColumns("  \tx", 4) === 4 && indentColumns("\t  x", 4) === 6);
check("indent columns: a blank or whitespace-only line is -1", indentColumns("", 4) === -1 && indentColumns("   ", 4) === -1);

{
  const source = sourceOf("a\n    b\n        c\n\n    d");
  check("guides: one per started indent level (ceil of indent / size)", same(guideCounts(source, 1, 5, 4, false), [0, 1, 2, 2, 1]));
  check("guides: a blank line between deeper lines takes the larger level of its neighbours", same(guideCounts(sourceOf("if x:\n    a\n\n    b"), 1, 4, 4, false), [0, 1, 1, 1]));
  check("guides: a blank line after a block keeps the block when offSide, drops one level otherwise", whitespaceLineLevel(true, 8, 4, 4) === 1 && whitespaceLineLevel(false, 8, 4, 4) === 2 && whitespaceLineLevel(false, 4, 8, 4) === 2);
  check("guides: no neighbour above or below means none", whitespaceLineLevel(false, -1, 4, 4) === 0 && whitespaceLineLevel(false, 4, -1, 4) === 0);
}

{
  const source = sourceOf("function f() {\n  if (a) {\n    b();\n  }\n}", 2);
  const inner = activeGuide(source, 3, 1, 6, 2, false);
  check("active guide: the cursor inside the inner block lights its level and lines", inner.indent === 2 && inner.startLine === 3 && inner.endLine === 3, JSON.stringify(inner));
  const mid = activeGuide(source, 2, 1, 6, 2, false);
  check("active guide: the cursor on a block header lights the block it opens", mid.indent === 2 && mid.startLine === 3 && mid.endLine === 3, JSON.stringify(mid));
  const header = activeGuide(source, 1, 1, 6, 2, false);
  check("active guide: the cursor on the top header lights the block under it", header.indent === 1 && header.startLine === 2 && header.endLine === 4, JSON.stringify(header));
  const flat = activeGuide(sourceOf("a\nb\nc", 2), 2, 1, 4, 2, false);
  check("active guide: a flat file has none", flat.indent === 0, JSON.stringify(flat));
  const body = activeGuide(sourceOf("a\n  b\n  c\n\n  d\ne", 2), 3, 1, 7, 2, false);
  check("active guide: the block runs through a blank line to its last line", body.indent === 1 && body.startLine === 2 && body.endLine === 5, JSON.stringify(body));
}

check("offSide languages", isOffSideLanguage("python") && isOffSideLanguage("yaml") && !isOffSideLanguage("typescript") && !isOffSideLanguage(null));

check("whitespace none draws nothing", same(whitespaceOffsets("a b\t", "none", null), []));
check("whitespace all draws every space and tab", same(whitespaceOffsets(" a  b\t", "all", null), [0, 2, 3, 5]));
check("boundary skips a single space between words", same(whitespaceOffsets("a b", "boundary", null), []));
check("boundary draws leading, trailing and doubled spaces", same(whitespaceOffsets("  a  b ", "boundary", null), [0, 1, 3, 4, 6]));
check("boundary always draws tabs", same(whitespaceOffsets("a\tb", "boundary", null), [1]));
check("trailing draws only the line end", same(whitespaceOffsets(" a b  ", "trailing", null), [4, 5]));
check("trailing on an all-whitespace line draws all", same(whitespaceOffsets("  \t", "trailing", null), [0, 1, 2]));
check("selection with nothing selected draws nothing", same(whitespaceOffsets("a b", "selection", null), []) && same(whitespaceOffsets("a b", "selection", []), []));
check("selection draws only inside the selected range", same(whitespaceOffsets("a b c d", "selection", [{ from: 2, to: 5 }]), [3]));
check("selection with two ranges on a line", same(whitespaceOffsets("a b c d", "selection", [{ from: 0, to: 2 }, { from: 4, to: 7 }]), [1, 5]));
check("runs merge adjacent spaces but not tabs", same(whitespaceRuns("a  \t\tb", [1, 2, 3, 4]), [{ from: 1, to: 3, tab: false }, { from: 3, to: 4, tab: true }, { from: 4, to: 5, tab: true }]));

{
  const lines = ["a", "  b", "  c", "", "d", "  e"];
  const indentOf = (i: number) => indentColumns(lines[i]!, 2);
  const plain = computeIndentRegions({ lineCount: lines.length, indentOf, offSide: false });
  check("indent regions: ends before the next line at the same indent, blank lines included", same(plain, [{ start: 1, end: 4 }, { start: 5, end: 6 }]), JSON.stringify(plain));
  const offSide = computeIndentRegions({ lineCount: lines.length, indentOf, offSide: true });
  check("indent regions: offSide drops the trailing blank line", same(offSide, [{ start: 1, end: 3 }, { start: 5, end: 6 }]), JSON.stringify(offSide));
  const nested = ["a", "  b", "    c", "  d", "e"];
  const regions = computeIndentRegions({ lineCount: nested.length, indentOf: (i) => indentColumns(nested[i]!, 2), offSide: false });
  check("indent regions: nested blocks", same(regions, [{ start: 1, end: 4 }, { start: 2, end: 3 }]), JSON.stringify(regions));
  const markerLines = ["//#region x", "foo", "//#endregion", "bar"];
  const markers = regionMarkersFor("a.ts")!;
  check("marker regions include the end marker line", same(computeMarkerRegions(markerLines.length, (i) => markerLines[i]!, markers.start, markers.end), [{ start: 1, end: 3 }]));
  check("region markers by language", regionMarkersFor("x.py")!.start.test("# region a") && regionMarkersFor("x.css")!.start.test("/* #region a */") && regionMarkersFor("x.txt") === null && regionMarkersFor(null) === null);
}

{
  const tree = buildRegionTree([{ start: 1, end: 4 }, { start: 2, end: 3 }, { start: 5, end: 6 }, { start: 3, end: 8 }]);
  check("region tree drops regions that cross another", tree.regions.length === 3 && same(tree.regions.map((r) => r.start), [1, 2, 5]));
  check("region tree finds the innermost region at a line", regionIndexAt(tree, 3) === 1 && regionIndexAt(tree, 4) === 0 && regionIndexAt(tree, 7) === -1);
  check("regions at a line run from the innermost out", same(regionsAtLine(tree, 3), [1, 0]));
  check("regions inside use depth 1 for direct children", same(regionsInside(tree, null, (_i, level) => level === 1), [0, 2]) && same(regionsInside(tree, null, (_i, level) => level === 2), [1]));
  const none = { tree, collapsed: () => false };
  check("fold all picks every region", same(planSetState(none, true, Number.MAX_VALUE), [0, 1, 2]));
  check("fold at a line picks the innermost unfolded region", same(planFoldAtLines(none, true, [3]), [1]));
  const innerFolded = { tree, collapsed: (i: number) => i === 1 };
  check("fold at a line whose region is folded picks the parent", same(planFoldAtLines(innerFolded, true, [3]), [0]));
  const allFolded = { tree, collapsed: () => true };
  check("unfold one level leaves nested folds", same(planSetState(allFolded, false, 1, [1]), [0]) && same(planSetState(allFolded, false, 1, [3]), [1]));
  check("unfold recursively opens the region and the folds inside it", same(planSetState(allFolded, false, Number.MAX_VALUE, [1]), [0, 1]));
  check("fold recursively takes the region and what it contains", same(planSetState(none, true, Number.MAX_VALUE, [1]), [0, 1]));
  check("fold recursively on the inner line takes only the inner region", same(planSetState(none, true, Number.MAX_VALUE, [3]), [1]));
  check("fold level 1 skips regions that hold the cursor line", same(planLevel(none, 1, true, [3]), [2]) && same(planLevel(none, 1, true, []), [0, 2]));
  check("fold level 2 picks depth 2 regions", same(planLevel(none, 2, true, []), [1]));
  check("fold all except selected folds only unrelated regions", same(planExcept(none, true, [3]), [2]));
  check("toggle flips the region at the line", same(planToggle(none, 1, [3]), [1]) && same(planToggle({ tree, collapsed: (i: number) => i === 1 }, 1, [3]), [1]));
  check("by start line picks matching starts", same(planByStartLine(none, true, (line) => line === 5), [2]));
  check("icon click plain toggles only that region", same(planIconClick(none, 0, "plain"), [0]));
  check("icon click with shift on an open region folds its open children, not the region itself", same(planIconClick(none, 0, "recursive"), [1]));
  check("icon click with shift on a folded region unfolds it and the folded children", same(planIconClick({ tree, collapsed: () => true }, 0, "recursive"), [1, 0]));
  check("icon click with alt acts on unrelated regions", same(planIconClick(none, 0, "others"), [2]));
}

const JS = ["function f() {", "  if (a) {", "    b();", "  }", "  return 1;", "}", "const x = 1;", "/**", " * doc", " */", "const y = 2;"].join("\n");

function foldState(text: string, setup: Partial<FoldSetup> = {}, withJs = true) {
  const state = EditorState.create({
    doc: text,
    extensions: [withJs ? javascript() : [], codeFolding(), foldSetup.of({ strategy: "auto", markers: null, offSide: false, ...setup })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

{
  const state = foldState(JS);
  check("js: a function body folds up to the line before its closing brace", same(regionAtLine(state, 1), { start: 1, end: 5 }), JSON.stringify(regionAtLine(state, 1)));
  check("js: an inner block folds the same way", same(regionAtLine(state, 2), { start: 2, end: 3 }), JSON.stringify(regionAtLine(state, 2)));
  check("js: a line with no block is not foldable", regionAtLine(state, 5) === null && regionAtLine(state, 7) === null);
  check("js: a block comment folds through its closing line", same(regionAtLine(state, 8), { start: 8, end: 10 }), JSON.stringify(regionAtLine(state, 8)));
  const command = (id: string) => FOLD_COMMANDS.find((c) => c.id === id)!;
  const run = (s: EditorState, id: string) => {
    const spec = foldCommandSpec(s, command(id));
    return spec ? s.update(spec).state : s;
  };
  const foldedCount = (s: EditorState) => {
    let n = 0;
    foldedRanges(s).between(0, s.doc.length, () => {
      n++;
    });
    return n;
  };
  check("fold all folds the function, the inner block and the comment", foldedCount(run(state, "foldAll")) === 3);
  check("unfold all clears every fold", foldedCount(run(run(state, "foldAll"), "unfoldAll")) === 0);
  const away = state.update({ selection: { anchor: state.doc.line(7).from } }).state;
  check("fold level 1 folds the top level regions", foldedCount(run(away, "foldLevel1")) === 2);
  check("fold level 1 skips the region that holds the cursor", foldedCount(run(state, "foldLevel1")) === 1);
  const atInner = state.update({ selection: { anchor: state.doc.line(3).from } }).state;
  const once = run(atInner, "fold");
  check("fold at the cursor folds the innermost block and moves the cursor to its first line", foldedCount(once) === 1 && once.selection.main.head === once.doc.line(2).to, `head ${once.selection.main.head}`);
  const twice = run(once, "fold");
  check("fold again folds the parent", foldedCount(twice) === 2);
  check("unfold opens the region at the cursor line", foldedCount(run(once, "unfold")) === 0);
  check("toggle fold folds then unfolds", foldedCount(run(run(atInner, "toggleFold"), "toggleFold")) === 0);
  check("fold all block comments folds the comment only", foldedCount(run(state, "foldAllBlockComments")) === 1);
  check("fold all except selected leaves the cursor's own region open", foldedCount(run(atInner, "foldAllExcept")) === 1);
  const click = iconClickSpec(state, 1, "plain");
  check("icon click on a foldable line produces a fold", !!click && foldedCount(state.update(click).state) === 1);
  check("icon click on a plain line does nothing", iconClickSpec(state, 5, "plain") === null);
  check("commands do nothing without folding set up", foldCommandSpec(EditorState.create({ doc: JS }), command("foldAll")) === null);
}

{
  const text = ["root:", "  a: 1", "  b:", "    c: 2", "other: 3"].join("\n");
  const state = foldState(text, {}, false);
  check("no language: falls back to indentation", same(regionAtLine(state, 1), { start: 1, end: 4 }) && same(regionAtLine(state, 3), { start: 3, end: 4 }) && regionAtLine(state, 5) === null);
  const forced = foldState(JS, { strategy: "indentation" });
  check("strategy indentation ignores syntax", same(regionAtLine(forced, 1), { start: 1, end: 5 }) && same(regionAtLine(forced, 2), { start: 2, end: 3 }));
  const marked = foldState(["//#region x", "a", "//#region y", "b", "//#endregion", "//#endregion", "c"].join("\n"), { markers: regionMarkersFor("a.ts") });
  check("region markers pair up with nesting, the end marker is included", same(regionAtLine(marked, 1), { start: 1, end: 6 }) && same(regionAtLine(marked, 3), { start: 3, end: 5 }));
}

check("screen aware size rounds down to device pixels but never below one", screenAwareSize(2, 2) === 2 && screenAwareSize(2, 1.5) === 1.5 && screenAwareSize(2, 0.1) === 0.5 && screenAwareSize(1, 1.5) === 1);
check("line cursor: width 0 means 2px", linePiece({ style: "line", widthSetting: 0, charWidth: 7.2, pixelRatio: 2, left: 100 }).width === 2);
check("line cursor: width is capped at the character width", linePiece({ style: "line", widthSetting: 8, charWidth: 7, pixelRatio: 1, left: 100 }).width === 7);
check("line cursor: 2px or wider moves 1px left of the boundary", linePiece({ style: "line", widthSetting: 0, charWidth: 7, pixelRatio: 1, left: 100 }).left === 99);
check("line cursor: not moved at the very left edge", linePiece({ style: "line", widthSetting: 0, charWidth: 7, pixelRatio: 1, left: 0 }).left === 0);
check("thin line cursor is 1px and is not shifted", linePiece({ style: "line-thin", widthSetting: 5, charWidth: 7, pixelRatio: 2, left: 50 }).width === 1 && linePiece({ style: "line-thin", widthSetting: 5, charWidth: 7, pixelRatio: 1, left: 50 }).left === 50);
check("block width: tab and line end use the average character width", blockWidth("\t", 20, 7) === 7 && blockWidth("", null, 7) === 7 && blockWidth("a", 0.5, 7) === 7 && blockWidth("한", 14, 7) === 14);
check("read only editors never blink", effectiveBlinking("smooth", true) === "solid" && effectiveBlinking("smooth", false) === "smooth");

{
  const one = pieceCorners([{ left: 10, right: 50 }], 8);
  check("single line selection is rounded on all corners", same(one, [{ startTop: 0, startBottom: 0, endTop: 0, endBottom: 0 }]) && radiusClasses(one[0]!).length === 4);
  const two = pieceCorners([{ left: 20, right: 80 }, { left: 5, right: 40 }], 8);
  check("second line sticking out to the left: the first line's bottom-left is concave, the second line's top-left round", two[0]!.startBottom === 1 && two[1]!.startTop === 0 && two[0]!.endBottom === 0, JSON.stringify(two));
  const aligned = pieceCorners([{ left: 10, right: 60 }, { left: 11, right: 40 }], 8);
  check("aligned left edges are square", aligned[0]!.startBottom === 2 && aligned[1]!.startTop === 2);
  const indented = pieceCorners([{ left: 10, right: 60 }, { left: 30, right: 50 }], 8);
  check("a line starting inside the previous line gets a concave top-left, the line above a concave bottom-left is not needed", indented[1]!.startTop === 1 && indented[1]!.endTop === 1);
  check("concave corners add fillet pieces", filletPieces(indented[1]!).length === 2 && filletPieces(one[0]!).length === 0);
}

if (failed > 0) {
  console.log(`editor drawing: ${failed} failed`);
  process.exit(1);
}
console.log("editor drawing: all passed");

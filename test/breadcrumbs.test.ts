import { ChangeSet } from "@codemirror/state";
import { crumbsFor, fileItems, highlightParts, listable, mapSymbols, matchLabel, matchRowIndex, navigatePicker, pickerBodyHeight, pickerPlacement, symbolItems, symbolTone, visibleRows } from "../web/breadcrumbModel";
import type { SymbolNode } from "../web/documentSymbols";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const node = (name: string, kind: number, from: number, to: number, children: SymbolNode[] = []): SymbolNode => ({ name, detail: "", kind, from, to, nameFrom: from + 1, nameTo: from + 1 + name.length, children });

{
  const method = node("render", 6, 30, 60);
  const klass = node("Widget", 5, 10, 80, [method, node("update", 6, 62, 78)]);
  const other = node("helper", 12, 90, 120);
  const tree = [klass, other];
  const crumbs = crumbsFor("src/web/Widget.tsx", tree, [klass, method]);
  same("folders, the file, then the symbol path", crumbs.map((c) => [c.kind, c.label]), [["folder", "src"], ["folder", "web"], ["file", "Widget.tsx"], ["symbol", "Widget"], ["symbol", "render"]]);
  same("each file crumb knows its folder", crumbs.slice(0, 3).map((c) => (c.kind === "symbol" ? null : [c.path, c.dir])), [["src", ""], ["src/web", "src"], ["src/web/Widget.tsx", "src/web"]]);
  const [outer, inner] = crumbs.slice(3);
  check("the outermost symbol's siblings are the top level of the document", outer?.kind === "symbol" && outer.siblings === tree);
  check("an inner symbol's siblings are its parent's children", inner?.kind === "symbol" && inner.siblings === klass.children);
  same("a file with no symbols has only path crumbs", crumbsFor("README.md", [], []).map((c) => c.label), ["README.md"]);
  same("a path outside the workspace has no sibling list", [listable("src/a.ts"), listable("../x/a.ts"), listable("a/../b.ts"), listable("/Users/me/a.ts")], [true, false, false, false]);
}

{
  const files = ["src/b.ts", "src/a10.ts", "src/a2.ts", "src/web/Editor.tsx", "src/web/util/x.ts", "README.md", "package.json", "Zed.md"];
  const names = (items: { label: string }[]) => items.map((i) => i.label);
  same("the workspace root lists folders first, then names", names(fileItems(files, [], "")), ["src", "package.json", "README.md", "Zed.md"]);
  same("numbers sort by value, not by digits", names(fileItems(files, [], "src")), ["web", "a2.ts", "a10.ts", "b.ts"]);
  same("folders know they have children, files do not", fileItems(files, [], "src").map((i) => i.hasChildren), [true, false, false, false]);
  same("a folder's children are loaded when asked", names(fileItems(files, [], "src")[0]!.children()), ["util", "Editor.tsx"]);
  same("empty folders show up", names(fileItems(files, ["docs/empty"], "")).slice(0, 2), ["docs", "src"]);
  same("a folder with only an empty folder in it", names(fileItems(files, ["docs/empty"], "docs")), ["empty"]);
  same("a folder that does not exist lists nothing", fileItems(files, [], "nope"), []);
  same("targets carry workspace-relative paths", fileItems(files, [], "src/web").map((i) => i.target), [{ type: "folder", path: "src/web/util" }, { type: "file", path: "src/web/Editor.tsx" }]);
  check("the same list gives the same index (cached)", fileItems(files, [], "src")[0]!.id === fileItems(files, [], "src")[0]!.id);
}

{
  const files = ["a/one.ts", "a/two.ts", "a/deep/three.ts", "b.ts", "c/alpha.ts"];
  const items = fileItems(files, [], "");
  same("collapsed folders show only themselves", visibleRows(items, new Set()).map((r) => r.item.label), ["a", "c", "b.ts"]);
  const rows = visibleRows(items, new Set(["a", "a/deep"]));
  same("an expanded folder shows its children below it", rows.map((r) => [r.item.label, r.depth]), [["a", 0], ["deep", 1], ["three.ts", 2], ["one.ts", 1], ["two.ts", 1], ["c", 0], ["b.ts", 0]]);
  same("children know their parent", rows.filter((r) => r.depth > 0).map((r) => r.parentId), ["a", "a/deep", "a", "a"]);
  same("expanded rows are marked", rows.filter((r) => r.expanded).map((r) => r.item.label), ["a", "deep"]);

  same("highlight mode keeps every row and marks matches", visibleRows(items, new Set(), "b", false).map((r) => [r.item.label, !!r.match]), [["a", false], ["c", false], ["b.ts", true]]);
  const filtered = visibleRows(items, new Set(), "three", true);
  same("filter mode keeps matches and the folders that contain them", filtered.map((r) => [r.item.label, r.depth, r.expanded]), [["a", 0, true], ["deep", 1, true], ["three.ts", 2, false]]);
  same("filter mode with no match is empty", visibleRows(items, new Set(), "zzz", true), []);

  same("a contiguous match wins over a scattered one", matchLabel("tab", "t.a.b tab"), [6, 7, 8]);
  same("letters in order match across the name", matchLabel("wdgt", "Widget"), [0, 2, 3, 5]);
  same("case does not matter", matchLabel("ED", "Editor.tsx"), [0, 1]);
  same("letters out of order do not match", matchLabel("xe", "Editor.tsx"), null);
  same("an empty query matches nothing", matchLabel("", "abc"), null);
  same("a name is cut into bold and plain pieces", highlightParts("Editor.tsx", [0, 1]), [{ text: "Ed", hit: true }, { text: "itor.tsx", hit: false }]);
  same("no match leaves the name whole", highlightParts("abc", null), [{ text: "abc", hit: false }]);

  const marked = visibleRows(items, new Set(["a"]), "t", false);
  same("the next match after the focused row", matchRowIndex(marked, 0, 1), marked.findIndex((r, i) => i > 0 && r.match));
  same("the match at the focused row itself when stepping 0", matchRowIndex(marked, marked.findIndex((r) => r.match), 0), marked.findIndex((r) => r.match));
  same("the previous match wraps around", matchRowIndex(marked, marked.findIndex((r) => r.match), -1), marked.map((r) => !!r.match).lastIndexOf(true));
  same("no rows means no match", matchRowIndex([], 0, 1), -1);
}

{
  const items = fileItems(["a/one.ts", "a/two.ts", "b.ts"], [], "");
  const closed = new Set<string>();
  const rows = visibleRows(items, closed);
  same("down moves to the next row", navigatePicker(rows, "a", "down", closed).focusId, "b.ts");
  same("down at the end stays", navigatePicker(rows, "b.ts", "down", closed).focusId, "b.ts");
  same("up at the top stays", navigatePicker(rows, "a", "up", closed).focusId, "a");
  same("home and end", [navigatePicker(rows, "b.ts", "home", closed).focusId, navigatePicker(rows, "a", "end", closed).focusId], ["a", "b.ts"]);
  same("no focus yet: down starts at the top, up at the bottom", [navigatePicker(rows, null, "down", closed).focusId, navigatePicker(rows, null, "up", closed).focusId], ["a", "b.ts"]);
  const opened = navigatePicker(rows, "a", "right", closed);
  same("right opens a closed folder", [...opened.expanded], ["a"]);
  const openRows = visibleRows(items, opened.expanded);
  same("right on an open folder goes into its first child", navigatePicker(openRows, "a", "right", opened.expanded).focusId, "a/one.ts");
  same("right on a file does nothing", navigatePicker(openRows, "b.ts", "right", opened.expanded).focusId, "b.ts");
  same("left on a child goes to its folder", navigatePicker(openRows, "a/two.ts", "left", opened.expanded).focusId, "a");
  same("left on an open folder closes it", [...navigatePicker(openRows, "a", "left", opened.expanded).expanded], []);
  same("page down jumps by the page size", navigatePicker(openRows, "a", "pageDown", opened.expanded, 2).focusId, "a/two.ts");
  same("nothing to move in an empty list", navigatePicker([], null, "down", closed).focusId, null);
}

{
  const view = { width: 1440, height: 900 };
  const at = pickerPlacement({ left: 100, top: 40, width: 80, height: 22 }, view, null);
  const width = Math.min(1432, Math.max(240, 1432 / 4.17));
  same("below the crumb with an 8px gap", at.top, 70);
  check("a quarter of the window wide", Math.abs(at.width - width) < 1e-9, String(at.width));
  same("up to 300px tall", at.maxHeight, 300);
  same("keyboard: the arrow points 30% into the crumb", [at.left, at.arrowOffset], [100, 24]);

  const narrow = pickerPlacement({ left: 100, top: 40, width: 80, height: 22 }, { width: 800, height: 900 }, null);
  same("never narrower than 240px", narrow.width, 240);
  const right = pickerPlacement({ left: 700, top: 40, width: 80, height: 22 }, { width: 800, height: 900 }, null);
  same("pushed left to stay inside the window", right.left, 800 - 8 - 240);
  same("and the arrow still points at the crumb", right.arrowOffset, 700 + 24 - right.left);
  const low = pickerPlacement({ left: 100, top: 600, width: 80, height: 22 }, { width: 1440, height: 700 }, null);
  same("near the bottom the height shrinks to leave 30px", low.maxHeight, 700 - 630 - 30);
  const short = pickerPlacement({ left: 100, top: 40, width: 80, height: 22 }, { width: 1440, height: 300 }, null);
  same("short windows use 70% of their height", short.maxHeight, 210);
  const tiny = pickerPlacement({ left: 100, top: 40, width: 80, height: 22 }, { width: 1440, height: 200 }, null);
  same("a very short window leaves 30px under the list", tiny.maxHeight, 200 - 70 - 30);

  const mouse = pickerPlacement({ left: 100, top: 40, width: 80, height: 22 }, view, 130);
  same("mouse: the arrow points where it was pressed", mouse.arrowOffset, 30);
  const farMouse = pickerPlacement({ left: 100, top: 40, width: 600, height: 22 }, view, 650);
  check("a press far to the right slides the list along and clamps the arrow", farMouse.arrowOffset === farMouse.width - 16 && farMouse.left > 100);
  same("rows are 22px and the list stops 16px short of the maximum", [pickerBodyHeight(3, 300), pickerBodyHeight(100, 300)], [66, 284]);
}

{
  const klass = node("Widget", 5, 10, 80, [node("render", 6, 30, 60)]);
  const before = mapSymbols([klass], ChangeSet.of({ from: 0, insert: "12345" }, 100));
  same("an insertion before shifts every position", [before[0]!.from, before[0]!.to, before[0]!.nameFrom, before[0]!.children[0]!.from], [15, 85, 16, 35]);
  const inside = mapSymbols([klass], ChangeSet.of({ from: 40, insert: "abc" }, 100));
  same("an insertion inside grows the range", [inside[0]!.from, inside[0]!.to, inside[0]!.children[0]!.to], [10, 83, 63]);
  const atStart = mapSymbols([klass], ChangeSet.of({ from: 10, insert: "zz" }, 100));
  same("an insertion at the very start stays outside the symbol", atStart[0]!.from, 12);
  const atEnd = mapSymbols([klass], ChangeSet.of({ from: 80, insert: "zz" }, 100));
  same("an insertion at the very end stays outside the symbol", atEnd[0]!.to, 80);
  const deleted = mapSymbols([klass], ChangeSet.of({ from: 5, to: 95 }, 100));
  check("a symbol deleted as a whole collapses without inverting", deleted[0]!.from <= deleted[0]!.to && deleted[0]!.nameFrom <= deleted[0]!.nameTo);

  same("kind tones", [5, 10, 24, 6, 9, 12, 8, 11, 13, 22, 7, 14, 2].map(symbolTone), ["class", "class", "class", "function", "function", "function", "variable", "variable", "variable", "variable", "default", "default", "default"]);
  const items = symbolItems([klass]);
  same("symbol rows: label, icon kind, children", [items[0]!.label, items[0]!.icon, items[0]!.hasChildren, items[0]!.children().map((c) => c.label)], ["Widget", { kind: "symbol", symbolKind: 5 }, true, ["render"]]);
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");

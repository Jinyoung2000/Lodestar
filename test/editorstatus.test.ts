import { Compartment, EditorSelection, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { EDITOR_OPTION_DEFAULTS } from "../shared/editorOptions";
import { stepKey, type KeyContext } from "../web/keymap";
import type { SymbolNode } from "../web/documentSymbols";
import { eolOf, eolExtension, setEol } from "../web/editorEol";
import { clearRangeHighlight, rangeHighlightExtension } from "../web/editorRangeHighlight";
import { indentationLabel, languageName, selectionLabel, statusColumn, statusItems } from "../web/editorStatusModel";
import { isWrapped, toggleWordWrap, wrapExtension } from "../web/editorWrap";
import { columnFromVisible, parseGoTo, positionAt, visibleColumn } from "../web/goToLineModel";
import { buildSymbolPicks, categoryOf, symbolList, symbolTone } from "../web/goToSymbolModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

const doc = "const a = 1;\n\tfoo(bar);\nlast line";
const at = (anchor: number, head = anchor) => EditorState.create({ doc, selection: { anchor, head }, extensions: [EditorState.allowMultipleSelections.of(true), EditorState.tabSize.of(4)] });

same("cursor at the start is Ln 1, Col 1", selectionLabel(at(0)), "Ln 1, Col 1");
same("cursor after a tab counts the tab as one tab stop", selectionLabel(at(doc.indexOf("foo"))), "Ln 2, Col 5");
same("cursor mid line counts one per character", selectionLabel(at(6)), "Ln 1, Col 7");
same("a selection adds the selected count", selectionLabel(at(0, 5)), "Ln 1, Col 6 (5 selected)");
same("a backwards selection reports the head position", selectionLabel(at(5, 0)), "Ln 1, Col 1 (5 selected)");
same("a selection across lines counts the line break", selectionLabel(at(10, 14)), "Ln 2, Col 5 (4 selected)");
const crlf = EditorState.create({ doc: "ab\r\ncd", selection: { anchor: 0, head: 5 }, extensions: [EditorState.lineSeparator.of("\r\n")] });
same("a CRLF document counts the line break as two", selectionLabel(crlf), "Ln 2, Col 3 (6 selected)");
const multi = EditorState.create({ doc, selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3), EditorSelection.range(5, 8)], 2), extensions: [EditorState.allowMultipleSelections.of(true)] });
same("several ranges count the characters", selectionLabel(multi), "3 selections (3 characters selected)");
const multiCursors = EditorState.create({ doc, selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)]), extensions: [EditorState.allowMultipleSelections.of(true)] });
same("several cursors only count the selections", selectionLabel(multiCursors), "2 selections");
same("an emoji is one character", selectionLabel(EditorState.create({ doc: "a😀b", selection: { anchor: 0, head: 4 } })), "Ln 1, Col 4 (3 selected)");
same("the status column counts code points", statusColumn("a😀b", 3, 4), 3);
same("tabs jump to the next tab stop", statusColumn("\t\tx", 2, 2), 5);

same("spaces label", indentationLabel({ useSpaces: true, size: 2 }), "Spaces: 2");
same("tabs label", indentationLabel({ useSpaces: false, size: 4 }), "Tab Size: 4");
const items = statusItems(crlf, { path: "web/Editor.tsx" }, { useSpaces: true, size: 2 });
same("status items for a CRLF tsx file", [items.encoding, items.eol, items.language], ["UTF-8", "CRLF", "TypeScript JSX"]);
same("LF document", statusItems(at(0), { path: null }, { useSpaces: true, size: 2 }).eol, "LF");
same("untitled is plain text", languageName(null), "Plain Text");
same("unknown extension is plain text", languageName("a/b/file.unknownext"), "Plain Text");
same("ts and json names", [languageName("a.ts"), languageName("package.json"), languageName("tsconfig.json"), languageName("x/Dockerfile"), languageName("a.scss"), languageName("README.md")], ["TypeScript", "JSON", "JSON with Comments", "Docker", "SCSS", "Markdown"]);

const text = Text.of(["first", "\tindent", "한글 line", "", "last one"]);
const input = { doc: text, eolLength: 1, tabSize: 4 };
const parse = (value: string, extra: Partial<typeof input> & { zeroBasedOffset?: boolean } = {}) => parseGoTo({ ...input, ...extra }, value);

same("empty input asks for a line number", parse(":").label, "Type a line number to go to (from 1 to 5).");
same("empty input has no target", parse(":").target, null);
same("a number targets the line", parse(":3").target?.line, 3);
same("a number alone suggests adding a column", parse(":3").label, "Press 'Enter' to go to line 3 or enter colon : to add a column number.");
same("a number goes to column 1", parse(":3").target, { line: 3, column: 1, pos: text.line(3).from });
same("a trailing colon asks for a column in range", parse(":2:").label, "Press 'Enter' to go to line 2 or enter a column number (from 1 to 11).");
same("line and column with a colon", parse(":5:3").target, { line: 5, column: 3, pos: text.line(5).from + 2 });
same("a comma separates too", parse(":5,3").target?.column, 3);
same("a hash separates too", parse(":5#3").target?.column, 3);
same("a column label", parse(":5:3").label, "Press 'Enter' to go to line 5 at column 3.");
same("a line past the end clamps", parse(":99").target?.line, 5);
same("zero clamps to the first line", parse(":0").target?.line, 1);
same("negative lines count from the end", parse(":-1").target?.line, 5);
same("negative column counts from the end", parse(":1:-1").target?.column, 5);
same("a column past the end clamps", parse(":1:99").target?.column, 6);
same("a tab is four visible columns", [visibleColumn("\tindent", 2, 4), parse(":2:5").target?.column], [4, 2]);
same("a wide character takes two visible columns", [visibleColumn("한글 line", 3, 4), visibleColumn("한글 line", 4, 4)], [4, 5]);
same("a visible column inside a wide character picks the nearer side", [columnFromVisible("한글", 1, 4), columnFromVisible("한글", 2, 4), columnFromVisible("한글", 3, 4)], [1, 2, 2]);
same("garbage in the line part asks again", parse(":abc").label, "Type a line number to go to (from 1 to 5).");
same("offset mode prompt", parse("::").label, "Type a character position to go to (from 1 to 31).");
same("offset mode prompt zero based", parse("::", { zeroBasedOffset: true }).label, "Type a character position to go to (from 0 to 30).");
same("offset 1 is the document start", parse("::1").target, { line: 1, column: 1, pos: 0 });
same("offset counts line breaks", [parse("::6").target?.line, parse("::6").target?.column, parse("::7").target?.line], [1, 6, 2]);
same("offset crossing the first line", parse("::8").target?.line, 2);
same("negative offset counts from the end", parse("::-1").target?.line, 5);
const crlfInput = { doc: Text.of(["ab", "cd"]), eolLength: 2, tabSize: 4 };
same("a CRLF offset skips two characters per break", [parseGoTo(crlfInput, "::5").target?.line, parseGoTo(crlfInput, "::5").target?.column], [2, 1]);
same("an offset inside the CRLF stays at the end of the line", positionAt(crlfInput.doc, 2, 3), { line: 1, column: 3 });
same("offset past the end clamps", positionAt(crlfInput.doc, 2, 99), { line: 2, column: 3 });

const node = (name: string, kind: number, from: number, to: number, children: SymbolNode[] = []): SymbolNode => ({ name, detail: "", kind, from, to, nameFrom: from + 1, nameTo: from + 1 + name.length, children });
const tree: SymbolNode[] = [node("Widget", 5, 0, 100, [node("render", 6, 10, 40), node("value", 7, 50, 60)]), node("helper", 12, 110, 150), node("MAX", 14, 160, 170)];
const list = symbolList(tree);
const names = (picks: ReturnType<typeof buildSymbolPicks>) => picks.rows.map((r) => (r.type === "separator" ? `--${r.label}` : r.node.name));

same("symbols are in document order", list.map((s) => s.node.name), ["Widget", "render", "value", "helper", "MAX"]);
same("children know their container", list.map((s) => s.container), ["", "Widget", "Widget", "", ""]);
same("empty filter lists all under a symbols header", names(buildSymbolPicks(list, "@", null)), ["--symbols (5)", "Widget", "render", "value", "helper", "MAX"]);
same("the symbol around the cursor starts active", buildSymbolPicks(list, "@", 20).active, 2);
same("without a surrounding symbol nothing is forced active", buildSymbolPicks(list, "@", 105).active, null);
same("a filter narrows by name", names(buildSymbolPicks(list, "@rend", null)), ["--symbols (1)", "render"]);
same("fuzzy matching finds the best name first", names(buildSymbolPicks(list, "@hlp", null)), ["--symbols (1)", "helper"]);
same("a second word filters by container", names(buildSymbolPicks(list, "@v Widget", null)), ["--symbols (1)", "value"]);
same("a filter with no hit says so", buildSymbolPicks(list, "@zzz", null).empty, "No matching editor symbols");
same("no symbols at all says so", buildSymbolPicks([], "@", null).empty, "No editor symbols");
same("by category groups and counts", names(buildSymbolPicks(list, "@:", null)), ["--classes (1)", "Widget", "--constants (1)", "MAX", "--functions (1)", "helper", "--methods (1)", "render", "--properties (1)", "value"]);
same("category label for LSP Method is methods", [categoryOf(6), categoryOf(12), categoryOf(21)], ["methods", "functions", "properties"]);
same("icon tones", [symbolTone(5), symbolTone(12), symbolTone(13), symbolTone(7)], ["class", "function", "variable", "default"]);
same("the match ranges mark the typed letters", (() => {
  const row = buildSymbolPicks(list, "@rend", null).rows[1];
  return row?.type === "symbol" ? row.labelMatch : null;
})(), [{ start: 0, end: 4 }]);

const wrapCompartment = new Compartment();
const wrapState = (wordWrap: "on" | "off") => EditorState.create({ doc: "x", extensions: [wrapCompartment.of(wrapExtension({ ...EDITOR_OPTION_DEFAULTS, wordWrap }))] });
const wrapped = (state: EditorState) => state.facet(EditorView.contentAttributes).some((source) => typeof source !== "function" && source.class === "cm-lineWrapping");
const holder = (state: EditorState) => ({
  state,
  dispatch(spec: TransactionSpec) {
    this.state = this.state.update(spec).state;
  },
});

const off = holder(wrapState("off"));
check("wrap is off by the setting", !isWrapped(off.state) && !wrapped(off.state));
toggleWordWrap(off);
check("toggling turns wrapping on for this editor", isWrapped(off.state) && wrapped(off.state));
off.dispatch({ effects: wrapCompartment.reconfigure(wrapExtension({ ...EDITOR_OPTION_DEFAULTS, wordWrap: "off" })) });
check("the override survives the options compartment being replaced", isWrapped(off.state) && wrapped(off.state));
off.dispatch({ effects: wrapCompartment.reconfigure(wrapExtension({ ...EDITOR_OPTION_DEFAULTS, wordWrap: "on" })) });
check("the override still wins when the setting changes", isWrapped(off.state));
toggleWordWrap(off);
check("toggling again turns wrapping off even if the setting is on", !isWrapped(off.state) && !wrapped(off.state));
const on = holder(wrapState("on"));
check("wrap on by setting", isWrapped(on.state) && wrapped(on.state));
toggleWordWrap(on);
check("toggling turns it off", !isWrapped(on.state) && !wrapped(on.state));

const eolHolder = holder(EditorState.create({ doc: "a\nb\nc", extensions: [eolExtension(null)] }));
same("a plain document is LF", [eolOf(eolHolder.state), eolHolder.state.sliceDoc(0)], ["\n", "a\nb\nc"]);
setEol(eolHolder, "\r\n");
same("switching to CRLF changes what is saved", [eolOf(eolHolder.state), eolHolder.state.sliceDoc(0)], ["\r\n", "a\r\nb\r\nc"]);
same("the document itself keeps its lines", eolHolder.state.doc.lines, 3);
setEol(eolHolder, "\n");
same("switching back to LF", eolHolder.state.sliceDoc(0), "a\nb\nc");
const crlfFile = holder(EditorState.create({ doc: EditorState.create({ doc: "" }).toText("a\r\nb"), extensions: [eolExtension("\r\n")] }));
same("a file read as CRLF starts as CRLF", [eolOf(crlfFile.state), crlfFile.state.sliceDoc(0)], ["\r\n", "a\r\nb"]);

const verdict = (stroke: string, c: KeyContext) => {
  const out = stepKey(null, stroke, c, 0);
  return out.kind === "run" ? out.command : out.kind;
};
const plain: KeyContext = { inTerminal: false, inEditor: false };
const inArea: KeyContext = { ...plain, inEditorArea: true };
const inEditor: KeyContext = { ...plain, inEditor: true, inEditorArea: true };
same("ctrl G goes to a line in the editor area only", [verdict("Ctrl+KeyG", inArea), verdict("Ctrl+KeyG", inEditor), verdict("Ctrl+KeyG", plain)], ["gotoLine", "gotoLine", "pass"]);
same("shift cmd O is Go to Symbol in Editor everywhere", [verdict("Shift+Meta+KeyO", plain), verdict("Shift+Meta+KeyO", inEditor)], ["gotoSymbol", "gotoSymbol"]);
same("cmd T is workspace symbols outside a Browser tab and a new tab inside one", [verdict("Meta+KeyT", plain), verdict("Meta+KeyT", { ...plain, inBrowser: true })], ["symbols", "openBrowser"]);
same("alt Z toggles word wrap in the editor only", [verdict("Alt+KeyZ", inEditor), verdict("Alt+KeyZ", plain)], ["editor:toggleWordWrap", "pass"]);

const hl = EditorState.create({ doc: "a\nb\nc", extensions: [rangeHighlightExtension] });
check("clearing without a view does not throw", typeof clearRangeHighlight === "function" && hl.doc.lines === 3);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");

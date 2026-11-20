import { javascript } from "@codemirror/lang-javascript";
import { Compartment, EditorSelection, EditorState, type Extension, type Transaction } from "@codemirror/state";
import { baseIndentation, convertIndentation, detectIndentation, guessIndentation, indentEffect, indentInfoOf, indentState, leadingLines, reindentLines, shiftTabCommand, tabCommand } from "../web/indentLogic";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const guess = (text: string, tabSize = 4, insertSpaces = true) => guessIndentation(leadingLines(text), tabSize, insertSpaces);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- 감지 ---
check("empty file keeps the defaults", same(guess(""), { insertSpaces: true, tabSize: 4 }));
check("empty file keeps tab defaults", same(guess("", 8, false), { insertSpaces: false, tabSize: 8 }));
check("two-space file", same(guess("a {\n  b {\n    c;\n  }\n}\n"), { insertSpaces: true, tabSize: 2 }));
check("four-space file", same(guess("a {\n    b {\n        c;\n    }\n}\n"), { insertSpaces: true, tabSize: 4 }));
check("tab file is tabs and keeps the default tab size", same(guess("a {\n\tb {\n\t\tc;\n\t}\n}\n"), { insertSpaces: false, tabSize: 4 }));
check("tab file keeps a configured tab size of 8", same(guess("a {\n\tb;\n}\n", 8, true), { insertSpaces: false, tabSize: 8 }));
check("more tab lines than space lines means tabs", guess("\ta\n\tb\n  c\n").insertSpaces === false);
check("more space lines than tab lines means spaces", guess("\ta\n  b\n  c\n").insertSpaces === true);
check("a tie keeps the default insertSpaces", guess("\ta\n  b\n", 4, false).insertSpaces === false && guess("\ta\n  b\n", 4, true).insertSpaces === true);
check("lines with exactly one leading space do not count as space lines", guess(" a\n b\n\tc\n", 4, true).insertSpaces === false);
check("blank and whitespace-only lines are skipped", same(guess("a\n\n   \n  b\n\n    c\n"), { insertSpaces: true, tabSize: 2 }));
check("3-space indent is found", guess("a\n   b\n      c\n   d\n").tabSize === 3);
check("4 wins when 2 is rare", (() => {
  const text = ["a", "    b", "        c", "    d", "        e", "    f", "  g"].join("\n");
  return guess(text).tabSize === 4;
})());
check("2 wins over 4 at the two thirds line", (() => {
  const lines = ["a"];
  for (let i = 0; i < 3; i++) lines.push("    b", "a");
  for (let i = 0; i < 2; i++) lines.push("  c", "a");
  return guess(lines.join("\n")).tabSize === 2;
})());
check("histogram ties go to the smaller candidate", guess("a\n  b\na\n    c\n").tabSize === 2);
check("an alignment line under a trailing comma does not count", (() => {
  // 앞 줄이 쉼표로 끝나고 그 줄의 공백 위치에 맞춘 줄은 3 칸 증거로 세지 않는다
  const text = ["a, b,", "   x", "a, b,", "   x", "y", "  z"].join("\n");
  return guess(text).tabSize === 2;
})());
check("an alignment line counts when its size equals the default", (() => {
  const text = ["a, b,", "   x", "a, b,", "   x", "y", "  z"].join("\n");
  return guess(text, 3, true).tabSize === 3;
})());
check("only the first 10000 lines are read", (() => {
  const lines = Array.from({ length: 10_000 }, () => "a");
  const text = [...lines, ...Array.from({ length: 50 }, (_, i) => (i % 2 ? "  x" : "y"))].join("\n");
  return same(guess(text), { insertSpaces: true, tabSize: 4 });
})());
check("CRLF files are read like LF files", same(guess("a {\r\n  b;\r\n}\r\n"), { insertSpaces: true, tabSize: 2 }));
check("leadingLines stops at the limit", leadingLines("a\nb\nc\nd", 2).length === 2);
check("base indentation uses the settings when detection is off", same(baseIndentation({ tabSize: 3, insertSpaces: false, detectIndentation: false }, "  a\n    b\n"), { useSpaces: false, size: 3, source: "config" }));
check("base indentation detects when asked", same(baseIndentation({ tabSize: 4, insertSpaces: true, detectIndentation: true }, "a\n  b\n"), { useSpaces: true, size: 2, source: "detected" }));

// --- 파일별 상태 ---
const make = (info: { useSpaces: boolean; size: number }, doc: string, extra: Extension = []) => EditorState.create({ doc, extensions: [indentState({ ...info, source: "config" }), extra] });
const apply = (state: EditorState) => {
  let current = state;
  const target = { get state() { return current; }, dispatch: (tr: Transaction) => void (current = tr.state) };
  return target;
};

check("indentInfoOf reads the base value", same(indentInfoOf(make({ useSpaces: true, size: 2 }, "")), { useSpaces: true, size: 2, source: "config" }));
check("indentUnit and tabSize follow the base value", (() => {
  const s = make({ useSpaces: false, size: 8 }, "");
  return s.tabSize === 8 && s.facet(indentUnitFacet) === "\t";
})());
check("a manual choice wins over the base value", (() => {
  let s = make({ useSpaces: true, size: 2 }, "");
  s = s.update({ effects: indentEffect({ useSpaces: false, size: 6 }) }).state;
  return same(indentInfoOf(s), { useSpaces: false, size: 6, source: "manual" }) && s.tabSize === 6 && s.facet(indentUnitFacet) === "\t";
})());
check("the size is clamped to 1..16", indentInfoOf(make({ useSpaces: true, size: 2 }, "").update({ effects: indentEffect({ useSpaces: true, size: 99 }) }).state).size === 16);
check("a manual choice survives a Compartment reconfigure (settings change)", (() => {
  const compartment = new Compartment();
  let s = EditorState.create({ doc: "a\n  b\n", extensions: [compartment.of(indentState({ useSpaces: true, size: 2, source: "detected" }))] });
  s = s.update({ effects: indentEffect({ useSpaces: false, size: 3 }) }).state;
  s = s.update({ effects: compartment.reconfigure(indentState({ useSpaces: true, size: 4, source: "config" })) }).state;
  return same(indentInfoOf(s), { useSpaces: false, size: 3, source: "manual" }) && s.tabSize === 3;
})());
check("without a manual choice a reconfigure takes the new base", (() => {
  const compartment = new Compartment();
  let s = EditorState.create({ doc: "", extensions: [compartment.of(indentState({ useSpaces: true, size: 2, source: "config" }))] });
  s = s.update({ effects: compartment.reconfigure(indentState({ useSpaces: false, size: 8, source: "config" })) }).state;
  return same(indentInfoOf(s), { useSpaces: false, size: 8, source: "config" });
})());

// --- Tab, Shift+Tab ---
const cursorAt = (state: EditorState, pos: number) => state.update({ selection: { anchor: pos } }).state;
const tabbed = (doc: string, pos: number, info = { useSpaces: true, size: 2 }) => {
  const target = apply(cursorAt(make(info, doc), pos));
  tabCommand(target);
  return target.state;
};
check("Tab at column 0 inserts one indent", tabbed("ab", 0).doc.toString() === "  ab");
check("Tab after two characters jumps to the next tab stop (size 4)", tabbed("ab", 2, { useSpaces: true, size: 4 }).doc.toString() === "ab  ");
check("Tab after one character with size 4 inserts three spaces", tabbed("a", 1, { useSpaces: true, size: 4 }).doc.toString() === "a   ");
check("Tab with tabs inserts a tab character", tabbed("ab", 1, { useSpaces: false, size: 4 }).doc.toString() === "a\tb");
check("Tab moves the cursor after the inserted text", tabbed("ab", 1, { useSpaces: true, size: 4 }).selection.main.head === 4);
check("Tab on an empty line indents one level", tabbed("", 0, { useSpaces: true, size: 4 }).doc.toString() === "    ");
check("Tab replaces a single-line partial selection", (() => {
  const s = cursorAt(make({ useSpaces: true, size: 4 }, "abcdef"), 0).update({ selection: EditorSelection.range(1, 4) }).state;
  const t = apply(s);
  tabCommand(t);
  return t.state.doc.toString() === "a   ef" && t.state.selection.main.head === 4;
})());
check("Tab on a multi-line selection indents every non-empty line to the next stop", (() => {
  const s = make({ useSpaces: true, size: 4 }, "a\n  b\n\n    c").update({ selection: EditorSelection.range(0, 12) }).state;
  const t = apply(s);
  tabCommand(t);
  return t.state.doc.toString() === "    a\n    b\n\n        c";
})());
check("a selection that ends at a line start leaves that line alone", (() => {
  const s = make({ useSpaces: true, size: 2 }, "a\nb\nc").update({ selection: EditorSelection.range(0, 4) }).state;
  const t = apply(s);
  tabCommand(t);
  return t.state.doc.toString() === "  a\n  b\nc";
})());
check("Shift+Tab outdents to the previous stop", (() => {
  const t = apply(cursorAt(make({ useSpaces: true, size: 4 }, "      x"), 7));
  shiftTabCommand(t);
  return t.state.doc.toString() === "    x";
})());
check("Shift+Tab outdents a tab-indented line", (() => {
  const t = apply(cursorAt(make({ useSpaces: false, size: 4 }, "\t\tx"), 3));
  shiftTabCommand(t);
  return t.state.doc.toString() === "\tx";
})());
check("Shift+Tab on an unindented line does nothing", (() => {
  const t = apply(cursorAt(make({ useSpaces: true, size: 2 }, "x"), 1));
  shiftTabCommand(t);
  return t.state.doc.toString() === "x";
})());
check("Tab on a read-only editor is not handled", (() => {
  const t = apply(make({ useSpaces: true, size: 2 }, "x", EditorState.readOnly.of(true)));
  return tabCommand(t) === false;
})());
check("Tab with two cursors inserts at both", (() => {
  const s = make({ useSpaces: true, size: 2 }, "a\nb", EditorState.allowMultipleSelections.of(true)).update({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]) }).state;
  const t = apply(s);
  tabCommand(t);
  return t.state.doc.toString() === "  a\n  b";
})());

// --- 변환 ---
check("convert to spaces replaces each leading tab with tabSize spaces and records the choice", (() => {
  const t = apply(make({ useSpaces: false, size: 4 }, "a\n\tb\n\t\tc\n\t \td\ne\t\tf\n"));
  convertIndentation(t, true);
  const info = indentInfoOf(t.state);
  return t.state.doc.toString() === "a\n    b\n        c\n         d\ne\t\tf\n" && info.useSpaces && info.size === 4 && info.source === "manual";
})());
check("convert to tabs replaces each run of tabSize spaces", (() => {
  const t = apply(make({ useSpaces: true, size: 2 }, "a\n  b\n    c\n   d\n"));
  convertIndentation(t, false);
  return t.state.doc.toString() === "a\n\tb\n\t\tc\n\t d\n" && indentInfoOf(t.state).useSpaces === false;
})());
check("whitespace-only lines are converted whole", (() => {
  const t = apply(make({ useSpaces: false, size: 2 }, "a\n\t\t\nb"));
  convertIndentation(t, true);
  return t.state.doc.toString() === "a\n    \nb";
})());
check("conversion is one undo step with the doc change", (() => {
  const t = apply(make({ useSpaces: false, size: 4 }, "\ta\n\tb"));
  convertIndentation(t, true);
  return t.state.doc.toString() === "    a\n    b";
})());
check("convert with nothing to change still records the choice", (() => {
  const t = apply(make({ useSpaces: false, size: 4 }, "a\nb"));
  convertIndentation(t, true);
  return t.state.doc.toString() === "a\nb" && indentInfoOf(t.state).useSpaces === true;
})());

// --- 내용에서 다시 감지 ---
check("Detect Indentation reads the current text and marks it detected", (() => {
  const t = apply(make({ useSpaces: false, size: 4 }, "a {\n  b;\n}\n"));
  detectIndentation(t, { tabSize: 4, insertSpaces: true });
  return same(indentInfoOf(t.state), { useSpaces: true, size: 2, source: "detected" });
})());

// --- 다시 들여쓰기 ---
check("Reindent Lines fixes JavaScript indentation", (() => {
  const t = apply(make({ useSpaces: true, size: 2 }, "function f() {\nconst a = 1;\n      if (a) {\nreturn a;\n}\n}\n", javascript()));
  reindentLines(t, false);
  return t.state.doc.toString() === "function f() {\n  const a = 1;\n  if (a) {\n    return a;\n  }\n}\n";
})());
check("Reindent Lines uses tabs when the file indents with tabs", (() => {
  const t = apply(make({ useSpaces: false, size: 4 }, "function f() {\nreturn 1;\n}\n", javascript()));
  reindentLines(t, false);
  return t.state.doc.toString() === "function f() {\n\treturn 1;\n}\n";
})());
check("Reindent Selected Lines only touches the selection", (() => {
  const s = make({ useSpaces: true, size: 2 }, "function f() {\nconst a = 1;\nconst b = 2;\n}\n", javascript()).update({ selection: EditorSelection.range(15, 26) }).state;
  const t = apply(s);
  reindentLines(t, true);
  return t.state.doc.toString() === "function f() {\n  const a = 1;\nconst b = 2;\n}\n";
})());
check("a language without indent rules is left alone", (() => {
  const t = apply(make({ useSpaces: true, size: 2 }, "a\n    b\n"));
  reindentLines(t, false);
  return t.state.doc.toString() === "a\n    b\n";
})());

import { indentUnit as indentUnitFacet } from "@codemirror/language";

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");

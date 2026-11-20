// 코드 액션 메뉴(그룹, 정렬, 키 이동)와 전구(요청 조건, 자리, 아이콘, 툴팁, 메뉴 자리)의 순수 로직.
// 실행: npm test
import {
  ACTION_GROUPS,
  buildRows,
  focusableIndexes,
  groupOf,
  hasAutoFix,
  indentColumns,
  isSourceAction,
  kindContains,
  lightbulbInfo,
  placeLightbulb,
  placeMenu,
  shouldRequestLightbulb,
  sortActions,
  stepFocus,
  type MenuRow,
} from "../web/codeActionModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

// ---- kind 와 그룹 ----
check("refactor contains refactor.extract", kindContains("refactor", "refactor.extract") && kindContains("refactor", "refactor"));
check("refactor.extract does not contain refactor.inline or refactorX", !kindContains("refactor.extract", "refactor.inline") && !kindContains("refactor", "refactorX"));
check("the empty kind contains everything", kindContains("", "quickfix") && kindContains("", "@@none@@"));
check("quickfix goes to Quick Fix", groupOf("quickfix").title === "Quick Fix" && groupOf("quickfix.fixAll").title === "Quick Fix");
check("refactor groups map by kind", groupOf("refactor.extract.function").title === "Extract" && groupOf("refactor.inline.variable").title === "Inline" && groupOf("refactor.rewrite.function.convertToArrow").title === "Rewrite" && groupOf("refactor.move.newFile").title === "Move");
check("a bare refactor kind falls to More Actions...", groupOf("refactor").title === "More Actions..." && groupOf(undefined).title === "More Actions...");
check("group order is Quick Fix first, More Actions... last", ACTION_GROUPS[0]!.id === "quickfix" && ACTION_GROUPS[ACTION_GROUPS.length - 1]!.id === "other");
check("source actions are detected", isSourceAction({ title: "x", kind: "source.organizeImports" }) && !isSourceAction({ title: "x", kind: "refactor" }) && !isSourceAction({ title: "x" }));

// ---- 정렬과 행 ----
const fix = { title: "Add import", kind: "quickfix", diagnostics: [{}] };
const preferred = { title: "Fix spelling", kind: "quickfix", diagnostics: [{}], isPreferred: true };
const extract = { title: "Extract to constant", kind: "refactor.extract.constant" };
const rewrite = { title: "Convert to arrow function", kind: "refactor.rewrite.function.convertToArrow" };
const noKind = { title: "Odd action" };
const sorted = sortActions([extract, fix, preferred, rewrite]);
check("diagnostic fixes first, preferred before others", sorted.map((a) => a.title).join("|") === "Fix spelling|Add import|Extract to constant|Convert to arrow function");

const rows = buildRows([extract, rewrite, fix, preferred, noKind], { showHeaders: true, showDisabled: false });
const shape = rows.map((r) => (r.type === "header" ? `# ${r.title}` : r.label));
check("headers group Quick Fix, Extract, Rewrite, More Actions...", shape.join(" / ") === "# Quick Fix / Fix spelling / Add import / # Extract / Extract to constant / # Rewrite / Convert to arrow function / # More Actions... / Odd action", shape.join(" / "));
const refactorRow = rows.find((r): r is Extract<MenuRow, { type: "action" }> => r.type === "action" && r.label === "Extract to constant")!;
check("refactor rows carry the Refactor... key hint, quick fixes do not", refactorRow.hint === "⌃⇧R" && (rows.find((r) => r.type === "action" && r.label === "Add import") as { hint: string | null }).hint === null);
check("extract and rewrite can preview, a quick fix without an edit cannot", refactorRow.canPreview && !(rows.find((r) => r.type === "action" && r.label === "Add import") as { canPreview: boolean }).canPreview);
check("a quick fix with an edit can preview", (buildRows([{ title: "x", kind: "quickfix", edit: { changes: {} } }], { showHeaders: true, showDisabled: false })[1] as { canPreview: boolean }).canPreview);

const flat = buildRows([extract, fix], { showHeaders: false, showDisabled: false });
check("without headers the list is flat and has no hints", flat.length === 2 && flat.every((r) => r.type === "action" && r.hint === null));

const disabled = { title: "Extract to function", kind: "refactor.extract.function", disabled: { reason: "Cannot extract range" } };
check("disabled actions are hidden until Show Disabled", buildRows([fix, disabled], { showHeaders: true, showDisabled: false }).every((r) => r.type === "header" || !r.disabled));
const shown = buildRows([fix, disabled], { showHeaders: true, showDisabled: true });
const shownDisabled = shown.find((r) => r.type === "action" && r.disabled) as Extract<MenuRow, { type: "action" }>;
check("a disabled row shows its reason and cannot preview", shownDisabled?.label === "Cannot extract range" && !shownDisabled.canPreview);

// ---- 키 이동 ----
const focusable = focusableIndexes(shown);
check("focus skips headers and disabled rows", focusable.length === 1 && shown[focusable[0]!]!.type === "action");
const list = buildRows([fix, preferred, extract], { showHeaders: true, showDisabled: false });
const first = focusableIndexes(list)[0]!;
check("down moves to the next action across a header", stepFocus(list, first, 1) === first + 1 && (list[stepFocus(list, stepFocus(list, first, 1), 1)] as { label: string }).label === "Extract to constant");
check("up from the first wraps to the last", (list[stepFocus(list, first, -1)] as { label: string }).label === "Extract to constant");
check("down from the last wraps to the first", stepFocus(list, stepFocus(list, first, -1), 1) === first);
check("no focusable rows gives -1", stepFocus([{ type: "header", title: "x" }], 0, 1) === -1);

// ---- 자동 수정 표시 ----
check("a preferred quickfix means auto fix", hasAutoFix([fix, preferred]) && !hasAutoFix([fix, extract]));
check("a preferred refactor does not count", !hasAutoFix([{ title: "x", kind: "refactor", isPreferred: true }]));
check("a disabled preferred fix does not count", !hasAutoFix([{ ...preferred, disabled: { reason: "no" } }]));
const plain = lightbulbInfo([extract], { autoFix: "⌥⌘.", quickFix: "⌘." });
check("plain bulb title shows the quick fix key", plain.icon === "light-bulb" && plain.title === "Show Code Actions (⌘.)");
const auto = lightbulbInfo([preferred], { autoFix: "⌥⌘.", quickFix: "⌘." });
check("auto fix bulb uses the autofix icon and the preferred title", auto.icon === "lightbulb-autofix" && auto.title === "Show Code Actions. Preferred Quick Fix Available (⌥⌘.)");
check("without key labels the title is plain", lightbulbInfo([extract], { autoFix: "", quickFix: "" }).title === "Show Code Actions" && lightbulbInfo([preferred], { autoFix: "", quickFix: "⌘." }).title === "Show Code Actions");

// ---- 전구 요청 조건(onCode) ----
check("off never requests", !shouldRequestLightbulb("off", true, "const a = 1;", 3));
check("on always requests, even on an empty line", shouldRequestLightbulb("on", true, "", 1));
check("onCode skips an empty line", !shouldRequestLightbulb("onCode", true, "", 1));
check("onCode skips leading whitespace at column 1", !shouldRequestLightbulb("onCode", true, "  foo", 1) && shouldRequestLightbulb("onCode", true, "foo", 1));
check("onCode skips trailing whitespace at the end", !shouldRequestLightbulb("onCode", true, "foo  ", 6) && shouldRequestLightbulb("onCode", true, "foo", 4));
check("onCode skips between two whitespace characters", !shouldRequestLightbulb("onCode", true, "a   b", 3) && shouldRequestLightbulb("onCode", true, "a b", 2));
check("onCode requests for a selection anywhere", shouldRequestLightbulb("onCode", false, "   ", 2));

// ---- 들여쓰기 칸 수 ----
check("indent columns count spaces and expand tabs", indentColumns("    x", 2) === 4 && indentColumns("\tx", 4) === 4 && indentColumns(" \tx", 4) === 4 && indentColumns("x", 4) === 0);

// ---- 전구 자리 ----
const doc = ["import a from 'a';", "import b from 'b';", "", "function f() {", "  const x = 1;", "    return x;", "  }", "}", "last();"];
const at = (line: number, column = 1, overrides: Partial<Parameters<typeof placeLightbulb>[0]> = {}) =>
  placeLightbulb({
    line,
    column,
    lineCount: doc.length,
    lineText: (n) => doc[n - 1] ?? "",
    indentWidth: indentColumns(doc[line - 1] ?? "", 2),
    spaceWidth: 7.2,
    ...overrides,
  });
check("a deeply indented line puts the bulb at its own column 1", JSON.stringify(at(6)) === JSON.stringify({ kind: "widget", line: 6, column: 1 }));
check("two columns of indent (14px) is not enough room", at(5).kind !== "widget" || (at(5) as { line: number }).line !== 5);
const imports = ["import a;", "import b;", "import c;"];
check("with no blank or indented neighbour the bulb goes to the gutter", JSON.stringify(at(2, 1, { lineText: (n) => imports[n - 1] ?? "", lineCount: 3, indentWidth: 0 })) === JSON.stringify({ kind: "gutter", line: 2 }));
check("a blank line below receives the bulb", JSON.stringify(at(2)) === JSON.stringify({ kind: "widget", line: 3, column: 1 }));
check("a line before a blank line moves the bulb onto the blank line below", JSON.stringify(at(2, 3, { lineText: (n) => ["import a;", "import b;", "", "x"][n - 1] ?? "", lineCount: 4 })) === JSON.stringify({ kind: "widget", line: 3, column: 1 }));
check("an indented previous line wins over the line below", JSON.stringify(at(4)) === JSON.stringify({ kind: "widget", line: 3, column: 1 }), JSON.stringify(at(4)));
check("a top-level line right after an indented one uses the line above", JSON.stringify(at(8)) === JSON.stringify({ kind: "widget", line: 7, column: 1 }) || JSON.stringify(at(8)) === JSON.stringify({ kind: "widget", line: 7, column: 2 }), JSON.stringify(at(8)));
check("line 1 with nothing indented goes to the gutter", JSON.stringify(at(1)) === JSON.stringify({ kind: "gutter", line: 1 }));
check("a one-line file goes to the gutter", JSON.stringify(placeLightbulb({ line: 1, column: 1, lineCount: 1, lineText: () => "foo();", indentWidth: 0, spaceWidth: 7.2 })) === JSON.stringify({ kind: "gutter", line: 1 }));
check("the last line with an indented line above uses the line above", (at(9, 1, { lineText: (n) => (n === 8 ? "  x" : n === 9 ? "last();" : "") }) as { line: number }).line === 8);
check("a single-character line like } puts the bulb at column 2", JSON.stringify(at(5, 1, { indentWidth: 0, lineText: (n) => (n === 6 ? "}" : n === 5 ? "foo();" : n === 4 ? "bar();" : "") , lineCount: 6 })) === JSON.stringify({ kind: "widget", line: 6, column: 2 }), JSON.stringify(at(5, 1, { indentWidth: 0, lineText: (n) => (n === 6 ? "}" : n === 5 ? "foo();" : n === 4 ? "bar();" : ""), lineCount: 6 })));

// ---- 메뉴 놓는 자리 ----
const viewport = { width: 1000, height: 800 };
const below = placeMenu({ x: 100, top: 90, bottom: 110 }, { width: 200, height: 300 }, viewport);
check("the menu opens below the anchor when it fits", !below.above && below.top === 110 && below.left === 100);
const flipped = placeMenu({ x: 100, top: 600, bottom: 620 }, { width: 200, height: 300 }, viewport);
check("it flips above when below is short and above is roomier", flipped.above && flipped.top === 300);
const squeezed = placeMenu({ x: 100, top: 30, bottom: 50 }, { width: 200, height: 900 }, viewport);
check("a tall menu uses the larger side and gets a max height", !squeezed.above && squeezed.maxHeight === 750);
check("it slides left to stay inside the window", placeMenu({ x: 950, top: 10, bottom: 30 }, { width: 200, height: 50 }, viewport).left === 800);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("code action model: all passed");

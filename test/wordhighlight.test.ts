import { highlightAnnouncement, highlightKind, stepHighlight, textualOccurrences, wordRangeAt } from "../web/wordHighlightModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const line = "const foo_bar = $baz.qux(1);";
check("a word is found at its start, middle and right end", same(wordRangeAt(line, 6), { from: 6, to: 13 }) && same(wordRangeAt(line, 9), { from: 6, to: 13 }) && same(wordRangeAt(line, 13), { from: 6, to: 13 }));
check("$ and _ belong to the word", same(wordRangeAt(line, 17), { from: 16, to: 20 }) && same(wordRangeAt(line, 8), { from: 6, to: 13 }));
check("a separator between words has no word of its own", wordRangeAt("a  b", 2) === null || same(wordRangeAt("a  b", 2), { from: 0, to: 1 }));
check("a position between two separators has no word", wordRangeAt("(  )", 2) === null);
check("an empty line has no word", wordRangeAt("", 0) === null);
check("a dot ends the word", same(wordRangeAt(line, 21), { from: 21, to: 24 }));

const text = "foo foo.bar xfoo foox (foo) foo_foo foo";
const hits = textualOccurrences(text, "foo");
check("only whole-word matches count", same(hits.map((h) => h.from), [0, 4, 23, 36]), JSON.stringify(hits.map((h) => h.from)));
check("matching is case-sensitive", textualOccurrences("Foo foo FOO", "foo").length === 1);
check("an empty word matches nothing", textualOccurrences("abc", "").length === 0);
check("a word at the very start and end of the text matches", textualOccurrences("foo", "foo").length === 1);
check("overlapping candidates do not double count", same(textualOccurrences("aaaa aa", "aa").map((h) => h.from), [5]));
check("a word that starts with a separator matches next to word characters", textualOccurrences("x$foo", "$foo").length === 1);

check("LSP kinds map to read, write and text", highlightKind(2) === "read" && highlightKind(3) === "write" && highlightKind(1) === "text");
check("an unknown kind reads as read", highlightKind(undefined) === "read");

const ranges = [{ from: 5, to: 8 }, { from: 20, to: 23 }, { from: 40, to: 43 }];
check("next from inside a highlight goes to the following one", stepHighlight(ranges, 6, 1) === 1 && stepHighlight(ranges, 21, 1) === 2);
check("next from the last wraps to the first", stepHighlight(ranges, 41, 1) === 0);
check("previous from the first wraps to the last", stepHighlight(ranges, 5, -1) === 2);
check("the cursor right after a word still counts as inside it", stepHighlight(ranges, 8, 1) === 1);
check("next from outside every highlight starts at the first", stepHighlight(ranges, 30, 1) === 0);
check("no highlights give -1", stepHighlight([], 0, 1) === -1);
check("the announcement matches the bundle format", highlightAnnouncement("const a = 1;", 1, 3, "a") === "const a = 1;, 2 of 3 for 'a'");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("word highlight: all passed");

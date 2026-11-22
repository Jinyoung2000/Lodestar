import assert from "node:assert/strict";

import { parseCodeSpanRef } from "../web/fileRefParse";

assert.deepEqual(parseCodeSpanRef("src/a.ts"), { raw: "src/a.ts", line: undefined, column: undefined });
assert.deepEqual(parseCodeSpanRef("src/a.ts:12:3"), { raw: "src/a.ts", line: 12, column: 3 });
assert.equal(parseCodeSpanRef("~/.agents/rules.md")?.raw, "~/.agents/rules.md");
assert.equal(parseCodeSpanRef("settings.json")?.raw, "settings.json");
assert.equal(parseCodeSpanRef("agent-sync check"), null);
assert.equal(parseCodeSpanRef("cat src/a.ts"), null);
assert.equal(parseCodeSpanRef("gh pr edit"), null);
assert.equal(parseCodeSpanRef("a.ts and b.ts"), null);
console.log("codespan ok");

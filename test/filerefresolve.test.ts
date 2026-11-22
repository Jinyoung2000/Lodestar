import assert from "node:assert/strict";

import { ExistCache } from "../web/fileExistCache";
import { outsideCandidates } from "../web/fileRefOutside";
import { createPathFor, fileIndex, normalizeRelative, resolveFileRef } from "../web/fileRefResolve";
import { codeWithoutPathHeader, forgetSuggestedCode, peekSuggestedCode, rememberSuggestedCode, withTrailingNewline } from "../web/missingFileCode";

const none = new Map<string, boolean>();
const files = ["package.json", "app-cli/package.json", "app-cli/bin/jobs.ts", "app-cli/src/util.ts", "app-webview/src/a.ts", "app-webview/src/Report.tsx", "docs/Report.tsx", "README.md"];
const index = fileIndex(files);

assert.equal(normalizeRelative("./src/a.ts"), "src/a.ts");
assert.equal(normalizeRelative("app-cli/bin/../src/cli.ts"), "app-cli/src/cli.ts");
assert.equal(normalizeRelative("../x.ts"), "../x.ts");
assert.equal(normalizeRelative("a/../../x.ts"), "../x.ts");

assert.deepEqual(resolveFileRef(index, "app-cli/bin/jobs.ts", [], none), { kind: "found", path: "app-cli/bin/jobs.ts" });
assert.deepEqual(resolveFileRef(index, "./README.md", [], none), { kind: "found", path: "README.md" });

assert.deepEqual(resolveFileRef(index, "util.ts", [], none), { kind: "found", path: "app-cli/src/util.ts" });
assert.deepEqual(resolveFileRef(index, "Report.tsx", [], none), { kind: "ambiguous", matches: ["app-webview/src/Report.tsx", "docs/Report.tsx"] });
assert.deepEqual(resolveFileRef(index, "Report.tsx", ["app-webview/src/a.ts"], none), { kind: "found", path: "app-webview/src/Report.tsx" });

assert.deepEqual(resolveFileRef(index, "src/util.ts", ["app-cli/bin/jobs.ts"], none), { kind: "found", path: "app-cli/src/util.ts" });
const withRoot = fileIndex([...files, "src/util.ts"]);
assert.deepEqual(resolveFileRef(withRoot, "src/util.ts", ["app-cli/bin/jobs.ts"], none), { kind: "found", path: "src/util.ts" });

const pending = resolveFileRef(index, "src/cli.ts", [], none);
assert.deepEqual(pending, { kind: "pending", check: ["src/cli.ts"] });
assert.deepEqual(resolveFileRef(index, "src/cli.ts", [], new Map([["src/cli.ts", true]])), { kind: "found", path: "src/cli.ts" });
assert.deepEqual(resolveFileRef(index, "src/cli.ts", [], new Map([["src/cli.ts", false]])), { kind: "missing", path: "src/cli.ts" });
const hinted = resolveFileRef(index, "src/cli.ts", ["app-cli/bin/jobs.ts"], new Map([["src/cli.ts", false]]));
assert.deepEqual(hinted, { kind: "pending", check: ["app-cli/bin/src/cli.ts", "app-cli/src/cli.ts"] });
const settled = resolveFileRef(index, "src/cli.ts", ["app-cli/bin/jobs.ts"], new Map([["src/cli.ts", false], ["app-cli/bin/src/cli.ts", false], ["app-cli/src/cli.ts", false]]));
assert.deepEqual(settled, { kind: "missing", path: "app-cli/src/cli.ts" });
assert.deepEqual(resolveFileRef(index, "src/cli.ts", ["app-cli/bin/jobs.ts"], new Map([["src/cli.ts", false], ["app-cli/bin/src/cli.ts", false], ["app-cli/src/cli.ts", true]])), { kind: "found", path: "app-cli/src/cli.ts" });
assert.deepEqual(resolveFileRef(index, "../x.ts", [], none), { kind: "found", path: "../x.ts" });

assert.equal(createPathFor("src/cli.ts", ["app-cli/bin/jobs.ts"], index), "app-cli/src/cli.ts");
assert.equal(createPathFor("lib/cli.ts", ["app-cli/bin/jobs.ts"], index), "app-cli/lib/cli.ts");
assert.equal(createPathFor("lib/cli.ts", [], index), "lib/cli.ts");
assert.equal(createPathFor("docs/new.md", ["app-cli/bin/jobs.ts"], index), "docs/new.md");
assert.equal(createPathFor("lib/cli.ts", ["README.md"], index), "lib/cli.ts");
assert.equal(createPathFor("cli.ts", ["app-cli/bin/jobs.ts"], index), "app-cli/bin/cli.ts");

const cache = new ExistCache();
let woke = 0;
cache.subscribe(() => {
  woke += 1;
});
const list1 = ["a.ts"];
cache.syncList("w1", list1);
cache.set("w1", "x.ts", false);
cache.set("w2", "y.ts", true);
cache.syncList("w1", list1);
assert.equal(cache.known("w1").get("x.ts"), false);
assert.equal(woke, 0);
cache.syncList("w1", ["a.ts", "x.ts"]);
assert.equal(cache.known("w1").has("x.ts"), false);
assert.equal(cache.known("w2").get("y.ts"), true);
assert.equal(woke, 1);
assert.equal(cache.invalidate("w1"), false);
assert.equal(woke, 1);
assert.equal(cache.invalidate(), true);
assert.equal(cache.known("w2").has("y.ts"), false);
assert.equal(cache.getVersion(), 2);

assert.equal(codeWithoutPathHeader("// app-cli/src/cli.ts\nexport const a = 1;\n", "app-cli/src/cli.ts"), "export const a = 1;\n");
assert.equal(codeWithoutPathHeader("# src/x.py\nprint(1)", "src/x.py"), "print(1)\n");
assert.equal(codeWithoutPathHeader("/* src/a.css */\n.a{}", "src/a.css"), ".a{}\n");
assert.equal(codeWithoutPathHeader("<!-- docs/a.md -->\n# t", "docs/a.md"), "# t\n");
assert.equal(codeWithoutPathHeader("// src/other.ts\nx", "src/cli.ts"), null);
assert.equal(codeWithoutPathHeader("export const a = 1;", "src/cli.ts"), null);
assert.equal(withTrailingNewline("a"), "a\n");
assert.equal(withTrailingNewline("a\n"), "a\n");

rememberSuggestedCode("w1", "a.ts", "code");
assert.equal(peekSuggestedCode("w1", "a.ts"), "code");
assert.equal(peekSuggestedCode("w2", "a.ts"), null);
forgetSuggestedCode("w1", "a.ts");
assert.equal(peekSuggestedCode("w1", "a.ts"), null);

{
  const ws = "/Users/me/Repository/app";
  const inputs = [
    JSON.stringify({ command: "cd /Users/me/Repository/app-client/app-webview/src && cat components/pagePromiseReport/schedules.ts | head -80" }),
    JSON.stringify({ file_path: "/Users/me/Repository/app/src/graphql/schema/Schedule/Schedule.ts" }),
  ];
  const got = outsideCandidates("app-webview/src/components/pagePromiseReport/schedules.ts", inputs, ws);
  assert.equal(got[0], "/Users/me/Repository/app-client/app-webview/src/components/pagePromiseReport/schedules.ts");
  assert.ok(got.every((p) => !p.startsWith(`${ws}/`)));
  assert.ok(outsideCandidates("components/pagePromiseReport/schedules.ts", inputs, ws).includes("/Users/me/Repository/app-client/app-webview/src/components/pagePromiseReport/schedules.ts"));
  const read = [JSON.stringify({ file_path: "/Users/me/Repository/other/pkg/src/x.ts" })];
  assert.equal(outsideCandidates("src/x.ts", read, ws)[0], "/Users/me/Repository/other/pkg/src/x.ts");
  assert.deepEqual(outsideCandidates("../x.ts", inputs, ws), []);
  assert.deepEqual(outsideCandidates("src/x.ts", [], ws), []);
  assert.deepEqual(outsideCandidates("x.ts", [JSON.stringify({ command: "ls /Users/me" })], ws), []);
}

console.log("filerefresolve ok");

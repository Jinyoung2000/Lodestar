import { ChangeSet, Text } from "@codemirror/state";
import { toViewDiagnostics } from "../web/diagnosticViews";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

{
  const synced = Text.of(["const a = 1;", "let b;"]);
  const diagnostic = { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } }, severity: 1, message: "b is never used" };
  const fromPosition = (position: { line: number; character: number }, doc: Text = synced) => doc.line(position.line + 1).from + position.character;
  const plugin = (unsynced: ChangeSet) => ({ syncedDoc: synced, unsyncedChanges: unsynced, fromPosition });

  const exact = toViewDiagnostics([diagnostic], plugin(ChangeSet.empty(synced.length)));
  same("with no unsent edits the range is the server's range", exact.map((d) => [d.from, d.to, d.severity, d.message]), [[17, 18, "error", "b is never used"]]);

  const typed = ChangeSet.of({ from: 0, insert: "// x\n" }, synced.length);
  const shifted = toViewDiagnostics([diagnostic], plugin(typed));
  same("unsent edits shift the underline", shifted.map((d) => [d.from, d.to]), [[22, 23]]);

  const second = toViewDiagnostics([diagnostic], plugin(typed));
  same("a second view with the same unsent edits gets the same underline", second, shifted);

  same("severities", toViewDiagnostics([1, 2, 3, 4, undefined].map((severity) => ({ ...diagnostic, severity })), plugin(ChangeSet.empty(synced.length))).map((d) => d.severity), ["error", "warning", "info", "hint", "error"]);
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");

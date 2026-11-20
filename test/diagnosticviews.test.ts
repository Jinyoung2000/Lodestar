// 진단 밑줄을 같은 파일의 모든 보기에 그리는 순수 부분(web/diagnosticViews.ts): LSP 진단을 보기의 위치로 바꾸기. 파일의 보기 목록은 test/diffmirror.test.ts 가 본다.
// 실행: npm test
import { ChangeSet, Text } from "@codemirror/state";
import { toViewDiagnostics } from "../web/diagnosticViews";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

{
  // 서버가 본 글: "const a = 1;\nlet b;" 에서 b 가 2번째 줄 4번째 글자
  const synced = Text.of(["const a = 1;", "let b;"]);
  const diagnostic = { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } }, severity: 1, message: "b is never used" };
  const fromPosition = (position: { line: number; character: number }, doc: Text = synced) => doc.line(position.line + 1).from + position.character;
  const plugin = (unsynced: ChangeSet) => ({ syncedDoc: synced, unsyncedChanges: unsynced, fromPosition });

  const exact = toViewDiagnostics([diagnostic], plugin(ChangeSet.empty(synced.length)));
  same("with no unsent edits the range is the server's range", exact.map((d) => [d.from, d.to, d.severity, d.message]), [[17, 18, "error", "b is never used"]]);

  // 아직 서버에 안 보낸 편집: 첫 줄 앞에 "// x\n"(5자)를 넣었다. 두 보기 모두 같은 편집이 쌓여 있어 같은 밑줄 위치가 된다.
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

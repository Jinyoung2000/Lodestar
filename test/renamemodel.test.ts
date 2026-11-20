// 이름 바꾸기 미리 보기의 순수 로직: WorkspaceEdit 를 파일별 항목으로 바꾸고, 체크한 항목만 다시 WorkspaceEdit 로 만든다.
// 실행: npm test
import { buildPreview, collectEdits, countEdits, fileState, selectedEdit, visibleBreaks, type WorkspaceEdit } from "../web/renameModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const range = (line: number, from: number, to: number, endLine = line) => ({ start: { line, character: from }, end: { line: endLine, character: to } });
const a = "file:///w/a.ts";
const b = "file:///w/b.ts";
const sources: Record<string, string> = {
  [a]: "export const total = 1;\nconsole.log(total);\n",
  [b]: "import { total } from './a';\nuse(total, total);",
};

const edit: WorkspaceEdit = {
  changes: { [b]: [{ range: range(1, 4, 9), newText: "sum" }, { range: range(1, 11, 16), newText: "sum" }, { range: range(0, 9, 14), newText: "sum" }] },
  documentChanges: [{ textDocument: { uri: a }, edits: [{ range: range(1, 12, 17), newText: "sum" }, { range: range(0, 13, 18), newText: "sum" }] }],
};

const collected = collectEdits(edit);
check("collect merges changes and documentChanges per document", collected.perUri.get(a)?.length === 2 && collected.perUri.get(b)?.length === 3 && !collected.fileOps);
check("file operations are flagged", collectEdits({ documentChanges: [{ kind: "rename" }] }).fileOps === true);
check("countEdits gives edit and file totals", JSON.stringify(countEdits(edit)) === JSON.stringify({ edits: 5, files: 2 }));
check("count of an empty edit is zero", countEdits({}).edits === 0);

const { files } = buildPreview(edit, (uri) => sources[uri] ?? null);
check("files are sorted by uri", files.map((f) => f.uri).join() === `${a},${b}`);
check("edits are sorted by position within a file", files[0]!.edits.map((e) => e.line).join() === "1,2" && files[1]!.edits.map((e) => e.line).join() === "1,2,2");
const first = files[0]!.edits[0]!;
check("a rename row shows context before, the old name, the new name and context after", first.prefix === "export const " && first.removed === "total" && first.inserted === "sum" && first.suffix === " = 1;", JSON.stringify(first));
const second = files[0]!.edits[1]!;
check("a later line reads its own line", second.prefix === "console.log(" && second.suffix === ");" && second.line === 2);
check("ids are unique per file and index", new Set(files.flatMap((f) => f.edits.map((e) => e.id))).size === 5);

const noText = buildPreview({ changes: { [a]: [{ range: range(0, 0, 1), newText: "x" }] } }, () => null);
check("an unreadable document still lists the edit without context", noText.files[0]!.edits[0]!.prefix === "" && noText.files[0]!.edits[0]!.removed === "" && noText.files[0]!.edits[0]!.inserted === "x");

const multi = buildPreview({ changes: { [a]: [{ range: range(0, 1, 1, 2), newText: "Z" }] } }, () => "ab\ncd\nef").files[0]!.edits[0]!;
check("multi-line removed text joins with newlines and the suffix starts after the end", multi.removed === "b\ncd\ne" && multi.suffix === "f" && multi.prefix === "a", JSON.stringify(multi));
check("visibleBreaks marks newlines on one line", visibleBreaks("b\ncd\r\ne") === "b↵cd↵e");

const longLine = "x".repeat(100) + "NAME" + "y".repeat(100);
const trimmed = buildPreview({ changes: { [a]: [{ range: range(0, 100, 104), newText: "N" }] } }, () => longLine).files[0]!.edits[0]!;
check("context is trimmed to a short stretch on each side", trimmed.prefix.length === 30 && trimmed.suffix.length === 50);

// ---- 선택 ----
const none = new Set<string>();
check("nothing unchecked keeps every edit", countEdits(selectedEdit(files, none)).edits === 5);
const offOne = new Set([files[0]!.edits[0]!.id]);
const partial = selectedEdit(files, offOne);
check("an unchecked edit is left out of the result", countEdits(partial).edits === 4 && partial.changes![a]!.length === 1);
const offFile = new Set(files[0]!.edits.map((e) => e.id));
const withoutFile = selectedEdit(files, offFile);
check("a file with every edit unchecked is dropped", Object.keys(withoutFile.changes!).join() === b);
check("everything unchecked gives an empty edit", countEdits(selectedEdit(files, new Set(files.flatMap((f) => f.edits.map((e) => e.id))))).edits === 0);
check("file state is all, some or none", fileState(files[0]!, none) === "all" && fileState(files[0]!, offOne) === "some" && fileState(files[0]!, offFile) === "none");
check("the kept edit objects are the original ones", partial.changes![a]![0] === files[0]!.edits[1]!.edit);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("rename model: all passed");

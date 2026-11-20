// 편집 승인 카드의 변경 미리보기(web/approvalPreview.ts). 실행: npm test
import { isEditApproval, previewEdit } from "../web/approvalPreview";

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const file = "/w/a.ts";
const create = previewEdit("Write", { file_path: file, content: "x\n" }, null);
expect(create?.isNew === true && create.before === "" && create.after === "x\n", "Write to a missing file creates it");
const overwrite = previewEdit("Write", { file_path: file, content: "y\n" }, "x\n");
expect(overwrite?.isNew === false && overwrite.before === "x\n", "Write over an existing file is a diff against it");
expect(previewEdit("Write", { file_path: file, content: "y\n" }, undefined)?.isNew === false, "an unread file is not claimed new");

const edit = previewEdit("Edit", { file_path: file, old_string: "b", new_string: "B" }, "a\nb\nc\n");
expect(edit?.after === "a\nB\nc\n" && edit.before === "a\nb\nc\n", "Edit applies to the whole file");
const all = previewEdit("Edit", { file_path: file, old_string: "b", new_string: "B", replace_all: true }, "b b");
expect(all?.after === "B B", "replace_all");
const dollar = previewEdit("Edit", { file_path: file, old_string: "b", new_string: "$&" }, "b");
expect(dollar?.after === "$&", "replacement text is literal");
const snippet = previewEdit("Edit", { file_path: file, old_string: "zzz", new_string: "Z" }, "a\n");
expect(snippet?.before === "zzz" && snippet.after === "Z", "text not found falls back to the snippet");
const unread = previewEdit("Edit", { file_path: file, old_string: "q", new_string: "Q" }, undefined);
expect(unread?.before === "q" && unread.after === "Q", "unread file falls back to the snippet");

const multi = previewEdit("MultiEdit", { file_path: file, edits: [{ old_string: "a", new_string: "b" }, { old_string: "b", new_string: "c" }] }, "a\n");
expect(multi?.after === "c\n", "MultiEdit applies in order");
expect(previewEdit("Bash", { command: "ls" }, null) === null, "other tools have no preview");
expect(previewEdit("Edit", { file_path: file }, "a") === null, "malformed input has no preview");
expect(isEditApproval("Write") && isEditApproval("MultiEdit") && !isEditApproval("NotebookEdit"), "edit tools");
console.log("ok  approvaldiff");

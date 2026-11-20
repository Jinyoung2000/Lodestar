// ⌘ hover 정의 링크(web/definitionLinkState.ts)를 DOM 없이 확인한다. 밑줄 장식이 링크 상태에서만 생기고 글이 바뀌면 사라지는지, 미리보기 자르기.
// 실행: npm test
import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { linkField, setLink, sliceDeclaration } from "../web/definitionLinkState";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

// 상태에 든 모든 mark 장식을 { from, to, class } 로 모은다.
function marks(state: EditorState) {
  const found: { from: number; to: number; cls: string }[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    (source as DecorationSet).between(0, state.doc.length, (from, to, value) => {
      found.push({ from, to, cls: (value.spec as { class: string }).class });
    });
  }
  return found;
}

const base = () => EditorState.create({ doc: "const state = getState();", extensions: [linkField] });
const link = { from: 14, to: 22, preview: null, hover: null };

test("링크가 없으면 밑줄 장식이 없다", () => {
  expect(marks(base()).length === 0, "no marks");
  return "ok";
});

test("setLink 하면 그 범위에 cm-definition-link 장식이 생기고 null 이면 사라진다", () => {
  const on = base().update({ effects: setLink.of(link) }).state;
  const found = marks(on);
  expect(found.length === 1 && found[0]!.from === 14 && found[0]!.to === 22 && found[0]!.cls === "cm-definition-link", JSON.stringify(found));
  expect(on.sliceDoc(14, 22) === "getState", "range is the word");
  const off = on.update({ effects: setLink.of(null) }).state;
  expect(marks(off).length === 0, "cleared");
  return "ok";
});

test("글이 바뀌면(편집 중) 링크는 지워진다", () => {
  const on = base().update({ effects: setLink.of(link) }).state;
  const edited = on.update({ changes: { from: 0, insert: "// " } }).state;
  expect(marks(edited).length === 0, "cleared on edit");
  return "ok";
});

test("sliceDeclaration: 괄호와 중괄호가 닫힐 때까지 잇고 들여쓰기를 걷는다", () => {
  const lines = ["", "  export function f(", "    a: number,", "  ) {", "    return a;", "  }", "  const x = 1;"];
  const preview = sliceDeclaration(lines, 1, null, "typescript");
  expect(preview.text === "export function f(\n  a: number,\n) {\n  return a;\n}" && !preview.truncated, JSON.stringify(preview.text));
  return "ok";
});

test("sliceDeclaration: 선언 범위(LocationLink)는 그대로, 8줄을 넘으면 잘리고 truncated", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
  const preview = sliceDeclaration(lines, 0, 11, null);
  expect(preview.text.split("\n").length === 8 && preview.truncated, `${preview.text.split("\n").length} ${preview.truncated}`);
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);

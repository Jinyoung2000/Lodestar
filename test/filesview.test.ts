import { expandFolders, filesViewOf, revealFilePath, setFilesView, toggleFolder } from "../web/filesView";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const openOf = (workspaceId: string) => [...filesViewOf(workspaceId).open].sort().join(",");

test("처음에는 아무것도 펼치지 않고 맨 위 폴더만 열려 있다", () => {
  const view = filesViewOf("w-new");
  expect(view.open.size === 0 && view.rootOpen && view.selected === null, JSON.stringify([...view.open]));
  return "빈 상태";
});

test("toggleFolder 는 폴더를 펼치고 접는다", () => {
  toggleFolder("w1", "src");
  expect(openOf("w1") === "src", openOf("w1"));
  toggleFolder("w1", "src");
  expect(openOf("w1") === "", openOf("w1"));
  return "펼침, 접힘";
});

test("expandFolders 는 그 폴더와 위 폴더를 모두 펼친다", () => {
  expandFolders("w2", "a/b/c");
  expect(openOf("w2") === "a,a/b,a/b/c", openOf("w2"));
  expandFolders("w2", "");
  expect(openOf("w2") === "a,a/b,a/b/c", "빈 경로는 바꾸지 않는다");
  return "a, a/b, a/b/c";
});

test("revealFilePath 는 파일이 든 폴더를 펼치고 그 파일을 고른다", () => {
  setFilesView("w3", { rootOpen: false });
  revealFilePath("w3", "src/lib/util.ts");
  const view = filesViewOf("w3");
  expect(openOf("w3") === "src,src/lib" && view.rootOpen && view.selected?.path === "src/lib/util.ts" && view.selected.file, JSON.stringify([openOf("w3"), view.rootOpen, view.selected]));
  return "src, src/lib 펼침, 파일 선택, 맨 위 폴더 열림";
});

test("맨 위 폴더의 파일은 폴더를 펼치지 않고 고르기만 한다", () => {
  revealFilePath("w4", "README.md");
  expect(openOf("w4") === "" && filesViewOf("w4").selected?.path === "README.md", openOf("w4"));
  return "README.md";
});

test("작업 폴더마다 상태가 따로다", () => {
  toggleFolder("wa", "x");
  expect(openOf("wa") === "x" && openOf("wb") === "", `${openOf("wa")} / ${openOf("wb")}`);
  return "wa 만 펼침";
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
if (failed) process.exit(1);
console.log(`${cases.length - failed}/${cases.length} 통과`);

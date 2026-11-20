// Files 트리 우클릭 메뉴의 항목 결정, 행 키, 이름 바꾸기 계산(web/filesMenu.ts)을 본다. 실행: npm test
import { filesKeyAction, filesMenuItems, isSameOrUnder, renamedPath, renameProblem, renameSelection, retargetPath, type FilesMenuItem } from "../web/filesMenu";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

// 항목 이름을 구분선과 함께 한 줄로 (| 가 구분선)
const line = (items: FilesMenuItem[]) => items.map((i) => `${i.separatorBefore ? "| " : ""}${i.action}`).join(" ");
const key = (items: FilesMenuItem[], action: string) => items.find((i) => i.action === action)?.key;

test("파일 행 메뉴: 열기, Finder, 채팅에 붙이기, 경로 복사, 이름과 삭제, 새로 만들기 순서에 구분선", () => {
  const items = filesMenuItems("file", { canAttach: true });
  expect(line(items) === "open openSide | reveal | attach | copyPath copyRelativePath | rename delete | newFile newFolder", line(items));
  return line(items);
});

test("폴더 행 메뉴: 만들기, Finder 와 터미널과 폴더 검색, 경로 복사, 이름과 삭제(채팅에 붙이기와 Open 은 없다)", () => {
  const items = filesMenuItems("folder", { canAttach: true });
  expect(line(items) === "newFile newFolder | reveal openTerminal findInFolder | copyPath copyRelativePath | rename delete", line(items));
  expect(!items.some((i) => i.action === "attach" || i.action === "open" || i.action === "openSide"), "no file-only items");
  return line(items);
});

test("루트(작업 폴더 이름) 행: 이름 바꾸기, 삭제, 상대 경로 복사가 없다", () => {
  const items = filesMenuItems("root", { canAttach: true });
  expect(line(items) === "newFile newFolder | reveal openTerminal findInFolder | copyPath", line(items));
  return line(items);
});

test("대화 칸이 없으면 채팅에 붙이기만 비활성", () => {
  const off = filesMenuItems("file", { canAttach: false });
  expect(off.find((i) => i.action === "attach")?.disabled === true, "attach disabled");
  expect(off.filter((i) => i.disabled).length === 1, "only attach");
  const on = filesMenuItems("file", { canAttach: true });
  return expect(!on.some((i) => i.disabled), "all enabled");
});

test("GROUPS: 파일 행의 ⌃Enter 와 ⌘Enter 는 Open to the Side, 폴더 행과 다른 수정키는 아니다", () => {
  const input = (over: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
  expect(filesKeyAction(input({ ctrlKey: true }), "file") === "openSide" && filesKeyAction(input({ metaKey: true }), "file") === "openSide", "⌃Enter, ⌘Enter");
  expect(filesKeyAction(input({ ctrlKey: true }), "folder") === null && filesKeyAction(input({ ctrlKey: true, metaKey: true }), "file") === null, "폴더와 두 수정키는 아님");
  return expect(filesKeyAction(input({}), "file") === null && filesKeyAction(input({ ctrlKey: true, shiftKey: true }), "file") === null, "수정키 없는 Enter 와 ⇧ 가 붙은 것은 아님");
});

test("힌트는 실제로 묶인 키만: F2, ⌘⌫, ⌥⌘R, ⌥⌘C, ⇧⌥⌘C", () => {
  const items = filesMenuItems("file", { canAttach: true });
  expect(key(items, "rename") === "F2" && key(items, "delete") === "⌘⌫" && key(items, "reveal") === "⌥⌘R", "rename delete reveal");
  expect(key(items, "copyPath") === "⌥⌘C" && key(items, "copyRelativePath") === "⇧⌥⌘C", "copy keys");
  expect(key(items, "open") === undefined && key(items, "attach") === undefined, "unbound items have no hint");
  expect(key(items, "openSide") === "⌃Enter", "Open to the Side 는 행에서 ⌃Enter(번들의 explorer.openToSide 맥 키)로 실제 묶여 있다");
  const root = filesMenuItems("root", { canAttach: true });
  return expect(key(root, "reveal") === "⌥⌘R" && key(root, "copyPath") === "⌥⌘C", "root keeps bound hints");
});

const press = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}, code?: string) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("행 키 -> 항목: F2 이름 바꾸기, ⌘⌫ 삭제, ⌥⌘R, ⌥⌘C, ⇧⌥⌘C", () => {
  expect(filesKeyAction(press("F2"), "file") === "rename", "F2");
  expect(filesKeyAction(press("Backspace", { metaKey: true }), "folder") === "delete", "cmd backspace");
  expect(filesKeyAction(press("r", { metaKey: true, altKey: true }, "KeyR"), "file") === "reveal", "alt cmd R");
  expect(filesKeyAction(press("c", { metaKey: true, altKey: true }, "KeyC"), "file") === "copyPath", "alt cmd C");
  expect(filesKeyAction(press("C", { metaKey: true, altKey: true, shiftKey: true }, "KeyC"), "file") === "copyRelativePath", "shift alt cmd C");
  return "ok";
});

test("행 키: 루트 행은 이름 바꾸기, 삭제, 상대 경로 키를 받지 않고, 다른 조합은 무시한다", () => {
  expect(filesKeyAction(press("F2"), "root") === null, "root F2");
  expect(filesKeyAction(press("Backspace", { metaKey: true }), "root") === null, "root delete");
  expect(filesKeyAction(press("C", { metaKey: true, altKey: true, shiftKey: true }, "KeyC"), "root") === null, "root relative");
  expect(filesKeyAction(press("F2", { metaKey: true }), "file") === null, "cmd F2 ignored");
  expect(filesKeyAction(press("Backspace"), "file") === null, "plain backspace ignored");
  expect(filesKeyAction(press("c", { metaKey: true }, "KeyC"), "file") === null, "plain copy ignored");
  expect(filesKeyAction(press("Enter"), "file") === null, "enter ignored");
  return "ok";
});

test("이름 바꾸기 선택 범위: 확장자 앞까지, 점 파일과 폴더는 전체", () => {
  expect(renameSelection("config.json", true).join() === "0,6", "config.json");
  expect(renameSelection("a.test.ts", true).join() === "0,6", "last dot");
  expect(renameSelection(".env", true).join() === "0,4", "dotfile");
  expect(renameSelection("README", true).join() === "0,6", "no extension");
  expect(renameSelection("v1.2", false).join() === "0,4", "folder");
  return "ok";
});

test("이름 검사: 빈 이름, 슬래시, . 과 .. 는 거절", () => {
  expect(renameProblem("") === "empty" && renameProblem("   ") === "empty", "empty");
  expect(renameProblem("a/b") === "invalid" && renameProblem("..") === "invalid" && renameProblem(".") === "invalid", "invalid");
  expect(renameProblem("ok.ts") === null && renameProblem(" ok.ts ") === null && renameProblem(".env") === null, "valid");
  return "ok";
});

test("경로 계산: 마지막 이름만 바뀌고, 폴더 이름을 바꾸면 그 아래 경로가 따라간다", () => {
  expect(renamedPath("src/lib/a.ts", " b.ts ") === "src/lib/b.ts" && renamedPath("a.ts", "b.ts") === "b.ts", "renamedPath");
  expect(retargetPath("src/a.ts", "src/a.ts", "src/b.ts") === "src/b.ts", "same file");
  expect(retargetPath("src/lib/a.ts", "src/lib", "src/core") === "src/core/a.ts", "under folder");
  expect(retargetPath("src/library/a.ts", "src/lib", "src/core") === null, "prefix of a sibling name is not under it");
  expect(retargetPath("other/a.ts", "src/lib", "src/core") === null, "unrelated");
  expect(isSameOrUnder("src/lib/a.ts", "src/lib") && isSameOrUnder("src/lib", "src/lib") && !isSameOrUnder("src/library", "src/lib"), "isSameOrUnder");
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

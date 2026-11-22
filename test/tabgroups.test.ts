import { adjacentGroup, groupIdsOf, moveToGroup, neighborAfterClose, normalizeLayout, removeGroup, setSplitSizes, SINGLE_LAYOUT, splitGroup, type EditorLayout } from "../web/editorGroups";
import { moveTab } from "../web/tabOrder";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const t = (key: string, group?: string) => ({ key, ...(group ? { group } : {}) });
const keys = (s: { tabs: { key: string }[] }) => s.tabs.map((x) => x.key).join(",");

test("줄 안에서 탭 순서 바꾸기: 앞 구역(changes 와 files 사이) 안에서", () => {
  const s = { tabs: [t("a"), t("b"), t("c"), t("d")], filesIndex: 2 };
  const moved = moveTab(s, "b", "a");
  expect(keys(moved) === "b,a,c,d" && moved.filesIndex === 2, `${keys(moved)} ${moved.filesIndex}`);
  const toEnd = moveTab(s, "a", "files");
  expect(keys(toEnd) === "b,a,c,d" && toEnd.filesIndex === 2, `before files: ${keys(toEnd)} ${toEnd.filesIndex}`);
  return "ok";
});

test("files 탭을 넘겨 놓으면 filesIndex 가 따라 바뀐다", () => {
  const s = { tabs: [t("a"), t("b"), t("c"), t("d")], filesIndex: 2 };
  const after = moveTab(s, "a", "d");
  expect(keys(after) === "b,c,a,d" && after.filesIndex === 1, `a before d: ${keys(after)} ${after.filesIndex}`);
  const toFront = moveTab(s, "d", "a");
  expect(keys(toFront) === "d,a,b,c" && toFront.filesIndex === 3, `d before a: ${keys(toFront)} ${toFront.filesIndex}`);
  const beforeChanges = moveTab(s, "c", "changes");
  expect(keys(beforeChanges) === "c,a,b,d" && beforeChanges.filesIndex === 3, `before changes: ${keys(beforeChanges)} ${beforeChanges.filesIndex}`);
  const end = moveTab(s, "a", null);
  expect(keys(end) === "b,c,d,a" && end.filesIndex === 1, `end: ${keys(end)} ${end.filesIndex}`);
  const beforeCard = moveTab(s, "a", "card");
  expect(keys(beforeCard) === "b,a,c,d" && beforeCard.filesIndex === 1, `before card (start of the after-files part): ${keys(beforeCard)} ${beforeCard.filesIndex}`);
  return "ok";
});

test("자기 자리에 놓으면 그대로", () => {
  const s = { tabs: [t("a"), t("b"), t("c")], filesIndex: 1 };
  const same = moveTab(s, "b", "c");
  expect(keys(same) === "a,b,c" && same.filesIndex === 1, `${keys(same)} ${same.filesIndex}`);
  const across = moveTab(s, "a", "b");
  expect(keys(across) === "a,b,c" && across.filesIndex === 0, `${keys(across)} ${across.filesIndex}`);
  const stay = moveTab(s, "a", "files");
  expect(keys(stay) === "a,b,c" && stay.filesIndex === 1, `${keys(stay)} ${stay.filesIndex}`);
  return "ok";
});

test("분할: 나누면 새 그룹이 뒤에 오고 같은 방향이면 한 줄이 늘어난다", () => {
  const right = splitGroup(SINGLE_LAYOUT, "main", "row", "g2", "s1");
  expect(right.type === "split" && right.dir === "row" && groupIdsOf(right).join() === "main,g2" && right.sizes.join() === "0.5,0.5", JSON.stringify(right));
  const again = splitGroup(right, "main", "row", "g3", "s2");
  expect(again.type === "split" && groupIdsOf(again).join() === "main,g3,g2" && again.sizes.join() === "0.25,0.25,0.5", JSON.stringify(again));
  const down = splitGroup(right, "g2", "column", "g3", "s2");
  expect(down.type === "split" && down.children[1].type === "split" && groupIdsOf(down).join() === "main,g2,g3", JSON.stringify(down));
  return "ok";
});

test("그룹을 지우면 이웃이 크기를 가져가고, 하나 남은 분할은 접힌다", () => {
  const three = splitGroup(splitGroup(SINGLE_LAYOUT, "main", "row", "g2", "s1"), "g2", "row", "g3", "s2");
  const two = removeGroup(three, "g2");
  expect(two.type === "split" && groupIdsOf(two).join() === "main,g3" && Math.abs(two.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9, JSON.stringify(two));
  const one = removeGroup(two, "g3");
  expect(one.type === "group" && one.id === "main", JSON.stringify(one));
  expect(removeGroup(SINGLE_LAYOUT, "main").type === "group", "마지막 그룹은 그대로");
  const nested = splitGroup(splitGroup(SINGLE_LAYOUT, "main", "row", "g2", "s1"), "g2", "column", "g3", "s2");
  const folded = normalizeLayout(removeGroup(nested, "g3"));
  expect(folded.type === "split" && folded.children.length === 2 && groupIdsOf(folded).join() === "main,g2", JSON.stringify(folded));
  return "ok";
});

test("크기 바꾸기와 이전, 다음 그룹", () => {
  const two = splitGroup(SINGLE_LAYOUT, "main", "row", "g2", "s1") as Extract<EditorLayout, { type: "split" }>;
  const resized = setSplitSizes(two, "s1", [0.3, 0.7]) as Extract<EditorLayout, { type: "split" }>;
  expect(resized.sizes.join() === "0.3,0.7", resized.sizes.join());
  expect(adjacentGroup(two, "main", 1) === "g2" && adjacentGroup(two, "g2", -1) === "main" && adjacentGroup(two, "g2", 1) === null, "adjacent");
  return "ok";
});

test("탭을 다른 그룹으로 옮기면 group 이 바뀌고 filesIndex 는 main 목록 기준으로 맞는다", () => {
  const s = { tabs: [t("a"), t("b"), t("c"), t("x", "g2"), t("y", "g2")], filesIndex: 2 };
  const out = moveToGroup(s, "a", "g2", "y");
  expect(out.tabs.filter((x) => x.group === "g2").map((x) => x.key).join() === "x,a,y" && out.filesIndex === 1 && out.tabs.filter((x) => !x.group).map((x) => x.key).join() === "b,c", JSON.stringify(out));
  const back = moveToGroup(out, "y", "main", "files");
  expect(back.tabs.filter((x) => !x.group).map((x) => x.key).join() === "b,y,c" && back.filesIndex === 2 && !("group" in back.tabs.find((x) => x.key === "y")!), JSON.stringify(back));
  const append = moveToGroup(s, "b", "g2", null);
  expect(append.tabs.filter((x) => x.group === "g2").map((x) => x.key).join() === "x,y,b", JSON.stringify(append));
  const within = moveToGroup(s, "y", "g2", "x");
  expect(within.tabs.filter((x) => x.group === "g2").map((x) => x.key).join() === "y,x", JSON.stringify(within));
  return "ok";
});

test("닫은 뒤 활성이 될 탭은 오른쪽, 없으면 왼쪽, 남은 게 없으면 null", () => {
  expect(neighborAfterClose(["a", "b", "c"], "b") === "c" && neighborAfterClose(["a", "b", "c"], "c") === "b" && neighborAfterClose(["a"], "a") === null, "neighbors");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok  ${c.name} - ${c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}\n  ${(error as Error).message}`);
  }
}
if (failed) process.exit(1);

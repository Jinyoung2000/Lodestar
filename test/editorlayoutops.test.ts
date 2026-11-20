// 에디터 그룹 배치 트리 조작(web/editorLayoutOps.ts)과 탭 목록 규칙(web/editorTabs.ts). 순수 함수만 본다.
// 실행: npm test
import { groupIdsOf, MAIN_GROUP, type EditorLayout } from "../web/editorGroups";
import { evenLayout, flipLayout, groupAtIndex, groupInDirection, LAYOUT_PRESETS, moveGroup, nextToJoin, planPreset, presetGroupCount, splitSpec, swapGroups } from "../web/editorLayoutOps";
import { baseKeyOf, clampDrop, renamedKey, closable, findInGroup, isDuplicable, mruOrder, sameContent, shiftTarget, stepTab, stickyAnchor, uniqueKey } from "../web/editorTabs";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const g = (id: string): EditorLayout => ({ type: "group", id });
const split = (id: string, dir: "row" | "column", ...children: EditorLayout[]): EditorLayout => ({ type: "split", id, dir, children, sizes: children.map(() => 1 / children.length) });
// main 은 왼쪽, 오른쪽 열은 위 g1 아래 g2
const tree = split("s1", "row", g("main"), split("s2", "column", g("g1"), g("g2")));

let seq = 0;
const newId = () => `n${++seq}`;
const newSplit = () => `ns${++seq}`;

test("이웃 그룹: 가로 분할의 오른쪽과 왼쪽, 세로 분할의 위아래", () => {
  expect(groupInDirection(tree, "main", "right") === "g1", "main 오른쪽은 g1 (들어오는 쪽 첫 그룹)");
  expect(groupInDirection(tree, "g2", "left") === "main", "g2 왼쪽은 main");
  expect(groupInDirection(tree, "g1", "down") === "g2" && groupInDirection(tree, "g2", "up") === "g1", "세로 이웃");
  expect(groupInDirection(tree, "g1", "up") === null && groupInDirection(tree, "main", "left") === null, "끝에서는 null");
  expect(groupInDirection(tree, "main", "down") === null, "세로 분할이 없는 쪽은 null");
  return "ok";
});

test("이웃 그룹: 직각 분할로 들어갈 때 위(왼쪽) 끝 그룹, 같은 방향이면 가까운 쪽 끝", () => {
  const row = split("s1", "row", split("s2", "column", g("a"), g("b")), g("c"));
  expect(groupInDirection(row, "c", "left") === "a", "c 왼쪽은 열의 첫 그룹 a");
  const rows = split("s1", "column", g("a"), split("s2", "row", g("b"), g("c")));
  expect(groupInDirection(rows, "a", "down") === "b", "a 아래는 행의 첫 그룹 b");
  const wide = split("s1", "row", g("a"), split("s2", "row", g("b"), g("c")));
  expect(groupInDirection(wide, "a", "right") === "b", "같은 방향 중첩이면 가까운 b");
  return "ok";
});

test("읽는 순서 index 와 다음 그룹", () => {
  expect(groupAtIndex(tree, 0) === "main" && groupAtIndex(tree, 2) === "g2" && groupAtIndex(tree, 3) === null, "index");
  expect(nextToJoin(tree, "main") === "g1" && nextToJoin(tree, "g2") === null, "next");
  return "ok";
});

test("그룹 자리 맞바꾸기와 그룹 옮기기", () => {
  const swapped = swapGroups(tree, "main", "g2");
  expect(groupIdsOf(swapped).join(",") === "g2,g1,main", groupIdsOf(swapped).join(","));
  const moved = moveGroup(tree, "main", "right");
  expect(moved !== null && groupIdsOf(moved).join(",") === "g1,main,g2", "main 을 오른쪽으로 옮기면 g1 과 바뀐다");
  expect(moveGroup(tree, "main", "left") === null, "이웃이 없으면 null");
  return "ok";
});

test("방향 뒤집기와 균등 크기", () => {
  const flipped = flipLayout(tree);
  expect(flipped.type === "split" && flipped.dir === "column" && flipped.children[1].type === "split" && flipped.children[1].dir === "row", "모든 분할 방향이 뒤집힌다");
  const uneven: EditorLayout = { type: "split", id: "s1", dir: "row", children: [g("a"), g("b"), g("c")], sizes: [0.6, 0.3, 0.1] };
  const even = evenLayout(uneven);
  expect(even.type === "split" && even.sizes.every((s) => Math.abs(s - 1 / 3) < 1e-9), "균등");
  return "ok";
});

test("프리셋: 그룹 수와 모양", () => {
  const counts = LAYOUT_PRESETS.map((p) => `${p}:${presetGroupCount(p)}`).join(",");
  expect(counts === "single:1,twoColumns:2,threeColumns:3,twoRows:2,threeRows:3,grid:4,twoRowsRight:3,twoColumnsBottom:3", counts);
  return counts;
});

test("프리셋: 기존 그룹을 먼저 쓰고 모자라면 빈 그룹을 만든다", () => {
  const plan = planPreset(g("main"), "grid", newId, newSplit);
  expect(plan.ids.length === 4 && plan.ids[0] === "main" && plan.created.length === 3 && plan.removed.length === 0, JSON.stringify(plan.ids));
  expect(groupIdsOf(plan.layout).join(",") === plan.ids.join(","), "읽는 순서가 ids 와 같다");
  expect(plan.layout.type === "split" && plan.layout.dir === "row" && plan.layout.children.length === 2, "Grid 는 열 둘");
  return "ok";
});

test("프리셋: 남는 그룹은 지우고 탭은 마지막 그룹으로 합친다, main 은 늘 남는다", () => {
  const five = split("s1", "row", g("main"), g("g1"), g("g2"), g("g3"), g("g4"));
  const plan = planPreset(five, "twoColumns", newId, newSplit);
  expect(plan.ids.join(",") === "main,g1" && plan.removed.join(",") === "g2,g3,g4" && plan.mergeInto === "g1", `${plan.ids} ${plan.removed}`);
  const mainLast = split("s1", "row", g("g1"), g("g2"), g("main"));
  const keep = planPreset(mainLast, "single", newId, newSplit);
  expect(keep.ids.join(",") === "main" && keep.removed.includes("g1") && keep.removed.includes("g2"), `main 이 남는다: ${keep.ids} / ${keep.removed}`);
  expect(keep.layout.type === "group" && keep.layout.id === MAIN_GROUP, "Single 은 그룹 하나");
  return "ok";
});

test("새 그룹 방향", () => {
  expect(JSON.stringify(splitSpec("left")) === '{"dir":"row","before":true}' && JSON.stringify(splitSpec("down")) === '{"dir":"column","before":false}', "방향");
  return "ok";
});

// --- 탭 규칙 ---

const t = (key: string, extra: Record<string, unknown> = {}) => ({ key, kind: "file", ...extra });

test("탭 키: 첫 탭은 기본 키, 다음은 #2, #3, 빈 번호를 채운다", () => {
  expect(uniqueKey([], "w:a.ts") === "w:a.ts", "첫 탭");
  expect(uniqueKey(["w:a.ts"], "w:a.ts") === "w:a.ts#2", "둘째");
  expect(uniqueKey(["w:a.ts", "w:a.ts#2", "w:a.ts#3"], "w:a.ts") === "w:a.ts#4", "넷째");
  expect(uniqueKey(["w:a.ts#2"], "w:a.ts") === "w:a.ts", "첫 탭이 닫혔으면 기본 키부터");
  expect(baseKeyOf("w:a.ts#3") === "w:a.ts" && baseKeyOf("w:a.ts") === "w:a.ts" && baseKeyOf("w:dir#1/a.ts") === "w:dir#1/a.ts", "기본 키");
  return "ok";
});

test("이름을 바꾸면 #번호는 그대로 두 탭의 키가 겹치지 않는다", () => {
  expect(renamedKey("w:b.ts", "w:a.ts") === "w:b.ts" && renamedKey("w:b.ts", "w:a.ts#2") === "w:b.ts#2", "접미사 보존");
  expect(renamedKey("w:dir/b.ts", "w:dir/a.ts#3") !== renamedKey("w:dir/b.ts", "w:dir/a.ts"), "두 탭이 다른 키");
  return "ok";
});

test("같은 내용 판정은 파일, diff, scm 만", () => {
  expect(sameContent(t("w:a.ts"), t("w:a.ts#2")), "파일 둘");
  expect(!sameContent(t("w:a.ts"), t("w:b.ts")), "다른 파일");
  expect(!sameContent({ key: "browser:1", kind: "browser" }, { key: "browser:1", kind: "browser" }), "Browser 는 복사 대상 아님");
  expect(isDuplicable({ kind: "diff" }) && !isDuplicable({ kind: "untitled" }) && !isDuplicable({ kind: "search" }), "복사 가능 종류");
  const tabs = [t("w:a.ts"), t("w:a.ts#2", { group: "g1" })];
  expect(findInGroup(tabs, "g1", t("w:a.ts"))?.key === "w:a.ts#2" && findInGroup(tabs, "main", t("w:a.ts#2"))?.key === "w:a.ts", "그룹 안에서 찾기");
  return "ok";
});

test("붙박이 탭 자리: 일반 탭은 붙박이 구역에 못 들어가고 붙박이는 구역 밖으로 못 나간다", () => {
  const tabs = [t("s1", { sticky: true }), t("s2", { sticky: true }), t("a"), t("b")];
  expect(clampDrop(tabs, t("a"), "s1") === "b", "a 를 붙박이 앞에 놓으면 (a 를 뺀) 첫 일반 탭 b 앞으로");
  expect(clampDrop(tabs, t("b"), "s2") === "a", "b 를 s2 앞에 놓으면 첫 일반 탭(a) 앞");
  expect(clampDrop(tabs, t("b"), "a") === "a", "일반 탭끼리는 그대로");
  expect(clampDrop(tabs, t("s1", { sticky: true }), "b") === "a", "붙박이를 일반 탭 앞에 놓으면 첫 일반 탭 앞");
  expect(clampDrop(tabs, t("s1", { sticky: true }), null) === "a", "붙박이를 끝에 놓아도 첫 일반 탭 앞");
  expect(clampDrop(tabs, t("s2", { sticky: true }), "s1") === "s1", "붙박이끼리는 그대로");
  expect(stickyAnchor(tabs, "b") === "a" && stickyAnchor([t("x")], "x") === null, "붙일 자리");
  return "ok";
});

test("닫기 계열은 붙박이를 뺀다", () => {
  const tabs = [t("s1", { sticky: true }), t("a"), t("b")];
  expect(closable(tabs, ["s1", "a", "b"]).join(",") === "a,b", "붙박이 제외");
  return "ok";
});

test("그룹 안 이전, 다음 탭과 한 칸 옮기기", () => {
  expect(stepTab(["a", "b", "c"], "c", 1) === "a" && stepTab(["a", "b", "c"], "a", -1) === "c" && stepTab(["a"], "a", 1) === null, "끝에서 끝으로 이어진다");
  const tabs = [t("s", { sticky: true }), t("a"), t("b"), t("c")];
  expect(shiftTarget(tabs, "b", -1) === "a", "b 를 왼쪽으로: a 앞");
  expect(shiftTarget(tabs, "b", 1) === null, "b 를 오른쪽으로: c 뒤(끝)");
  expect(shiftTarget(tabs, "a", -1) === undefined, "일반 탭은 붙박이 구역으로 못 감");
  expect(shiftTarget(tabs, "c", 1) === undefined, "끝에서 더 못 감");
  expect(shiftTarget(tabs, "a", 1) === "c", "a 를 오른쪽으로: c 앞");
  return "ok";
});

test("MRU 표시 순서: 지금 탭, 직전 탭 순서로, 모르는 탭은 뒤에", () => {
  const order = mruOrder(["a", "b", "c", "x"], ["a", "b", "c", "d"], "c");
  expect(order.join(",") === "c,b,a,d", order.join(","));
  expect(mruOrder([], ["a", "b"], null).join(",") === "a,b", "기록이 없으면 그룹 순서");
  return order.join(",");
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

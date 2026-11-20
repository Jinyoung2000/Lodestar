// 미리보기 탭의 상태 전이(web/previewTabs.ts)와 Changes 탭 개수 배지 글자(web/countBadge.ts)를 본다. 실행: npm test
import { countBadge } from "../web/countBadge";
import { isPreview, pinTab, planOpen } from "../web/previewTabs";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

type T = { key: string; group?: string; preview?: boolean };
const keys = (tabs: T[]) => tabs.map((t) => (t.preview ? `~${t.key}` : t.key)).join(",");

test("첫 미리보기 탭은 끝에 붙고 preview 가 켜진다", () => {
  const plan = planOpen<T>([], "main", { key: "a" }, "preview");
  expect(keys(plan.tabs) === "~a" && plan.replaced === null && plan.added, keys(plan.tabs));
  return keys(plan.tabs);
});

test("다른 파일을 미리보기로 열면 같은 자리의 탭이 바뀐다(탭 수가 늘지 않는다)", () => {
  let tabs: T[] = [{ key: "pinned" }];
  tabs = planOpen(tabs, "main", { key: "a" }, "preview").tabs;
  const plan = planOpen(tabs, "main", { key: "b" }, "preview");
  expect(keys(plan.tabs) === "pinned,~b", keys(plan.tabs));
  expect(plan.replaced === "a" && plan.added, "a was replaced by b");
  return keys(plan.tabs);
});

test("미리보기 탭이 가운데에 있어도 그 자리에서 바뀐다", () => {
  const tabs: T[] = [{ key: "x" }, { key: "a", preview: true }, { key: "y" }];
  const plan = planOpen(tabs, "main", { key: "b" }, "preview");
  return expect(keys(plan.tabs) === "x,~b,y", keys(plan.tabs));
});

test("고정으로 열면 미리보기 탭은 그대로 두고 끝에 새 탭이 붙는다", () => {
  const tabs: T[] = [{ key: "a", preview: true }];
  const plan = planOpen(tabs, "main", { key: "b" }, "pinned");
  return expect(keys(plan.tabs) === "~a,b" && plan.replaced === null, keys(plan.tabs));
});

test("이미 열린 미리보기 탭을 고정으로 열면(더블클릭) 고정된다. 새 탭은 생기지 않는다", () => {
  const tabs: T[] = [{ key: "a", preview: true }];
  const plan = planOpen(tabs, "main", { key: "a" }, "pinned");
  expect(keys(plan.tabs) === "a" && !plan.added && plan.replaced === null, keys(plan.tabs));
  return keys(plan.tabs);
});

test("고정 탭을 미리보기로 다시 열어도 미리보기로 돌아가지 않는다", () => {
  const tabs: T[] = [{ key: "a" }];
  const plan = planOpen(tabs, "main", { key: "a" }, "preview");
  return expect(plan.tabs === tabs && !isPreview(plan.tabs[0]), "same array, still pinned");
});

test("미리보기 탭은 그룹마다 하나다: 다른 그룹의 미리보기 탭은 바뀌지 않는다", () => {
  const tabs: T[] = [{ key: "m", preview: true }, { key: "s", group: "g2", preview: true }];
  const inSecond = planOpen(tabs, "g2", { key: "n" }, "preview");
  expect(keys(inSecond.tabs) === "~m,~n" && inSecond.tabs[1].group === "g2" && inSecond.replaced === "s", `${keys(inSecond.tabs)} group=${inSecond.tabs[1].group}`);
  const inMain = planOpen(tabs, "main", { key: "n" }, "preview");
  expect(keys(inMain.tabs) === "~n,~s" && inMain.tabs[0].group === undefined, keys(inMain.tabs));
  const noneThere = planOpen<T>([{ key: "m", preview: true }], "g2", { key: "n" }, "preview");
  return expect(keys(noneThere.tabs) === "~m,~n" && noneThere.replaced === null, `other group untouched: ${keys(noneThere.tabs)}`);
});

test("main 그룹 탭에는 group 이 붙지 않고, 다른 그룹 탭에는 붙는다", () => {
  const main = planOpen<T>([], "main", { key: "a", group: "stale" }, "pinned");
  const other = planOpen<T>([], "g3", { key: "a" }, "pinned");
  return expect(main.tabs[0].group === undefined && other.tabs[0].group === "g3", "group handling");
});

test("pinTab: 미리보기만 고정하고 나머지는 같은 배열을 돌려준다(편집 시작, 저장, 탭 더블클릭)", () => {
  const tabs: T[] = [{ key: "a", preview: true }, { key: "b" }];
  const pinned = pinTab(tabs, "a");
  expect(keys(pinned) === "a,b" && pinned[0] !== tabs[0], keys(pinned));
  expect(pinTab(tabs, "b") === tabs, "pinned tab: same array");
  expect(pinTab(tabs, "zzz") === tabs, "unknown key: same array");
  return keys(pinned);
});

test("연속 클릭 시나리오: a, b, c 를 차례로 한 번씩 누르면 탭은 하나, 편집하면 고정되어 다음 클릭이 새 탭을 만든다", () => {
  let tabs: T[] = [];
  for (const key of ["a", "b", "c"]) tabs = planOpen(tabs, "main", { key }, "preview").tabs;
  expect(keys(tabs) === "~c", keys(tabs));
  tabs = pinTab(tabs, "c");
  tabs = planOpen(tabs, "main", { key: "d" }, "preview").tabs;
  expect(keys(tabs) === "c,~d", keys(tabs));
  tabs = planOpen(tabs, "main", { key: "d" }, "pinned").tabs;
  return expect(keys(tabs) === "c,d", keys(tabs));
});

test("개수 배지: 0 이하는 없음, 9 까지는 숫자, 10 부터 9+", () => {
  expect(countBadge(0) === null && countBadge(-3) === null && countBadge(Number.NaN) === null, "none");
  expect(countBadge(1) === "1" && countBadge(9) === "9", "digits");
  expect(countBadge(10) === "9+" && countBadge(16) === "9+" && countBadge(1000) === "9+", "9+");
  return "0:null 1:1 9:9 10:9+";
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

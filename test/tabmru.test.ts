// 탭을 닫으면 그 그룹에서 직전에 활성이던 탭으로 돌아가는 규칙(web/tabMru.ts)을 본다. 실행: npm test
import { noteActive, pickAfterClose, recentAfterClose, touchTab, type TabMru } from "../web/tabMru";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

// store.ts 의 setState 훅과 closeTab 이 하는 일을 순수 함수로 되풀이하는 작은 모의 그룹이다.
class Group {
  mru: TabMru = {};
  tabs: string[] = [];
  active: string | null = "changes";
  // sideKey: main 그룹의 마지막 탭을 닫았을 때 돌아가는, 고정 칸이 보이던 탭
  constructor(private readonly id = "main", public sideKey: string = "changes") {}
  activate(key: string) {
    // normalizeTabs: 고정 탭을 고르면 고정 칸이 그 탭을 보인다(에디터 탭이 열려 있으면 활성 탭은 그대로)
    if (key === "changes" || key === "files") {
      this.sideKey = key;
      if (this.tabs.length > 0) return;
    }
    this.mru = noteActive(this.mru, { group: this.id, key: this.active }, { group: this.id, key });
    this.active = key;
  }
  open(key: string) {
    this.tabs.push(key);
    this.activate(key);
  }
  close(key: string) {
    const siblings = [...this.tabs];
    this.tabs = this.tabs.filter((t) => t !== key);
    if (this.active !== key) return;
    this.activate(pickAfterClose(this.mru, this.id, key, siblings, this.id === "main" ? this.sideKey : null) as string);
  }
}

test("Files, open a file, close it: back to Files", () => {
  const g = new Group();
  g.activate("files");
  g.open("a.ts");
  g.close("a.ts");
  expect(g.active === "files", `${g.active}`);
  return "files";
});

test("Changes, open a diff, open another file, close it: back to the diff", () => {
  const g = new Group();
  g.open("diff:x");
  g.open("b.ts");
  g.close("b.ts");
  expect(g.active === "diff:x", `${g.active}`);
  g.close("diff:x");
  expect(g.active === "changes", `closing the last editor goes back to the pinned tab it came from: ${g.active}`);
  return "diff then changes";
});

test("closing the last editor tab returns to the previous pinned tab, not always Changes", () => {
  const g = new Group();
  g.activate("files");
  g.open("a.ts");
  g.close("a.ts");
  expect(g.active === "files", `${g.active}`);
  return "files";
});

test("the order follows use, not position", () => {
  const g = new Group();
  g.open("a");
  g.open("b");
  g.open("c");
  g.activate("a");
  g.activate("c");
  g.close("c");
  expect(g.active === "a", `${g.active}`);
  g.close("a");
  expect(g.active === "b", `${g.active}`);
  return "a then b";
});

test("closing a tab that is not active keeps the active one", () => {
  const g = new Group();
  g.open("a");
  g.open("b");
  g.close("a");
  expect(g.active === "b", `${g.active}`);
  return "b";
});

test("groups keep separate orders", () => {
  let mru: TabMru = {};
  mru = noteActive(mru, { group: "main", key: null }, { group: "main", key: "m1" });
  mru = noteActive(mru, { group: "g1", key: null }, { group: "g1", key: "x1" });
  mru = noteActive(mru, { group: "g1", key: "x1" }, { group: "g1", key: "x2" });
  expect(recentAfterClose(mru, "g1", "x2", ["x1", "x2"]) === "x1", "g1");
  expect(recentAfterClose(mru, "main", "m1", ["m1"]) === null, "main has nothing else");
  return "separate";
});

test("a remembered tab that moved to another group or closed is skipped", () => {
  const mru = touchTab(touchTab(touchTab({}, "main", "a"), "main", "b"), "main", "c");
  expect(recentAfterClose(mru, "main", "c", ["a", "c"]) === "a", "b is gone");
  expect(recentAfterClose(mru, "main", "c", ["c"]) === null, "nothing left");
  return "filtered";
});

test("a tab that is not in the list yet still works through the neighbor fallback", () => {
  const g = new Group();
  g.tabs = ["a", "b", "c"];
  g.active = "b";
  g.close("b");
  expect(g.active === "c", `${g.active}`);
  return "neighbor";
});

test("choosing Files while editors are open does not become a close target", () => {
  const g = new Group();
  g.open("a.ts");
  g.open("b.ts");
  g.activate("files");
  expect(g.active === "b.ts", "the active editor stays");
  g.close("b.ts");
  expect(g.active === "a.ts", `an editor tab wins over the pinned tab: ${g.active}`);
  g.close("a.ts");
  expect(g.active === "files", `the column's tab returns once no editor is left: ${g.active}`);
  return "files last";
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

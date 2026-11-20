// Chat 중심에서 에디터 옆에 붙는 고정 칸(Changes, Files)의 폭 계산(web/pinnedLayout.ts)을 확인한다. 실행: npm test
import type { EditorLayout } from "../web/editorGroups";
import { PINNED_DEFAULT, PINNED_EDITOR_MIN, PINNED_FIT, PINNED_MIN, edgeGroupOf, fitsBoth, isPinnedSide, nextPinnedState, parsePinnedWidth, pinnedRange, pinnedShown, pinnedWidth, presentationOf, snapDrawerWidth, DRAWER_SLIVER } from "../web/pinnedLayout";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("pinnedRange: the editors always keep their minimum width", () => {
  const wide = pinnedRange(900);
  expect(wide.min === PINNED_MIN && wide.max === 900 - 1 - PINNED_EDITOR_MIN, `max ${wide.max}`);
  const tight = pinnedRange(PINNED_MIN + 1 + PINNED_EDITOR_MIN);
  expect(tight.max === PINNED_MIN, `at the smallest panel both minimums fit exactly: ${tight.max}`);
  expect(pinnedRange(100).max === PINNED_MIN, "never below the minimum");
  return "ok";
});

test("pinnedWidth: saved width is clamped into the range, default is 300", () => {
  expect(pinnedWidth(900, null) === PINNED_DEFAULT, "default");
  expect(pinnedWidth(1000, 420) === 420, "saved");
  expect(pinnedWidth(900, 50) === PINNED_MIN, "too small");
  expect(pinnedWidth(1000, 800) === 1000 - 1 - PINNED_EDITOR_MIN, "too large for the editors");
  expect(pinnedWidth(801, 410) === 801 - 1 - PINNED_EDITOR_MIN, "the 801px panel of the dogfood case leaves the editors 480px");
  expect(pinnedWidth(700, null) === 700 - 1 - PINNED_EDITOR_MIN, "the default shrinks in a 700px panel so the editors keep PINNED_EDITOR_MIN");
  return "ok";
});

test("presentationOf: side, collapsed, overlay", () => {
  expect(presentationOf(900, false) === "side", "wide");
  expect(presentationOf(900, true) === "collapsed", "wide but collapsed");
  expect(presentationOf(PINNED_FIT, false) === "side", "exactly enough for both");
  expect(presentationOf(PINNED_MIN + PINNED_EDITOR_MIN, false) === "overlay", "one pixel short for the border");
  expect(presentationOf(400, true) === "overlay", "narrow wins over collapsed: the toggle opens the drawer");
  expect(presentationOf(0, false) === "side", "not measured yet draws side by side, no drawer flash");
  expect(fitsBoth(PINNED_MIN + PINNED_EDITOR_MIN) === false && fitsBoth(PINNED_MIN + 1 + PINNED_EDITOR_MIN) === true, "threshold is the two minimums plus the border");
  return "ok";
});

test("pinnedWidth in an overlay never exceeds the panel", () => {
  expect(pinnedWidth(260, null) === 260, "260px panel, default 300 -> 260");
  expect(pinnedWidth(400, 300) === 300, "400px panel keeps 300");
  return "ok";
});

test("nextPinnedState: the toggle collapses beside the editors and opens the drawer when narrow", () => {
  const a = nextPinnedState("side", false, false);
  expect(a.collapsed === true && a.drawerOpen === false, "side -> collapsed");
  const b = nextPinnedState("collapsed", true, false);
  expect(b.collapsed === false && b.drawerOpen === false, "collapsed -> side");
  const c = nextPinnedState("overlay", false, false);
  expect(c.collapsed === false && c.drawerOpen === true, "overlay opens, the remembered collapse is untouched");
  const d = nextPinnedState("overlay", true, true);
  expect(d.collapsed === true && d.drawerOpen === false, "overlay closes");
  return "ok";
});

test("pinnedShown", () => {
  expect(pinnedShown("side", false) && !pinnedShown("collapsed", true) && !pinnedShown("overlay", false) && pinnedShown("overlay", true), "shown only when beside or drawer open");
  return "ok";
});

test("parsePinnedWidth and isPinnedSide reject junk", () => {
  expect(parsePinnedWidth("320") === 320 && parsePinnedWidth(320.4) === 320, "numbers and numeric strings");
  expect(parsePinnedWidth("abc") === null && parsePinnedWidth(null) === null && parsePinnedWidth(120) === null && parsePinnedWidth(99999) === null, "junk");
  expect(isPinnedSide("left") && isPinnedSide("right") && !isPinnedSide("top") && !isPinnedSide(null), "sides");
  return "ok";
});

test("edgeGroupOf: the top group touching the pinned column", () => {
  const g = (id: string): EditorLayout => ({ type: "group", id });
  const row: EditorLayout = { type: "split", id: "s1", dir: "row", children: [g("main"), g("g2")], sizes: [0.5, 0.5] };
  expect(edgeGroupOf(g("main"), "right") === "main", "single group");
  expect(edgeGroupOf(row, "right") === "g2" && edgeGroupOf(row, "left") === "main", "row split");
  const column: EditorLayout = { type: "split", id: "s2", dir: "column", children: [row, g("g3")], sizes: [0.5, 0.5] };
  expect(edgeGroupOf(column, "right") === "g2", "stacked: the top row's right end");
  const nested: EditorLayout = { type: "split", id: "s3", dir: "row", children: [g("main"), { type: "split", id: "s4", dir: "column", children: [g("g2"), g("g3")], sizes: [0.5, 0.5] }], sizes: [0.5, 0.5] };
  expect(edgeGroupOf(nested, "right") === "g2", "right column's top group");
  return "ok";
});
test("snapDrawerWidth: a thin sliver of another group next to the drawer is covered", () => {
  const groups = [{ left: 0, right: 312 }, { left: 313, right: 625 }];
  expect(snapDrawerWidth(625, 300, "right", groups) === 312, "the 12px of group 2 left of a 300px drawer: widen to the group edge");
  expect(snapDrawerWidth(625, 150, "right", groups) === 150, "a wide visible part is left alone");
  expect(snapDrawerWidth(625, 313, "right", groups) === 313, "the drawer edge on the group edge");
  expect(snapDrawerWidth(625, 300, "left", groups) === 312, "left drawer: group 1 shows 12px past it");
  expect(snapDrawerWidth(625, 300, "right", [{ left: 0, right: 625 }]) === 300, "a single group is the editor itself");
  expect(DRAWER_SLIVER > 12, "threshold");
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

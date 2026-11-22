import { stripScrollTarget, type TabBox } from "../web/tabStrip";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const tabs: TabBox[] = Array.from({ length: 6 }, (_, i) => ({ left: i * 100, right: i * 100 + 100 }));
const at = (scrollLeft: number, active: number, width = 350, padRight = 30) => stripScrollTarget({ scrollLeft, width, padRight, tabs, active });

test("an active tab that already fits does not scroll", () => expect(at(0, 2) === 0 && at(100, 3) === 100, "no move"));

test("scrolling right to a tab lands on a tab boundary, never inside a tab", () => {
  const next = at(0, 5);
  expect(next === 300, `got ${next}`);
  return expect(tabs.some((t) => t.left === next), "boundary");
});

test("the active tab stays visible after snapping", () => {
  for (let active = 0; active < tabs.length; active++) {
    const next = at(0, active);
    expect(tabs[active].left >= next && tabs[active].right <= next + 320, `active ${active} next ${next}`);
  }
  return "all six";
});

test("scrolling left to a hidden tab puts its left edge at the view edge", () => expect(at(300, 1) === 100, `got ${at(300, 1)}`));

test("when the next boundary is past the scroll end, go back to the clipped tab's left edge", () => {
  const next = stripScrollTarget({ scrollLeft: 60, width: 380, padRight: 30, tabs, active: 2, maxScroll: 60 });
  return expect(next === 0 && tabs[2].right <= next + 350, `got ${next}`);
});

test("a tab wider than the view is aligned to its left edge", () => {
  const wide: TabBox[] = [{ left: 0, right: 100 }, { left: 100, right: 700 }];
  const next = stripScrollTarget({ scrollLeft: 0, width: 300, padRight: 0, tabs: wide, active: 1 });
  return expect(next === 100, `got ${next}`);
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

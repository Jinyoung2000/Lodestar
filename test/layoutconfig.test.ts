// Customize Layout 의 순수 로직(web/layoutConfig.ts)을 확인한다. 실행: npm test
import { DEFAULT_LAYOUT_CONFIG, PANEL_ALIGNMENTS, SIDE_BAR_POSITIONS, gridPlan, gridVars, isDefaultLayoutConfig, parseLayoutConfig, restoredLayoutConfig, type LayoutConfig } from "../web/layoutConfig";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("defaults follow VS Code: side bar left, panel centered, activity bar shown", () => {
  expect(DEFAULT_LAYOUT_CONFIG.sideBar === "left" && DEFAULT_LAYOUT_CONFIG.panelAlignment === "center" && DEFAULT_LAYOUT_CONFIG.activityBar, "defaults");
  expect(isDefaultLayoutConfig(DEFAULT_LAYOUT_CONFIG) && !isDefaultLayoutConfig({ ...DEFAULT_LAYOUT_CONFIG, sideBar: "right" }), "isDefault");
  expect(PANEL_ALIGNMENTS.join() === "left,right,center,justify", "alignment order matches the Customize Layout window");
  expect(SIDE_BAR_POSITIONS.join() === "left,right", "position order");
  return "ok";
});

test("parse: broken fields fall back one by one", () => {
  expect(parseLayoutConfig(null) === DEFAULT_LAYOUT_CONFIG, "null");
  expect(parseLayoutConfig("not json") === DEFAULT_LAYOUT_CONFIG, "garbage");
  expect(parseLayoutConfig("[1]") === DEFAULT_LAYOUT_CONFIG, "array");
  const mixed = parseLayoutConfig({ sideBar: "right", panelAlignment: "diagonal", activityBar: "no" });
  expect(mixed.sideBar === "right" && mixed.panelAlignment === "center" && mixed.activityBar === true, JSON.stringify(mixed));
  const hidden = parseLayoutConfig(JSON.stringify({ sideBar: "left", panelAlignment: "justify", activityBar: false }));
  expect(hidden.panelAlignment === "justify" && hidden.activityBar === false, JSON.stringify(hidden));
  return "ok";
});

test("restore defaults resets position, alignment and activity bar", () => {
  const restored = restoredLayoutConfig();
  expect(isDefaultLayoutConfig(restored), JSON.stringify(restored));
  return "ok";
});

test("gridPlan: side bar left, panel center puts the panel under the middle column only and both side bars full height", () => {
  const p = gridPlan({ sideBar: "left", panelAlignment: "center" });
  expect(p.primaryColumn === 1 && p.secondaryColumn === 5, "columns");
  expect(p.panelColumns === "3 / 4", p.panelColumns);
  expect(p.primaryRows === "1 / 4" && p.secondaryRows === "1 / 4", "side bars reach the panel row");
  expect(p.primaryDirection === 1 && p.secondaryDirection === -1, "drag directions");
  return p.panelColumns;
});

test("gridPlan: panel alignment decides which side bars are shortened", () => {
  const left = gridPlan({ sideBar: "left", panelAlignment: "left" });
  expect(left.panelColumns === "1 / 4" && left.primaryRows === "1" && left.secondaryRows === "1 / 4", `left ${left.panelColumns} ${left.primaryRows} ${left.secondaryRows}`);
  const right = gridPlan({ sideBar: "left", panelAlignment: "right" });
  expect(right.panelColumns === "3 / 6" && right.primaryRows === "1 / 4" && right.secondaryRows === "1", `right ${right.panelColumns}`);
  const justify = gridPlan({ sideBar: "left", panelAlignment: "justify" });
  expect(justify.panelColumns === "1 / 6" && justify.primaryRows === "1" && justify.secondaryRows === "1", `justify ${justify.panelColumns}`);
  return "ok";
});

test("gridPlan: alignment is physical, so a right side bar swaps which side bar the panel runs under", () => {
  const left = gridPlan({ sideBar: "right", panelAlignment: "left" });
  // 왼쪽 열은 Secondary, 오른쪽 열이 Primary
  expect(left.primaryColumn === 5 && left.secondaryColumn === 1 && left.primaryResizerColumn === 4 && left.secondaryResizerColumn === 2, "columns");
  expect(left.panelColumns === "1 / 4" && left.secondaryRows === "1" && left.primaryRows === "1 / 4", `secondary shortened ${left.secondaryRows} ${left.primaryRows}`);
  expect(left.primaryDirection === -1 && left.secondaryDirection === 1, "directions flip");
  const right = gridPlan({ sideBar: "right", panelAlignment: "right" });
  expect(right.primaryRows === "1" && right.secondaryRows === "1 / 4", "primary shortened");
  return "ok";
});

test("gridPlan: every combination keeps a side bar full height only when the panel does not run under it", () => {
  for (const sideBar of SIDE_BAR_POSITIONS) {
    for (const panelAlignment of PANEL_ALIGNMENTS) {
      const p = gridPlan({ sideBar, panelAlignment } satisfies Pick<LayoutConfig, "sideBar" | "panelAlignment">);
      const [start, end] = p.panelColumns.split(" / ").map(Number);
      const under = (column: number) => start <= column && column < end;
      expect((p.primaryRows === "1") === under(p.primaryColumn), `${sideBar}/${panelAlignment} primary`);
      expect((p.secondaryRows === "1") === under(p.secondaryColumn), `${sideBar}/${panelAlignment} secondary`);
      expect(under(3), `${sideBar}/${panelAlignment} panel always under the middle column`);
    }
  }
  return "8 combinations";
});

test("gridVars: values reach CSS custom properties as strings", () => {
  const vars = gridVars({ sideBar: "right", panelAlignment: "justify" });
  expect(vars["--grid-primary-col"] === "5" && vars["--grid-secondary-col"] === "1" && vars["--grid-panel-cols"] === "1 / 6", JSON.stringify(vars));
  return Object.keys(vars).length + " vars";
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

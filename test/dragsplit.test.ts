// 사이드바 세션 행을 칸에 끌어 놓는 규칙의 순수 로직(web/paneDrop.ts, web/gridLayout.ts)을 확인한다. 실행: npm test
import { gridOf, paneOrder, placeBeside, withoutPane, type Grid } from "../web/gridLayout";
import { allowedEdges, planSessionDrop, previewRect, zoneAt, type DropState } from "../web/paneDrop";
import type { Pane } from "../web/store";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(wanted);
  if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
};

const R = { left: 100, top: 50, width: 400, height: 200 };
const BOTH = { horizontal: true, vertical: true };

test("zoneAt: edges are the outer quarter, the middle is center", () => {
  same(zoneAt(R, 110, 150, BOTH), "left", "left");
  same(zoneAt(R, 490, 150, BOTH), "right", "right");
  same(zoneAt(R, 300, 55, BOTH), "top", "top");
  same(zoneAt(R, 300, 245, BOTH), "bottom", "bottom");
  same(zoneAt(R, 300, 150, BOTH), "center", "center");
  same(zoneAt(R, 100 + 99, 150, BOTH), "left", "just inside the left quarter");
  same(zoneAt(R, 100 + 101, 150, BOTH), "center", "just outside the left quarter");
  return "5 zones and the 25% boundary";
});

test("zoneAt: outside the rectangle is null, a corner goes to the nearer edge", () => {
  same(zoneAt(R, 99, 150, BOTH), null, "left of rect");
  same(zoneAt(R, 300, 251, BOTH), null, "below rect");
  same(zoneAt({ ...R, width: 0 }, 100, 100, BOTH), null, "empty rect");
  // 왼쪽 위 모서리: 가로 10/400=0.025, 세로 40/200=0.2 이므로 left
  same(zoneAt(R, 110, 90, BOTH), "left", "corner nearer the left edge");
  // 세로 5/200=0.025, 가로 80/400=0.2 이므로 top
  same(zoneAt(R, 180, 55, BOTH), "top", "corner nearer the top edge");
  return "null outside, nearer edge in corners";
});

test("zoneAt: closed directions fall back to center", () => {
  same(zoneAt(R, 110, 150, { horizontal: false, vertical: true }), "center", "left closed");
  same(zoneAt(R, 300, 55, { horizontal: true, vertical: false }), "center", "top closed");
  same(zoneAt(R, 110, 55, { horizontal: false, vertical: true }), "top", "corner with only vertical open");
  same(zoneAt(R, 110, 55, { horizontal: false, vertical: false }), "center", "all closed");
  return "per-axis closing";
});

test("allowedEdges: only the floating window closes the edges", () => {
  same(allowedEdges(true), { horizontal: false, vertical: false }, "floating");
  same(allowedEdges(false), { horizontal: true, vertical: true }, "grid pane");
  return "floating vs grid";
});

test("previewRect: edges fill the half toward that side, center fills the pane, top/bottom use the row", () => {
  const row = { left: 100, top: 50, width: 800, height: 200 };
  same(previewRect("center", R, row), R, "center");
  same(previewRect("left", R, row), { left: 100, top: 50, width: 200, height: 200 }, "left");
  same(previewRect("right", R, row), { left: 300, top: 50, width: 200, height: 200 }, "right");
  same(previewRect("top", R, row), { left: 100, top: 50, width: 800, height: 100 }, "top");
  same(previewRect("bottom", R, row), { left: 100, top: 150, width: 800, height: 100 }, "bottom");
  return "5 previews";
});

const agentPane = (id: string, agentId: string): Pane => ({ id, kind: "agent", agentId });
const draftPane = (id: string): Pane => ({ id, kind: "draft", workspaceId: "" });
const state = (panes: Pane[], grid: Grid, activePaneId = panes[0].id): DropState => ({ panes, grid, activePaneId });
const layout = (grid: Grid) => grid.rows.map((r) => r.ids);
let seq = 0;
const newId = () => `new-${++seq}`;

test("planSessionDrop: right/left edge opens a new pane beside the target", () => {
  const panes = [agentPane("p1", "a1"), agentPane("p2", "a2")];
  const s = state(panes, gridOf(["p1", "p2"]));
  const right = planSessionDrop(s, "a9", "p1", "right", newId)!;
  same(layout(right.grid), [["p1", "new-1", "p2"]], "right of p1");
  same(right.panes.length, 3, "pane count");
  same(right.activePaneId, "new-1", "new pane focused");
  const left = planSessionDrop(s, "a9", "p1", "left", newId)!;
  same(layout(left.grid), [["new-2", "p1", "p2"]], "left of p1");
  return "[p1,new,p2] and [new,p1,p2]";
});

test("planSessionDrop: top/bottom edge opens a new row above or below the target row", () => {
  const panes = [agentPane("p1", "a1"), agentPane("p2", "a2")];
  const s = state(panes, { rows: [{ id: "r1", ids: ["p1"] }, { id: "r2", ids: ["p2"] }], colWeights: {}, rowWeights: null });
  const bottom = planSessionDrop(s, "a9", "p1", "bottom", newId)!;
  same(layout(bottom.grid), [["p1"], ["new-3"], ["p2"]], "below p1");
  const top = planSessionDrop(s, "a9", "p2", "top", newId)!;
  same(layout(top.grid), [["p1"], ["new-4"], ["p2"]], "above p2");
  const topFirst = planSessionDrop(s, "a9", "p1", "top", newId)!;
  same(layout(topFirst.grid), [["new-5"], ["p1"], ["p2"]], "above the first row");
  return "rows inserted on both sides";
});

test("planSessionDrop: center replaces the target pane's session in place", () => {
  const panes = [agentPane("p1", "a1"), draftPane("p2")];
  const s = state(panes, gridOf(["p1", "p2"]));
  const plan = planSessionDrop(s, "a9", "p2", "center", newId)!;
  same(plan.panes, [agentPane("p1", "a1"), agentPane("p2", "a9")], "p2 now shows a9");
  same(plan.grid, s.grid, "grid untouched");
  same(plan.activePaneId, "p2", "focus on target");
  return "pane id kept, session swapped";
});

test("planSessionDrop: a session already open moves instead of duplicating", () => {
  const panes = [agentPane("p1", "a1"), agentPane("p2", "a2"), agentPane("p3", "a3")];
  const s = state(panes, gridOf(["p1", "p2", "p3"]));
  const center = planSessionDrop(s, "a1", "p3", "center", newId)!;
  same(layout(center.grid), [["p3", "p2", "p1"]], "centers swap places");
  same(center.panes, panes, "pane list untouched");
  same(center.activePaneId, "p1", "focus follows the moved session");
  const edge = planSessionDrop(s, "a1", "p3", "right", newId)!;
  same(layout(edge.grid), [["p2", "p3", "p1"]], "p1 relocated to the right of p3");
  same(edge.panes.length, 3, "no duplicate pane");
  same(edge.panes.filter((p) => p.kind === "agent" && p.agentId === "a1").length, 1, "one pane for a1");
  const down = planSessionDrop(s, "a1", "p2", "bottom", newId)!;
  same(layout(down.grid), [["p2", "p3"], ["p1"]], "p1 moved to a new row below p2");
  same(down.panes.length, 3, "still three panes");
  return "swap on center, relocate on edge";
});

test("planSessionDrop: dropping a session on its own pane changes nothing", () => {
  const panes = [agentPane("p1", "a1"), agentPane("p2", "a2")];
  const s = state(panes, gridOf(["p1", "p2"]));
  same(planSessionDrop(s, "a1", "p1", "center", newId), null, "own center");
  same(planSessionDrop(s, "a1", "p1", "right", newId), null, "own edge");
  same(planSessionDrop(s, "a1", "gone", "center", newId), null, "missing target");
  return "null plans";
});

test("planSessionDrop: moving the only pane of a row to another row closes the emptied row", () => {
  const panes = [agentPane("p1", "a1"), agentPane("p2", "a2"), agentPane("p3", "a3")];
  const grid: Grid = { rows: [{ id: "r1", ids: ["p1", "p2"] }, { id: "r2", ids: ["p3"] }], colWeights: {}, rowWeights: null };
  const plan = planSessionDrop(state(panes, grid), "a3", "p1", "left", newId)!;
  same(layout(plan.grid), [["p3", "p1", "p2"]], "row r2 is gone");
  same(paneOrder(plan.grid).length, 3, "all panes placed");
  return "emptied row removed";
});

test("placeBeside: measured sizes split the target exactly in half", () => {
  const grid: Grid = { rows: [{ id: "r1", ids: ["a", "b"] }], colWeights: {}, rowWeights: null };
  const right = placeBeside(grid, "n", "b", "right", { cols: { a: 600, b: 400 } });
  same(layout(right), [["a", "b", "n"]], "order");
  same(right.colWeights, { a: 600, b: 200, n: 200 }, "b split in half, a untouched");
  const left = placeBeside(grid, "n", "a", "left", { cols: { a: 600, b: 400 } });
  same(left.colWeights, { n: 300, a: 300, b: 400 }, "left split");
  const rows: Grid = { rows: [{ id: "r1", ids: ["a"] }, { id: "r2", ids: ["b"] }], colWeights: {}, rowWeights: null };
  const below = placeBeside(rows, "n", "a", "bottom", { rows: { r1: 300, r2: 500 } });
  same(below.rowWeights, [150, 150, 500], "row split in half");
  const above = placeBeside(rows, "n", "b", "top", { rows: { r1: 300, r2: 500 } });
  same(above.rowWeights, [300, 250, 250], "row above split in half");
  return "col and row halves";
});

test("placeBeside: without measurements it keeps the existing rules", () => {
  const rows: Grid = { rows: [{ id: "r1", ids: ["a"] }, { id: "r2", ids: ["b"] }], colWeights: {}, rowWeights: [1, 3] };
  const below = placeBeside(rows, "n", "a", "bottom");
  same(below.rowWeights, [1, 2, 3], "mean height like splitDown");
  const flat = placeBeside(gridOf(["a", "b"]), "n", "a", "right");
  same(flat.colWeights, {}, "no weights stay unset");
  same(layout(withoutPane(flat, "n")), [["a", "b"]], "withoutPane");
  return "splitDown parity";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name}: ${c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log(`${cases.length} passed`);

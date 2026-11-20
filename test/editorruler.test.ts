// 개요 눈금자의 순수 계산(web/editorRulerModel.ts): 칸 폭, 표시 합치기, 커서 선, 슬라이더, 선택 일치.
// 실행: npm test
import { EditorSelection, EditorState } from "@codemirror/state";
import { CURSOR_CSS_PX, LANE_CENTER, LANE_FULL, LANE_LEFT, LANE_RIGHT, layoutCursors, layoutZones, overSlider, rulerLanes, scrollFromDelta, scrollFromOffset, selectionMatches, sliderMetrics, type RulerZone } from "../web/editorRulerModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

// 칸: 14px 트랙, dpr 1 이면 캔버스 폭 14. 왼쪽 경계선 1 뒤에서 4, 5, 4 로 나뉜다.
const one = rulerLanes(14);
check("lanes at dpr 1 split 13 as 4 / 5 / 4", one.w[LANE_LEFT] === 4 && one.w[LANE_CENTER] === 5 && one.w[LANE_RIGHT] === 4, JSON.stringify(one));
check("lane x starts after the 1px border", one.x[LANE_LEFT] === 1 && one.x[LANE_CENTER] === 5 && one.x[LANE_RIGHT] === 10);
check("the full lane spans all three", one.x[LANE_FULL] === 1 && one.w[LANE_FULL] === 13);
const two = rulerLanes(28);
check("lanes at dpr 2 are 9 / 9 / 9", two.w[LANE_LEFT] === 9 && two.w[LANE_CENTER] === 9 && two.w[LANE_RIGHT] === 9 && two.x[LANE_CENTER] === 10 && two.x[LANE_RIGHT] === 19);
check("left plus center lane is one block", one.x[3] === 1 && one.w[3] === 9);

const metrics = { scrollHeight: 10_000, canvasHeight: 1000, dpr: 1, lanes: one };
const zone = (top: number, bottom: number, lane: RulerZone["lane"] = LANE_RIGHT, color = "red", z = 30): RulerZone => ({ lane, top, bottom, color, z });

const tiny = layoutZones([zone(5000, 5019)], metrics);
check("a one line mark grows to the 6px minimum centered on the line", tiny.length === 1 && tiny[0]!.h === 6 && tiny[0]!.y === 497, JSON.stringify(tiny));
check("the right lane rectangle uses the lane x and width", tiny[0]!.x === 10 && tiny[0]!.w === 4);

const merged = layoutZones([zone(1000, 1019), zone(1050, 1069), zone(1090, 1109)], metrics);
check("overlapping marks become one rectangle", merged.length === 1 && merged[0]!.y === 97 && merged[0]!.h === 15, JSON.stringify(merged));
check("marks one pixel apart join, two pixels apart do not", layoutZones([zone(1000, 1019), zone(1070, 1089)], metrics).length === 1 && layoutZones([zone(1000, 1019), zone(1080, 1099)], metrics).length === 2);
const apart = layoutZones([zone(1000, 1019), zone(3000, 3019)], metrics);
check("marks far apart stay separate", apart.length === 2);
const lanesApart = layoutZones([zone(1000, 1019, LANE_LEFT), zone(1000, 1019, LANE_RIGHT)], metrics);
check("the same place in two lanes stays two rectangles", lanesApart.length === 2 && lanesApart[0]!.x !== lanesApart[1]!.x);
check("a mark at the very top and bottom stays inside the canvas", (() => {
  const edges = layoutZones([zone(0, 19), zone(9990, 10_009)], metrics);
  return edges[0]!.y === 0 && edges[1]!.y + edges[1]!.h === 1000;
})());
check("lower z is drawn first so errors end up on top", (() => {
  const rects = layoutZones([zone(100, 119, LANE_RIGHT, "E", 30), zone(100, 119, LANE_RIGHT, "I", 10), zone(100, 119, LANE_RIGHT, "W", 20)], metrics);
  return rects.map((r) => r.color).join("") === "IWE";
})());
check("a long selection spanning many lines keeps its real height", (() => {
  const rects = layoutZones([zone(2000, 4000, LANE_LEFT, "blue", 0)], metrics);
  return rects[0]!.y === 200 && rects[0]!.h === 200;
})());
check("100k marks collapse to a handful of rectangles", (() => {
  const many: RulerZone[] = [];
  for (let line = 0; line < 100_000; line++) many.push(zone(line * 20, line * 20 + 19, LANE_CENTER, "find", 0));
  const rects = layoutZones(many, { scrollHeight: 2_000_000, canvasHeight: 1000, dpr: 1, lanes: one });
  return rects.length === 1 && rects[0]!.y === 0 && rects[0]!.h === 1000;
})());
check("dpr 2 doubles the minimum height", layoutZones([zone(5000, 5019)], { scrollHeight: 10_000, canvasHeight: 2000, dpr: 2, lanes: two })[0]!.h === 12);
check("no scroll height draws nothing", layoutZones([zone(0, 10)], { ...metrics, scrollHeight: 0 }).length === 0);

const cursors = layoutCursors([{ top: 5000, color: "c" }], metrics);
check("the cursor line is 2px tall across the full lane", cursors.length === 1 && cursors[0]!.h === CURSOR_CSS_PX && cursors[0]!.x === 1 && cursors[0]!.w === 13 && cursors[0]!.y === 499, JSON.stringify(cursors));
check("cursors on neighbouring pixels join, far ones do not", layoutCursors([{ top: 5000, color: "c" }, { top: 5010, color: "c" }], metrics).length === 1 && layoutCursors([{ top: 5000, color: "c" }, { top: 8000, color: "c" }], metrics).length === 2);
check("cursor colors that differ stay separate", layoutCursors([{ top: 5000, color: "a" }, { top: 5010, color: "b" }], metrics).length === 2);

// 슬라이더: 보이는 높이 800, 문서 4000, 가로 스크롤바 없음
const slider = sliderMetrics({ visible: 800, scrollSize: 4000, scrollPosition: 1600, oppositeSize: 0 });
check("slider size is visible/scroll of the track", slider.needed && slider.size === 160 && slider.track === 800, JSON.stringify(slider));
check("slider position follows the ratio (track - size) / (scroll - visible)", slider.position === Math.round(1600 * (640 / 3200)) && slider.position === 320);
check("a short document needs no slider", !sliderMetrics({ visible: 800, scrollSize: 700, scrollPosition: 0, oppositeSize: 0 }).needed);
check("the slider never gets shorter than 20", sliderMetrics({ visible: 800, scrollSize: 400_000, scrollPosition: 0, oppositeSize: 0 }).size === 20);
check("a horizontal scrollbar shortens the track by its height", sliderMetrics({ visible: 800, scrollSize: 4000, scrollPosition: 0, oppositeSize: 12 }).track === 788);
check("clicking the track centers the slider on the click", scrollFromOffset(slider, 400) === Math.round((400 - 80) / slider.ratio) && scrollFromOffset(slider, 400) === 1600);
check("dragging by a pixel moves the scroll by 1/ratio", scrollFromDelta(slider, 1600, 64) === 1600 + 320);
check("hit test of the slider", overSlider(slider, 321) && !overSlider(slider, 100) && !overSlider(slider, 481));

// 선택 일치
const doc = "foo bar foo\nbaz foo\n";
const selected = (from: number, to: number) => EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [EditorState.allowMultipleSelections.of(true)] });
check("selection matches skip the selection itself", JSON.stringify(selectionMatches(selected(0, 3))) === JSON.stringify([{ from: 8, to: 11 }, { from: 16, to: 19 }]));
check("an empty selection has none", selectionMatches(selected(2, 2)).length === 0);
check("more than one cursor has none", selectionMatches(EditorState.create({ doc, selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 11)]), extensions: [EditorState.allowMultipleSelections.of(true)] })).length === 0);
check("a selection longer than 200 characters has none", selectionMatches(EditorState.create({ doc: "x".repeat(300), selection: EditorSelection.single(0, 250) })).length === 0);
check("the limit stops the scan", selectionMatches(EditorState.create({ doc: "a ".repeat(100), selection: EditorSelection.single(0, 1) }), 10).length === 10);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("editor ruler: all passed");

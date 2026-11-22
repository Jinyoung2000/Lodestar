import { PANE_MIN } from "../web/paneDrop";
import { paneMin, panesFit, panesMinWidth, RIGHT_FLOOR, rightRange, rowMinWidth, sidebarMax, stretchedMin } from "../web/paneFit";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(wanted);
  if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
};

const NARROW = 300;

test("rowMinWidth: cols x PANE_MIN plus 1px dividers, zero for no cols", () => {
  same(rowMinWidth(0), 0, "0 cols");
  same(rowMinWidth(1), PANE_MIN, "1 col");
  same(rowMinWidth(4), 4 * PANE_MIN + 3, "4 cols");
  return "0, 1, 4 cols";
});

test("paneMin: several columns use the chat min 360, one column keeps the old floor 300", () => {
  same(paneMin(false), PANE_MIN, "many");
  same(paneMin(true), 300, "single");
  same(rowMinWidth(1, paneMin(true)), 300, "single row");
  const range = rightRange({ center: 744, sideChat: 0, panesReserve: panesMinWidth([1], 300), squeezeReserve: 300, narrow: NARROW });
  const fit = panesFit(744, 0, range.max, [1], 300);
  same(fit.scrolls, false, "1024 window, sidebar 280, one pane: no scroll");
  same(range.max, 444, "panel takes the rest");
  return "360 / 300, 1024 window single pane does not scroll";
});

test("panesMinWidth: the row with the most cols decides", () => {
  same(panesMinWidth([]), 0, "no rows");
  same(panesMinWidth([1, 3, 2]), rowMinWidth(3), "widest row");
  return "widest row wins";
});

test("rightRange: 1280 window, sidebar 280, 4 cols: the panel stops at its minimum 300 and the cells scroll", () => {
  const range = rightRange({ center: 1000, sideChat: 0, panesReserve: panesMinWidth([4]), squeezeReserve: PANE_MIN, narrow: NARROW });
  same(range, { min: 300, max: 300 }, "range");
  const fit = panesFit(1000, 0, range.max, [4]);
  same(fit.scrolls, true, "scrolls");
  if (fit.each < PANE_MIN) throw new Error(`cell ${fit.each} below ${PANE_MIN}`);
  return "right 300, cells >= 360, grid scrolls";
});

test("rightRange: 2 cols on a wide window: the panel may widen until both cells are exactly PANE_MIN", () => {
  const range = rightRange({ center: 1400, sideChat: 0, panesReserve: panesMinWidth([2]), squeezeReserve: PANE_MIN, narrow: NARROW });
  same(range.max, 1400 - rowMinWidth(2), "max");
  const fit = panesFit(1400, 0, range.max, [2]);
  same(fit.scrolls, false, "scrolls");
  same(fit.each, PANE_MIN, "each");
  return "max 679, no scroll, cells 360";
});

test("rightRange: a single column keeps the old floor (300) so the panel can widen to 860 on 1440", () => {
  const range = rightRange({ center: 1160, sideChat: 0, panesReserve: 300, squeezeReserve: 300, narrow: NARROW });
  same(range, { min: 300, max: 860 }, "range");
  return "min 300, max 860";
});

test("rightRange: a very narrow center lets the panel go below 300 so one cell keeps its minimum, but never below RIGHT_FLOOR", () => {
  const range = rightRange({ center: 600, sideChat: 0, panesReserve: panesMinWidth([3]), squeezeReserve: PANE_MIN, narrow: NARROW });
  same(range.min, 240, "min squeezed");
  same(range.max, 240, "max follows min");
  const tiny = rightRange({ center: 300, sideChat: 0, panesReserve: panesMinWidth([2]), squeezeReserve: PANE_MIN, narrow: NARROW });
  same(tiny, { min: RIGHT_FLOOR, max: RIGHT_FLOOR }, "never below the floor");
  return "240 at 600, floor 200 at 300";
});

test("stretchedMin: panes that overflow grow so a whole number of them fills the region, so scroll stops land on pane edges", () => {
  same(stretchedMin(360, 2000, [4]), 360, "fits: unchanged");
  same(stretchedMin(360, 680, [4]), 680, "680 region, 4 panes: one per screen");
  same(stretchedMin(360, 860, [4]), 429, "860 region: two per screen");
  same(stretchedMin(360, 1000, [3]), 499, "1000 region, 3 panes: two per screen");
  same(stretchedMin(300, 220, [1, 2]), 300, "region below the minimum: stays at the minimum and scrolls");
  same(stretchedMin(360, 0, [4]), 360, "unmeasured region");
  for (const region of [400, 500, 680, 860, 1000, 1160]) for (const cols of [2, 3, 4, 5]) {
    const w = stretchedMin(360, region, [cols]);
    if (w < 360) throw new Error(`below min: ${w}`);
    if (panesMinWidth([cols], 360) > region) {
      const fit = Math.max(1, Math.floor((region + 1) / (w + 1)));
      if (fit * w + (fit - 1) > region) throw new Error(`${fit} panes of ${w} overflow ${region}`);
    }
  }
  return "680 -> 680, 860 -> 429, 1000 x3 -> 499";
});

test("rightRange: the /btw side chat width comes off the free space", () => {
  const range = rightRange({ center: 1400, sideChat: 360, panesReserve: panesMinWidth([2]), squeezeReserve: PANE_MIN, narrow: NARROW });
  same(range.max, 1400 - 360 - rowMinWidth(2), "max");
  return `max ${range.max}`;
});

test("panesFit: no cell is narrower than PANE_MIN for any window x cols x right width", () => {
  let checked = 0;
  for (const center of [500, 744, 1000, 1160, 1440, 2000]) {
    for (const cols of [1, 2, 3, 4, 6]) {
      for (const sideChat of [0, 360]) {
        const range = rightRange({ center, sideChat, panesReserve: panesMinWidth([cols]), squeezeReserve: PANE_MIN, narrow: NARROW });
        for (const right of [range.min, range.max]) {
          const fit = panesFit(center, sideChat, right, [cols]);
          if (fit.each < PANE_MIN) throw new Error(`center ${center} cols ${cols} side ${sideChat} right ${right}: cell ${fit.each}`);
          checked++;
        }
      }
    }
  }
  return `${checked} combinations`;
});

test("sidebarMax: keeps one cell and the open right panel minimum, never below the sidebar minimum", () => {
  same(sidebarMax(1280, 300, PANE_MIN, 400, 200), 400, "wide window");
  same(sidebarMax(1024, 300, PANE_MIN, 400, 200), 364, "1024 with right panel");
  same(sidebarMax(1024, 0, PANE_MIN, 400, 200), 400, "right panel closed");
  same(sidebarMax(700, 300, PANE_MIN, 400, 200), 200, "tiny window clamps to min");
  return "400, 364, 400, 200";
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

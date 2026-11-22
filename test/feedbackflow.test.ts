import { FLOW_OFF, attachElement, labelPlacement, openFlow, pressEscape, removeElement, togglePicking } from "../web/feedbackFlow";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: unknown) => {
  if (!condition) throw new Error(String(JSON.stringify(detail)));
  return JSON.stringify(detail);
};

test("open starts with compose and picking both on, nothing attached", () => {
  const f = openFlow();
  return expect(f.mode === "compose" && f.picking && !f.attached, f);
});
test("clicking an element attaches it and turns picking off, compose stays", () => {
  const f = attachElement(openFlow());
  return expect(f.mode === "compose" && !f.picking && f.attached, f);
});
test("a pick that finishes after Esc turned picking off is ignored", () => {
  const afterEsc = pressEscape(openFlow());
  const f = attachElement(afterEsc);
  return expect(f === afterEsc && !f.attached, f);
});
test("a pick that finishes after the feedback closed is ignored", () => {
  const f = attachElement(FLOW_OFF);
  return expect(f.mode === "off" && !f.attached, f);
});
test("the Attach Element button toggles picking and keeps the chip", () => {
  const attached = attachElement(openFlow());
  const on = togglePicking(attached);
  const off = togglePicking(on);
  return expect(on.picking && on.attached && !off.picking && off.attached, { on, off });
});
test("toggling does nothing while closed", () => expect(togglePicking(FLOW_OFF) === FLOW_OFF, FLOW_OFF));
test("first Esc with picking on only turns picking off", () => {
  const f = pressEscape(openFlow());
  return expect(f.mode === "compose" && !f.picking, f);
});
test("second Esc closes", () => {
  const f = pressEscape(pressEscape(openFlow()));
  return expect(f.mode === "off" && !f.picking && !f.attached, f);
});
test("Esc after attaching (picking already off) closes at once", () => {
  const f = pressEscape(attachElement(openFlow()));
  return expect(f.mode === "off", f);
});
test("Esc after toggling picking back on turns picking off first", () => {
  const f = pressEscape(togglePicking(pressEscape(openFlow())));
  return expect(f.mode === "compose" && !f.picking, f);
});
test("removing the chip does not turn picking back on", () => {
  const f = removeElement(attachElement(openFlow()));
  return expect(f.mode === "compose" && !f.picking && !f.attached, f);
});
test("removing the chip leaves picking as it was when the user had re-enabled it", () => {
  const f = removeElement(togglePicking(attachElement(openFlow())));
  return expect(f.picking && !f.attached, f);
});
test("Esc on a closed flow stays closed", () => expect(pressEscape(FLOW_OFF) === FLOW_OFF, FLOW_OFF));

const compose = { x: 419, y: 43, width: 602, height: 86 };
const box = (y: number, height = 40, x = 500) => ({ x, y, width: 200, height });
test("label goes above the outline when there is room and no compose in the way", () => {
  const p = labelPlacement(box(300), compose, 18, 100);
  return expect(p.top === 300 && !p.below, p);
});
test("label goes below when the outline touches the top edge", () => {
  const p = labelPlacement(box(5), null, 18, 100);
  return expect(p.top === 45 && p.below, p);
});
test("label that would sit on the compose box flips below the outline", () => {
  const p = labelPlacement(box(135), compose, 18, 100);
  return expect(p.top === 175 && p.below, p);
});
test("when both sides hit the compose box the label sits right under it", () => {
  const p = labelPlacement(box(60, 50), compose, 18, 100);
  return expect(p.top === 129 && p.below, p);
});
test("a label far to the left of the compose box stays above even in its vertical band", () => {
  const p = labelPlacement(box(100, 40, 4), compose, 18, 100);
  return expect(p.top === 100 && !p.below, p);
});
test("without a compose box the old rule holds (above unless y < 18)", () => {
  const a = labelPlacement(box(18), null, 18, 100);
  const b = labelPlacement(box(17), null, 18, 100);
  return expect(!a.below && a.top === 18 && b.below && b.top === 57, { a, b });
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

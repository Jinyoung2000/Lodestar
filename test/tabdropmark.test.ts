import { dropMarkAt, type StripTabBox } from "../web/tabDropMark";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const box = (key: string, index: number, sticky = false, editor = true): StripTabBox => ({ key, left: index * 100, right: index * 100 + 100, sticky, editor });
const strip = [box("s1", 0, true), box("s2", 1, true), box("a", 2), box("b", 3)];
const mark = (x: number, key: string, sticky: boolean, tabs = strip) => dropMarkAt(tabs, x, { key, sticky }, 0);

check("a loose tab dropped over the pinned zone lands before the first loose tab", (() => {
  const m = mark(120, "x", false);
  return m.beforeKey === "a" && m.x === 200;
})(), "x=120 is left of s2's middle, raw target s2");
check("a loose tab dropped before the first pinned tab also lands before the first loose tab", (() => {
  const m = mark(10, "x", false);
  return m.beforeKey === "a" && m.x === 200;
})());
check("a loose tab dropped between loose tabs keeps the spot", (() => {
  const m = mark(360, "x", false);
  return m.beforeKey === null && m.x === 400;
})(), "right of b's middle: end of strip");
check("a loose tab dropped before a loose tab keeps that spot", (() => {
  const m = mark(240, "x", false);
  return m.beforeKey === "a" && m.x === 200;
})());
check("a pinned tab dropped after the loose tabs lands before the first loose tab", (() => {
  const m = mark(390, "x", true);
  return m.beforeKey === "a" && m.x === 200;
})(), "end of strip is not in the pinned zone");
check("a pinned tab dropped among the pinned tabs keeps the spot", (() => {
  const m = mark(140, "x", true);
  return m.beforeKey === "s2" && m.x === 100;
})(), "x=140 is left of s2's middle");
check("a pinned tab dropped before the first pinned tab keeps it", (() => {
  const m = mark(10, "x", true);
  return m.beforeKey === "s1" && m.x === 0;
})());
check("a pinned tab dropped over a loose tab lands before the first loose tab", (() => {
  const m = mark(340, "x", true);
  return m.beforeKey === "a" && m.x === 200;
})());

check("the dragged tab from the same strip is not in tabs, the mark still clamps", (() => {
  const rest = [box("s1", 0, true), box("a", 1), box("b", 2)];
  const m = mark(310, "s2", true, rest);
  return m.beforeKey === "a" && m.x === 100;
})());

check("a strip without loose tabs: a pinned tab goes to the end of the strip", (() => {
  const onlyPinned = [box("s1", 0, true), box("s2", 1, true)];
  const m = mark(500, "x", true, onlyPinned);
  return m.beforeKey === null && m.x === 200;
})());
check("a loose tab dropped on a strip of only pinned tabs goes to the end", (() => {
  const onlyPinned = [box("s1", 0, true), box("s2", 1, true)];
  const m = mark(20, "x", false, onlyPinned);
  return m.beforeKey === null && m.x === 200;
})());
check("an empty strip puts the mark at the strip's left edge", dropMarkAt([], 50, { key: "x", sticky: false }, 33).x === 33);

check("slots that are not editor tabs (Changes, Files) are not clamped", (() => {
  const main = [box("changes", 0, false, false), box("s1", 1, true), box("a", 2), box("files", 3, false, false)];
  const m = mark(30, "x", false, main);
  return m.beforeKey === "changes" && m.x === 0;
})());

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("tab drop mark: all passed");

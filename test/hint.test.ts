// 사소한 결과 안내(말풍선)의 순수 로직: 보이는 시간, 붙일 곳 고르기, 놓는 자리, 닫는 키.
// 실행: npm test
import { chooseAnchor, dismissesOnKey, hintDuration, HINT_MAX_MS, HINT_MIN_MS, placeBubble, POINTER_FRESH_MS, windowPoint, type AnchorInput, type HintRect } from "../web/hintModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const rect = (left: number, top: number, width: number, height: number): HintRect => ({ left, top, right: left + width, bottom: top + height });
const base: AnchorInput = { explicit: null, focusInEditor: false, pointer: null, now: 10_000, focused: null };

check("a short message stays 2.5 seconds", hintDuration("No definition found") === HINT_MIN_MS);
check("a long message stays longer but never past 6 seconds", hintDuration("x".repeat(80)) > HINT_MIN_MS && hintDuration("x".repeat(500)) === HINT_MAX_MS);

check("the caller's editor wins over everything", chooseAnchor({ ...base, explicit: { kind: "editor" }, focusInEditor: true, focused: rect(0, 0, 10, 10) }).kind === "explicit-editor");
check("the caller's element rect wins over focus and pointer", (() => {
  const picked = chooseAnchor({ ...base, explicit: { kind: "rect", rect: rect(1, 1, 5, 5) }, pointer: { rect: rect(50, 50, 5, 5), at: 9_900 }, focused: rect(9, 9, 5, 5) });
  return picked.kind === "rect" && picked.rect.left === 1 && picked.from === "explicit";
})());
check("focus inside an editor puts it at the cursor", chooseAnchor({ ...base, focusInEditor: true, pointer: { rect: rect(50, 50, 5, 5), at: 9_900 } }).kind === "focused-editor");
check("a fresh press anchors to the pressed spot", (() => {
  const picked = chooseAnchor({ ...base, pointer: { rect: rect(50, 50, 5, 5), at: 10_000 - POINTER_FRESH_MS }, focused: rect(9, 9, 5, 5) });
  return picked.kind === "rect" && picked.from === "pointer";
})());
check("a stale press falls back to the focused element", (() => {
  const picked = chooseAnchor({ ...base, pointer: { rect: rect(50, 50, 5, 5), at: 10_000 - POINTER_FRESH_MS - 1 }, focused: rect(9, 9, 5, 5) });
  return picked.kind === "rect" && picked.from === "focus";
})());
check("a pressed element with no size is skipped", (() => {
  const picked = chooseAnchor({ ...base, pointer: { rect: rect(50, 50, 0, 0), at: 9_999 }, focused: rect(9, 9, 5, 5) });
  return picked.kind === "rect" && picked.from === "focus";
})());
check("nothing to anchor to means the window", chooseAnchor(base).kind === "window");
check("a hidden focused element means the window", chooseAnchor({ ...base, focused: rect(0, 0, 0, 0) }).kind === "window");

const viewport = { width: 1000, height: 700 };
const size = { width: 120, height: 28 };
const above = placeBubble(rect(400, 300, 80, 24), size, viewport, 8, 8);
check("it sits above the anchor, centered", above.side === "above" && above.top === 300 - 8 - 28 && above.left === 440 - 60, JSON.stringify(above));
const flipped = placeBubble(rect(400, 10, 80, 24), size, viewport, 8, 8);
check("it flips below when there is no room above", flipped.side === "below" && flipped.top === 10 + 24 + 8, JSON.stringify(flipped));
const leftEdge = placeBubble(rect(0, 300, 10, 24), size, viewport, 8, 8);
check("it is pushed inside the left edge", leftEdge.left === 8, JSON.stringify(leftEdge));
const rightEdge = placeBubble(rect(990, 300, 10, 24), size, viewport, 8, 8);
check("it is pushed inside the right edge", rightEdge.left === 1000 - 8 - 120, JSON.stringify(rightEdge));
const point = windowPoint(viewport, 96);
check("the window fallback is a point at bottom center", point.left === 500 && point.right === 500 && point.top === 604 && point.top === point.bottom);

check("modifier keys alone do not dismiss", !dismissesOnKey("Meta") && !dismissesOnKey("Shift") && !dismissesOnKey("Alt") && !dismissesOnKey("Control"));
check("a letter, Esc or an arrow dismisses", dismissesOnKey("a") && dismissesOnKey("Escape") && dismissesOnKey("ArrowDown"));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("hint model: all passed");

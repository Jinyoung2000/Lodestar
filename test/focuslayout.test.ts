import {
  ACTIVITY_BAR,
  DOCK_DEFAULT,
  DOCK_MIN,
  EDITOR_MIN,
  FOCUS_SIDE_DEFAULT,
  FOCUS_SIDE_MAX,
  FOCUS_SIDE_MIN,
  FOCUS_VIEWS,
  chatDockOf,
  chatHiddenInEditor,
  dockRange,
  dockWidth,
  focusShown,
  focusSideRange,
  focusSideWidth,
  isChatDock,
  parseDockWidth,
  parseFocusSideWidth,
  pressActivity,
} from "../web/focusLayout";
import { moveView, sanitizeActivityBar, setViewHidden, shownViews } from "../shared/activityBar";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const stable = (value: unknown) => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = stable(actual);
  const b = stable(wanted);
  if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
};

test("chat dock: only the two known values are accepted and anything else is docked", () => {
  expect(isChatDock("docked") && isChatDock("floating") && !isChatDock("left") && !isChatDock(null), "guards");
  expect(chatDockOf("floating") === "floating", "floating");
  expect(chatDockOf(null) === "docked" && chatDockOf(undefined) === "docked" && chatDockOf("x") === "docked", "default docked");
  return "docked default";
});

test("chatHiddenInEditor: floating hides by collapsing, docked hides by closing the panel", () => {
  expect(chatHiddenInEditor({ chatDock: "floating", floatCollapsed: true, chatDockOpen: true }), "collapsed pill");
  expect(!chatHiddenInEditor({ chatDock: "floating", floatCollapsed: false, chatDockOpen: false }), "floating ignores the dock flag");
  expect(chatHiddenInEditor({ chatDock: "docked", floatCollapsed: false, chatDockOpen: false }), "closed dock");
  expect(!chatHiddenInEditor({ chatDock: "docked", floatCollapsed: true, chatDockOpen: true }), "docked ignores the pill flag");
  return "ok";
});

test("pressActivity: a different button switches the view and opens, the same open button closes", () => {
  same(pressActivity(false, "changes", "files"), { open: true, view: "files" }, "closed bar opens on the pressed view");
  same(pressActivity(true, "changes", "files"), { open: true, view: "files" }, "other view while open");
  same(pressActivity(true, "files", "files"), { open: false, view: "files" }, "same view while open closes");
  same(pressActivity(false, "files", "files"), { open: true, view: "files" }, "same view while closed opens");
  return "toggle";
});

test("the view order follows the request: Explorer, Changes, Source Control, then Search like VS Code", () => {
  same([...FOCUS_VIEWS], ["files", "changes", "scm", "search"], "order");
  return "files, changes, scm, search";
});

test("dockRange: the editor keeps EDITOR_MIN and the dock never goes below DOCK_MIN", () => {
  same(dockRange(1200), { min: DOCK_MIN, max: 1200 - EDITOR_MIN - 1 }, "wide");
  same(dockRange(500), { min: DOCK_MIN, max: DOCK_MIN }, "too narrow for both: the dock keeps its minimum");
  return "ok";
});

test("dockWidth: the default, a saved width, and clamping into the range", () => {
  expect(dockWidth(null, 1200) === DOCK_DEFAULT, "default");
  expect(dockWidth(560, 1200) === 560, "saved");
  expect(dockWidth(2000, 1200) === 1200 - EDITOR_MIN - 1, "clamped to the editor floor");
  expect(dockWidth(100, 1200) === DOCK_MIN, "clamped to the minimum");
  expect(dockWidth(700, 0) === 700, "unknown container width keeps the saved value");
  return "420 / 560 / 879 / 320";
});

test("parseDockWidth and parseFocusSideWidth reject junk", () => {
  expect(parseDockWidth("480") === 480 && parseDockWidth(480.4) === 480, "numbers and strings");
  expect(parseDockWidth(10) === null && parseDockWidth("x") === null && parseDockWidth(NaN) === null && parseDockWidth(null) === null && parseDockWidth(99999) === null, "junk");
  expect(parseFocusSideWidth("300") === 300 && parseFocusSideWidth(150) === null && parseFocusSideWidth(undefined) === null, "side");
  return "ok";
});

test("focusSideRange: leaves room for the bar, the dock and the editor", () => {
  const range = focusSideRange(1440, DOCK_DEFAULT);
  expect(range.min === FOCUS_SIDE_MIN, "min");
  expect(range.max === FOCUS_SIDE_MAX, `max is capped at ${FOCUS_SIDE_MAX}: ${range.max}`);
  const tight = focusSideRange(1000, 420);
  expect(tight.max === 1000 - ACTIVITY_BAR - 1 - 420 - EDITOR_MIN - 1, `tight ${tight.max}`);
  expect(focusSideRange(700, 420).max === FOCUS_SIDE_MIN, "never below the minimum");
  expect(focusSideRange(900, 0).max === 900 - ACTIVITY_BAR - 1 - EDITOR_MIN, "no dock, no dock border");
  return `${range.max} / ${tight.max}`;
});

test("focusSideWidth: default, saved and shrunk by a narrow window", () => {
  expect(focusSideWidth(null, 1440, DOCK_DEFAULT) === FOCUS_SIDE_DEFAULT, "default");
  expect(focusSideWidth(400, 1440, DOCK_DEFAULT) === 400, "saved");
  expect(focusSideWidth(500, 1000, 420) === 1000 - ACTIVITY_BAR - 1 - 420 - EDITOR_MIN - 1, "shrinks to protect the editor");
  expect(focusSideWidth(123, 0, 0) === 123, "unknown body width keeps the saved value");
  return "ok";
});

test("focusShown: nothing outside the editor layout or outside the sessions view", () => {
  const off = { side: false, dock: false, floating: false };
  same(focusShown({ editorLayout: false, sessionsView: true, chatDock: "docked", sideOpen: true, dockOpen: true }), off, "chat layout");
  same(focusShown({ editorLayout: true, sessionsView: false, chatDock: "docked", sideOpen: true, dockOpen: true }), off, "board view");
  return "off";
});

test("focusShown: docked shows the panel, floating shows the window, and each side bar flag is independent", () => {
  same(focusShown({ editorLayout: true, sessionsView: true, chatDock: "docked", sideOpen: true, dockOpen: true }), { side: true, dock: true, floating: false }, "all open");
  same(focusShown({ editorLayout: true, sessionsView: true, chatDock: "docked", sideOpen: false, dockOpen: true }), { side: false, dock: true, floating: false }, "side closed");
  same(focusShown({ editorLayout: true, sessionsView: true, chatDock: "docked", sideOpen: true, dockOpen: false }), { side: true, dock: false, floating: false }, "dock closed");
  same(focusShown({ editorLayout: true, sessionsView: true, chatDock: "floating", sideOpen: true, dockOpen: true }), { side: true, dock: false, floating: true }, "floating");
  return "ok";
});

test("activity bar order and hidden views are validated", () => {
  same(sanitizeActivityBar(undefined), { order: ["files", "changes", "scm", "search", "card"], hidden: [], hiddenBadges: [] }, "missing");
  same(sanitizeActivityBar({ order: ["search", "bogus", "search", "files"], hidden: ["scm", 3], hiddenBadges: ["changes"] }), { order: ["search", "files", "changes", "scm", "card"], hidden: ["scm"], hiddenBadges: ["changes"] }, "unknown dropped, new views appended");
  same(sanitizeActivityBar({ hidden: ["files", "changes", "scm", "search"] }).hidden, [], "all hidden resets");
  same(moveView(["files", "changes", "scm", "search", "card"], "search", "files"), ["search", "files", "changes", "scm", "card"], "move to front");
  same(moveView(["files", "changes", "scm", "search", "card"], "files", null), ["changes", "scm", "search", "card", "files"], "move to end");
  const prefs = sanitizeActivityBar({ hidden: ["files", "changes"] });
  same(shownViews(prefs, false), ["scm", "search"], "card needs an open card");
  same(setViewHidden(setViewHidden(prefs, "scm", true, false), "search", true, false).hidden, ["files", "changes", "scm"], "last visible view stays");
  same(setViewHidden(prefs, "files", false, false).hidden, ["changes"], "unhide");
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

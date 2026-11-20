// 보드와 멘션 화면이 세션 오른쪽 패널을 쓰지 않는 규칙의 순수 로직(web/centerPanels.ts, web/floatLayout.ts)을 확인한다. 실행: npm test
import { cardOpensInSessionPanel, detailWidthLimits, isRetiredTabKey, sanitizeRestoredTabs, sessionPanelShown, sessionPanelToggleable, type CenterViewName } from "../web/centerPanels";
import { isPinnedTab, sideKeyOf } from "../web/floatLayout";
import { inboxKindCounts, inboxRows, matchesShow, neighborRowId } from "../web/inboxRows";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(wanted);
  if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
};

const VIEWS: CenterViewName[] = ["sessions", "board", "inbox", "pr"];

test("the session right panel shows only on the sessions screen and only when open", () => {
  for (const view of VIEWS) {
    same(sessionPanelShown(view, true), view === "sessions", `${view} open`);
    same(sessionPanelShown(view, false), false, `${view} closed`);
  }
  return "4 views x open/closed";
});

test("switching to the board or mentions hides the panel without changing rightOpen, and switching back shows it again", () => {
  let rightOpen = true;
  const shown = (view: CenterViewName) => sessionPanelShown(view, rightOpen);
  same([shown("sessions"), shown("board"), shown("sessions"), shown("inbox"), shown("sessions")], [true, false, true, false, true], "round trips");
  rightOpen = false;
  same([shown("sessions"), shown("board"), shown("sessions")], [false, false, false], "a closed panel stays closed after the round trip");
  return "rightOpen is the only memory";
});

test("the panel toggle only means something on the sessions screen", () => {
  same(VIEWS.map(sessionPanelToggleable), [true, false, false, false], "toggleable");
  return "sessions only";
});

test("a card opens in the session panel from sessions and in the board detail from everywhere else", () => {
  same(VIEWS.map(cardOpensInSessionPanel), [true, false, false, false], "card target");
  return "sessions panel vs board";
});

test("a saved inbox tab key is filtered out when restoring", () => {
  same(isRetiredTabKey("inbox"), true, "retired");
  same(isRetiredTabKey("card"), false, "card stays");
  same(sanitizeRestoredTabs({ activeTabKey: "inbox", sideTabKey: "inbox", groupActive: { main: "inbox", g2: "a.ts", g3: null } }), { activeTabKey: "changes", sideTabKey: "changes", groupActive: { g2: "a.ts", g3: null } }, "inbox everywhere");
  same(sanitizeRestoredTabs({ activeTabKey: "files", sideTabKey: "card", groupActive: { main: "files" } }), { activeTabKey: "files", sideTabKey: "card", groupActive: { main: "files" } }, "other keys untouched");
  same(sanitizeRestoredTabs(null), { activeTabKey: "changes", sideTabKey: "changes", groupActive: {} }, "nothing saved");
  same(sanitizeRestoredTabs({ activeTabKey: 5, sideTabKey: {}, groupActive: "x" }), { activeTabKey: "changes", sideTabKey: "changes", groupActive: {} }, "wrong types");
  return "inbox -> changes";
});

test("inbox is no longer a pinned side tab, and a stale side key falls back to Changes", () => {
  same(isPinnedTab("inbox"), false, "not pinned");
  same(["changes", "files", "card"].map(isPinnedTab), [true, true, true], "others pinned");
  same(sideKeyOf("inbox", true), "changes", "stale inbox key even with a card open");
  return "changes";
});

test("the detail column never goes below its minimum, and the list keeps its floor while there is room", () => {
  same(detailWidthLimits(1000, 300, 300), { min: 300, max: 700 }, "wide");
  same(detailWidthLimits(600, 300, 300), { min: 300, max: 300 }, "just fits");
  same(detailWidthLimits(520, 300, 300), { min: 300, max: 300 }, "too narrow: the detail keeps its minimum and the list shrinks");
  same(detailWidthLimits(200, 300, 300), { min: 300, max: 300 }, "tiny container");
  return "limits";
});

const row = (id: string, time: string, over: { read?: boolean; archived?: boolean } = {}) => ({ id, time, read: false, archived: false, ...over });
const items = [row("a", "2026-10-15T01:00:00Z"), row("b", "2026-10-15T03:00:00Z"), row("c", "2026-10-15T02:00:00Z", { read: true }), row("d", "2026-10-15T04:00:00Z", { archived: true })];
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

test("filters: unread, all and archived, newest first", () => {
  same(ids(inboxRows(items, "unread", null)), ["b", "a"], "unread");
  same(ids(inboxRows(items, "all", null)), ["b", "c", "a"], "all");
  same(ids(inboxRows(items, "archived", null)), ["d"], "archived");
  same(matchesShow(items[2], "unread"), false, "read item is not unread");
  return "3 filters";
});

test("the open item stays in the list after it is read, and leaves when another is picked or the detail closes", () => {
  const opened = items.map((i) => (i.id === "b" ? { ...i, read: true } : i));
  same(ids(inboxRows(opened, "unread", "b")), ["b", "a"], "b is read but still listed while open");
  same(ids(inboxRows(opened, "unread", "a")), ["a"], "picking a drops the read b");
  same(ids(inboxRows(opened, "unread", null)), ["a"], "closing the detail drops it");
  same(ids(inboxRows(opened, "unread", "gone")), ["a"], "an id that no longer exists adds nothing");
  return "kept while open";
});

test("kind filter: Mentions and Threads narrow the list, All shows both, and the open item stays while it is open", () => {
  const typed = [{ ...row("m1", "2026-10-15T05:00:00Z"), kind: "mention" as const }, { ...row("t1", "2026-10-15T06:00:00Z"), kind: "thread" as const }, { ...row("t2", "2026-10-15T07:00:00Z", { read: true }), kind: "thread" as const }, { ...row("m2", "2026-10-15T08:00:00Z", { archived: true }), kind: "mention" as const }];
  same(ids(inboxRows(typed, "unread", null)), ["t1", "m1"], "all kinds, unread");
  same(ids(inboxRows(typed, "unread", null, "mention")), ["m1"], "mentions only");
  same(ids(inboxRows(typed, "unread", null, "thread")), ["t1"], "threads only, the read one is not unread");
  same(ids(inboxRows(typed, "all", null, "thread")), ["t2", "t1"], "threads in All");
  same(ids(inboxRows(typed, "unread", "m1", "thread")), ["t1", "m1"], "the open mention stays while the Threads tab is shown");
  same(inboxKindCounts(typed, "unread"), { all: 2, mention: 1, thread: 1 }, "counts follow the show filter");
  same(inboxKindCounts(typed, "all"), { all: 3, mention: 1, thread: 2 }, "counts in All exclude archived");
  same(inboxKindCounts(typed, "archived"), { all: 1, mention: 1, thread: 0 }, "counts in Archived");
  return "kinds";
});

test("arrow keys move to the neighbor row, clamp at the ends, and start from the ends when nothing is open", () => {
  const rows = [{ id: "x" }, { id: "y" }, { id: "z" }];
  same([neighborRowId(rows, "y", 1), neighborRowId(rows, "y", -1)], ["z", "x"], "middle");
  same([neighborRowId(rows, "z", 1), neighborRowId(rows, "x", -1)], [null, null], "ends");
  same([neighborRowId(rows, null, 1), neighborRowId(rows, null, -1)], ["x", "z"], "nothing open");
  same(neighborRowId([], null, 1), null, "empty list");
  return "neighbors";
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

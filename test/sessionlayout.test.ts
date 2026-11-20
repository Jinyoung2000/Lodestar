// 세션별 화면 배치 기억(web/sessionLayout.ts)의 순수 로직을 확인한다. 실행: npm test
import { dropSessionLayout, layoutKeyOf, layoutPatch, planSwitch, pruneSessionLayouts, sameLayout, sanitizeSessionLayouts, sliceOf, type SessionLayout, type SessionLayouts } from "../web/sessionLayout";
import type { Pane } from "../web/store";

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

const chatOpen: SessionLayout = { layoutMode: "chat", floatCollapsed: false, floatRect: null, sidebarOpen: true, rightOpen: false, bottomOpen: false, sideTabKey: "changes", focusSideOpen: true, chatDockOpen: true, chatDockWidth: null };
const editorShut: SessionLayout = { layoutMode: "editor", floatCollapsed: true, floatRect: { x: 10, y: 50, w: 400, h: 300 }, sidebarOpen: false, rightOpen: true, bottomOpen: true, sideTabKey: "files", focusSideOpen: false, chatDockOpen: false, chatDockWidth: 480 };

const agentPane = (id: string, agentId: string): Pane => ({ id, kind: "agent", agentId }) as Pane;
const draftPane = (id: string): Pane => ({ id, kind: "draft", workspaceId: "w" }) as Pane;

// --- 어느 세션의 배치인가 ---

test("the key is the agent of the active pane", () => {
  const panes = [agentPane("p1", "A"), agentPane("p2", "B")];
  expect(layoutKeyOf({ centerView: "sessions", panes, activePaneId: "p1" }) === "A", "p1");
  expect(layoutKeyOf({ centerView: "sessions", panes, activePaneId: "p2" }) === "B", "p2");
  return "A, B";
});

test("the same session in two panes resolves to one key", () => {
  const panes = [agentPane("p1", "A"), agentPane("p2", "A")];
  const k1 = layoutKeyOf({ centerView: "sessions", panes, activePaneId: "p1" });
  const k2 = layoutKeyOf({ centerView: "sessions", panes, activePaneId: "p2" });
  expect(k1 === "A" && k2 === "A", `${k1} ${k2}`);
  return "A";
});

test("draft panes and non-session screens have no key", () => {
  const panes = [draftPane("p1"), agentPane("p2", "B")];
  expect(layoutKeyOf({ centerView: "sessions", panes, activePaneId: "p1" }) === null, "draft");
  for (const view of ["board", "inbox", "improvements", "pr"]) expect(layoutKeyOf({ centerView: view, panes, activePaneId: "p2" }) === null, view);
  return "null";
});

// --- 전환 계획 ---

test("a session seen for the first time inherits the screen and is remembered", () => {
  const out = planSwitch({ enabled: true, prevKey: null, prev: chatOpen, key: "A", current: editorShut, layouts: {} });
  expect(out.apply === null, "nothing to apply");
  same(out.layouts, { A: editorShut }, "A remembered as is");
  return "inherit";
});

test("leaving a session stores the layout it had before the switch, arriving applies the stored one", () => {
  const layouts: SessionLayouts = { B: chatOpen };
  const out = planSwitch({ enabled: true, prevKey: "A", prev: editorShut, key: "B", current: editorShut, layouts });
  same(out.apply, chatOpen, "B layout comes back");
  same(out.layouts, { A: editorShut, B: chatOpen }, "A stored");
  return "A stored, B applied";
});

test("A to B to A round trip restores each layout", () => {
  let layouts: SessionLayouts = {};
  let screen = editorShut;
  let key: string | null = "A";
  layouts = planSwitch({ enabled: true, prevKey: null, prev: screen, key, current: screen, layouts }).layouts;
  // B 는 처음: A 배치를 이어받은 뒤 사용자가 Chat 배치로 바꾼다
  let r = planSwitch({ enabled: true, prevKey: "A", prev: screen, key: "B", current: screen, layouts });
  layouts = r.layouts;
  key = "B";
  same(r.apply, null, "B inherits");
  screen = chatOpen;
  layouts = planSwitch({ enabled: true, prevKey: "B", prev: screen, key: "B", current: screen, layouts }).layouts;
  same(layouts.B, chatOpen, "B updated while viewed");
  r = planSwitch({ enabled: true, prevKey: "B", prev: screen, key: "A", current: screen, layouts });
  same(r.apply, editorShut, "A comes back");
  layouts = r.layouts;
  screen = r.apply!;
  r = planSwitch({ enabled: true, prevKey: "A", prev: screen, key: "B", current: screen, layouts });
  same(r.apply, chatOpen, "B comes back");
  return "A editor, B chat";
});

test("screens without a session neither store nor apply", () => {
  const layouts: SessionLayouts = { A: editorShut };
  const toBoard = planSwitch({ enabled: true, prevKey: "A", prev: editorShut, key: null, current: editorShut, layouts });
  expect(toBoard.apply === null, "board applies nothing");
  const onBoard = planSwitch({ enabled: true, prevKey: null, prev: chatOpen, key: null, current: chatOpen, layouts: toBoard.layouts });
  expect(onBoard.layouts === toBoard.layouts, "edits on the board are not attributed to a session");
  same(onBoard.layouts, { A: editorShut }, "A untouched");
  const back = planSwitch({ enabled: true, prevKey: null, prev: chatOpen, key: "A", current: chatOpen, layouts: onBoard.layouts });
  same(back.apply, editorShut, "A comes back after the board");
  return "kept";
});

test("an unchanged screen returns the same object", () => {
  const layouts: SessionLayouts = { A: editorShut };
  const out = planSwitch({ enabled: true, prevKey: "A", prev: editorShut, key: "A", current: { ...editorShut }, layouts });
  expect(out.layouts === layouts && out.apply === null, "same reference");
  return "no churn";
});

test("turning the feature off forgets everything", () => {
  const out = planSwitch({ enabled: false, prevKey: "A", prev: editorShut, key: "B", current: editorShut, layouts: { A: editorShut } });
  same(out.layouts, {}, "cleared");
  expect(out.apply === null, "nothing applied");
  const empty: SessionLayouts = {};
  expect(planSwitch({ enabled: false, prevKey: null, prev: chatOpen, key: "A", current: chatOpen, layouts: empty }).layouts === empty, "empty stays the same object");
  return "cleared";
});

// --- 되살리는 패치 ---

test("a stored layout becomes a patch; the side tab follows activeTabKey when no editor tab splits the panel", () => {
  const patch = layoutPatch({ ...chatOpen, rightOpen: true, sideTabKey: "files" }, { activeTabKey: "changes", tabKeys: [], hasCard: false });
  same(patch, { ...chatOpen, rightOpen: true, sideTabKey: "files", activeTabKey: "files" }, "activeTabKey follows");
  return "files";
});

test("the active editor tab is left alone when the panel is split", () => {
  const editor = layoutPatch(editorShut, { activeTabKey: "file:a.ts", tabKeys: ["file:a.ts"], hasCard: false });
  expect(!("activeTabKey" in editor), "editor layout keeps the editor tab");
  const withTabs = layoutPatch({ ...chatOpen, sideTabKey: "scm" }, { activeTabKey: "file:a.ts", tabKeys: ["file:a.ts"], hasCard: false });
  expect(!("activeTabKey" in withTabs) && withTabs.sideTabKey === "scm", "chat layout with an editor tab keeps it too");
  return "kept";
});

test("a stored card tab falls back to changes when no card is selected", () => {
  const patch = layoutPatch({ ...chatOpen, sideTabKey: "card" }, { activeTabKey: "changes", tabKeys: [], hasCard: false });
  expect(patch.sideTabKey === "changes", String(patch.sideTabKey));
  return "changes";
});

// --- 정리와 읽기 ---

test("deleted sessions are pruned", () => {
  const layouts: SessionLayouts = { A: chatOpen, B: editorShut };
  same(pruneSessionLayouts(layouts, new Set(["B"])), { B: editorShut }, "A gone");
  expect(pruneSessionLayouts(layouts, new Set(["A", "B", "C"])) === layouts, "nothing to prune keeps the object");
  same(dropSessionLayout(layouts, "A"), { B: editorShut }, "drop one");
  expect(dropSessionLayout(layouts, "Z") === layouts, "unknown id");
  return "A removed";
});

test("saved values are sanitized", () => {
  const out = sanitizeSessionLayouts({
    A: { ...editorShut },
    bad: { layoutMode: "sideways" },
    worse: 3,
    partial: { layoutMode: "chat", floatRect: { x: 1 }, sideTabKey: 7, rightOpen: "yes" },
  });
  same(Object.keys(out).sort(), ["A", "partial"], "bad entries dropped");
  same(out.A, editorShut, "good entry kept");
  same(out.partial, { layoutMode: "chat", floatCollapsed: false, floatRect: null, sidebarOpen: true, rightOpen: false, bottomOpen: false, sideTabKey: "changes", focusSideOpen: true, chatDockOpen: true, chatDockWidth: null }, "partial gets defaults");
  same(sanitizeSessionLayouts(null), {}, "null");
  same(sanitizeSessionLayouts([1, 2]), {}, "array");
  return "ok";
});

// --- 포커스 모드 값: 왼쪽 사이드바 열림, 대화 패널 열림과 폭 ---

test("focus layout values are remembered per session and compared", () => {
  const a = { ...editorShut, focusSideOpen: true, chatDockOpen: true, chatDockWidth: 520 };
  const b = { ...a, chatDockWidth: 480 };
  expect(!sameLayout(a, b), "dock width differs");
  expect(!sameLayout(a, { ...a, focusSideOpen: false }), "side open differs");
  expect(!sameLayout(a, { ...a, chatDockOpen: false }), "dock open differs");
  const out = planSwitch({ enabled: true, prevKey: "A", prev: a, key: "B", current: a, layouts: { B: b } });
  same(out.apply, b, "B comes back with its own dock width");
  same(out.layouts.A, a, "A keeps 520");
  return "520 vs 480";
});

test("a dock width that is not a usable number goes back to the default", () => {
  const out = sanitizeSessionLayouts({ A: { ...editorShut, chatDockWidth: 12 }, B: { ...editorShut, chatDockWidth: "x" }, C: { ...editorShut, chatDockWidth: 640 } });
  expect(out.A.chatDockWidth === null && out.B.chatDockWidth === null, "too small and junk");
  expect(out.C.chatDockWidth === 640, "kept");
  return "null, null, 640";
});

test("a saved layout survives a JSON round trip", () => {
  const back = sanitizeSessionLayouts(JSON.parse(JSON.stringify({ A: editorShut, B: chatOpen })));
  expect(sameLayout(back.A, editorShut) && sameLayout(back.B, chatOpen), "equal");
  expect(sliceOf({ ...editorShut }) !== editorShut, "slice copies");
  return "round trip";
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

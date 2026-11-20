// 배치 모드와 떠 있는 창의 순수 로직(web/floatLayout.ts)을 확인한다. 실행: npm test
import {
  clampRect,
  defaultRect,
  editorKeyOfMain,
  floatSessionChoices,
  moveRect,
  normalizeTabs,
  parseRect,
  pillAnchor,
  resizeRect,
  separatesPinned,
  sideKeyOf,
  startingMode,
  type FloatLimits,
  type SessionChoice,
  type TabSlice,
  type Viewport,
} from "../web/floatLayout";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
// 키 순서와 상관없이 비교한다
const stable = (value: unknown) => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = stable(actual);
  const b = stable(wanted);
  if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
};

const vp: Viewport = { width: 1440, height: 900, top: 35 };
const limits: FloatLimits = { minW: 320, minH: 240, margin: 16 };

// --- 시작 모드 ---

test("starts from the Settings default", () => {
  same(startingMode({ restored: null, defaultLayout: "editor", remember: false, last: "chat" }), "editor", "default beats last when remember is off");
  same(startingMode({ restored: null, defaultLayout: null, remember: false, last: "editor" }), "chat", "no default means chat");
  return "default wins";
});

test("remember last layout is opt in", () => {
  same(startingMode({ restored: null, defaultLayout: "chat", remember: true, last: "editor" }), "editor", "remember on uses last");
  same(startingMode({ restored: null, defaultLayout: "editor", remember: true, last: null }), "editor", "remember on but nothing remembered uses the default");
  return "last only when on";
});

test("a reloaded window keeps its mode", () => {
  same(startingMode({ restored: "chat", defaultLayout: "editor", remember: false, last: null }), "chat", "restored beats settings");
  return "restored first";
});

// --- 자리와 크기 ---

test("default rect sits at the bottom right", () => {
  const r = defaultRect({ w: 420, h: 560 }, vp, limits);
  same(r, { w: 420, h: 560, x: 1440 - 420 - 16, y: 900 - 560 - 16 }, "default");
  return JSON.stringify(r);
});

test("clamp pulls a rect back inside a smaller window", () => {
  const r = clampRect({ x: 1200, y: 700, w: 420, h: 560 }, { width: 800, height: 600, top: 35 }, limits);
  expect(r.x + r.w <= 800 && r.y + r.h <= 600 && r.x >= 0 && r.y >= 35, `inside: ${JSON.stringify(r)}`);
  same(r, { x: 380, y: 40, w: 420, h: 560 }, "moved, not resized, when it still fits");
  return JSON.stringify(r);
});

test("clamp shrinks a rect larger than the window but not below the minimum", () => {
  const small = clampRect({ x: 0, y: 35, w: 420, h: 560 }, { width: 380, height: 500, top: 35 }, limits);
  same(small, { x: 0, y: 35, w: 380, h: 465 }, "shrinks to the window");
  const tiny = clampRect({ x: 0, y: 35, w: 420, h: 560 }, { width: 300, height: 200, top: 35 }, limits);
  same(tiny, { x: 0, y: 35, w: 300, h: 165 }, "window smaller than the minimum: fit the window");
  return "ok";
});

test("never above the title bar", () => {
  const r = clampRect({ x: 100, y: -50, w: 420, h: 560 }, vp, limits);
  expect(r.y === 35, `y ${r.y}`);
  return "y=35";
});

test("move is clamped to the window", () => {
  const start = { x: 1000, y: 300, w: 420, h: 560 };
  same(moveRect(start, 500, 500, vp, limits), { x: 1020, y: 340, w: 420, h: 560 }, "right/bottom");
  same(moveRect(start, -5000, -5000, vp, limits), { x: 0, y: 35, w: 420, h: 560 }, "left/top");
  return "ok";
});

test("resize from the north-west corner keeps the opposite corner", () => {
  const start = { x: 800, y: 300, w: 420, h: 500 };
  const r = resizeRect(start, "nw", -100, -60, vp, limits);
  same(r, { x: 700, y: 240, w: 520, h: 560 }, "grows up and left");
  expect(r.x + r.w === 1220 && r.y + r.h === 800, "bottom right corner fixed");
  return JSON.stringify(r);
});

test("resize stops at the minimum size and the window edge", () => {
  const start = { x: 800, y: 300, w: 420, h: 500 };
  const shrunk = resizeRect(start, "se", -1000, -1000, vp, limits);
  same(shrunk, { x: 800, y: 300, w: 320, h: 240 }, "minimum");
  const grown = resizeRect(start, "se", 5000, 5000, vp, limits);
  expect(grown.x + grown.w === 1440 && grown.y + grown.h === 900, `edge: ${JSON.stringify(grown)}`);
  const up = resizeRect(start, "n", 0, -5000, vp, limits);
  expect(up.y === 35 && up.y + up.h === 800, `top stops at the title bar: ${JSON.stringify(up)}`);
  return "bounded";
});

test("resize from the west edge never moves the right edge", () => {
  const start = { x: 800, y: 300, w: 420, h: 500 };
  const r = resizeRect(start, "w", 600, 0, vp, limits);
  expect(r.x + r.w === 1220 && r.w === 320 && r.h === 500, JSON.stringify(r));
  return JSON.stringify(r);
});

test("stored rects are validated", () => {
  same(parseRect({ x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 }, "valid");
  same(parseRect({ x: "1", y: 2, w: 3, h: 4 }), null, "string");
  same(parseRect({ x: 1, y: 2, w: 0, h: 4 }), null, "zero width");
  same(parseRect(null), null, "null");
  same(parseRect({ x: Number.NaN, y: 2, w: 3, h: 4 }), null, "NaN");
  return "ok";
});

test("the pill hangs from the window's bottom right corner", () => {
  same(pillAnchor({ x: 1004, y: 324, w: 420, h: 560 }, vp), { right: 16, bottom: 16 }, "default spot");
  same(pillAnchor({ x: 1300, y: 800, w: 420, h: 560 }, vp), { right: 0, bottom: 0 }, "never negative");
  return "ok";
});

// --- 고정 탭과 에디터 탭 ---

const slice = (over: Partial<TabSlice>): TabSlice => ({
  layoutMode: "editor",
  activeTabKey: "a.ts",
  sideTabKey: "changes",
  mainEditorKey: "a.ts",
  groupActive: {},
  tabKeys: ["a.ts", "b.ts", "c.ts"],
  mainKeys: ["a.ts", "b.ts"],
  ...over,
});

test("editor layout: choosing a pinned tab moves it to the side and keeps the editor", () => {
  const prev = slice({});
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "files" });
  same([out.activeTabKey, out.sideTabKey], ["a.ts", "files"], "files goes to the side panel");
  const card = normalizeTabs(prev, { ...prev, activeTabKey: "card" });
  same([card.activeTabKey, card.sideTabKey], ["a.ts", "card"], "card too");
  return "center stays on a.ts";
});

test("editor layout: opening another file is a plain editor change", () => {
  const prev = slice({});
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "b.ts" });
  same([out.activeTabKey, out.sideTabKey, out.mainEditorKey], ["b.ts", "changes", "b.ts"], "b.ts active");
  return "ok";
});

test("editor layout: a tab in another group stays active when a pinned tab is chosen", () => {
  const prev = slice({ activeTabKey: "c.ts", mainEditorKey: "a.ts" });
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "files" });
  same([out.activeTabKey, out.sideTabKey, out.mainEditorKey], ["c.ts", "files", "a.ts"], "c.ts stays");
  return "ok";
});

test("editor layout: closing the active tab does not move the side panel", () => {
  const prev = slice({ sideTabKey: "files" });
  // closeTab 이 "changes" 로 떨어뜨린다. 활성이던 a.ts 는 사라졌다.
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "changes", tabKeys: ["b.ts", "c.ts"], mainKeys: ["b.ts"] });
  same([out.activeTabKey, out.sideTabKey], ["b.ts", "files"], "falls to the remaining tab, side panel untouched");
  const last = normalizeTabs(prev, { ...prev, activeTabKey: "changes", tabKeys: [], mainKeys: [] });
  same([last.activeTabKey, last.sideTabKey, last.mainEditorKey], [null, "files", null], "no editors left");
  return "ok";
});

test("editor layout: choosing a pinned tab with no editor tab open still moves the side panel", () => {
  // 열린 에디터 탭이 없으면 activeTabKey 는 null 이다. 이때 Changes 나 Files 를 눌러도 반응이 없던 버그(떠 있는 창 배치).
  const prev = slice({ activeTabKey: null, mainEditorKey: null, sideTabKey: "files", tabKeys: [], mainKeys: [] });
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "changes" });
  same([out.activeTabKey, out.sideTabKey], [null, "changes"], "changes selected");
  const back = normalizeTabs({ ...prev, sideTabKey: "changes" }, { ...prev, sideTabKey: "changes", activeTabKey: "files" });
  same([back.activeTabKey, back.sideTabKey], [null, "files"], "files selected");
  return "ok";
});

test("switching to editor layout sends the pinned tab to the side", () => {
  const prev = slice({ layoutMode: "chat", activeTabKey: "files", mainEditorKey: "b.ts" });
  const out = normalizeTabs(prev, { ...prev, layoutMode: "editor" });
  same([out.activeTabKey, out.sideTabKey, out.mainEditorKey], ["b.ts", "files", "b.ts"], "center shows the last editor");
  return "ok";
});

test("switching to editor layout with an editor already active changes nothing but the mode", () => {
  const prev = slice({ layoutMode: "chat", activeTabKey: "b.ts", sideTabKey: "changes" });
  const out = normalizeTabs(prev, { ...prev, layoutMode: "editor" });
  same([out.activeTabKey, out.sideTabKey], ["b.ts", "changes"], "same tabs");
  return "ok";
});

test("switching back to chat layout keeps the editor tab on screen", () => {
  const prev = slice({ layoutMode: "editor", activeTabKey: "b.ts", sideTabKey: "files" });
  const out = normalizeTabs(prev, { ...prev, layoutMode: "chat" });
  same([out.activeTabKey, out.sideTabKey], ["b.ts", "files"], "unchanged");
  return "ok";
});

test("chat layout with editor tabs open keeps the pinned column apart from the editors", () => {
  const prev = slice({ layoutMode: "chat", activeTabKey: "a.ts" });
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "files" });
  same([out.activeTabKey, out.sideTabKey, out.mainEditorKey], ["a.ts", "files", "a.ts"], "Files goes to the column, a.ts stays the active editor");
  return "ok";
});

test("chat layout with no editor tab open: the pinned tab is the active tab", () => {
  const prev = slice({ layoutMode: "chat", activeTabKey: "changes", mainEditorKey: null, tabKeys: [], mainKeys: [] });
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "files" });
  same([out.activeTabKey, out.sideTabKey], ["files", "files"], "files fills the panel and is active");
  return "ok";
});

test("chat layout: opening the first file from Files keeps Files in the column", () => {
  const prev = slice({ layoutMode: "chat", activeTabKey: "files", sideTabKey: "files", mainEditorKey: null, tabKeys: [], mainKeys: [] });
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "a.ts", tabKeys: ["a.ts"], mainKeys: ["a.ts"] });
  same([out.activeTabKey, out.sideTabKey, out.mainEditorKey], ["a.ts", "files", "a.ts"], "a.ts active, Files still in the column");
  return "ok";
});

test("chat layout: closing the last file hands the panel back to the pinned tab it showed", () => {
  const prev = slice({ layoutMode: "chat", activeTabKey: "a.ts", sideTabKey: "files", tabKeys: ["a.ts"], mainKeys: ["a.ts"] });
  // store.ts activeAfterClose 가 main 그룹의 마지막 탭을 닫으면 sideTabKey 를 고른다
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "files", tabKeys: [], mainKeys: [] });
  same([out.activeTabKey, out.sideTabKey, out.mainEditorKey], ["files", "files", null], "Files is active again and fills the panel");
  return "ok";
});

test("chat layout: a snapshot saved with a pinned active tab and editors open is settled on load", () => {
  // 옛 Chat 배치는 Files 탭이 에디터 탭줄에 있었다. 저장된 activeTabKey 가 files 이고 에디터 탭이 있으면 고정 칸으로 옮기고 보이는 에디터를 활성으로 한다.
  const saved = slice({ layoutMode: "chat", activeTabKey: "files", sideTabKey: "changes", mainEditorKey: "b.ts" });
  const out = normalizeTabs(saved, saved);
  same([out.activeTabKey, out.sideTabKey], ["b.ts", "files"], "column shows Files, b.ts active");
  const none = normalizeTabs({ ...saved, mainEditorKey: null }, { ...saved, mainEditorKey: null });
  same([none.activeTabKey, none.sideTabKey], ["b.ts", "files"], "last main tab when none is remembered");
  return "ok";
});

test("separatesPinned: editor layout, or chat with an editor tab", () => {
  same(separatesPinned({ layoutMode: "editor", tabKeys: [] }), true, "editor layout always");
  same(separatesPinned({ layoutMode: "chat", tabKeys: ["a.ts"] }), true, "chat with a tab");
  same(separatesPinned({ layoutMode: "chat", tabKeys: [] }), false, "chat without tabs");
  return "ok";
});

test("a stale pinned key remembered for the main group is replaced in editor layout", () => {
  const prev = slice({ layoutMode: "chat", groupActive: { main: "changes" }, activeTabKey: "c.ts" });
  const out = normalizeTabs(prev, { ...prev, layoutMode: "editor" });
  same(out.groupActive, { main: "a.ts" }, "main now remembers an editor tab");
  return "ok";
});

test("the main group shows the last editor when its remembered key is pinned or gone", () => {
  same(editorKeyOfMain("changes", "b.ts", ["a.ts", "b.ts"]), "b.ts", "pinned -> last editor");
  same(editorKeyOfMain("a.ts", "b.ts", ["a.ts", "b.ts"]), "a.ts", "own active key wins");
  same(editorKeyOfMain(null, "gone.ts", ["a.ts", "b.ts"]), "b.ts", "gone -> last tab");
  same(editorKeyOfMain(null, null, []), null, "nothing open");
  return "ok";
});

test("the side panel falls back to Changes when its card is gone or the key is a retired inbox tab", () => {
  same(sideKeyOf("card", false), "changes", "no card");
  same(sideKeyOf("card", true), "card", "card");
  same(sideKeyOf("inbox", true), "changes", "retired inbox key");
  same(sideKeyOf("files", false), "files", "files");
  return "ok";
});

// --- 세션 드롭다운 ---

const agent = (id: string, workspaceId: string | null, over: Partial<SessionChoice> = {}): SessionChoice => ({ id, title: id, workspaceId, done: false, feedback: false, updatedAt: 0, ...over });

test("session choices put the same folder first, then the most recently opened", () => {
  const agents = [agent("other-new", "w2", { updatedAt: 90 }), agent("same-old", "w1", { updatedAt: 1 }), agent("same-recent", "w1", { updatedAt: 2 }), agent("current", "w1"), agent("done", "w1", { done: true }), agent("fb", "w1", { feedback: true })];
  const out = floatSessionChoices(agents, ["same-recent", "other-new"], "current", "w1", (w) => w);
  same(out.map((a) => a.id), ["same-recent", "same-old", "other-new"], "order");
  return out.map((a) => a.id).join(" > ");
});

test("session choices are capped", () => {
  const many = Array.from({ length: 20 }, (_, i) => agent(`s${i}`, "w1", { updatedAt: i }));
  const out = floatSessionChoices(many, [], null, "w1", (w) => w, 8);
  expect(out.length === 8 && out[0].id === "s19", `${out.length} ${out[0].id}`);
  return "8";
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

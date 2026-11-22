import { clampEditorPos, collectExtras, forLaunch, noteWindowChanged, parseWindowState, pruneExtras, pruneTabState, registerChatReader, registerEditorReader, sanitizeExtras, setPendingRestore, setWindowSaver, takeChatRestore, takeEditorRestore, SAVE_DELAY_MS, type TabLike, type TabState } from "../web/windowState";

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

type T = TabLike & { path?: string };
const file = (ws: string, path: string, group?: string): T => ({ key: `${ws}:${path}`, kind: "file", workspaceId: ws, path, ...(group ? { group } : {}) });
const base = (tabs: T[], extra: Partial<TabState<T>> = {}): TabState<T> => ({ tabs, filesIndex: tabs.length, activeTabKey: "changes", groupActive: {}, mainEditorKey: null, activeWorkspaceId: "w1", ...extra });
const known = (over: { workspaceIds?: string[]; agentIds?: string[]; missing?: string[] } = {}) => ({ workspaceIds: new Set(over.workspaceIds ?? ["w1"]), agentIds: new Set(over.agentIds ?? ["a1"]), missingFileKeys: new Set(over.missing ?? []) });

test("parseWindowState: 깨진 글, 모르는 버전, 틀린 형태는 null", () => {
  expect(parseWindowState(null) === null && parseWindowState("{") === null && parseWindowState("[1]") === null, "깨진 글");
  expect(parseWindowState(JSON.stringify({ version: 99, panes: [] })) === null, "모르는 버전");
  expect(parseWindowState(JSON.stringify({ version: 1, panes: "x" })) === null, "panes 가 배열이 아님");
  const ok = parseWindowState<{ panes?: unknown }>(JSON.stringify({ version: 1, panes: [{ id: "pane-1" }], extras: { drafts: { a1: "hello", empty: "" }, panelWidths: { "agent:a1": 541, bad: "x" } } }));
  expect(ok !== null && Array.isArray(ok.panes), "정상");
  expect(ok?.extras.drafts.a1 === "hello" && !("empty" in (ok?.extras.drafts ?? {})), "빈 초안은 버림");
  expect(ok?.extras.panelWidths["agent:a1"] === 541 && !("bad" in (ok?.extras.panelWidths ?? {})), "숫자만 통과");
  return "ok";
});

test("sanitizeExtras: 없는 값은 빈 객체, 형태가 틀린 항목은 버린다", () => {
  const e = sanitizeExtras({ editorPos: { a: { anchor: 1, head: 2, scrollTop: 30 }, b: { anchor: "x" } }, chatScroll: { s: { top: 10, atBottom: false }, t: { top: 1 } } });
  expect(Object.keys(e.editorPos).join() === "a" && Object.keys(e.chatScroll).join() === "s", "항목 거름");
  expect(JSON.stringify(sanitizeExtras(undefined)) === JSON.stringify({ editorPos: {}, chatScroll: {}, drafts: {}, panelWidths: {}, handoffs: {} }), "빈 값");
  return "ok";
});

test("pruneTabState: 지워진 폴더와 파일의 탭이 조용히 빠지고 활성 탭과 Files 자리가 맞춰진다", () => {
  const tabs = [file("w1", "a.ts"), file("w2", "gone-ws.ts"), file("w1", "deleted.ts"), file("w1", "b.ts", "g2")];
  const state = base(tabs, { filesIndex: 3, activeTabKey: "w1:deleted.ts", groupActive: { main: "w1:deleted.ts", g2: "w1:b.ts" }, mainEditorKey: "w2:gone-ws.ts" });
  const out = pruneTabState(state, known({ missing: ["w1:deleted.ts"] }));
  expect(out.tabs.map((t) => t.key).join() === "w1:a.ts,w1:b.ts", "남은 탭");
  expect(out.filesIndex === 1, `Files 자리가 앞서 빠진 둘만큼 당겨진다(${out.filesIndex})`);
  expect(out.activeTabKey === "changes", "활성 탭은 Changes");
  expect(out.groupActive.main === null && out.groupActive.g2 === "w1:b.ts", "그룹 활성");
  expect(out.mainEditorKey === null, "mainEditorKey");
  return "ok";
});

test("pruneTabState: 지울 것이 없으면 같은 객체, Browser 탭과 이름 없는 탭은 폴더가 없어도 남는다", () => {
  const state = base([file("w1", "a.ts")]);
  expect(pruneTabState(state, known()) === state, "변화 없음");
  const browser: T = { key: "browser-1", kind: "browser" };
  const out = pruneTabState(base([browser, file("w9", "x.ts")]), known());
  expect(out.tabs.length === 1 && out.tabs[0].key === "browser-1", "browser 유지");
  return "ok";
});

test("pruneTabState: 지워진 세션의 diff 탭과 없어진 활성 폴더", () => {
  const diff: T = { key: "diff:a2:x", kind: "diff", workspaceId: "w1", agentId: "a2" };
  const out = pruneTabState(base([diff], { activeWorkspaceId: "w404" }), known());
  expect(out.tabs.length === 0 && out.activeWorkspaceId === null, "diff 와 활성 폴더");
  return "ok";
});

test("pruneExtras: 지워진 세션의 초안과 대화 위치를 빼고 새 세션 칸 초안은 둔다", () => {
  const out = pruneExtras({ editorPos: {}, chatScroll: { a1: { top: 5, atBottom: false }, a2: { top: 9, atBottom: false } }, drafts: { a1: "keep", a2: "drop", "new:pane-2": "draft" }, panelWidths: {}, handoffs: {} }, new Set(["a1"]));
  expect(Object.keys(out.drafts).sort().join() === "a1,new:pane-2" && Object.keys(out.chatScroll).join() === "a1", "정리");
  return "ok";
});

test("forLaunch: 새로 켤 때는 layoutMode 를 떼고 나머지는 그대로", () => {
  const out = forLaunch({ layoutMode: "editor", sidebarOpen: false, panes: [1] });
  expect(!("layoutMode" in out) && out.sidebarOpen === false && out.panes.length === 1, "layoutMode 제거");
  return "ok";
});

test("clampEditorPos: 문서가 줄었으면 문서 끝으로", () => {
  const out = clampEditorPos({ anchor: 500, head: 600, scrollTop: -3 }, 120);
  expect(out.anchor === 120 && out.head === 120 && out.scrollTop === 0, JSON.stringify(out));
  return "ok";
});

test("collectExtras: 화면이 읽어 준 값이 우선이고, 아직 화면이 안 받은 복원 값은 살아 있는 탭과 세션 것만 이어진다", () => {
  setPendingRestore({ editorPos: { t1: { anchor: 1, head: 1, scrollTop: 10 }, t2: { anchor: 2, head: 2, scrollTop: 20 }, tDead: { anchor: 3, head: 3, scrollTop: 30 } }, chatScroll: { a1: { top: 100, atBottom: false }, aDead: { top: 1, atBottom: false } } });
  const off = registerEditorReader("t2", () => ({ anchor: 9, head: 9, scrollTop: 99 }));
  const alive = { tabKeys: new Set(["t1", "t2"]), agentIds: new Set(["a1"]) };
  const got = collectExtras(alive, { drafts: { a1: "x" }, panelWidths: { k: 300 }, handoffs: {} });
  expect(got.editorPos.t1.scrollTop === 10, "복원 대기 값 유지");
  expect(got.editorPos.t2.scrollTop === 99, "읽기 값이 우선");
  expect(!("tDead" in got.editorPos) && !("aDead" in got.chatScroll), "죽은 것은 뺌");
  expect(got.chatScroll.a1.top === 100 && got.drafts.a1 === "x" && got.panelWidths.k === 300, "나머지");
  expect(takeEditorRestore("t1")?.scrollTop === 10 && takeEditorRestore("t1") === null, "한 번만 받아 간다");
  expect(takeChatRestore("a1")?.top === 100 && takeChatRestore("a1") === null, "대화 위치도 한 번만");
  const offChat = registerChatReader("a1", () => ({ top: 7, atBottom: true }));
  expect(collectExtras(alive, { drafts: {}, panelWidths: {}, handoffs: {} }).chatScroll.a1.atBottom === true, "받아 간 뒤에는 읽기 값");
  off();
  offChat();
  setPendingRestore({ editorPos: {}, chatScroll: {} });
  return "ok";
});

test("noteWindowChanged: 연달아 불러도 마지막 변화 뒤 한 번만 저장한다", async () => {
  let saves = 0;
  setWindowSaver(() => void (saves += 1));
  noteWindowChanged();
  noteWindowChanged();
  noteWindowChanged();
  expect(saves === 0, "바로 저장하지 않는다");
  await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 150));
  expect(saves === 1, `한 번(${saves})`);
  setWindowSaver(null);
  noteWindowChanged();
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${await c.run()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log(`${cases.length} passed`);

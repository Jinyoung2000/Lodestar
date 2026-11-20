import { BINDINGS, INTERCEPT_STROKES, stepKey, type KeyContext } from "../web/keymap";
import { editorFocusHeld, holdEditorFocus, releaseEditorFocus } from "../web/editorFocusHold";
import { FOCUS_VIEWS, pressActivity } from "../web/focusLayout";
import { isPinnedTab, normalizeTabs, PINNED_TAB_KEYS, sideKeyOf, type TabSlice } from "../web/floatLayout";
import { DEFAULT_SEARCH_VIEW, buildSearchRequest, needsRunLink, planFindInFiles, runIsCurrent, sanitizeSearchView, seedQuery, togglesOf, type SearchRun, type SearchViewOptions } from "../web/searchViewModel";
import { parseWindowState } from "../web/windowState";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(wanted);
  if (a !== w) throw new Error(`${label}: ${a} != ${w}`);
};

// --- 선택 글로 검색어 채우기 ---

test("seedQuery: 한 줄 안의 선택만 검색어가 된다", () => {
  same(seedQuery("useStore"), "useStore", "한 낱말");
  same(seedQuery("const a = 1;"), "const a = 1;", "공백이 든 한 줄은 그대로(앞뒤 공백도 지우지 않는다)");
  same(seedQuery("  x "), "  x ", "앞뒤 공백 유지");
  same(seedQuery(null), null, "선택 없음");
  same(seedQuery(""), null, "빈 선택");
  same(seedQuery("   "), null, "공백뿐");
  same(seedQuery("a\nb"), null, "여러 줄");
  same(seedQuery("a\r\nb"), null, "CRLF 여러 줄");
  return "ok";
});

test("planFindInFiles: 에디터에 선택이 있으면 채우고 바로 검색한다", () => {
  same(planFindInFiles({ inEditor: true, inSearchView: false, selection: "renderRow", query: "old" }), { seed: "renderRow", include: null, run: true }, "에디터 선택");
  return "seed + run";
});

test("planFindInFiles: 선택이 없거나 여러 줄이면 검색어를 그대로 두고 검색도 안 한다(입력 전체 선택은 화면이 한다)", () => {
  same(planFindInFiles({ inEditor: true, inSearchView: false, selection: null, query: "old" }), { seed: null, include: null, run: false }, "선택 없음");
  same(planFindInFiles({ inEditor: true, inSearchView: false, selection: "a\nb", query: "old" }), { seed: null, include: null, run: false }, "여러 줄");
  return "keep";
});

test("planFindInFiles: 에디터 밖이거나 Search 뷰 입력에 포커스가 있으면 에디터 선택으로 덮지 않는다", () => {
  same(planFindInFiles({ inEditor: false, inSearchView: false, selection: "x", query: "old" }).seed, null, "에디터 포커스 아님(대화 입력창, 터미널)");
  same(planFindInFiles({ inEditor: true, inSearchView: true, selection: "x", query: "typed" }).seed, null, "검색 뷰 안");
  return "ok";
});

test("planFindInFiles: Find in Folder 는 include 를 채우고, 검색어가 있을 때만 바로 검색한다", () => {
  same(planFindInFiles({ inEditor: false, inSearchView: false, selection: null, include: "./src/a", query: "needle" }), { seed: null, include: "./src/a", run: true }, "검색어 있음");
  same(planFindInFiles({ inEditor: false, inSearchView: false, selection: null, include: "./src/a", query: "  " }), { seed: null, include: "./src/a", run: false }, "검색어 없음");
  same(planFindInFiles({ inEditor: false, inSearchView: false, selection: null, include: "", query: "needle" }), { seed: null, include: "", run: true }, "루트 폴더는 include 를 비운다");
  return "ok";
});

// --- 뷰 전환 ---

test("search 는 고정 탭이다: Chat 중심의 오른쪽 패널 탭이자 Editor 중심의 사이드바 뷰", () => {
  expect(PINNED_TAB_KEYS.includes("search") && isPinnedTab("search"), "고정 탭 목록");
  same(sideKeyOf("search", false), "search", "카드가 없어도 search 는 Changes 로 떨어지지 않는다");
  expect(isPinnedTab("search:abc") === false, "Search 에디터 탭 키(search:...)는 고정 탭이 아니다");
  same([...FOCUS_VIEWS], ["files", "changes", "scm", "search"], "막대 순서");
  return "ok";
});

test("활동 막대 돋보기: 닫혀 있으면 열고, 다른 뷰면 바꾸고, 같은 뷰가 열려 있으면 접는다", () => {
  same(pressActivity(false, "files", "search"), { open: true, view: "search" }, "닫힘에서 열기");
  same(pressActivity(true, "files", "search"), { open: true, view: "search" }, "다른 뷰에서 전환");
  same(pressActivity(true, "search", "search"), { open: false, view: "search" }, "눌린 상태에서 다시 누르면 접기");
  return "ok";
});

const slice = (over: Partial<TabSlice>): TabSlice => ({ layoutMode: "editor", activeTabKey: "a.ts", sideTabKey: "changes", mainEditorKey: "a.ts", groupActive: {}, tabKeys: ["a.ts"], mainKeys: ["a.ts"], ...over });

test("⇧⌘F 가 쓰는 setState({ activeTabKey: 'search' }): Editor 중심은 사이드바 뷰로, 가운데 에디터는 그대로", () => {
  const prev = slice({});
  const out = normalizeTabs(prev, { ...prev, activeTabKey: "search" });
  same([out.activeTabKey, out.sideTabKey], ["a.ts", "search"], "에디터 중심");
  return "ok";
});

test("⇧⌘F: Chat 중심에서 에디터 탭이 열려 있으면 오른쪽 고정 칸의 Search 탭, 에디터 탭이 없으면 패널 전체", () => {
  const withEditors = slice({ layoutMode: "chat" });
  const a = normalizeTabs(withEditors, { ...withEditors, activeTabKey: "search" });
  same([a.activeTabKey, a.sideTabKey], ["a.ts", "search"], "에디터와 고정 칸이 나뉨");
  const alone = slice({ layoutMode: "chat", activeTabKey: "changes", mainEditorKey: null, tabKeys: [], mainKeys: [] });
  const b = normalizeTabs(alone, { ...alone, activeTabKey: "search" });
  same([b.activeTabKey, b.sideTabKey], ["search", "search"], "에디터 탭이 없는 Chat 중심");
  return "ok";
});

test("⇧⌘F 키: 어디서나 findInFiles 이고 Electron 이 가로채는 집합에 든다(앱 재설치 불필요)", () => {
  const where: KeyContext[] = [{ inTerminal: false, inEditor: false }, { inTerminal: false, inEditor: true, inEditorArea: true }, { inTerminal: true, inEditor: false }, { inTerminal: false, inEditor: false, inComposer: true }, { inTerminal: false, inEditor: false, inFocusLayout: true }];
  for (const ctx of where) {
    const step = stepKey(null, "Shift+Meta+KeyF", ctx, 0);
    expect(step.kind === "run" && step.command === "findInFiles", `${JSON.stringify(ctx)}`);
  }
  expect(INTERCEPT_STROKES.has("Shift+Meta+KeyF"), "intercept");
  expect(BINDINGS.filter((b) => b.command === "findInFiles").length === 1 && !BINDINGS.some((b) => b.command === "openSearch"), "키는 하나, openSearch 는 키 없음");
  return "ok";
});

// --- 저장본 ---

test("sanitizeSearchView: 모르는 값은 기본값으로, 맞는 값은 그대로", () => {
  same(sanitizeSearchView(undefined), DEFAULT_SEARCH_VIEW, "없음");
  same(sanitizeSearchView("x"), DEFAULT_SEARCH_VIEW, "문자열");
  same(sanitizeSearchView({ query: 3, matchCase: "yes", context: "2", ignore: null }), DEFAULT_SEARCH_VIEW, "타입이 틀린 필드");
  const full: SearchViewOptions = { query: "foo", matchCase: true, wholeWord: true, regex: true, context: 3, include: "./src", exclude: "*.test.ts", details: true, openOnly: true, ignore: false, showReplace: true, replaceText: "x", preserveCase: true, viewMode: "tree", changedOnly: true };
  same(sanitizeSearchView(JSON.parse(JSON.stringify(full))), full, "저장했다 읽은 값");
  same(sanitizeSearchView({ context: 99 }).context, 5, "컨텍스트 줄 수 상한");
  same(sanitizeSearchView({ context: -4 }).context, 0, "컨텍스트 줄 수 하한");
  return "ok";
});

test("창 상태 저장본: searchView 가 JSON 을 오가며 살아남고, 결과(searchRun)는 저장본에 없다", () => {
  const saved = JSON.stringify({ version: 1, panes: [], tabs: [], searchView: { query: "needle", regex: true, include: "./web" } });
  const parsed = parseWindowState<{ panes?: unknown; tabs?: unknown; searchView?: unknown }>(saved);
  expect(parsed !== null, "저장본을 읽는다");
  const options = sanitizeSearchView(parsed?.searchView);
  same([options.query, options.regex, options.include], ["needle", true, "./web"], "복원");
  expect(!saved.includes("searchRun"), "결과는 싣지 않는다");
  return "ok";
});

// --- 결과 소속 ---

const done = (workspaceId: string): SearchRun => ({ kind: "done", result: { files: [], matches: 0, truncated: false, engine: "git" }, query: "q", toggles: togglesOf(DEFAULT_SEARCH_VIEW), workspaceId });

test("runIsCurrent, needsRunLink: 다른 폴더에서 돌린 결과는 이 폴더의 것이 아니다", () => {
  expect(runIsCurrent(done("w1"), "w1") && !runIsCurrent(done("w1"), "w2") && !runIsCurrent({ kind: "idle" }, "w1"), "소속");
  const q = { query: "needle" };
  expect(needsRunLink(q, { kind: "idle" }, "w1"), "되살린 검색어, 결과 없음 -> Run Search");
  expect(needsRunLink(q, done("w1"), "w2"), "다른 폴더 결과 -> Run Search");
  expect(!needsRunLink(q, done("w1"), "w1"), "현재 결과가 있으면 링크 없음");
  expect(!needsRunLink(q, { kind: "busy" }, "w1") && !needsRunLink(q, { kind: "error", message: "x" }, "w1"), "검색 중, 오류는 링크 없음");
  expect(!needsRunLink({ query: "  " }, { kind: "idle" }, "w1") && !needsRunLink(q, { kind: "idle" }, null), "검색어가 비었거나 폴더가 없으면 링크 없음");
  return "ok";
});

// --- 요청 ---

test("buildSearchRequest: Open Editors 만 찾는데 열린 파일이 없으면 요청 없음, 있으면 include 를 열린 경로로", () => {
  const options: SearchViewOptions = { ...DEFAULT_SEARCH_VIEW, query: "q", include: "./src", exclude: "dist" };
  same(buildSearchRequest("w1", options, ["a.ts"])?.include, "./src", "일반 검색은 include 입력");
  same(buildSearchRequest("w1", { ...options, openOnly: true }, []), null, "열린 파일 없음");
  same(buildSearchRequest("w1", { ...options, openOnly: true }, ["a.ts", "b/c.ts"])?.include, "a.ts,b/c.ts", "열린 파일만");
  const request = buildSearchRequest("w1", { ...options, matchCase: true, regex: true, context: 2, ignore: false }, []);
  same([request?.matchCase, request?.regex, request?.wholeWord, request?.context, request?.exclude, request?.ignore], [true, true, false, 2, "dist", false], "옵션 전달");
  return "ok";
});

// --- 포커스 유지 ---

test("editorFocusHold: 그 탭만, 정해진 시간 동안만, 포커스와 함께 다시 열면 바로 풀린다", () => {
  holdEditorFocus("w1:a.ts", 1000);
  expect(editorFocusHeld("w1:a.ts", 1500), "막는 중");
  expect(!editorFocusHeld("w1:b.ts", 1500), "다른 탭은 막지 않는다");
  expect(!editorFocusHeld("w1:a.ts", 3500), "시간이 지나면 풀린다");
  holdEditorFocus("w1:a.ts", 1000);
  releaseEditorFocus("w1:b.ts");
  expect(editorFocusHeld("w1:a.ts", 1500), "다른 탭을 풀어도 그대로");
  releaseEditorFocus("w1:a.ts");
  expect(!editorFocusHeld("w1:a.ts", 1500), "release");
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

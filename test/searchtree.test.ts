// 사이드바 Search 뷰의 결과 트리 모델(web/searchTree.ts), 기록(web/searchHistory.ts), 메뉴(web/searchMenu.ts), 바꾸기 규칙(web/searchReplaceModel.ts), 문구(web/searchViewStrings.ts), 입력 지연(web/searchViewModel.ts). 실행: npm test
import { searchSettingsDefaults } from "./searchSettingsDefaults";
import { SearchHistory } from "../web/searchHistory";
import { appendPattern, fileTypePattern, hoverActions, searchMenuItems } from "../web/searchMenu";
import { fileRequestsOf, matchTextOf, previewTextOf, replaceActiveOf, settleReplace } from "../web/searchReplaceModel";
import { buildNodes, collapsibleKeys, comparePaths, dismissHits, filesOf, hasExpanded, hitsUnder, initialCollapsed, lcut, orderedHits, previewOf, visibleRows, type FileNode, type FolderNode } from "../web/searchTree";
import { SV, confirmReplaceAll, noResults, replacedAll, resultCount } from "../web/searchViewStrings";
import { buildSearchRequest, DEFAULT_SEARCH_VIEW, effectiveMatchCase, regexError, typingDelay } from "../web/searchViewModel";

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

type Result = Parameters<typeof filesOf>[0];
const row = (line: number, text: string, ranges: [number, number][], offset?: number) => ({ line, text, match: true, ranges: ranges.map(([start, end]) => ({ start, end })), ...(offset ? { offset } : {}) });
const result = (files: Record<string, ReturnType<typeof row>[]>): Result => ({ files: Object.entries(files).map(([path, rows]) => ({ path, rows })), matches: 0, truncated: false, engine: "git" });
const FIXTURE = result({
  "src/index.ts": [row(3, "export function renderRow(a) {}", [[16, 25]]), row(9, "renderRow(a) renderRow(b)", [[0, 9], [13, 22]])],
  "README.md": [row(3, "renderRow demo project.", [[0, 9]])],
  "src/components/deep/Card.tsx": [row(4, "// TODO renderRow here", [[8, 17]])],
  "docs/notes.md": [row(1, "The renderRow helper", [[4, 13]]), row(2, "x renderRow", [[2, 11]])],
  "src/components/Button.tsx": [row(2, "renderRow(0)", [[0, 9]])],
});

test("filesOf: 같은 줄의 일치도 일치마다 하나, 일치 구간이 없는 줄(옛 데몬)은 한 칸짜리", () => {
  const files = filesOf(FIXTURE);
  expect(files.find((f) => f.path === "src/index.ts")!.hits.length === 3, "index.ts 3");
  const legacy = filesOf({ files: [{ path: "a.ts", rows: [{ line: 1, text: "abc", match: true }] }], matches: 1, truncated: false, engine: "git" });
  same([legacy[0].hits[0].start, legacy[0].hits[0].end], [0, 1], "옛 형식");
  const windowed = filesOf(result({ "m.js": [row(1, "xxrenderRow", [[2, 11]], 1400)] }));
  same([windowed[0].hits[0].start, windowed[0].hits[0].end, windowed[0].hits[0].textOffset], [1402, 1411, 1400], "긴 줄 창은 줄 전체 기준 오프셋");
  return "ok";
});

test("정렬: 기본은 경로 순(얕은 파일이 앞), 대소문자 무시, 숫자는 값으로", () => {
  same(["src/b.ts", "README.md", "src/a/x.ts", "docs/n.md", "src/A.ts"].sort(comparePaths), ["README.md", "docs/n.md", "src/A.ts", "src/b.ts", "src/a/x.ts"], "경로순");
  const files = filesOf(FIXTURE);
  same(buildNodes(files, "list").map((n) => (n as FileNode).file.path), ["README.md", "docs/notes.md", "src/index.ts", "src/components/Button.tsx", "src/components/deep/Card.tsx"], "목록 보기는 VS Code 와 같은 순서");
  same(buildNodes(files, "list", "countDescending").map((n) => (n as FileNode).file.path)[0], "src/index.ts", "개수 내림차순");
  same(buildNodes(filesOf(result({ "a10.ts": [row(1, "x", [[0, 1]])], "a2.ts": [row(1, "x", [[0, 1]])] })), "list", "fileNames").map((n) => (n as FileNode).file.name), ["a2.ts", "a10.ts"], "숫자 이름");
  same(buildNodes(files, "list", "type").map((n) => (n as FileNode).file.name).slice(0, 2), ["notes.md", "README.md"], "확장자순(md 가 ts 앞, 같은 확장자는 이름순)");
  return "ok";
});

test("트리 보기: 폴더가 파일보다 앞, 폴더 이름순, 일치 수 합산", () => {
  const nodes = buildNodes(filesOf(FIXTURE), "tree");
  same(nodes.map((n) => (n.kind === "folder" ? n.label : (n as FileNode).file.name)), ["docs", "src", "README.md"], "최상위");
  const src = nodes[1] as FolderNode;
  same(src.children.map((c) => (c.kind === "folder" ? c.label : (c as FileNode).file.name)), ["components", "index.ts"], "src 아래");
  same([src.hitCount, src.fileCount], [5, 3], "src 합산");
  return "ok";
});

test("트리 보기: 자식이 폴더 하나뿐인 폴더는 한 행으로 합치지만 최상위 폴더는 합치지 않는다", () => {
  const nodes = buildNodes(filesOf(result({ "docs/a/b/c.md": [row(1, "x", [[0, 1]])], "docs/a/b/d/e.md": [row(1, "x", [[0, 1]])] })), "tree");
  const docs = nodes[0] as FolderNode;
  same(docs.label, "docs", "최상위는 그대로");
  same((docs.children[0] as FolderNode).label, "a/b", "그 아래는 합침");
  return "ok";
});

test("펼침: alwaysExpand 는 다 펴고, auto 는 일치 10개 초과만 접고, 파일 하나뿐이면 펴며, alwaysCollapse 는 다 접는다", () => {
  const many = result({ "a.ts": Array.from({ length: 11 }, (_, i) => row(i + 1, "x", [[0, 1]])), "b.ts": [row(1, "x", [[0, 1]])] });
  const nodes = buildNodes(filesOf(many), "list");
  same([...initialCollapsed(nodes, "alwaysExpand")], [], "alwaysExpand");
  same([...initialCollapsed(nodes, "auto")], ["file:a.ts"], "auto");
  same([...initialCollapsed(nodes, "alwaysCollapse")].sort(), ["file:a.ts", "file:b.ts"], "alwaysCollapse");
  const single = buildNodes(filesOf(result({ "a.ts": Array.from({ length: 11 }, (_, i) => row(i + 1, "x", [[0, 1]])) })), "list");
  same([...initialCollapsed(single, "auto")], [], "하나뿐이면 편다");
  return "ok";
});

test("보이는 행: 접힌 파일의 일치는 빠지고, 펼쳐진 노드가 있으면 Collapse All 이 보인다", () => {
  const nodes = buildNodes(filesOf(FIXTURE), "list");
  expect(visibleRows(nodes, new Set()).length === 5 + 8, "전부 펼침");
  const rows = visibleRows(nodes, new Set(["file:src/index.ts"]));
  expect(rows.length === 5 + 5, `index.ts 접힘 ${rows.length}`);
  same(rows.find((r) => r.node.key === "file:src/index.ts")?.expanded, false, "expanded");
  expect(hasExpanded(nodes, new Set(collapsibleKeys(nodes))) === false && hasExpanded(nodes, new Set()) === true, "hasExpanded");
  return "ok";
});

test("Dismiss: 일치를 빼고 마지막 일치가 사라지면 파일 행도 사라진다, 파일과 폴더는 아래 일치 전부", () => {
  const files = filesOf(FIXTURE);
  const index = files.find((f) => f.path === "src/index.ts")!;
  const one = dismissHits(files, new Set([index.hits[0].key]));
  expect(one.find((f) => f.path === "src/index.ts")!.hits.length === 2, "일치 하나");
  const all = dismissHits(files, new Set(hitsUnder(buildNodes(files, "list").find((n) => n.key === "file:README.md")!).map((h) => h.key)));
  expect(!all.some((f) => f.path === "README.md"), "파일 행 사라짐");
  const tree = buildNodes(files, "tree");
  const docs = tree.find((n) => n.key === "folder:docs")!;
  expect(hitsUnder(docs).length === 2, "폴더 아래 일치");
  expect(orderedHits(tree)[0].path === "docs/notes.md", "트리 순서의 첫 일치");
  return "ok";
});

test("미리보기: 앞 문맥은 단어 경계에서 26자 이상 남겨 …로 줄이고, 짧으면 앞 공백만 지운다", () => {
  same(lcut("    const someVeryLongVariableName = anotherFunctionCall(argumentOne, ", 26, "…"), "…anotherFunctionCall(argumentOne, ", "긴 문맥");
  same(lcut("        const result = await ", 26, "…"), "const result = await ", "짧은 문맥");
  const line = "Use renderRows for lists. rowcount is not renderRow.";
  const at = line.lastIndexOf("renderRow");
  const hit = filesOf(result({ "a.ts": [row(1, line, [[at, at + 9]])] }))[0].hits[0];
  const p = previewOf(hit);
  same([p.before, p.inside, p.after], ["…for lists. rowcount is not ", "renderRow", "."], "계측한 두 번째 일치 행");
  return "ok";
});

test("기록: ↑ 는 최근부터, 쓰던 값은 ↓ 로 돌아오고 한 번 더 내리면 빈 글, 같은 값은 맨 뒤로", () => {
  const h = new SearchHistory(["alpha1", "beta2", "gamma3"]);
  same([h.previous(""), h.previous(""), h.previous("")], ["gamma3", "beta2", "alpha1"], "거슬러 오름");
  same([h.next(), h.next(), h.next(), h.next()], ["beta2", "gamma3", "", null], "내려옴");
  const d = new SearchHistory(["a", "b"]);
  same([d.previous("draft"), d.previous("draft"), d.next(), d.next(), d.next()], ["b", "a", "b", "draft", ""], "쓰던 값");
  const dup = new SearchHistory(["a", "b"]);
  dup.add("a");
  same(dup.values(), ["b", "a"], "중복은 맨 뒤로");
  expect(new SearchHistory().previous("x") === null, "빈 기록");
  expect(new SearchHistory(Array.from({ length: 150 }, (_, i) => `q${i}`)).values().length === 100, "100개");
  return "ok";
});

test("메뉴: 행 종류와 바꾸기 줄 여부에 따라 항목과 순서가 정해진다", () => {
  same(searchMenuItems("hit", { replaceShown: false, hasResults: true }).map((i) => i.action), ["dismiss", "copy", "copyAll"], "일치 행");
  same(searchMenuItems("hit", { replaceShown: true, hasResults: true }).map((i) => i.action), ["replace", "dismiss", "copy", "copyAll"], "바꾸기");
  same(searchMenuItems("file", { replaceShown: true, hasResults: true }).map((i) => i.action), ["replaceAll", "dismiss", "excludeFileType", "includeFileType", "copy", "copyPath", "copyAll", "reveal"], "파일 행");
  same(searchMenuItems("folder", { replaceShown: false, hasResults: true }).map((i) => i.action), ["dismiss", "restrictToFolder", "expandRecursively", "excludeFolder", "copyPath", "copyAll"], "폴더 행");
  expect(searchMenuItems("file", { replaceShown: false, hasResults: true }).filter((i) => i.separatorBefore).length === 2, "구분선은 그룹 사이");
  same(hoverActions("hit", false), ["dismiss"], "hover 단추");
  same(hoverActions("file", true), ["replaceAll", "dismiss"], "hover 바꾸기");
  same([fileTypePattern("src/a.test.ts"), fileTypePattern("Makefile"), appendPattern("*.ts", "*.md"), appendPattern("*.ts, *.md", "*.md")], ["*.ts", null, "*.ts, *.md", "*.ts, *.md"], "패턴");
  return "ok";
});

test("바꾸기 규칙: 바꾸기 활성 조건, 파일별 요청(0 부터), 미리보기 글, 결과 처리", () => {
  expect(replaceActiveOf({ showReplace: true, replaceText: "x" }, { useReplacePreview: true }) && !replaceActiveOf({ showReplace: true, replaceText: "" }, { useReplacePreview: true }) && !replaceActiveOf({ showReplace: false, replaceText: "x" }, { useReplacePreview: true }) && !replaceActiveOf({ showReplace: true, replaceText: "x" }, { useReplacePreview: false }), "활성 조건");
  const files = filesOf(FIXTURE);
  const index = files.find((f) => f.path === "src/index.ts")!;
  const req = fileRequestsOf(index.hits, () => "renderCell");
  same(req[0].edits[1], { range: { startLine: 8, startCol: 0, endLine: 8, endCol: 9 }, expected: "renderRow", replacement: "renderCell" }, "요청");
  expect(matchTextOf(index.hits[2]) === "renderRow", "일치 글");
  same(previewTextOf("a renderRow b renderRow\r\nx\n", [{ ...index.hits[0], line: 1, start: 2, end: 11 }, { ...index.hits[0], line: 1, start: 14, end: 23 }], () => "Z"), "a Z b Z\r\nx\n", "미리보기 글 CRLF 유지");
  const settled = settleReplace(index.hits, [{ path: "src/index.ts", status: "conflict", applied: 0 }, { path: "x", status: "applied", applied: 1 }, { path: "y", status: "notFound", applied: 0 }]);
  same([settled.replaced.length, settled.conflicts, settled.failed], [0, ["src/index.ts"], ["y"]], "충돌");
  return "ok";
});

test("문구: 요약 4가지, 빈 결과 변형, Replace All 확인과 완료", () => {
  same([resultCount(1, 1), resultCount(1, 2), resultCount(2, 1), resultCount(15, 5)], ["1 result in 1 file", "1 result in 2 files", "2 results in 1 file", "15 results in 5 files"], "요약");
  same(noResults("all", "", ""), "No results found. Review your configured exclusions and check your gitignore files - ", "기본");
  same(noResults("all", "src", "dist"), "No results found in 'src' excluding 'dist' - ", "둘 다");
  same(noResults("all", "", "dist"), "No results found excluding 'dist' - ", "exclude");
  same(noResults("openEditors", "*.ts", ""), "No results found in open editors matching '*.ts' - ", "열린 편집기");
  same(confirmReplaceAll(1, 1, "x"), "Replace 1 occurrence across 1 file with 'x'?", "1건");
  same(confirmReplaceAll(5, 2, ""), "Replace 5 occurrences across 2 files?", "빈 바꿀 글");
  expect(confirmReplaceAll(2, 1, Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n")).includes("l9\n...'?"), "10줄 초과는 줄임");
  same(replacedAll(3, 1, "y"), "Replaced 3 occurrences across 1 file with 'y'.", "완료");
  same([SV.matchBadge(1), SV.matchBadge(3), SV.fileBadge(2), SV.replacePreviewTitle("a.ts", "a.ts")], ["1 match found", "3 matches found", "2 files found", "a.ts ↔ a.ts (Replace Preview)"], "배지와 탭 제목");
  return "ok";
});

test("입력 지연: 정규식이 넓게 일치할수록 디바운스가 늘고, 틀린 정규식은 검색하지 않는다", () => {
  same(typingDelay({ query: "renderRow", regex: false }, 300), 300, "일반");
  same(typingDelay({ query: "zzzz", regex: true }, 300), 300, "정규식 좁음");
  same(typingDelay({ query: ".", regex: true }, 300), 1500, "정규식 아주 넓음(샘플 100자 미만)");
  same(typingDelay({ query: "[a-zA-Z]", regex: true }, 300), 1500, "중간(영문자 52개)");
  same(typingDelay({ query: "(", regex: true }, 300), null, "틀린 정규식");
  same(regexError("(", true), "Invalid regular expression: /(/u: Unterminated group", "오류 문구는 JS 엔진 그대로");
  same([regexError("(", false), regexError("", true)], [null, null], "정규식이 아니면 오류 없음");
  return "ok";
});

test("검색 요청: ranges 모드는 앞뒤 줄을 0 으로, smartCase 는 대문자가 있을 때만 대소문자를 가리고, Changed Files 는 목록이 비면 요청 없음", () => {
  const view = { ...DEFAULT_SEARCH_VIEW, query: "renderRow", context: 3 };
  const req = buildSearchRequest("w", view, [], { ranges: true, smartCase: true })!;
  same([req.ranges, req.context, req.matchCase], [true, 0, true], "smartCase 대문자");
  same(buildSearchRequest("w", { ...view, query: "renderrow" }, [], { ranges: true, smartCase: true })!.matchCase, false, "소문자");
  expect(effectiveMatchCase({ query: "a", matchCase: true }, true), "토글이 켜져 있으면 늘 가림");
  expect(buildSearchRequest("w", { ...view, changedOnly: true }, [], { ranges: true }) === null, "변경 파일 없음");
  same(buildSearchRequest("w", { ...view, changedOnly: true }, [], { changedPaths: ["a.ts", "b.ts"] })!.include, "a.ts,b.ts", "변경 파일이 include");
  same(searchSettingsDefaults(), { debounce: 300, mode: "tree", collapse: "alwaysExpand" }, "설정 기본값(결과 보기는 트리)");
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

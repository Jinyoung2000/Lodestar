import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findRanges, searchRegExp } from "../shared/searchMatch";
import { DEFAULT_SEARCH_SETTINGS, parseVscodeSearchSettings } from "../shared/searchSettings";
import { findRipgrep, searchWorkspace } from "../server/search";
import { readSearchSettings } from "../server/searchSettings";

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(wanted);
  if (a !== w) throw new Error(`${label}: ${a} != ${w}`);
};
const flags = { matchCase: false, wholeWord: false, regex: false };
const withDir = async <T>(run: (dir: string) => Promise<T> | T) => {
  const dir = mkdtempSync(join(tmpdir(), "an-replace-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("searchRegExp: 글자 그대로, 낱말 단위(기호로 시작해도), 정규식 오류는 null", () => {
  const plain = searchRegExp("a.b", flags)!;
  expect(plain.test("xA.By") && !new RegExp(plain.source, plain.flags).test("xaXby"), "정규식이 아니면 이스케이프");
  const word = searchRegExp("cat", { matchCase: true, wholeWord: true, regex: false })!;
  same(findRanges("concat cat Cat cat_", word), [{ start: 7, end: 10 }], "낱말은 앞뒤가 낱말 문자가 아니어야 한다");
  const symbol = searchRegExp("$x", { matchCase: false, wholeWord: true, regex: false })!;
  same(findRanges("a $x b$x", symbol), [{ start: 2, end: 4 }], "기호로 시작하는 낱말(\\b 는 못 잡는다)");
  expect(searchRegExp("(", { ...flags, regex: true }) === null, "잘못된 정규식");
  expect(searchRegExp("", flags) === null, "빈 검색어");
  same(findRanges("한글 renderRow 한글 renderRow", searchRegExp("renderRow", flags)!), [{ start: 3, end: 12 }, { start: 16, end: 25 }], "UTF-16 오프셋");
  same(findRanges("aaa", searchRegExp("a*", { ...flags, regex: true })!), [{ start: 0, end: 3 }], "빈 일치는 건너뜀");
  return "ok";
});

const write = (dir: string, path: string, text: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};

const makeRepo = (dir: string) => {
  write(dir, "src/index.ts", "renderRow(a) renderRow(b)\n한글 renderRow\n" + `${"x".repeat(1500)} renderRow end\n`);
  write(dir, "node_modules/lib/index.js", "renderRow\n");
  write(dir, "docs/notes.md", "no match here\nrenderRow\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
};

for (const engine of ["git", "rg"] as const) {
  test(`ranges 모드(${engine}): 일치 구간, 횟수, 한글 오프셋, 긴 줄 창, node_modules 제외`, () =>
    withDir(async (dir) => {
      const rg = engine === "rg" ? await findRipgrep() : null;
      if (engine === "rg" && !rg) return "rg 없음, 건너뜀";
      makeRepo(dir);
      const result = await searchWorkspace(dir, { query: "renderRow", matchCase: true, wholeWord: false, regex: false, context: 3, ranges: true, excludeGlobs: ["**/node_modules"] }, rg);
      same(result.files.map((f) => f.path), ["docs/notes.md", "src/index.ts"], "node_modules 는 설정 제외로 빠진다(앞뒤 줄 요청은 무시)");
      expect(result.matches === 5, `횟수 ${result.matches}`);
      const rows = result.files[1].rows;
      same(rows.map((r) => r.line), [1, 2, 3], "일치한 줄만");
      same(rows[0].ranges, [{ start: 0, end: 9 }, { start: 13, end: 22 }], "한 줄 두 일치");
      same(rows[1].ranges, [{ start: 3, end: 12 }], "한글 앞 오프셋");
      const long = rows[2];
      expect(long.offset === 1501 - 100 && long.text.length <= 1000 && long.ranges?.length === 1, `긴 줄 창 ${long.offset} ${long.text.length}`);
      expect(long.text.slice(long.ranges![0].start, long.ranges![0].end) === "renderRow", "창 안 구간이 일치 글을 가리킨다");
      return "ok";
    }));
}

test("ranges 모드: ignore 를 끄면 설정 제외가 빠진다", () =>
  withDir(async (dir) => {
    makeRepo(dir);
    const on = await searchWorkspace(dir, { query: "renderRow", matchCase: true, wholeWord: false, regex: false, context: 0, ranges: true, ignore: true, excludeGlobs: ["**/node_modules"] }, null);
    const off = await searchWorkspace(dir, { query: "renderRow", matchCase: true, wholeWord: false, regex: false, context: 0, ranges: true, ignore: false, excludeGlobs: ["**/node_modules"] }, null);
    expect(!on.files.some((f) => f.path.startsWith("node_modules")) && off.files.some((f) => f.path.startsWith("node_modules")), `${on.files.length} ${off.files.length}`);
    return "ok";
  }));


test("search 설정: 기본값, 사용자 값, 제외 패턴 합치기(false 로 끄기)", () => {
  same(DEFAULT_SEARCH_SETTINGS.searchOnType, true, "searchOnType");
  same(DEFAULT_SEARCH_SETTINGS.searchOnTypeDebouncePeriod, 300, "debounce");
  same(DEFAULT_SEARCH_SETTINGS.defaultViewMode, "tree", "기본 보기");
  expect(DEFAULT_SEARCH_SETTINGS.exclude.includes("**/node_modules") && DEFAULT_SEARCH_SETTINGS.exclude.includes("**/.git"), "기본 제외");
  const parsed = parseVscodeSearchSettings({ "search.searchOnType": false, "search.defaultViewMode": "tree", "search.searchOnTypeDebouncePeriod": "x", "search.exclude": { "**/node_modules": false, "**/dist": true }, "files.exclude": { "**/.git": false, "**/out": true }, "search.maxResults": null });
  same([parsed.searchOnType, parsed.defaultViewMode, parsed.searchOnTypeDebouncePeriod, parsed.maxResults], [false, "tree", 300, null], "값");
  expect(!parsed.exclude.includes("**/node_modules") && !parsed.exclude.includes("**/.git") && parsed.exclude.includes("**/dist") && parsed.exclude.includes("**/out") && parsed.exclude.includes("**/bower_components"), parsed.exclude.join());
  const read = readSearchSettings({ readText: () => '{ // 주석\n "search.showLineNumbers": true, }', vscodeState: () => null }, "/x");
  same(read.showLineNumbers, true, "JSONC");
  same(readSearchSettings({ readText: () => null, vscodeState: () => null }, "/x"), DEFAULT_SEARCH_SETTINGS, "파일 없음");
  expect(!existsSync("/x"), "x");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${await c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);

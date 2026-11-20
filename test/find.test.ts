// 찾기 위젯의 순수 계산(web/findModel.ts): 일치 모으기, 범위, 현재 번호, 다음과 이전, 바꿀 글, 결과 수 문구, 큰 파일 속도.
// 실행: npm test
import { EditorState } from "@codemirror/state";
import {
  buildQuery,
  collectMatches,
  containingIndex,
  countLabel,
  expandReplacement,
  firstMatchFrom,
  MATCH_LIMIT,
  nextIndex,
  preserveCase,
  previousIndex,
  regexError,
  replacementFor,
  seedText,
  type FindOptions,
} from "../web/findModel";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const plain: FindOptions = { caseSensitive: false, wholeWord: false, regexp: false, preserveCase: false };
const stateOf = (doc: string, anchor = 0, head = anchor) => EditorState.create({ doc, selection: { anchor, head } });
const spans = (doc: string, search: string, options: Partial<FindOptions> = {}, scope: { from: number; to: number } | null = null) =>
  collectMatches(buildQuery(search, { ...plain, ...options }), stateOf(doc), scope).list.map((m) => `${m.from}-${m.to}`).join(",");

test("대소문자 무시가 기본, Match Case 를 켜면 구분", () => {
  expect(spans("Foo foo FOO", "foo") === "0-3,4-7,8-11", spans("Foo foo FOO", "foo"));
  expect(spans("Foo foo FOO", "foo", { caseSensitive: true }) === "4-7", "case");
  return "ok";
});

test("낱말 단위: 다른 낱말 안의 일치는 뺀다", () => {
  expect(spans("cat concat cat_x cat", "cat", { wholeWord: true }) === "0-3,17-20", spans("cat concat cat_x cat", "cat", { wholeWord: true }));
  return "ok";
});

test("일반 모드에서 \\n 은 글자 그대로(줄바꿈으로 풀지 않는다)", () => {
  expect(spans("a\\nb\na\nb", "\\n") === "1-3", spans("a\\nb\na\nb", "\\n"));
  return "ok";
});

test("정규식: 일치와 잘못된 식의 메시지", () => {
  expect(spans("a1 b22 c333", "\\d+", { regexp: true }) === "1-2,4-6,8-11", spans("a1 b22 c333", "\\d+", { regexp: true }));
  expect(regexError("(") !== null && /Unterminated group|Invalid/.test(regexError("(")!), String(regexError("(")));
  expect(!/gmu/.test(regexError("(")!), "플래그가 메시지에 남지 않는다");
  expect(regexError("a+") === null && regexError("") === null, "valid");
  const q = buildQuery("(", { ...plain, regexp: true });
  expect(!q.valid && collectMatches(q, stateOf("(("), null).list.length === 0, "invalid query matches nothing");
  return "ok";
});

test("Find in Selection: 범위 안의 일치만", () => {
  const doc = "x x x x x";
  expect(spans(doc, "x", {}, { from: 2, to: 7 }) === "2-3,4-5,6-7", spans(doc, "x", {}, { from: 2, to: 7 }));
  return "ok";
});

test("현재 번호는 선택이 일치 안에 있을 때, 아니면 -1", () => {
  const list = collectMatches(buildQuery("ab", plain), stateOf("ab ab ab"), null).list;
  expect(containingIndex(list, 3, 5) === 1, "exact");
  expect(containingIndex(list, 4, 4) === 1, "caret inside");
  expect(containingIndex(list, 2, 2) === 0, "caret at a match end counts as inside");
  const gap = collectMatches(buildQuery("ab", plain), stateOf("ab  ab"), null).list;
  expect(containingIndex(gap, 3, 3) === -1, "between");
  expect(containingIndex(list, 0, 8) === -1, "wider than a match");
  return "ok";
});

test("다음: 선택 끝 뒤 첫 일치, 끝에서 처음으로 / 이전: 선택 시작 앞 마지막 일치, 처음에서 끝으로", () => {
  const list = collectMatches(buildQuery("ab", plain), stateOf("ab ab ab"), null).list;
  expect(nextIndex(list, 2) === 1 && nextIndex(list, 5) === 2, "next");
  expect(nextIndex(list, 8) === 0, "wrap to first");
  expect(nextIndex(list, 0) === 0, "caret at a match start selects that match");
  expect(previousIndex(list, 3) === 0 && previousIndex(list, 6) === 1, "previous");
  expect(previousIndex(list, 0) === 2, "wrap to last");
  expect(nextIndex([], 0) === -1 && previousIndex([], 0) === -1, "empty");
  return "ok";
});

test("입력 중 고르기: 시작 자리 이후 첫 일치, 없으면 처음부터", () => {
  const q = buildQuery("ab", plain);
  const state = stateOf("ab ab ab");
  expect(firstMatchFrom(q, state, 1, null)?.from === 3, "after anchor");
  expect(firstMatchFrom(q, state, 7, null)?.from === 0, "wraps");
  expect(firstMatchFrom(q, state, 0, { from: 3, to: 8 })?.from === 3, "scope start");
  expect(firstMatchFrom(buildQuery("zz", plain), state, 0, null) === null, "none");
  return "ok";
});

test("검색어 시드: 한 줄 선택은 그 글, 커서는 낱말, 여러 줄은 null", () => {
  expect(seedText(stateOf("hello world", 6, 11)) === "world", "selection");
  expect(seedText(stateOf("hello world", 8)) === "world", "word at caret");
  expect(seedText(stateOf("hello  world", 6)) === null || seedText(stateOf("hello  world", 6)) === "hello" || seedText(stateOf("hello  world", 6)) === "world", "between words");
  expect(seedText(stateOf("a\nb", 0, 3)) === null, "multi-line");
  return "ok";
});

test("Preserve Case: 전부 대문자, 전부 소문자, 첫 글자만 대문자, 섞이면 그대로", () => {
  expect(preserveCase("FOO", "bar") === "BAR", "upper");
  expect(preserveCase("foo", "BAR") === "bar", "lower");
  expect(preserveCase("Foo", "bar") === "Bar", "capitalized");
  expect(preserveCase("fOo", "bar") === "bar", "mixed");
  expect(preserveCase("123", "bar") === "bar", "no letters");
  const state = stateOf("Foo foo FOO");
  const found = collectMatches(buildQuery("foo", plain), state, null).list;
  const out = found.map((m) => replacementFor(state, m, "bar", { ...plain, preserveCase: true }));
  expect(out.join() === "Bar,bar,BAR", out.join());
  return "ok";
});

test("정규식 바꾸기: $1, $&, $$ 와 \\n, \\t, 일반 모드는 글자 그대로", () => {
  const state = stateOf("ab-12");
  const options = { ...plain, regexp: true };
  const [m] = collectMatches(buildQuery("([a-z]+)-(\\d+)", options), state, null).list;
  expect(expandReplacement(m, "$2:$1 [$&] $$ \\n|\\t|\\\\", options) === "12:ab [ab-12] $ \n|\t|\\", expandReplacement(m, "$2:$1 [$&] $$ \\n|\\t|\\\\", options));
  const [p] = collectMatches(buildQuery("ab", plain), state, null).list;
  expect(replacementFor(state, p, "$1\\n", plain) === "$1\\n", "literal in plain mode");
  return "ok";
});

test("결과 수 문구", () => {
  expect(countLabel(0, -1, false) === "No results", "none");
  expect(countLabel(12, 2, false) === "3 of 12", "n of m");
  expect(countLabel(12, -1, false) === "? of 12", "unknown");
  expect(countLabel(MATCH_LIMIT, 0, true) === `1 of ${MATCH_LIMIT}+`, "capped");
  return "ok";
});

test("일치가 상한을 넘으면 거기서 멈춘다", () => {
  const doc = "a".repeat(MATCH_LIMIT + 500);
  const result = collectMatches(buildQuery("a", plain), stateOf(doc), null);
  expect(result.capped && result.list.length === MATCH_LIMIT, `${result.list.length}`);
  const all = collectMatches(buildQuery("a", plain), stateOf(doc), null, Infinity);
  expect(!all.capped && all.list.length === MATCH_LIMIT + 500, `${all.list.length}`);
  return "ok";
});

test("7천 줄 파일: 일치 모으기와 이동이 끊김 없는 시간 안에 끝난다", () => {
  const lines: string[] = [];
  for (let i = 0; i < 7000; i++) lines.push(`const value${i} = compute(${i}, "needle"); // line ${i} needle`);
  const state = stateOf(lines.join("\n"));
  let start = performance.now();
  const plainResult = collectMatches(buildQuery("needle", plain), state, null);
  const plainMs = performance.now() - start;
  start = performance.now();
  const regexResult = collectMatches(buildQuery("need\\w+", { ...plain, regexp: true }), state, null);
  const regexMs = performance.now() - start;
  expect(plainResult.list.length === 14000 && regexResult.list.length === 14000, `${plainResult.list.length}, ${regexResult.list.length}`);
  start = performance.now();
  for (let i = 0; i < 1000; i++) nextIndex(plainResult.list, i * 300);
  const navMs = performance.now() - start;
  expect(plainMs < 500 && regexMs < 1000 && navMs < 50, `plain ${plainMs.toFixed(0)}ms regex ${regexMs.toFixed(0)}ms 1000 moves ${navMs.toFixed(1)}ms`);
  return `plain ${plainMs.toFixed(0)}ms, regex ${regexMs.toFixed(0)}ms, 1000 moves ${navMs.toFixed(1)}ms`;
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

// Q2: 대화 안 찾기의 계산(web/chatFindModel.ts). DOM 이 없다.
// 실행: npm test
import { buildPattern, partIndexAt, stepIndex, textMatches } from "../web/chatFindModel";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const off = { caseSensitive: false, wholeWord: false, regexp: false };
const found = (text: string, query: string, options = off) => {
  const { regex } = buildPattern(query, options);
  return regex ? textMatches(text, regex).list.map((m) => text.slice(m.from, m.to)) : [];
};

test("case-insensitive by default, Match Case narrows", () => {
  expect(found("Zebra zebra ZEBRA", "zebra").length === 3, "three");
  return expect(found("Zebra zebra ZEBRA", "zebra", { ...off, caseSensitive: true }).length === 1, "one");
});

test("plain text is escaped, regex mode is not", () => {
  expect(found("a.b axb", "a.b").length === 1, "dot is literal");
  expect(found("a.b axb", "a.b", { ...off, regexp: true }).length === 2, "dot is any char");
  const bad = buildPattern("(", { ...off, regexp: true });
  return expect(bad.regex === null && !!bad.error, `invalid regex: ${bad.error}`);
});

test("whole word works for Hangul too", () => {
  expect(found("빌드 빌드는 빌드", "빌드", { ...off, wholeWord: true }).length === 2, "hangul words");
  expect(found("build building rebuild", "build", { ...off, wholeWord: true }).length === 1, "latin words");
  return "ok";
});

test("empty matches are skipped and the limit caps the list", () => {
  const { regex } = buildPattern("^", { ...off, regexp: true });
  expect(textMatches("a\nb", regex!).list.length === 0, "no empty matches");
  const many = textMatches("aaaa", buildPattern("a", off).regex!, 3);
  return expect(many.list.length === 3 && many.capped, "capped");
});

test("offset to part lookup and wrap-around stepping", () => {
  expect(partIndexAt([0, 5, 9], 0) === 0 && partIndexAt([0, 5, 9], 4) === 0 && partIndexAt([0, 5, 9], 5) === 1 && partIndexAt([0, 5, 9], 100) === 2, "parts");
  expect(stepIndex(-1, 3, false) === 0 && stepIndex(-1, 3, true) === 2 && stepIndex(2, 3, false) === 0 && stepIndex(0, 3, true) === 2 && stepIndex(0, 0, false) === -1, "step");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok  ${c.name} - ${c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}\n  ${(error as Error).message}`);
  }
}
if (failed) process.exit(1);

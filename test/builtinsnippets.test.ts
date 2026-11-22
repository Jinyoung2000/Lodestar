import { BUILTIN_SNIPPETS, snippetOptions, toCodeMirrorSnippet } from "../web/builtinSnippets";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("변환: $0 은 빈 자리, $1 은 번호 자리, 선택 영역 변수는 지운다", () => {
  expect(toCodeMirrorSnippet("console.log($1);\n$0") === "console.log(${1});\n${}", "log");
  expect(toCodeMirrorSnippet("if (${1:condition}) {\n\t$TM_SELECTED_TEXT$0\n}") === "if (${1:condition}) {\n\t${}\n}", "if");
  expect(toCodeMirrorSnippet("${1:a} ${1:a}") === "${1:a} ${1:a}", "이미 맞는 자리는 그대로");
  return "ok";
});

test("목록: 접두어는 낱말 하나이고 겹치지 않으며 VS Code 의 log, for, forof, trycatch 가 있다", () => {
  const prefixes = BUILTIN_SNIPPETS.map((s) => s.prefix);
  expect(prefixes.every((p) => /^\w+$/.test(p)), "낱말 하나");
  expect(new Set(prefixes).size === prefixes.length, "중복 없음");
  expect(["log", "for", "forof", "trycatch", "settimeout"].every((p) => prefixes.includes(p)), "자주 쓰는 조각");
  expect(snippetOptions().length === prefixes.length && snippetOptions().every((o) => o.type === "snippet" && typeof o.apply === "function"), "옵션");
  return `${prefixes.length}개`;
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

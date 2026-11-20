// 에디터 제안 목록과 파라미터 힌트 키의 판정(web/editorKeys.ts)을 DOM 없이 확인한다.
// 실행: npm test
import { arrowAction, escapeAction, signatureContext, spaceKeyAction, type SuggestContext } from "../web/editorKeys";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const none: SuggestContext = { suggestOpen: false, signatureOpen: false, signatureMultiple: false };
const suggest: SuggestContext = { ...none, suggestOpen: true };
const single: SuggestContext = { ...none, signatureOpen: true };
const multiple: SuggestContext = { ...none, signatureOpen: true, signatureMultiple: true };

test("⌃Space: 제안이 열려 있으면 상세 토글, 닫혀 있으면 제안 열기", () => {
  expect(spaceKeyAction("ctrl-space", suggest) === "toggleDetails", "열림");
  expect(spaceKeyAction("ctrl-space", none) === "triggerSuggest", "닫힘");
  return "ok";
});

test("⌘I: 제안이 열려 있을 때만 상세 토글, 닫혀 있으면 앱의 빠른 질문으로 넘긴다", () => {
  expect(spaceKeyAction("cmd-i", suggest) === "toggleDetails", "열림");
  expect(spaceKeyAction("cmd-i", none) === "pass", "닫힘");
  return "ok";
});

test("↑↓: 제안 목록이 열려 있으면 CodeMirror 기본 키맵으로, 오버로드가 여럿인 힌트만 가로챈다", () => {
  expect(arrowAction({ direction: "down", via: "plain" }, suggest) === "pass", "제안 열림");
  expect(arrowAction({ direction: "down", via: "plain" }, multiple) === "nextSignature", "오버로드 아래");
  expect(arrowAction({ direction: "up", via: "plain" }, multiple) === "prevSignature", "오버로드 위");
  expect(arrowAction({ direction: "down", via: "plain" }, single) === "pass", "서명 하나면 일반 이동");
  expect(arrowAction({ direction: "down", via: "plain" }, none) === "pass", "아무것도 없으면 일반 이동");
  expect(arrowAction({ direction: "down", via: "plain" }, { ...multiple, suggestOpen: true }) === "pass", "제안이 힌트보다 먼저");
  return "ok";
});

test("⌥↑↓: 오버로드가 여럿인 힌트가 있을 때만 서명 이동, 아니면 줄 이동으로 넘긴다", () => {
  expect(arrowAction({ direction: "down", via: "alt" }, multiple) === "nextSignature", "아래");
  expect(arrowAction({ direction: "up", via: "alt" }, multiple) === "prevSignature", "위");
  expect(arrowAction({ direction: "down", via: "alt" }, single) === "pass", "서명 하나");
  expect(arrowAction({ direction: "down", via: "alt" }, suggest) === "pass", "제안만 열림");
  expect(arrowAction({ direction: "up", via: "alt" }, none) === "pass", "없음");
  return "ok";
});

test("⌃N, ⌃P: 제안 목록이 먼저, 그다음 오버로드, 아니면 기본 키(맥의 줄 이동)", () => {
  expect(arrowAction({ direction: "down", via: "ctrl" }, suggest) === "nextSuggestion", "제안 아래");
  expect(arrowAction({ direction: "up", via: "ctrl" }, suggest) === "prevSuggestion", "제안 위");
  expect(arrowAction({ direction: "down", via: "ctrl" }, multiple) === "nextSignature", "오버로드");
  expect(arrowAction({ direction: "up", via: "ctrl" }, none) === "pass", "없음");
  return "ok";
});

test("Esc: 제안 목록이 열려 있으면 CodeMirror 에 맡기고, 힌트만 떠 있으면 힌트를 닫는다", () => {
  expect(escapeAction(suggest) === "pass", "제안 열림");
  expect(escapeAction({ ...multiple, suggestOpen: true }) === "pass", "제안과 힌트 둘 다: 제안이 먼저");
  expect(escapeAction(single) === "closeSignature" && escapeAction(multiple) === "closeSignature", "힌트만");
  expect(escapeAction(none) === "pass", "없음");
  return "ok";
});

test("signatureContext: 힌트 상자와 오버로드 표시 클래스로 맥락을 읽는다", () => {
  const root = (classes: string | null) => ({ querySelector: () => (classes === null ? null : { classList: { contains: (name: string) => classes.split(" ").includes(name) } }) }) as unknown as ParentNode;
  expect(JSON.stringify(signatureContext(root(null), false)) === JSON.stringify(none), "상자 없음");
  expect(signatureContext(root("cm-lsp-signature-tooltip"), false).signatureMultiple === false, "서명 하나");
  const many = signatureContext(root("cm-lsp-signature-tooltip cm-lsp-signature-multiple"), true);
  expect(many.signatureOpen && many.signatureMultiple && many.suggestOpen, "서명 여럿");
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

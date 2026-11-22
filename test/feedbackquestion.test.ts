import { parseFeedbackReply, withoutQuestionMarker } from "../shared/feedbackQuestion";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: unknown) => {
  if (!condition) throw new Error(JSON.stringify(detail));
  return JSON.stringify(detail);
};

test("a [QUESTION] marker makes it a question and is removed from the text", () => {
  const r = parseFeedbackReply("[QUESTION] 고정 패널로 만들까요, 에디터 탭에 둘까요");
  return expect(r.question && r.text === "고정 패널로 만들까요, 에디터 탭에 둘까요", r);
});
test("the marker counts even when the sentence has no question mark", () => {
  const r = parseFeedbackReply("[QUESTION] 어느 화면을 말씀하시는지 알려 주세요.");
  return expect(r.question && !r.text.includes("QUESTION"), r);
});
test("the marker is matched case-insensitively with leading space", () => {
  const r = parseFeedbackReply("  \n[question]   Which one?");
  return expect(r.question && r.text === "Which one?", r);
});
test("a marker with nothing after it is not a question", () => {
  const r = parseFeedbackReply("[QUESTION]  ");
  return expect(!r.question && r.text === "", r);
});
test("an old session without a marker is a question when the last sentence ends with ?", () => {
  const r = parseFeedbackReply("변경 없이 확인이 필요합니다. 채팅 레이아웃에서 파일 탭을 에디터 탭과 분리해 별도 고정 패널로 만들까요, 아니면 다른 뜻인가요?");
  return expect(r.question, r);
});
test("a full-width question mark and a closing quote still count", () => {
  const a = parseFeedbackReply("이 버튼을 지울까요？");
  const b = parseFeedbackReply('"이 버튼을 지울까요?"');
  return expect(a.question && b.question, { a, b });
});
test("only the last non-empty line decides", () => {
  const a = parseFeedbackReply("무엇을 바꿀까요?\n\n탭 간격을 4px 줄였습니다.");
  const b = parseFeedbackReply("탭 간격을 4px 줄였습니다.\n확인해 주실래요?\n");
  return expect(!a.question && b.question, { a, b });
});
test("a plain statement is not a question", () => {
  const r = parseFeedbackReply("탭 간격을 4px 줄였습니다.");
  return expect(!r.question && r.text === "탭 간격을 4px 줄였습니다.", r);
});
test("a question mark in the middle of the last sentence does not count", () => {
  const r = parseFeedbackReply("왜 안 되는지? 원인은 캐시였고 고쳤습니다.");
  return expect(!r.question, r);
});
test("empty text is not a question", () => expect(!parseFeedbackReply("").question && !parseFeedbackReply("   \n").question, "empty"));
test("withoutQuestionMarker removes the marker and leaves other text alone", () => {
  const a = withoutQuestionMarker("[QUESTION] 정말요?");
  const b = withoutQuestionMarker("Changed the gap [QUESTION] later");
  return expect(a === "정말요?" && b === "Changed the gap [QUESTION] later", { a, b });
});
test("withoutQuestionMarker hides a marker that is still streaming in", () => {
  const parts = ["[", "[QUE", "[question"].map(withoutQuestionMarker);
  const other = withoutQuestionMarker("[link](x)");
  return expect(parts.every((p) => p === "") && other === "[link](x)", { parts, other });
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

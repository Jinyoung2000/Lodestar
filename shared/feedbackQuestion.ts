// 개선 세션의 마지막 답이 "사용자에게 묻는 말"인지 가른다. 서버(상태 판정, 요약)와 화면(말풍선에서 표지 지우기)이 같은 함수를 쓴다. 시험: test/feedbackquestion.test.ts
export const QUESTION_MARKER = "[QUESTION]";

const MARKER = /^\s*\[QUESTION\]\s*/i;
// 물음표 뒤에 붙을 수 있는 닫는 문자: 괄호, 따옴표, 강조 기호
const CLOSERS = /[)"'”’」』*_`\s]+$/;

export type FeedbackReply = { text: string; question: boolean };

// 표지가 있으면 표지를 떼고 질문으로 본다(명시 신호). 표지가 없는 옛 세션은 마지막 줄이 물음표로 끝날 때만 질문으로 본다(보조 판정).
export function parseFeedbackReply(raw: string): FeedbackReply {
  const marked = MARKER.test(raw);
  const text = raw.replace(MARKER, "").trim();
  if (marked) return { text, question: text.length > 0 };
  const last = text.split("\n").filter((line) => line.trim()).pop() ?? "";
  return { text, question: /[?？]$/.test(last.replace(CLOSERS, "")) };
}

// 화면에 보일 답: 표지만 지운다. 스트리밍 중 표지가 반쯤 온 상태("[QUE")도 숨긴다.
export function withoutQuestionMarker(raw: string): string {
  if (MARKER.test(raw)) return raw.replace(MARKER, "");
  const head = raw.trimStart().toUpperCase();
  return head.length > 0 && head.length < QUESTION_MARKER.length && QUESTION_MARKER.startsWith(head) ? "" : raw;
}

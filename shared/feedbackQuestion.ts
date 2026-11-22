export const QUESTION_MARKER = "[QUESTION]";

const MARKER = /^\s*\[QUESTION\]\s*/i;
const CLOSERS = /[)"'”’」』*_`\s]+$/;

export type FeedbackReply = { text: string; question: boolean };

export function parseFeedbackReply(raw: string): FeedbackReply {
  const marked = MARKER.test(raw);
  const text = raw.replace(MARKER, "").trim();
  if (marked) return { text, question: text.length > 0 };
  const last = text.split("\n").filter((line) => line.trim()).pop() ?? "";
  return { text, question: /[?？]$/.test(last.replace(CLOSERS, "")) };
}

export function withoutQuestionMarker(raw: string): string {
  if (MARKER.test(raw)) return raw.replace(MARKER, "");
  const head = raw.trimStart().toUpperCase();
  return head.length > 0 && head.length < QUESTION_MARKER.length && QUESTION_MARKER.startsWith(head) ? "" : raw;
}

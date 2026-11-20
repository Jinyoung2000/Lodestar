// 질문 카드(AskUserQuestion)와 계획 카드(ExitPlanMode)의 입력 읽기. shared/interactive.ts 와 같은 규칙이고 test/questions.test.ts 가 같은 입력으로 대조한다.
export const QUESTION_TOOL = "AskUserQuestion";
export const PLAN_TOOL = "ExitPlanMode";

export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };
export type QuestionState = { picked: string[]; other: boolean; text: string };

const str = (value: unknown) => (typeof value === "string" ? value : "");

export function readQuestions(input: Record<string, unknown>): Question[] {
  const list = Array.isArray(input.questions) ? input.questions : [];
  const out: Question[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = raw as Record<string, unknown>;
    const question = str(q.question).trim();
    if (!question) continue;
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((o) => {
      if (typeof o !== "object" || o === null) return [];
      const label = str((o as Record<string, unknown>).label).trim();
      return label ? [{ label, description: str((o as Record<string, unknown>).description) }] : [];
    });
    out.push({ question, header: str(q.header), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

export const emptyQuestionState = (): QuestionState => ({ picked: [], other: false, text: "" });

export function togglePick(question: Question, state: QuestionState, label: string): QuestionState {
  if (!question.multiSelect) return { picked: [label], other: false, text: state.text };
  return { ...state, picked: state.picked.includes(label) ? state.picked.filter((l) => l !== label) : [...state.picked, label] };
}

export function toggleOther(question: Question, state: QuestionState): QuestionState {
  if (!question.multiSelect) return { picked: [], other: true, text: state.text };
  return { ...state, other: !state.other };
}

export function answerOf(question: Question, state: QuestionState): string {
  const picked = question.options.map((o) => o.label).filter((label) => state.picked.includes(label));
  const text = state.other ? state.text.trim() : "";
  return [...picked, ...(text ? [text] : [])].join(", ");
}

export const isAnswered = (questions: Question[], states: QuestionState[]) => questions.length > 0 && questions.every((q, i) => answerOf(q, states[i] ?? emptyQuestionState()) !== "");

export function answersOf(questions: Question[], states: QuestionState[]): Record<string, string> {
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    out[q.question] = answerOf(q, states[i] ?? emptyQuestionState());
  });
  return out;
}

export function planText(input: Record<string, unknown>): string | null {
  const plan = str(input.plan).trim();
  return plan || null;
}

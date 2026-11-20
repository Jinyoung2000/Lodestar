// fixB: 질문(AskUserQuestion) 카드가 쓰는 순수 로직. 화면과 서버가 같은 질문 읽기와 답 만들기를 쓴다.
import { isNotionProposeTool } from "./notionMcp";

export const QUESTION_TOOL = "AskUserQuestion";
export const PLAN_TOOL = "ExitPlanMode";

// 이 두 도구는 모드(Bypass Permissions 포함)와 허용 규칙에 상관없이 늘 사용자에게 묻고, 허용 단추가 아니라 전용 카드로 답한다.
export const isInteractiveTool = (name: string) => name === QUESTION_TOOL || name === PLAN_TOOL;

// NOTION2: Notion 쓰기 제안도 허용 단추로 답하지 않고, 변경 내용(diff)을 카드에서 보고 적용 또는 거절한다. 사이드바, 알림, 단축키는 질문과 같이 세션을 여는 길만 둔다.
export const needsReview = (name: string) => isInteractiveTool(name) || isNotionProposeTool(name);

export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };

const str = (value: unknown) => (typeof value === "string" ? value : "");

// 모델이 준 입력에서 질문 목록을 읽는다. 모양이 어긋난 항목은 건너뛴다.
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

// 질문 하나에 대해 사용자가 고른 것. picked 는 고른 선택지 label, other 는 "Other" 를 골랐는지, text 는 Other 에 쓴 글.
export type QuestionState = { picked: string[]; other: boolean; text: string };

export const emptyQuestionState = (): QuestionState => ({ picked: [], other: false, text: "" });

// 선택지를 누른다. 하나만 고르는 질문은 그 선택지로 바뀌고 Other 가 꺼진다. 여러 개를 고르는 질문은 켜고 끈다.
export function togglePick(question: Question, state: QuestionState, label: string): QuestionState {
  if (!question.multiSelect) return { picked: [label], other: false, text: state.text };
  return { ...state, picked: state.picked.includes(label) ? state.picked.filter((l) => l !== label) : [...state.picked, label] };
}

// Other 를 누른다. 하나만 고르는 질문은 고른 선택지를 비우고, 여러 개를 고르는 질문은 켜고 끈다.
export function toggleOther(question: Question, state: QuestionState): QuestionState {
  if (!question.multiSelect) return { picked: [], other: true, text: state.text };
  return { ...state, other: !state.other };
}

// 모델에 가는 답 문자열. 고른 선택지는 질문의 선택지 순서로, Other 에 쓴 글은 맨 뒤에 ", " 로 잇는다. 아무것도 없으면 빈 문자열이다.
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

// 계획 승인 카드에 보일 계획 글. 도구 입력의 plan 이다(SDK 타입 선언에는 없지만 CLI 가 실제로 담아 보낸다). 없으면 null.
export function planText(input: Record<string, unknown>): string | null {
  const plan = str(input.plan).trim();
  return plan || null;
}

// 승인 카드가 보여 주는 요청은 타임라인에서 처음 pending 인 permission 이다(AgentView 와 같은 규칙).
// 도구 승인 단축키(⌘Enter, ⌥⌘Enter)는 일반 도구 승인에만 듣는다. 질문과 계획 승인은 카드에서 답을 고르는 일이라 단축키 대상이 아니다.
export function pendingToolRequest(items: readonly { id: string; kind: string; toolName?: string; status?: string }[] | undefined): { id: string; toolName: string } | null {
  const first = items?.find((item) => item.kind === "permission" && item.status === "pending");
  if (!first?.toolName || needsReview(first.toolName)) return null;
  return { id: first.id, toolName: first.toolName };
}

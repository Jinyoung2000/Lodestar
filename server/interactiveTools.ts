// fixB: 사용자에게 묻거나 계획을 승인받는 두 도구(AskUserQuestion, ExitPlanMode)의 결과를 SDK 의 PermissionResult 로 만든다.
// SDK 나 데몬 상태에 기대지 않는 순수한 조각이라 test/interactive.test.ts 가 따로 시험한다.
//
// 근거(2026-10-16, CLI 2.1.296, SDK 0.3.296):
// - AskUserQuestion: canUseTool 이 allow 와 함께 updatedInput.answers(질문 글 -> 답 문자열)를 돌려주면 CLI 가 그 값으로 도구 결과를 만든다.
//   sdk-tools.d.ts 의 AskUserQuestionInput.answers 가 이 값이고, 여러 개를 고른 답은 ", " 로 잇는다. 선택지에 없는 글(기타)도 같은 자리에 넣으면 되고 CLI 는 "The user answered:" 문구로 모델에 알린다.
// - ExitPlanMode: allow 와 updatedPermissions 의 setMode 가 권한 모드를 바꾸고, deny 의 message 가 그대로 도구 결과(모델이 보는 글)가 된다.
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode } from "../shared/protocol";
import { isInteractiveTool, PLAN_TOOL, planText, QUESTION_TOOL, readQuestions } from "../shared/interactive";

export { isInteractiveTool, PLAN_TOOL, planText, QUESTION_TOOL, readQuestions };
export type { Question } from "../shared/interactive";

const MAX_ANSWER = 4000;

// 화면에서 온 답을 질문 글에 맞춰 거른다. 없는 질문의 답은 버리고, 값은 문자열로 자르며, 비어 있는 답은 뺀다.
export function cleanAnswers(input: Record<string, unknown>, answers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { question } of readQuestions(input)) {
    const value = answers[question];
    if (typeof value !== "string") continue;
    const text = value.trim().slice(0, MAX_ANSWER);
    if (text) out[question] = text;
  }
  return out;
}

// 답했으면 updatedInput.answers 로, 답 없이 넘겼으면(answers 가 null) 빈 answers 로 CLI 가 "The user did not answer the questions." 를 만들게 한다.
export function questionResult(input: Record<string, unknown>, answers: Record<string, unknown> | null): { result: PermissionResult; answers: Record<string, string> } {
  const clean = answers ? cleanAnswers(input, answers) : {};
  return { result: { behavior: "allow", updatedInput: { ...input, answers: clean } }, answers: clean };
}

// 모델이 읽는 거절 글. 계획을 바꾸라는 사용자 글이 있으면 그대로 싣는다.
export function keepPlanningMessage(feedback?: string): string {
  const base = "The user wants to keep planning and did not approve the plan. Stay in plan mode, revise the plan, and call ExitPlanMode again when it is ready.";
  const text = feedback?.trim();
  return text ? `${base}\n\nThe user's feedback on the plan:\n${text.slice(0, MAX_ANSWER)}` : base;
}

export function planResult(input: Record<string, unknown>, decision: { approve: true; mode: PermissionMode } | { approve: false; feedback?: string }): PermissionResult {
  if (!decision.approve) return { behavior: "deny", message: keepPlanningMessage(decision.feedback) };
  return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode: decision.mode, destination: "session" }] };
}

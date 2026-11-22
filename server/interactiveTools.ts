import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode } from "../shared/protocol";
import { isInteractiveTool, PLAN_TOOL, planText, QUESTION_TOOL, readQuestions } from "../shared/interactive";

export { isInteractiveTool, PLAN_TOOL, planText, QUESTION_TOOL, readQuestions };
export type { Question } from "../shared/interactive";

const MAX_ANSWER = 4000;

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

export function questionResult(input: Record<string, unknown>, answers: Record<string, unknown> | null): { result: PermissionResult; answers: Record<string, string> } {
  const clean = answers ? cleanAnswers(input, answers) : {};
  return { result: { behavior: "allow", updatedInput: { ...input, answers: clean } }, answers: clean };
}

export function keepPlanningMessage(feedback?: string): string {
  const base = "The user wants to keep planning and did not approve the plan. Stay in plan mode, revise the plan, and call ExitPlanMode again when it is ready.";
  const text = feedback?.trim();
  return text ? `${base}\n\nThe user's feedback on the plan:\n${text.slice(0, MAX_ANSWER)}` : base;
}

export function planResult(input: Record<string, unknown>, decision: { approve: true; mode: PermissionMode } | { approve: false; feedback?: string }): PermissionResult {
  if (!decision.approve) return { behavior: "deny", message: keepPlanningMessage(decision.feedback) };
  return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode: decision.mode, destination: "session" }] };
}

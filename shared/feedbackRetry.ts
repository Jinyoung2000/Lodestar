import type { Feedback } from "./protocol";

// 검사를 한 번이라도 돌린 뒤 멈춘 피드백은 다시 돌릴 수 있다: 검사 실패, 검사는 통과했는데 반영 직전 본 작업 폴더와의 충돌, 병합 충돌(검사 한 줄로 남는다).
// 검사 전에 멈춘 것(개선 세션 오류, 변경 없음, package.json 수정 거절)은 checks 가 비어 있어 걸리지 않는다.
// FBBLOCK: 검사 단계에서 환경이나 인증 때문에 기다리는 중(blocked)인 것도 지금 바로 다시 돌릴 수 있다(자동 재시도를 기다리지 않고).
export function canRetryChecks(feedback: Pick<Feedback, "status" | "checks" | "retrying"> & Partial<Pick<Feedback, "blocked">>): boolean {
  if (feedback.status === "blocked") return feedback.blocked?.stage === "checks";
  return feedback.status === "failed" && !feedback.retrying && feedback.checks.length > 0;
}

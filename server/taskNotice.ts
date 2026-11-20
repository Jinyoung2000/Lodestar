import type { TimelineItem } from "../shared/protocol";

// 백그라운드 작업의 완료, 실패 알림을 대화에 글로 남길지. 도구 호출을 run_in_background 로 건 것이 아니면(CLI 가 오래 걸리는 명령을 스스로 백그라운드로 돌린 경우 포함)
// 그 호출의 행(Ran, 서브에이전트)이 이미 결과와 실패를 보여 주므로 같은 말을 한 줄 더 붙이지 않는다. 직접 백그라운드로 건 작업의 결과와, 어느 호출인지 모르는 알림은 남긴다.
export function showsTaskNotice(status: "completed" | "failed" | "stopped", tool: TimelineItem | undefined): boolean {
  if (status === "stopped") return false;
  if (!tool || tool.kind !== "tool") return true;
  return tool.input.run_in_background === true;
}

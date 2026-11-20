import type { Agent } from "./protocol";

// 폴더 이동과 제거 같은 "지금 이 세션을 건드리면 안 되는가" 판정의 단일 기준.
// 턴이 돌거나(running) 승인을 기다리는 중(waiting)이거나, 끝난 뒤에도 백그라운드 작업이 남은 세션만 센다.
// error 는 CLI 가 이미 죽은 상태(작업 폴더가 사라져 시작 못 한 경우 포함)라 세지 않고, 그때 남은 백그라운드 수도 무시한다.
export function isBusyAgent(agent: Pick<Agent, "status" | "backgroundTasks">) {
  if (agent.status === "error") return false;
  return agent.status !== "idle" || (agent.backgroundTasks ?? 0) > 0;
}

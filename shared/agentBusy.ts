import type { Agent } from "./protocol";

export function isBusyAgent(agent: Pick<Agent, "status" | "backgroundTasks">) {
  if (agent.status === "error") return false;
  return agent.status !== "idle" || (agent.backgroundTasks ?? 0) > 0;
}

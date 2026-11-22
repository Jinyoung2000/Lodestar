import type { Agent } from "../shared/protocol";

export type PendingRef = { kind: "queue" | "steering"; id: string };

export function lastPending(agent: Pick<Agent, "queue" | "steering"> | undefined): PendingRef | null {
  const queued = agent?.queue?.at(-1);
  if (queued) return { kind: "queue", id: queued.id };
  const steering = (agent?.steering ?? []).filter((s) => !s.sent).at(-1);
  return steering ? { kind: "steering", id: steering.id } : null;
}

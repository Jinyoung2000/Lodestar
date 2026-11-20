import type { Agent } from "../shared/protocol";

// QUEUECANCEL: 입력창 ↑ 가 편집으로 불러올 대기 메시지. 큐의 마지막 것이 먼저고, 큐가 비면 아직 CLI 가 넘겨받지 않은 끼어들기 메시지의 마지막 것이다.
// 이미 넘어간 끼어들기(sent)는 거둘 수 없으니 고르지 않는다.
export type PendingRef = { kind: "queue" | "steering"; id: string };

export function lastPending(agent: Pick<Agent, "queue" | "steering"> | undefined): PendingRef | null {
  const queued = agent?.queue?.at(-1);
  if (queued) return { kind: "queue", id: queued.id };
  const steering = (agent?.steering ?? []).filter((s) => !s.sent).at(-1);
  return steering ? { kind: "steering", id: steering.id } : null;
}

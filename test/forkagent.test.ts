import type { Agent } from "../shared/protocol";
import { forkedFrom } from "../server/forkAgent";

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const source = { id: "a1", title: "source", queue: [{ id: "q1", text: "later" }, { id: "q2", text: "after that" }] } as unknown as Agent;

const copy = forkedFrom(source);
expect(copy.queue?.length === 0, `갈래는 빈 큐로 시작한다: ${JSON.stringify(copy.queue)}`);
expect(source.queue?.length === 2, "원 세션의 큐는 그대로");
expect(copy.title === "source", "다른 필드는 그대로 복사");
expect(forkedFrom({ id: "a2" } as unknown as Agent).queue?.length === 0, "큐가 없던 원 세션도 빈 큐");
console.log("ok   fork agent: 갈래는 원 세션의 queue 를 복사하지 않음");

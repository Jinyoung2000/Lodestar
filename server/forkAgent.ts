import type { Agent } from "../shared/protocol";

// 갈래(세션 Fork, 메시지 Fork, /btw 사이드 챗 채택)가 원 세션에서 복사해 시작하는 세션 레코드.
// 원 세션의 응답 중 쌓인 메시지(queue)는 원 세션이 보낼 것이라 갈래는 빈 큐로 시작한다.
export function forkedFrom(source: Agent): Agent {
  return { ...source, queue: [] };
}

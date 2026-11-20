// PERFDAEMON: 쉬는 세션의 CLI 프로세스(개당 150~630MB)를 몇 개까지 데워 둘지. 한도를 넘으면 가장 오래전에 쓴 쉬는 세션부터 닫는다.
// 닫아도 다음 메시지가 같은 세션 id 로 resume 한다(측정: 첫 글자까지 데운 프로세스 중앙값 2.3초, 닫았다 resume 5.4초). 시험: test/warmcap.test.ts
export type WarmCandidate = {
  agentId: string;
  // 마지막으로 메시지를 받았거나 턴이 끝난 시각(ms)
  lastUsed: number;
  // 턴이 도는 중, 백그라운드 작업, 승인 대기, 보낼 큐가 남은 세션은 쉬는 세션이 아니다. 한도에 세지 않고 닫지도 않는다.
  busy: boolean;
};

// limit 이 0 이하면 한도 없음. 쉬는 세션이 limit 개를 넘으면 오래전에 쓴 순서대로 넘친 만큼의 id 를 돌려준다.
export function selectWarmEvictions(candidates: readonly WarmCandidate[], limit: number): string[] {
  if (!(limit > 0)) return [];
  return candidates
    .filter((c) => !c.busy)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(limit)
    .map((c) => c.agentId);
}

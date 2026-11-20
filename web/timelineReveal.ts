// 접힌 단계 묶음(web/Timeline.tsx 의 StepsBlock)은 열 때까지 안쪽 줄을 만들지 않는다. 2천 단계짜리 대화에서 DOM 노드의 87% 가 접힌 묶음 안에 있었다.
// 찾기, 메시지로 이동, 서브에이전트 줄로 이동처럼 접힌 묶음 안의 DOM 을 찾아야 하는 곳은 먼저 이 요청으로 그 칸의 모든 묶음을 만들게 한다(한 번 만든 묶음은 칸이 닫힐 때까지 남는다).
const handlers = new Map<string, () => void>();

export function registerReveal(paneId: string, reveal: () => void) {
  handlers.set(paneId, reveal);
  return () => {
    if (handlers.get(paneId) === reveal) handlers.delete(paneId);
  };
}

// 그 칸의 대화가 있으면 true. 만드는 일은 다음 렌더에서 끝나므로, 찾는 쪽은 두 프레임 뒤에 다시 찾는다.
export function revealAllSteps(paneId: string): boolean {
  const reveal = handlers.get(paneId);
  reveal?.();
  return !!reveal;
}

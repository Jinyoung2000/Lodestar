// 화면에 안 보이는 세션의 타임라인을 메모리에서 내릴 대상을 고른다(순수 계산, test/renderperf.test.ts).
// 타임라인은 읽어 오면 영영 안 내려갔다. 열었다 닫은 세션이 쌓이면 JS 힙이 계속 늘었다(큰 세션 하나가 힙 9MB, 16개 열면 힙 +45MB).
// 내리는 것은 안전하다: 안 읽은 세션의 갱신은 이미 버리고(web/store.ts timelineUpsert), 다시 열면 agents.timeline 으로 읽는다.

// loaded: 읽어 둔 타임라인의 세션 id. shown: 대화 화면이 지금 붙어 있는 세션. recent: 화면에서 내려간 지 얼마 안 된 세션(최근 순).
// busy: 응답 중이거나 승인을 기다리는 세션(사이드바 행이 승인 항목을 타임라인에서 읽는다). keep: 최근에 닫은 세션을 몇 개까지 남길지.
export function pickEvictions(loaded: readonly string[], shown: ReadonlySet<string>, recent: readonly string[], busy: (id: string) => boolean, keep: number): string[] {
  const kept = new Set(recent.slice(0, keep));
  return loaded.filter((id) => !shown.has(id) && !kept.has(id) && !busy(id));
}

// 화면에서 내려간 세션을 recent 맨 앞에 넣는다(이미 있으면 앞으로 옮긴다). 다시 화면에 붙은 세션은 뺀다.
export function noteHidden(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)];
}

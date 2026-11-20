import { getState, subscribe } from "./store";

// 시작 단계 계측: performance.mark 로 "an:" 이름표만 남긴다(비용 없음). 시험 스크립트(.verify/perf-startup)가 읽는다.
// modules-evaluated: 번들 평가가 끝나 main.tsx 본문이 도는 시점. store-loaded: 첫 목록 RPC 응답이 store 에 들어간 시점.
// first-paint-list: 그 상태가 화면에 그려진 다음 프레임. interactive: 그 뒤 메인 스레드가 처음 한가해진 시점.
// timelines-loaded: 칸에 열린 세션의 타임라인이 모두 store 에 들어온 시점.
export function mark(name: string) {
  performance.mark(`an:${name}`);
}

export function trackStartup() {
  mark("track-start");
  let loaded = false;
  let timelines = false;
  const unsubscribe = subscribe(() => {
    const state = getState();
    if (!loaded && state.workspaces.length > 0) {
      loaded = true;
      mark("store-loaded");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          mark("first-paint-list");
          const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 0));
          idle(() => mark("interactive"));
        }),
      );
    }
    if (!loaded || timelines) return;
    const open = state.panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : []));
    if (open.every((id) => state.timelines[id])) {
      timelines = true;
      mark(open.length ? "timelines-loaded" : "no-open-sessions");
      requestAnimationFrame(() => requestAnimationFrame(() => mark("timelines-painted")));
      unsubscribe();
    }
  });
}

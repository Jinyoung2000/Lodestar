import { getState, subscribe } from "./store";

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

import { getState, setState } from "./store";
import { noteHidden, pickEvictions } from "./timelineEvict";

const KEEP_RECENT = 3;
const EVICT_DELAY_MS = 5000;

const shown = new Map<string, number>();
let recent: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function retainTimeline(agentId: string) {
  shown.set(agentId, (shown.get(agentId) ?? 0) + 1);
  recent = recent.filter((id) => id !== agentId);
  return () => {
    const left = (shown.get(agentId) ?? 1) - 1;
    if (left > 0) {
      shown.set(agentId, left);
      return;
    }
    shown.delete(agentId);
    recent = noteHidden(recent, agentId);
    if (timer) clearTimeout(timer);
    timer = setTimeout(evictHidden, EVICT_DELAY_MS);
  };
}

function evictHidden() {
  timer = null;
  const state = getState();
  const busy = (id: string) => {
    const status = state.agents.find((a) => a.id === id)?.status;
    return status === "running" || status === "waiting";
  };
  const drop = pickEvictions(Object.keys(state.timelines), new Set(shown.keys()), recent, busy, KEEP_RECENT);
  if (!drop.length) return;
  const dropped = new Set(drop);
  setState((s) => ({ timelines: Object.fromEntries(Object.entries(s.timelines).filter(([id]) => !dropped.has(id))) }));
}

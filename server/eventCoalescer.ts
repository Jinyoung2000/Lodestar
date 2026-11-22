import type { ServerEvent } from "../shared/protocol";

export type CoalescerOptions = {
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  intervalFor?: (textLength: number) => number;
};

export const DRAFT_MIN_INTERVAL_MS = 40;
export const DRAFT_MAX_INTERVAL_MS = 200;

export function draftInterval(textLength: number) {
  return Math.min(DRAFT_MAX_INTERVAL_MS, DRAFT_MIN_INTERVAL_MS + Math.floor(textLength / 20));
}

type Slot = { agentId: string; last: number; pending: ServerEvent | null; timer: unknown };

type DraftUpsert = Extract<ServerEvent, { type: "timelineUpsert" }> & { item: { kind: "assistant"; text: string } };

const isDraftUpsert = (event: ServerEvent): event is DraftUpsert => event.type === "timelineUpsert" && event.item.kind === "assistant" && event.item.streaming === true;

const agentOf = (event: ServerEvent): string | null => {
  if (event.type === "agent") return event.agent.id;
  return "agentId" in event && typeof event.agentId === "string" ? event.agentId : null;
};

export function createCoalescer(send: (event: ServerEvent) => void, options: CoalescerOptions = {}) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const intervalFor = options.intervalFor ?? draftInterval;
  const slots = new Map<string, Slot>();

  const release = (slot: Slot) => {
    if (slot.timer !== null) clearTimer(slot.timer);
    slot.timer = null;
    const event = slot.pending;
    slot.pending = null;
    if (!event) return;
    slot.last = now();
    send(event);
  };

  const flushAgent = (agentId: string) => {
    for (const slot of slots.values()) if (slot.agentId === agentId && slot.pending) release(slot);
  };

  const dropAgent = (agentId: string) => {
    for (const [key, slot] of slots) {
      if (slot.agentId !== agentId) continue;
      if (slot.timer !== null) clearTimer(slot.timer);
      slots.delete(key);
    }
  };

  return {
    push(event: ServerEvent) {
      if (isDraftUpsert(event)) {
        const key = `${event.agentId}:${event.item.id}`;
        const slot = slots.get(key) ?? { agentId: event.agentId, last: -Infinity, pending: null, timer: null };
        slots.set(key, slot);
        const interval = intervalFor(event.item.text.length);
        const wait = slot.last + interval - now();
        if (slot.pending === null && wait <= 0) {
          slot.last = now();
          send(event);
          return;
        }
        slot.pending = event;
        slot.timer ??= setTimer(() => {
          slot.timer = null;
          release(slot);
        }, Math.max(1, wait));
        return;
      }
      if (event.type === "timelineRemove") {
        const key = `${event.agentId}:${event.itemId}`;
        const slot = slots.get(key);
        if (slot) {
          if (slot.timer !== null) clearTimer(slot.timer);
          slots.delete(key);
        }
      }
      const agentId = agentOf(event);
      if (agentId) flushAgent(agentId);
      send(event);
      if (agentId && event.type === "agent" && event.agent.status !== "running") dropAgent(agentId);
    },
    flush() {
      for (const slot of slots.values()) release(slot);
    },
    pendingCount: () => [...slots.values()].filter((slot) => slot.pending).length,
    slotCount: () => slots.size,
  };
}

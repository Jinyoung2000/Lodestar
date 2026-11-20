import type { ServerEvent } from "../shared/protocol";

// PERFDAEMON: 스트리밍 중인 어시스턴트 초안은 글자가 늘 때마다 지금까지의 전체 글을 timelineUpsert 로 보낸다(350단어 답 하나에 596번, 612KB).
// 보낸 양이 답 길이의 제곱으로 늘기 때문에, 초안 갱신만 같은 항목끼리 시간 간격으로 묶는다: 처음 한 번은 바로 보내고(첫 글자 지연 없음), 간격 안에 온 것은 마지막 것만 간격이 끝날 때 보낸다.
// 간격은 글이 길수록 늘린다(긴 글일수록 한 번에 보내는 양이 크다). 초안이 아닌 이벤트는 그대로 지나가되, 같은 세션의 밀린 초안을 먼저 보내 순서를 지킨다.
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

  const release = (key: string, slot: Slot) => {
    if (slot.timer !== null) clearTimer(slot.timer);
    slot.timer = null;
    const event = slot.pending;
    slot.pending = null;
    if (!event) return;
    slot.last = now();
    send(event);
  };

  const flushAgent = (agentId: string) => {
    for (const [key, slot] of slots) if (slot.agentId === agentId && slot.pending) release(key, slot);
  };

  // 턴이 끝났거나 멈춘 세션의 초안 자리는 비운다(초안은 timelineRemove 로 지워지는데, 그 전에 끝난 것이 쌓이지 않게).
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
          release(key, slot);
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
    // 밀린 초안을 지금 보낸다(종료 직전, 시험).
    flush() {
      for (const [key, slot] of slots) release(key, slot);
    },
    pendingCount: () => [...slots.values()].filter((slot) => slot.pending).length,
    slotCount: () => slots.size,
  };
}

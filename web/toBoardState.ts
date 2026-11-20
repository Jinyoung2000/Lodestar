import { useSyncExternalStore } from "react";
import { hint } from "./hint";
import type { HintRect } from "./hintModel";
import { flash, getState, openAgent, setState } from "./store";
import { S } from "./strings";

// 대화의 한 부분을 Board 카드로 만드는 작은 팝오버의 열림 상태(web/ToBoardPopover.tsx)와, 카드에서 대화의 그 메시지로 돌아가는 스크롤 목표.
// 둘 다 store.ts 를 건드리지 않는 작은 외부 저장소다. 팝오버는 앱에 하나만 뜬다.

export type ToBoardRequest = {
  nonce: number;
  agentId: string;
  itemId: string;
  // 카드로 만들 원문(선택한 글, 메시지 전체, 할 일 하나)
  text: string;
  // 항목 전체면 null, 선택한 글이나 할 일이면 그 지문(shared/toBoard.ts sourcePart)
  part: string | null;
  // 누른 곳. 확인 말풍선을 같은 자리에 띄운다.
  rect: HintRect;
  // 팝오버를 붙이는 보이지 않는 점. 누른 단추가 사라져도(선택 도구) 그 자리에 남는다.
  anchor: HTMLElement;
  placement: "above" | "below";
  align: "start" | "end";
  trigger: Element | null;
};

export type ToBoardInput = Pick<ToBoardRequest, "agentId" | "itemId" | "text" | "part"> & { rect: HintRect; trigger?: Element | null };

const POPOVER_HEIGHT = 240;
const POPOVER_WIDTH = 340;
// 누른 단추를 다시 눌러 닫는 경우, 바깥 누름으로 닫힌 직후의 같은 단추 클릭이 도로 열지 않게 한다.
const REOPEN_GUARD_MS = 400;

let current: ToBoardRequest | null = null;
let nextNonce = 1;
let lastClosed: { trigger: Element | null; at: number } = { trigger: null, at: 0 };
const listeners = new Set<() => void>();

export const canAddToBoard = () => !document.documentElement.dataset.embed;

export function openToBoard(input: ToBoardInput) {
  if (!getState().board) {
    flash(S.toBoardNoBoard);
    return;
  }
  const trigger = input.trigger ?? null;
  if (trigger && trigger === lastClosed.trigger && Date.now() - lastClosed.at < REOPEN_GUARD_MS) return;
  closeToBoard();
  const { rect } = input;
  const anchor = document.createElement("span");
  Object.assign(anchor.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px`, pointerEvents: "none", visibility: "hidden" });
  document.body.appendChild(anchor);
  emit({
    nonce: nextNonce++,
    agentId: input.agentId,
    itemId: input.itemId,
    text: input.text,
    part: input.part,
    rect,
    anchor,
    placement: window.innerHeight - rect.bottom >= POPOVER_HEIGHT ? "below" : "above",
    align: rect.left > window.innerWidth - POPOVER_WIDTH ? "end" : "start",
    trigger,
  });
}

export function closeToBoard() {
  if (!current) return;
  lastClosed = { trigger: current.trigger, at: Date.now() };
  current.anchor.remove();
  emit(null);
}

export function useToBoardRequest(): ToBoardRequest | null {
  return useSyncExternalStore(subscribe, () => current);
}

function emit(next: ToBoardRequest | null) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 마지막으로 카드를 만든 열. 열이 지워졌으면 shared/toBoard.ts pickColumn 이 Backlog 로 돌린다.
const COLUMN_KEY = "agent-nav:toBoardColumn";

export function rememberedColumn(): string | null {
  try {
    return localStorage.getItem(COLUMN_KEY);
  } catch {
    return null;
  }
}

export function rememberColumn(columnId: string) {
  try {
    localStorage.setItem(COLUMN_KEY, columnId);
  } catch {
    // 저장이 막힌 환경에서는 이번 실행 동안만 팝오버 기본값(Backlog)을 쓴다
  }
}

// --- 카드에서 대화의 메시지로 ---

// at: 만든 시각. 타임라인이 끝내 안 오면 한참 뒤 그 세션을 연 화면이 옛 목표를 따라가지 않게 AgentView 가 오래된 것은 버린다.
export type MessageTarget = { agentId: string; itemId: string; nonce: number; at: number };

export const MESSAGE_TARGET_TTL_MS = 5000;

let target: MessageTarget | null = null;
let nextTarget = 1;
const targetListeners = new Set<() => void>();

// 세션을 열고(이미 어느 칸에 떠 있으면 그 칸으로 가고) 그 메시지로 스크롤하라고 AgentView 에 알린다.
export function showMessage(agentId: string, itemId: string) {
  const state = getState();
  if (!state.agents.some((a) => a.id === agentId)) {
    hint(S.cardSessionGone);
    return;
  }
  const pane = state.panes.find((p) => p.kind === "agent" && p.agentId === agentId);
  if (pane) setState({ activePaneId: pane.id, centerView: "sessions" });
  else openAgent(agentId);
  target = { agentId, itemId, nonce: nextTarget++, at: Date.now() };
  for (const listener of targetListeners) listener();
}

export function useMessageTarget(): MessageTarget | null {
  return useSyncExternalStore(
    (listener) => {
      targetListeners.add(listener);
      return () => targetListeners.delete(listener);
    },
    () => target,
  );
}

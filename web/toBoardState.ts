import { useSyncExternalStore } from "react";
import { hint } from "./hint";
import type { HintRect } from "./hintModel";
import { flash, getState, openAgent, setState } from "./store";
import { S } from "./strings";

export type ToBoardRequest = {
  nonce: number;
  agentId: string;
  itemId: string;
  text: string;
  part: string | null;
  rect: HintRect;
  anchor: HTMLElement;
  placement: "above" | "below";
  align: "start" | "end";
  trigger: Element | null;
};

export type ToBoardInput = Pick<ToBoardRequest, "agentId" | "itemId" | "text" | "part"> & { rect: HintRect; trigger?: Element | null };

const POPOVER_HEIGHT = 240;
const POPOVER_WIDTH = 340;
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
  }
}

export type MessageTarget = { agentId: string; itemId: string; nonce: number; at: number };

export const MESSAGE_TARGET_TTL_MS = 5000;

let target: MessageTarget | null = null;
let nextTarget = 1;
const targetListeners = new Set<() => void>();

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

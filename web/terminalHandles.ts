import { hint } from "./hint";
import { S } from "./strings";

let focusWanted = false;
export const FOCUS_EVENT = "agent-nav:focus-terminal";
export function wantTerminalFocus() {
  focusWanted = true;
  requestAnimationFrame(() => window.dispatchEvent(new Event(FOCUS_EVENT)));
}
export function isTerminalFocusWanted() {
  return focusWanted;
}
export function takeTerminalFocusWanted() {
  focusWanted = false;
}

export type AskHandle = { pane: () => HTMLElement | null; open: () => void; clear: () => void; find: () => void };
const askHandles = new Set<AskHandle>();
let lastFocused: AskHandle | null = null;
export function registerAskHandle(handle: AskHandle) {
  askHandles.add(handle);
  return () => {
    askHandles.delete(handle);
    if (lastFocused === handle) lastFocused = null;
  };
}
export function markAskHandleFocused(handle: AskHandle) {
  lastFocused = handle;
}
function targetTerminal() {
  const visible = [...askHandles].filter((handle) => handle.pane()?.offsetParent);
  const focused = visible.find((handle) => handle.pane()?.contains(document.activeElement));
  return focused ?? (lastFocused && visible.includes(lastFocused) ? lastFocused : visible[0]);
}
export function openTerminalAsk() {
  const target = targetTerminal();
  if (!target) {
    hint(S.focusTerminalFirst);
    return;
  }
  target.open();
}
export function openTerminalFind() {
  const target = targetTerminal();
  if (!target) {
    hint(S.focusTerminalFirst);
    return;
  }
  target.find();
}

export function clearTerminal() {
  const target = targetTerminal();
  if (!target) {
    hint(S.focusTerminalFirst);
    return;
  }
  target.clear();
}

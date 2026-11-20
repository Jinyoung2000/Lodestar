import { hint } from "./hint";
import { S } from "./strings";

// 터미널 화면(Terminal.tsx, xterm 을 끌고 온다)과 단축키 쪽이 같이 쓰는 상태. 단축키가 xterm 을 처음 번들에 끌어오지 않게 따로 둔다.

// ⌘J 가 터미널을 열 때 입력 포커스를 요청한다. 터미널이 아직 없으면 마운트될 때, 이미 있으면 패널이 보이게 된 다음 프레임에 받는다.
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

// TERMASK: ⌘I 가 터미널 명령 질문을 연다. 열려 있는 터미널마다 핸들을 등록해 두고, 포커스가 있는 터미널(없으면 마지막으로 포커스를 받은 보이는 터미널)에 연다.
export type AskHandle = { pane: () => HTMLElement | null; open: () => void; clear: () => void };
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
export function clearTerminal() {
  const target = targetTerminal();
  if (!target) {
    hint(S.focusTerminalFirst);
    return;
  }
  target.clear();
}

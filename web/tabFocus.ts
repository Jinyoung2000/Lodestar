let toggled = false;
let escaped = false;

export const isTabFocusMode = () => toggled;

export function toggleTabFocusMode(): boolean {
  toggled = !toggled;
  escaped = false;
  return toggled;
}

export function armEscapeTab() {
  escaped = true;
}

export function tabShouldMoveFocus(): boolean {
  const move = toggled || escaped;
  escaped = false;
  return move;
}

export function noteKeyForTabFocus(event: { key: string }) {
  if (event.key === "Tab" || event.key === "Escape" || event.key === "Shift" || event.key === "Control" || event.key === "Alt" || event.key === "Meta") return;
  escaped = false;
}

let toggled = false;
let escaped = false;

export const isTabFocusMode = () => toggled;

export function toggleTabFocusMode(): boolean {
  toggled = !toggled;
  escaped = false;
  return toggled;
}

// 에디터가 Esc 를 아무 데도 쓰지 않았을 때 부른다
export function armEscapeTab() {
  escaped = true;
}

// Tab 이 눌렸을 때: 포커스를 옮겨야 하면 true. Esc 뒤 한 번은 소모한다.
export function tabShouldMoveFocus(): boolean {
  const move = toggled || escaped;
  escaped = false;
  return move;
}

// 수정키가 아닌 다른 키가 오면 Esc 뒤 Tab 은 취소된다
export function noteKeyForTabFocus(event: { key: string }) {
  if (event.key === "Tab" || event.key === "Escape" || event.key === "Shift" || event.key === "Control" || event.key === "Alt" || event.key === "Meta") return;
  escaped = false;
}

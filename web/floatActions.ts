import { chatHiddenInEditor } from "./focusLayout";
import { flash, focusPane, getState, revealChat, setChatDockOpen, setFloatCollapsed, setLayoutMode } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

export function focusActiveSession() {
  const s = getState();
  if (s.layoutMode !== "editor") {
    focusPane(s.activePaneId);
    return;
  }
  const pane = document.querySelector<HTMLElement>(`[data-pane-id="${s.activePaneId}"] > .pane`);
  const inChat = !!pane && pane.contains(document.activeElement);
  if (!chatHiddenInEditor(s) && inChat) {
    focusEditor();
    return;
  }
  revealChat();
  focusPane(s.activePaneId);
}

function focusEditor() {
  const visible = (el: HTMLElement) => el.getClientRects().length > 0;
  const content = Array.from(document.querySelectorAll<HTMLElement>(".editor-group[data-focused] .cm-content")).find(visible);
  if (content) {
    content.focus();
    return;
  }
  const group = document.querySelector<HTMLElement>(".editor-group[data-focused]");
  if (!group) {
    hint(S.noEditorsOpen);
    return;
  }
  group.tabIndex = -1;
  group.focus();
}

// ⌃⌘J. Editor 배치의 대화를 접거나 펼친다(떠 있는 창은 알약으로, 오른쪽 패널은 닫고 열기). Chat 배치에는 접을 대화가 없어서, 누르면 Editor 배치로 바꾸면서 대화를 펼치고 돌아가는 키를 알린다.
export function toggleFloatCollapsed() {
  const s = getState();
  if (s.layoutMode !== "editor") {
    setLayoutMode("editor");
    focusPane(s.activePaneId);
    flash(S.floatSwitchedToEditor);
    return;
  }
  toggleChatVisible();
}

// Editor 배치에서 대화를 보이거나 숨긴다. 보이게 할 때는 입력창으로 포커스를 옮긴다. ⌥⌘B, ⌃⌘J 와 오른쪽 패널 머리의 단추가 같은 길이다.
export function toggleChatVisible() {
  const s = getState();
  const hidden = chatHiddenInEditor(s);
  if (s.chatDock === "floating") setFloatCollapsed(!hidden);
  else setChatDockOpen(hidden);
  if (hidden) focusPane(s.activePaneId);
}

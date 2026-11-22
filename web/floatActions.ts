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

export function toggleChatVisible() {
  const s = getState();
  const hidden = chatHiddenInEditor(s);
  if (s.chatDock === "floating") setFloatCollapsed(!hidden);
  else setChatDockOpen(hidden);
  if (hidden) focusPane(s.activePaneId);
}

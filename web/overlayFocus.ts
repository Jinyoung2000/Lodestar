import { getState, setState, subscribe } from "./store";

let overlayShown = false;
let opener: HTMLElement | null = null;

function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function focusLost() {
  const active = document.activeElement;
  return active === null || active === document.body;
}

function restoreFocus(target: HTMLElement | null) {
  if (!focusLost()) return;
  if (target?.isConnected && !target.hasAttribute("disabled")) {
    target.focus({ preventScroll: true });
    return;
  }
  if (target) setState({ focusComposer: { paneId: getState().activePaneId, nonce: Date.now() } });
}

export function focusComposerIfLost() {
  setTimeout(() => {
    if (focusLost()) setState({ focusComposer: { paneId: getState().activePaneId, nonce: Date.now() } });
  }, 0);
}

export function initOverlayFocus() {
  subscribe(() => {
    const shown = getState().overlay !== null;
    if (shown === overlayShown) return;
    overlayShown = shown;
    if (shown) {
      opener = focusedElement();
      return;
    }
    const target = opener;
    opener = null;
    setTimeout(() => restoreFocus(target), 0);
  });
}

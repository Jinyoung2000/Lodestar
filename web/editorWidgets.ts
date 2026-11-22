import { subscribe, getState } from "./store";

const dismissers = new Set<() => void>();

export function registerWidgetDismisser(dismiss: () => void) {
  ensureOverlayWatch();
  dismissers.add(dismiss);
  return () => dismissers.delete(dismiss);
}

export function dismissEditorWidgets() {
  for (const dismiss of dismissers) dismiss();
}

let watching = false;
let wasOpen = false;

function ensureOverlayWatch() {
  if (watching) return;
  watching = true;
  wasOpen = getState().overlay !== null;
  subscribe(() => {
    const open = getState().overlay !== null;
    if (open && !wasOpen) dismissEditorWidgets();
    wasOpen = open;
  });
}

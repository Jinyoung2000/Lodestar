import { useSyncExternalStore } from "react";
import { acceleratorLabel, QUICK_ENTRY_DEFAULT_SHORTCUT, type QuickShortcutStatus } from "../shared/quickEntry";
import { flash, getState, subscribe } from "./store";
import { S } from "./strings";

let status: QuickShortcutStatus | null = null;
let pushed = "";
let announced = "";
const listeners = new Set<() => void>();

export function initQuickEntrySync() {
  const native = window.agentNavNative;
  if (!native?.quickEntryConfigure) return;
  native.onQuickEntryStatus?.(setStatus);
  void native.quickEntryStatus?.().then(setStatus, () => undefined);
  const push = () => {
    const settings = getState().settings;
    if (!settings) return;
    const config = { enabled: settings.quickEntryEnabled ?? true, accelerator: settings.quickEntryShortcut ?? QUICK_ENTRY_DEFAULT_SHORTCUT };
    const key = JSON.stringify(config);
    if (key === pushed) return;
    pushed = key;
    void native.quickEntryConfigure?.(config).then(setStatus, () => undefined);
  };
  subscribe(push);
  push();
}

function setStatus(next: QuickShortcutStatus) {
  status = next;
  for (const listener of listeners) listener();
  if (next.state === "failed" && announced !== next.accelerator) {
    announced = next.accelerator;
    flash(S.quickEntryTaken(acceleratorLabel(next.accelerator)), "warning");
  }
}

export function useQuickEntryStatus(): QuickShortcutStatus | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
    () => null,
  );
}

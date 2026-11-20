import { useSyncExternalStore } from "react";
import { acceleratorLabel, QUICK_ENTRY_DEFAULT_SHORTCUT, type QuickShortcutStatus } from "../shared/quickEntry";
import { flash, getState, subscribe } from "./store";
import { S } from "./strings";

// 메인 창 쪽 연결: Settings 의 빠른 입력창 설정(켬 여부, 단축키)을 Electron 메인의 전역 단축키 등록에 맞추고, 등록 결과를 Settings 행과 앱 안 알림에 알린다.
// 시작할 때의 등록은 메인이 settings.json 을 읽어 먼저 한다. 여기서 같은 설정을 보내면 메인은 다시 등록하지 않는다.

let status: QuickShortcutStatus | null = null;
let pushed = "";
// 다른 앱이 이미 쓰는 단축키라는 알림은 같은 단축키에 한 번만 띄운다
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

// Settings 행이 읽는 등록 상태. Electron 밖(브라우저 탭)이면 null.
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

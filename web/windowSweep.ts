import { sweepClosedWindows, WINDOW_ID } from "./windowStorage";

export function initWindowSweep() {
  const native = window.agentNavNative;
  if (!WINDOW_ID || !native?.windowIds) return;
  const sweep = (ids: string[]) => {
    if (ids.includes(WINDOW_ID!)) sweepClosedWindows(ids);
  };
  void native.windowIds().then(sweep, () => undefined);
  native.onWindowsChanged?.(sweep);
}

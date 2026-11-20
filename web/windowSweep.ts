import { sweepClosedWindows, WINDOW_ID } from "./windowStorage";

// 닫힌 창의 저장본(창 상태, 저장 안 한 편집, 초안)을 지운다. 메인이 살아 있는 창 id 목록을 알려 주고(켤 때 한 번, 창이 열리고 닫힐 때마다), 목록에 없는 창의 범위를 정리한다.
// 목록에 이 창 자신이 없으면 목록이 아직 덜 갖춰진 것으로 보고 아무것도 지우지 않는다.
export function initWindowSweep() {
  const native = window.agentNavNative;
  if (!WINDOW_ID || !native?.windowIds) return;
  const sweep = (ids: string[]) => {
    if (ids.includes(WINDOW_ID!)) sweepClosedWindows(ids);
  };
  void native.windowIds().then(sweep, () => undefined);
  native.onWindowsChanged?.(sweep);
}

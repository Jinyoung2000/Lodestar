import { subscribe, getState } from "./store";

// 에디터 위에 떠 있는 상자(자동완성, hover, 파라미터 힌트)를 에디터 밖의 사정으로 닫는 등록부(round-5 발견 8).
// 에디터가 포커스를 잃으면 CodeMirror 가 자동완성을 닫지만, 창이 OS 포커스를 못 받은 상태에서는 blur 가 오지 않고(그 사이 열린 Settings 와 팔레트 위에 상자가 남았다),
// hover 와 힌트는 blur 로 닫히는 장치가 아예 없다. 그래서 오버레이가 열리거나 확인 창이 뜰 때 직접 닫는다.
// 이 파일은 store 만 안다. 닫는 동작은 각 에디터가 등록한다(순환 import 를 피하려고 CodeMirror 를 여기서 부르지 않는다).
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

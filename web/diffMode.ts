import { useSyncExternalStore } from "react";
import { DIFF_VIEWS, type DiffView } from "../shared/protocol";
import { rpc } from "./rpc";
import { useStore } from "./store";

export { chooseDiffMode, SPLIT_GAP, SPLIT_MIN_PANE, splitFits } from "./diffWidth";

// 지금 요청된 보기. 설정(~/.agent-nav/settings.json)의 diffView 가 유일한 저장소라, 헤더 버튼으로 고른 마지막 선택이 그대로 기본값이 된다.
export function useDiffView(): [DiffView, (view: DiffView) => void] {
  const saved = useStore((s) => s.settings?.diffView);
  const view: DiffView = DIFF_VIEWS.includes(saved as DiffView) ? (saved as DiffView) : "inline";
  return [view, setDiffView];
}

export function setDiffView(view: DiffView) {
  void rpc.call("settings.set", { diffView: view });
}

// 폭이 모자라 split 대신 inline 으로 그리고 있는 diff 들. 헤더가 "Split needs more width" 를 보여 줄지 정한다.
const narrow = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function reportNarrow(key: string, on: boolean) {
  if (on === narrow.has(key)) return;
  if (on) narrow.add(key);
  else narrow.delete(key);
  notify();
}

// prefix 로 시작하는 키 중 하나라도 폭 부족으로 inline 에 머물러 있으면 true.
export function useSplitNarrow(prefix: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => [...narrow].some((key) => key.startsWith(prefix)),
  );
}
